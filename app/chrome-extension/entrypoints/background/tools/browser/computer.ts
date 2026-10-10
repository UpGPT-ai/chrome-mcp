import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  TOOL_NAMES,
  applyOffset,
  chooseDragMode,
  hoverApproach,
  parseHoldMs,
  parseObserve,
  parseOffset,
  parsePointerSteps,
  pointerSteps,
} from 'chrome-mcp-shared';
import { ERROR_MESSAGES, TIMEOUTS } from '@/common/constants';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { clickTool, fillTool, resolveRefTarget } from './interaction';
import { attachObserve, beginObserve, type ObserveSession } from './observe';
import { keyboardTool } from './keyboard';
import { screenshotTool } from './screenshot';
import { screenshotContextManager, scaleCoordinates } from '@/utils/screenshot-context';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  captureFrameOnAction,
  isAutoCaptureActive,
  type ActionMetadata,
  type ActionType,
} from './gif-recorder';

type MouseButton = 'left' | 'right' | 'middle';

interface Coordinates {
  x: number;
  y: number;
}

interface ZoomRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Modifiers {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

interface ComputerParams {
  action:
    | 'left_click'
    | 'right_click'
    | 'double_click'
    | 'triple_click'
    | 'left_click_drag'
    | 'scroll'
    | 'type'
    | 'key'
    | 'hover'
    | 'wait'
    | 'fill'
    | 'fill_form'
    | 'resize_page'
    | 'scroll_to'
    | 'zoom'
    | 'screenshot';
  // click/scroll coordinates in screenshot space (if screenshot context exists) or viewport space
  coordinates?: Coordinates; // for click/scroll; for drag, this is endCoordinates
  startCoordinates?: Coordinates; // for drag start
  // Optional element refs (from chrome_read_page) as alternative to coordinates
  ref?: string; // click target or drag end
  startRef?: string; // drag start
  startOffset?: { x?: number; y?: number };
  offset?: { x?: number; y?: number };
  dragMode?: string;
  steps?: number;
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  scrollAmount?: number;
  text?: string; // for type/key
  repeat?: number; // for key action (1-100)
  modifiers?: Modifiers; // for click actions
  region?: ZoomRegion; // for zoom action
  duration?: number; // seconds for wait; hover hold when holdMs is omitted
  holdMs?: number; // hover hold in milliseconds
  // For fill
  selector?: string;
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  value?: string;
  frameId?: number; // Target frame for selector/ref resolution
  tabId?: number; // target existing tab id
  windowId?: number;
  background?: boolean; // avoid focusing/activating
  observe?: boolean | 'full' | { settleMs?: number };
}

// Minimal CDP helper encapsulated here to avoid scattering CDP code
class CDPHelper {
  static async attach(tabId: number): Promise<void> {
    await cdpSessionManager.attach(tabId, 'computer');
  }

  static async detach(tabId: number): Promise<void> {
    await cdpSessionManager.detach(tabId, 'computer');
  }

  static async send(tabId: number, method: string, params?: object): Promise<any> {
    return await cdpSessionManager.sendCommand(tabId, method, params);
  }

  static async dispatchMouseEvent(tabId: number, opts: any) {
    const params: any = {
      type: opts.type,
      x: Math.round(opts.x),
      y: Math.round(opts.y),
      modifiers: opts.modifiers || 0,
    };
    if (
      opts.type === 'mousePressed' ||
      opts.type === 'mouseReleased' ||
      opts.type === 'mouseMoved'
    ) {
      params.button = opts.button || 'none';
      if (opts.type === 'mousePressed' || opts.type === 'mouseReleased') {
        params.clickCount = opts.clickCount || 1;
      }
      // Per CDP: buttons is ignored for mouseWheel
      params.buttons = opts.buttons !== undefined ? opts.buttons : 0;
    }
    if (opts.type === 'mouseWheel') {
      params.deltaX = opts.deltaX || 0;
      params.deltaY = opts.deltaY || 0;
    }
    await this.send(tabId, 'Input.dispatchMouseEvent', params);
  }

  /** Several moves, so the page sees the pointer enter instead of teleport. */
  static async hoverSequence(tabId: number, points: Array<{ x: number; y: number }>) {
    for (const p of points) {
      await this.dispatchMouseEvent(tabId, {
        type: 'mouseMoved',
        x: p.x,
        y: p.y,
        button: 'none',
        buttons: 0,
      });
    }
  }

  /** Press, step, and release. Range sliders follow this path. It does not emit drop. */
  static async dragPointer(tabId: number, points: Array<{ x: number; y: number }>) {
    const start = points[0];
    const end = points[points.length - 1];
    if (!start || !end) throw new Error('Drag path is empty');
    await this.dispatchMouseEvent(tabId, {
      type: 'mouseMoved',
      x: start.x,
      y: start.y,
      button: 'none',
      buttons: 0,
    });
    await this.dispatchMouseEvent(tabId, {
      type: 'mousePressed',
      x: start.x,
      y: start.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    for (let i = 1; i < points.length; i++) {
      await this.dispatchMouseEvent(tabId, {
        type: 'mouseMoved',
        x: points[i].x,
        y: points[i].y,
        button: 'left',
        buttons: 1,
      });
    }
    await this.dispatchMouseEvent(tabId, {
      type: 'mouseReleased',
      x: end.x,
      y: end.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  /**
   * HTML5 drag events under the pointer. This does not run the source dragstart,
   * so the payload is text/plain only. setInterceptDrags is not used: it swallows the drag.
   */
  static async dragHtml5(tabId: number, points: Array<{ x: number; y: number }>, text: string) {
    const data = {
      items: [{ mimeType: 'text/plain', data: text || 'drag' }],
      dragOperationsMask: 17,
    };
    const send = (type: string, p: { x: number; y: number }) =>
      this.send(tabId, 'Input.dispatchDragEvent', {
        type,
        x: Math.round(p.x),
        y: Math.round(p.y),
        data,
      });
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) throw new Error('Drag path is empty');
    await send('dragEnter', first);
    for (const p of points) await send('dragOver', p);
    await send('drop', last);
  }

  static async insertText(tabId: number, text: string) {
    await this.send(tabId, 'Input.insertText', { text });
  }

  static modifierMask(mods: string[]): number {
    const map: Record<string, number> = {
      alt: 1,
      ctrl: 2,
      control: 2,
      meta: 4,
      cmd: 4,
      command: 4,
      win: 4,
      windows: 4,
      shift: 8,
    };
    let mask = 0;
    for (const m of mods) mask |= map[m] || 0;
    return mask;
  }

  // Enhanced key mapping for common non-character keys
  private static KEY_ALIASES: Record<string, { key: string; code?: string; text?: string }> = {
    enter: { key: 'Enter', code: 'Enter' },
    return: { key: 'Enter', code: 'Enter' },
    backspace: { key: 'Backspace', code: 'Backspace' },
    delete: { key: 'Delete', code: 'Delete' },
    tab: { key: 'Tab', code: 'Tab' },
    escape: { key: 'Escape', code: 'Escape' },
    esc: { key: 'Escape', code: 'Escape' },
    space: { key: ' ', code: 'Space', text: ' ' },
    pageup: { key: 'PageUp', code: 'PageUp' },
    pagedown: { key: 'PageDown', code: 'PageDown' },
    home: { key: 'Home', code: 'Home' },
    end: { key: 'End', code: 'End' },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp' },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight' },
  };

  private static resolveKeyDef(token: string): { key: string; code?: string; text?: string } {
    const t = (token || '').toLowerCase();
    if (this.KEY_ALIASES[t]) return this.KEY_ALIASES[t];
    if (/^f([1-9]|1[0-2])$/.test(t)) {
      return { key: t.toUpperCase(), code: t.toUpperCase() };
    }
    if (t.length === 1) {
      const upper = t.toUpperCase();
      return { key: upper, code: `Key${upper}`, text: t };
    }
    return { key: token };
  }

  static async dispatchSimpleKey(tabId: number, token: string) {
    const def = this.resolveKeyDef(token);
    if (def.text && def.text.length === 1) {
      await this.insertText(tabId, def.text);
      return;
    }
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: def.key,
      code: def.code,
    });
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
    });
  }

  static async dispatchKeyChord(tabId: number, chord: string) {
    const parts = chord.split('+');
    const modifiers: string[] = [];
    let keyToken = '';
    for (const pRaw of parts) {
      const p = pRaw.trim().toLowerCase();
      if (
        ['ctrl', 'control', 'alt', 'shift', 'cmd', 'meta', 'command', 'win', 'windows'].includes(p)
      )
        modifiers.push(p);
      else keyToken = pRaw.trim();
    }
    const mask = this.modifierMask(modifiers);
    const def = this.resolveKeyDef(keyToken);
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: def.key,
      code: def.code,
      text: def.text,
      modifiers: mask,
    });
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      modifiers: mask,
    });
  }
}

class ComputerTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.COMPUTER;

  async execute(args: ComputerParams): Promise<ToolResult> {
    const params = args || ({} as ComputerParams);
    if (!params.action) return createErrorResponse('Action parameter is required');

    const observe = parseObserve(params.observe);
    if (observe && 'error' in observe) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${observe.error}`);
    }

    let session: ObserveSession | null = null;
    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id)
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');

      if (observe) session = await beginObserve(tab.id, observe.settleMs, observe.full === true);

      // Execute the action and capture frame on success
      const result = await this.executeAction(params, tab);

      // Trigger auto-capture on successful actions (except screenshot which is read-only)
      if (!result.isError && params.action !== 'screenshot' && params.action !== 'wait') {
        const actionType = this.mapActionToCapture(params.action);
        if (actionType) {
          // Convert to viewport-space coordinates for GIF overlays
          // params.coordinates may be screenshot-space when screenshot context exists
          const ctx = screenshotContextManager.getContext(tab.id);
          const toViewport = (c?: Coordinates): { x: number; y: number } | undefined => {
            if (!c) return undefined;
            if (!ctx) return { x: c.x, y: c.y };
            const scaled = scaleCoordinates(c.x, c.y, ctx);
            return { x: scaled.x, y: scaled.y };
          };

          const endCoords = toViewport(params.coordinates);
          const startCoords = toViewport(params.startCoordinates);

          await this.triggerAutoCapture(tab.id, actionType, {
            coordinateSpace: 'viewport',
            coordinates: endCoords,
            startCoordinates: startCoords,
            endCoordinates: actionType === 'drag' ? endCoords : undefined,
            text: params.text,
            ref: params.ref,
          });
        }
      }

      return attachObserve(session, result);
    } catch (error) {
      console.error('Error in computer tool:', error);
      return attachObserve(
        session,
        createErrorResponse(
          `Failed to execute action: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  private mapActionToCapture(action: string): ActionType | null {
    const mapping: Record<string, ActionType> = {
      left_click: 'click',
      right_click: 'right_click',
      double_click: 'double_click',
      triple_click: 'triple_click',
      left_click_drag: 'drag',
      scroll: 'scroll',
      type: 'type',
      key: 'key',
      hover: 'hover',
      fill: 'fill',
      fill_form: 'fill',
      resize_page: 'other',
      scroll_to: 'scroll',
      zoom: 'other',
    };
    return mapping[action] || null;
  }

  private async injectTreeHelper(tabId: number, frameId?: number): Promise<void> {
    await this.injectContentScript(
      tabId,
      ['inject-scripts/accessibility-tree-helper.js'],
      false,
      'ISOLATED',
      false,
      typeof frameId === 'number' ? [frameId] : undefined,
    );
  }

  /** Resolve a ref, including `ref_N@frameId`, to top-frame viewport coordinates. */
  private async resolveRefViewportPoint(
    tabId: number,
    ref: string,
    fallbackFrameId?: number,
  ): Promise<Coordinates | null> {
    const target = resolveRefTarget(ref, fallbackFrameId);
    if (!target.ref) return null;
    await this.injectTreeHelper(tabId, target.frameId);
    const resolved = await this.sendMessageToTab(
      tabId,
      { action: TOOL_MESSAGE_TYPES.RESOLVE_REF, ref: target.ref },
      target.frameId,
    );
    const point = resolved?.topCenter || resolved?.center;
    if (!resolved?.success || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return null;
    }
    return { x: point.x, y: point.y };
  }

  /** Read the drag source from the ref map. A miss falls back to a pointer drag. */
  private async dragSourceHint(
    tabId: number,
    startRef: string,
    fallbackFrameId?: number,
  ): Promise<{ range: boolean; draggable: boolean; text: string }> {
    const empty = { range: false, draggable: false, text: '' };
    try {
      const target = resolveRefTarget(startRef, fallbackFrameId);
      if (!target.ref) return empty;
      const [injection] = await chrome.scripting.executeScript({
        target: {
          tabId,
          ...(typeof target.frameId === 'number' ? { frameIds: [target.frameId] } : {}),
        },
        world: 'ISOLATED',
        func: (localRef: string) => {
          const map = (window as any).__claudeElementMap;
          const el = map?.[localRef]?.deref?.() ?? null;
          if (!el) return { range: false, draggable: false, text: '' };
          const tag = String(el.tagName || '').toUpperCase();
          const type = String(el.getAttribute?.('type') || '').toLowerCase();
          const role = String(el.getAttribute?.('role') || '').toLowerCase();
          const range = (tag === 'INPUT' && type === 'range') || role === 'slider';
          const rawAttr = el.getAttribute?.('draggable');
          const attr = typeof rawAttr === 'string' ? rawAttr.toLowerCase() : '';
          const defaultDrag = tag === 'IMG' || (tag === 'A' && el.hasAttribute('href'));
          const draggable = attr === 'true' || (attr !== 'false' && defaultDrag);
          const text = String(el.innerText || el.textContent || el.getAttribute?.('href') || '')
            .trim()
            .slice(0, 200);
          return { range, draggable: !range && draggable, text };
        },
        args: [target.ref],
      });
      const result = injection?.result as
        | { range?: boolean; draggable?: boolean; text?: string }
        | undefined;
      if (!result || typeof result !== 'object') return empty;
      return {
        range: Boolean(result.range),
        draggable: Boolean(result.draggable),
        text: typeof result.text === 'string' ? result.text : '',
      };
    } catch {
      return empty;
    }
  }

  private async executeAction(params: ComputerParams, tab: chrome.tabs.Tab): Promise<ToolResult> {
    if (!tab.id) {
      return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
    }

    // Helper to project coordinates using screenshot context when available
    const project = (c?: Coordinates): Coordinates | undefined => {
      if (!c) return undefined;
      const ctx = screenshotContextManager.getContext(tab.id!);
      if (!ctx) return c;
      const scaled = scaleCoordinates(c.x, c.y, ctx);
      return { x: scaled.x, y: scaled.y };
    };

    switch (params.action) {
      case 'resize_page': {
        const width = Number((params as any).coordinates?.x || (params as any).text);
        const height = Number((params as any).coordinates?.y || (params as any).value);
        const w = Number((params as any).width ?? width);
        const h = Number((params as any).height ?? height);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
          return createErrorResponse('Provide width and height for resize_page (positive numbers)');
        }
        try {
          // Prefer precise CDP emulation
          await CDPHelper.attach(tab.id);
          try {
            await CDPHelper.send(tab.id, 'Emulation.setDeviceMetricsOverride', {
              width: Math.round(w),
              height: Math.round(h),
              deviceScaleFactor: 0,
              mobile: false,
              screenWidth: Math.round(w),
              screenHeight: Math.round(h),
            });
          } finally {
            await CDPHelper.detach(tab.id);
          }
        } catch (e) {
          // Fallback: window resize
          if (tab.windowId !== undefined) {
            await chrome.windows.update(tab.windowId, {
              width: Math.round(w),
              height: Math.round(h),
            });
          } else {
            return createErrorResponse(
              `Failed to resize via CDP and cannot determine windowId: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, action: 'resize_page', width: w, height: h }),
            },
          ],
          isError: false,
        };
      }
      case 'hover': {
        const holdMs = parseHoldMs(params.holdMs, params.duration);
        if (typeof holdMs !== 'number') return createErrorResponse(holdMs.error);

        // Resolve target point from ref | selector | coordinates
        let coord: Coordinates | undefined = undefined;
        let resolvedBy: 'ref' | 'selector' | 'coordinates' | undefined;

        try {
          if (params.ref) {
            const target = resolveRefTarget(params.ref, params.frameId);
            await this.injectTreeHelper(tab.id, target.frameId);
            // Scroll element into view first to ensure it's visible
            try {
              await this.sendMessageToTab(
                tab.id,
                { action: 'focusByRef', ref: target.ref },
                target.frameId,
              );
            } catch {
              // Best effort - continue even if scroll fails
            }
            // Re-resolve coordinates after scroll. topCenter includes iframe offsets.
            const resolved = await this.sendMessageToTab(
              tab.id,
              { action: TOOL_MESSAGE_TYPES.RESOLVE_REF, ref: target.ref },
              target.frameId,
            );
            const point = resolved?.topCenter || resolved?.center;
            if (resolved && resolved.success && point) {
              coord = project({ x: point.x, y: point.y });
              resolvedBy = 'ref';
            }
          } else if (params.selector) {
            await this.injectTreeHelper(tab.id, params.frameId);
            const selectorType = params.selectorType || 'css';
            const ensured = await this.sendMessageToTab(
              tab.id,
              {
                action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
                selector: params.selector,
                isXPath: selectorType === 'xpath',
              },
              params.frameId,
            );
            if (ensured && ensured.success) {
              // Scroll element into view first to ensure it's visible
              const resolvedRef = typeof ensured.ref === 'string' ? ensured.ref : undefined;
              if (resolvedRef) {
                try {
                  await this.sendMessageToTab(
                    tab.id,
                    { action: 'focusByRef', ref: resolvedRef },
                    params.frameId,
                  );
                } catch {
                  // Best effort - continue even if scroll fails
                }
                // Re-resolve coordinates after scroll
                const reResolved = await this.sendMessageToTab(
                  tab.id,
                  {
                    action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
                    ref: resolvedRef,
                  },
                  params.frameId,
                );
                const point = reResolved?.topCenter || reResolved?.center;
                if (reResolved && reResolved.success && point) {
                  coord = project({ x: point.x, y: point.y });
                } else {
                  coord = project({ x: ensured.center.x, y: ensured.center.y });
                }
              } else {
                coord = project({ x: ensured.center.x, y: ensured.center.y });
              }
              resolvedBy = 'selector';
            }
          } else if (params.coordinates) {
            coord = project(params.coordinates);
            resolvedBy = 'coordinates';
          }
        } catch (e) {
          // fall through to error handling below
        }

        if (!coord)
          return createErrorResponse(
            'Provide ref or selector or coordinates for hover, or failed to resolve target',
          );
        {
          const stale = ((): any => {
            if (!params.coordinates) return null;
            const getHostname = (url: string): string => {
              try {
                return new URL(url).hostname;
              } catch {
                return '';
              }
            };
            const currentHostname = getHostname(tab.url || '');
            const ctx = screenshotContextManager.getContext(tab.id!);
            const contextHostname = (ctx as any)?.hostname as string | undefined;
            if (contextHostname && contextHostname !== currentHostname) {
              return createErrorResponse(
                `Security check failed: Domain changed since last screenshot (from ${contextHostname} to ${currentHostname}) during hover. Capture a new screenshot or use ref/selector.`,
              );
            }
            return null;
          })();
          if (stale) return stale;
        }

        // Step in from outside, then hold while still attached so :hover menus can open.
        const path = hoverApproach(coord);
        try {
          await CDPHelper.attach(tab.id);
          try {
            await CDPHelper.hoverSequence(tab.id, path);
            if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));
          } finally {
            await CDPHelper.detach(tab.id);
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'hover',
                  coordinates: path[path.length - 1] || coord,
                  resolvedBy,
                  transport: 'cdp',
                  holdMs,
                  steps: path.length,
                }),
              },
            ],
            isError: false,
          };
        } catch (error) {
          console.warn('[ComputerTool] CDP hover failed, attempting DOM fallback', error);
          return await this.domHoverFallback(tab.id, coord, resolvedBy, params.ref);
        }
      }
      case 'left_click':
      case 'right_click': {
        // Calculate CDP modifier mask for click events
        const modifiersMask = CDPHelper.modifierMask(
          [
            params.modifiers?.altKey ? 'alt' : undefined,
            params.modifiers?.ctrlKey ? 'ctrl' : undefined,
            params.modifiers?.metaKey ? 'meta' : undefined,
            params.modifiers?.shiftKey ? 'shift' : undefined,
          ].filter((v): v is string => typeof v === 'string'),
        );

        if (params.ref) {
          // Prefer DOM click via ref. frameId is carried on refs inside iframes.
          const target = resolveRefTarget(params.ref, params.frameId);
          const domResult = await clickTool.execute({
            ref: target.ref,
            frameId: target.frameId,
            tabId: tab.id,
            waitForNavigation: false,
            timeout: TIMEOUTS.DEFAULT_WAIT * 5,
            button: params.action === 'right_click' ? 'right' : 'left',
            modifiers: params.modifiers,
          });
          return domResult;
        }
        if (params.selector) {
          // Support selector-based click
          const domResult = await clickTool.execute({
            selector: params.selector,
            selectorType: params.selectorType,
            frameId: params.frameId,
            tabId: tab.id,
            waitForNavigation: false,
            timeout: TIMEOUTS.DEFAULT_WAIT * 5,
            button: params.action === 'right_click' ? 'right' : 'left',
            modifiers: params.modifiers,
          });
          return domResult;
        }
        if (!params.coordinates)
          return createErrorResponse('Provide ref, selector, or coordinates for click action');
        {
          const stale = ((): any => {
            const getHostname = (url: string): string => {
              try {
                return new URL(url).hostname;
              } catch {
                return '';
              }
            };
            const currentHostname = getHostname(tab.url || '');
            const ctx = screenshotContextManager.getContext(tab.id!);
            const contextHostname = (ctx as any)?.hostname as string | undefined;
            if (contextHostname && contextHostname !== currentHostname) {
              return createErrorResponse(
                `Security check failed: Domain changed since last screenshot (from ${contextHostname} to ${currentHostname}) during ${params.action}. Capture a new screenshot or use ref/selector.`,
              );
            }
            return null;
          })();
          if (stale) return stale;
        }
        const coord = project(params.coordinates)!;
        // Prefer DOM path via existing click tool
        const domResult = await clickTool.execute({
          coordinates: coord,
          tabId: tab.id,
          frameId: params.frameId,
          waitForNavigation: false,
          timeout: TIMEOUTS.DEFAULT_WAIT * 5,
          button: params.action === 'right_click' ? 'right' : 'left',
          modifiers: params.modifiers,
        });
        if (!domResult.isError) {
          return domResult; // Standardized response from click tool
        }
        // Fallback to CDP if DOM failed
        try {
          await CDPHelper.attach(tab.id);
          const button: MouseButton = params.action === 'right_click' ? 'right' : 'left';
          const clickCount = 1;
          await CDPHelper.dispatchMouseEvent(tab.id, {
            type: 'mouseMoved',
            x: coord.x,
            y: coord.y,
            button: 'none',
            buttons: 0,
            modifiers: modifiersMask,
          });
          for (let i = 1; i <= clickCount; i++) {
            await CDPHelper.dispatchMouseEvent(tab.id, {
              type: 'mousePressed',
              x: coord.x,
              y: coord.y,
              button,
              buttons: button === 'left' ? 1 : 2,
              clickCount: i,
              modifiers: modifiersMask,
            });
            await CDPHelper.dispatchMouseEvent(tab.id, {
              type: 'mouseReleased',
              x: coord.x,
              y: coord.y,
              button,
              buttons: 0,
              clickCount: i,
              modifiers: modifiersMask,
            });
          }
          await CDPHelper.detach(tab.id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: params.action,
                  coordinates: coord,
                }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          await CDPHelper.detach(tab.id);
          return createErrorResponse(
            `CDP click failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      case 'double_click':
      case 'triple_click': {
        // Calculate CDP modifier mask for click events
        const modifiersMask = CDPHelper.modifierMask(
          [
            params.modifiers?.altKey ? 'alt' : undefined,
            params.modifiers?.ctrlKey ? 'ctrl' : undefined,
            params.modifiers?.metaKey ? 'meta' : undefined,
            params.modifiers?.shiftKey ? 'shift' : undefined,
          ].filter((v): v is string => typeof v === 'string'),
        );

        if (!params.coordinates && !params.ref && !params.selector)
          return createErrorResponse(
            'Provide ref, selector, or coordinates for double/triple click',
          );
        let coord = params.coordinates ? project(params.coordinates)! : (undefined as any);
        // If ref is provided, resolve center via accessibility helper
        if (params.ref) {
          try {
            const point = await this.resolveRefViewportPoint(tab.id, params.ref, params.frameId);
            if (point) coord = project(point)!;
          } catch (e) {
            // ignore and use provided coordinates
          }
        } else if (params.selector) {
          // Support selector-based click
          try {
            await this.injectTreeHelper(tab.id, params.frameId);
            const selectorType = params.selectorType || 'css';
            const ensured = await this.sendMessageToTab(
              tab.id,
              {
                action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
                selector: params.selector,
                isXPath: selectorType === 'xpath',
              },
              params.frameId,
            );
            const point = ensured?.topCenter || ensured?.center;
            if (ensured && ensured.success && point) {
              coord = project({ x: point.x, y: point.y })!;
            }
          } catch (e) {
            // ignore
          }
        }
        if (!coord) return createErrorResponse('Failed to resolve coordinates from ref/selector');
        {
          const stale = ((): any => {
            if (!params.coordinates) return null;
            const getHostname = (url: string): string => {
              try {
                return new URL(url).hostname;
              } catch {
                return '';
              }
            };
            const currentHostname = getHostname(tab.url || '');
            const ctx = screenshotContextManager.getContext(tab.id!);
            const contextHostname = (ctx as any)?.hostname as string | undefined;
            if (contextHostname && contextHostname !== currentHostname) {
              return createErrorResponse(
                `Security check failed: Domain changed since last screenshot (from ${contextHostname} to ${currentHostname}) during ${params.action}. Capture a new screenshot or use ref/selector.`,
              );
            }
            return null;
          })();
          if (stale) return stale;
        }
        try {
          await CDPHelper.attach(tab.id);
          const button: MouseButton = 'left';
          const clickCount = params.action === 'double_click' ? 2 : 3;
          await CDPHelper.dispatchMouseEvent(tab.id, {
            type: 'mouseMoved',
            x: coord.x,
            y: coord.y,
            button: 'none',
            buttons: 0,
            modifiers: modifiersMask,
          });
          for (let i = 1; i <= clickCount; i++) {
            await CDPHelper.dispatchMouseEvent(tab.id, {
              type: 'mousePressed',
              x: coord.x,
              y: coord.y,
              button,
              buttons: 1,
              clickCount: i,
              modifiers: modifiersMask,
            });
            await CDPHelper.dispatchMouseEvent(tab.id, {
              type: 'mouseReleased',
              x: coord.x,
              y: coord.y,
              button,
              buttons: 0,
              clickCount: i,
              modifiers: modifiersMask,
            });
          }
          await CDPHelper.detach(tab.id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: params.action,
                  coordinates: coord,
                }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          await CDPHelper.detach(tab.id);
          return createErrorResponse(
            `CDP ${params.action} failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      case 'left_click_drag': {
        const parsedStartOffset = parseOffset(params.startOffset, 'startOffset');
        if (parsedStartOffset && 'error' in parsedStartOffset) {
          return createErrorResponse(parsedStartOffset.error);
        }
        const parsedEndOffset = parseOffset(params.offset, 'offset');
        if (parsedEndOffset && 'error' in parsedEndOffset) {
          return createErrorResponse(parsedEndOffset.error);
        }
        const stepCount = parsePointerSteps(params.steps);
        if (typeof stepCount !== 'number') return createErrorResponse(stepCount.error);
        const requestedMode = chooseDragMode({ dragMode: params.dragMode });
        if (typeof requestedMode !== 'string') return createErrorResponse(requestedMode.error);

        if (!params.startCoordinates && !params.startRef)
          return createErrorResponse('Provide startRef or startCoordinates for drag');
        if (!params.coordinates && !params.ref)
          return createErrorResponse('Provide ref or end coordinates for drag');
        let start = params.startCoordinates
          ? project(params.startCoordinates)!
          : (undefined as any);
        let end = params.coordinates ? project(params.coordinates)! : (undefined as any);
        {
          const stale = ((): any => {
            if (!params.startCoordinates && !params.coordinates) return null;
            const getHostname = (url: string): string => {
              try {
                return new URL(url).hostname;
              } catch {
                return '';
              }
            };
            const currentHostname = getHostname(tab.url || '');
            const ctx = screenshotContextManager.getContext(tab.id!);
            const contextHostname = (ctx as any)?.hostname as string | undefined;
            if (contextHostname && contextHostname !== currentHostname) {
              return createErrorResponse(
                `Security check failed: Domain changed since last screenshot (from ${contextHostname} to ${currentHostname}) during left_click_drag. Capture a new screenshot or use ref/selector.`,
              );
            }
            return null;
          })();
          if (stale) return stale;
        }
        if (params.startRef) {
          try {
            const point = await this.resolveRefViewportPoint(
              tab.id,
              params.startRef,
              params.frameId,
            );
            if (point) start = project(point)!;
          } catch {
            // ignore
          }
        }
        if (params.ref) {
          try {
            const point = await this.resolveRefViewportPoint(tab.id, params.ref, params.frameId);
            if (point) end = project(point)!;
          } catch {
            // ignore
          }
        }
        if (!start || !end) return createErrorResponse('Failed to resolve drag coordinates');
        start = applyOffset(start, parsedStartOffset);
        end = applyOffset(end, parsedEndOffset);

        let hint = { range: false, draggable: false, text: '' };
        if (params.startRef && params.dragMode !== 'pointer') {
          hint = await this.dragSourceHint(tab.id, params.startRef, params.frameId);
        }
        const chosen = chooseDragMode({
          dragMode: params.dragMode,
          range: hint.range,
          draggable: hint.draggable,
        });
        if (typeof chosen !== 'string') return createErrorResponse(chosen.error);

        const path = pointerSteps(start, end, stepCount);
        let mode = chosen;
        let note: string | undefined;
        try {
          await CDPHelper.attach(tab.id);
          if (mode === 'html5') {
            try {
              await CDPHelper.dragHtml5(tab.id, path, hint.text);
            } catch (dragError) {
              try {
                await CDPHelper.send(tab.id, 'Input.dispatchDragEvent', {
                  type: 'dragCancel',
                  x: Math.round(end.x),
                  y: Math.round(end.y),
                  data: { items: [], dragOperationsMask: 0 },
                });
              } catch {
                // No drag is in progress, or the drag API is missing.
              }
              try {
                await CDPHelper.dragPointer(tab.id, path);
              } catch {
                throw dragError;
              }
              mode = 'pointer';
              note = 'HTML5 drag events were unavailable, used pointer drag';
            }
          } else {
            await CDPHelper.dragPointer(tab.id, path);
          }
          await CDPHelper.detach(tab.id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'left_click_drag',
                  start,
                  end,
                  mode,
                  steps: path.length,
                  ...(note ? { note } : {}),
                }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          await CDPHelper.detach(tab.id);
          return createErrorResponse(`Drag failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      case 'scroll': {
        if (!params.coordinates && !params.ref)
          return createErrorResponse('Provide ref or coordinates for scroll');
        let coord = params.coordinates ? project(params.coordinates)! : (undefined as any);
        if (params.ref) {
          try {
            const point = await this.resolveRefViewportPoint(tab.id, params.ref, params.frameId);
            if (point) coord = project(point)!;
          } catch {
            // ignore
          }
        }
        if (!coord) return createErrorResponse('Failed to resolve scroll coordinates');
        {
          const stale = ((): any => {
            if (!params.coordinates) return null;
            const getHostname = (url: string): string => {
              try {
                return new URL(url).hostname;
              } catch {
                return '';
              }
            };
            const currentHostname = getHostname(tab.url || '');
            const ctx = screenshotContextManager.getContext(tab.id!);
            const contextHostname = (ctx as any)?.hostname as string | undefined;
            if (contextHostname && contextHostname !== currentHostname) {
              return createErrorResponse(
                `Security check failed: Domain changed since last screenshot (from ${contextHostname} to ${currentHostname}) during scroll. Capture a new screenshot or use ref/selector.`,
              );
            }
            return null;
          })();
          if (stale) return stale;
        }
        const direction = params.scrollDirection || 'down';
        const amount = Math.max(1, Math.min(params.scrollAmount || 3, 10));
        // Convert to deltas (~100px per tick)
        const unit = 100;
        let deltaX = 0,
          deltaY = 0;
        if (direction === 'up') deltaY = -amount * unit;
        if (direction === 'down') deltaY = amount * unit;
        if (direction === 'left') deltaX = -amount * unit;
        if (direction === 'right') deltaX = amount * unit;
        try {
          await CDPHelper.attach(tab.id);
          await CDPHelper.dispatchMouseEvent(tab.id, {
            type: 'mouseWheel',
            x: coord.x,
            y: coord.y,
            deltaX,
            deltaY,
          });
          await CDPHelper.detach(tab.id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'scroll',
                  coordinates: coord,
                  deltaX,
                  deltaY,
                }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          await CDPHelper.detach(tab.id);
          return createErrorResponse(
            `Scroll failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      case 'type': {
        if (!params.text) return createErrorResponse('Text parameter is required for type action');
        try {
          // Optional focus via ref before typing
          if (params.ref) {
            const target = resolveRefTarget(params.ref, params.frameId);
            await clickTool.execute({
              ref: target.ref,
              frameId: target.frameId,
              tabId: tab.id,
              waitForNavigation: false,
              timeout: TIMEOUTS.DEFAULT_WAIT * 5,
            });
          }
          await CDPHelper.attach(tab.id);
          // Use CDP insertText to avoid complex KeyboardEvent emulation for long text
          await CDPHelper.insertText(tab.id, params.text);
          await CDPHelper.detach(tab.id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'type',
                  length: params.text.length,
                }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          await CDPHelper.detach(tab.id);
          // Fallback to DOM-based keyboard tool
          const res = await keyboardTool.execute({
            keys: params.text.split('').join(','),
            delay: 0,
            selector: undefined,
          });
          return res;
        }
      }
      case 'fill': {
        if (!params.ref && !params.selector) {
          return createErrorResponse('Provide ref or selector and a value for fill');
        }
        // Reuse existing fill tool to leverage robust DOM event behavior
        const target = resolveRefTarget(params.ref, params.frameId);
        const res = await fillTool.execute({
          selector: params.selector as any,
          selectorType: params.selectorType as any,
          ref: target.ref as any,
          frameId: target.frameId,
          tabId: tab.id,
          value: params.value as any,
        } as any);
        return res;
      }
      case 'fill_form': {
        const elements = (params as any).elements as Array<{
          ref: string;
          value: string | number | boolean;
        }>;
        if (!Array.isArray(elements) || elements.length === 0) {
          return createErrorResponse('elements must be a non-empty array for fill_form');
        }
        const results: Array<{ ref: string; ok: boolean; error?: string }> = [];
        for (const item of elements) {
          if (!item || !item.ref) {
            results.push({ ref: String(item?.ref || ''), ok: false, error: 'missing ref' });
            continue;
          }
          try {
            const target = resolveRefTarget(item.ref, params.frameId);
            const r = await fillTool.execute({
              ref: target.ref as any,
              frameId: target.frameId,
              tabId: tab.id,
              value: item.value as any,
            } as any);
            const ok = !r.isError;
            results.push({ ref: item.ref, ok, error: ok ? undefined : 'failed' });
          } catch (e) {
            results.push({
              ref: item.ref,
              ok: false,
              error: String(e instanceof Error ? e.message : e),
            });
          }
        }
        const successCount = results.filter((r) => r.ok).length;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                action: 'fill_form',
                filled: successCount,
                total: results.length,
                results,
              }),
            },
          ],
          isError: false,
        };
      }
      case 'key': {
        if (!params.text)
          return createErrorResponse(
            'text is required for key action (e.g., "Backspace Backspace Enter" or "cmd+a")',
          );
        const tokens = params.text.trim().split(/\s+/).filter(Boolean);
        const repeat = params.repeat ?? 1;
        if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) {
          return createErrorResponse('repeat must be an integer between 1 and 100 for key action');
        }
        try {
          // Optional focus via ref before key events
          if (params.ref) {
            const target = resolveRefTarget(params.ref, params.frameId);
            await clickTool.execute({
              ref: target.ref,
              frameId: target.frameId,
              tabId: tab.id,
              waitForNavigation: false,
              timeout: TIMEOUTS.DEFAULT_WAIT * 5,
            });
          }
          await CDPHelper.attach(tab.id);
          for (let i = 0; i < repeat; i++) {
            for (const t of tokens) {
              if (t.includes('+')) await CDPHelper.dispatchKeyChord(tab.id, t);
              else await CDPHelper.dispatchSimpleKey(tab.id, t);
            }
          }
          await CDPHelper.detach(tab.id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, action: 'key', keys: tokens, repeat }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          await CDPHelper.detach(tab.id);
          // Fallback to DOM keyboard simulation (comma-separated combinations)
          const keysStr = tokens.join(',');
          const repeatedKeys =
            repeat === 1 ? keysStr : Array.from({ length: repeat }, () => keysStr).join(',');
          const res = await keyboardTool.execute({ keys: repeatedKeys });
          return res;
        }
      }
      case 'wait': {
        const hasTextCondition =
          typeof (params as any).text === 'string' && (params as any).text.trim().length > 0;
        if (hasTextCondition) {
          try {
            // Conditional wait for text appearance/disappearance using content script
            await this.injectContentScript(
              tab.id,
              ['inject-scripts/wait-helper.js'],
              false,
              'ISOLATED',
              true,
            );
            const appear = (params as any).appear !== false; // default to true
            const timeoutMs = Math.max(
              0,
              Math.min(((params as any).timeout as number) || 10000, 120000),
            );
            const resp = await this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.WAIT_FOR_TEXT,
              text: (params as any).text,
              appear,
              timeout: timeoutMs,
            });
            if (!resp || resp.success !== true) {
              return createErrorResponse(
                resp && resp.reason === 'timeout'
                  ? `wait_for timed out after ${timeoutMs}ms for text: ${(params as any).text}`
                  : `wait_for failed: ${resp && resp.error ? resp.error : 'unknown error'}`,
              );
            }
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    action: 'wait_for',
                    appear,
                    text: (params as any).text,
                    matched: resp.matched || null,
                    tookMs: resp.tookMs,
                  }),
                },
              ],
              isError: false,
            };
          } catch (e) {
            return createErrorResponse(
              `wait_for failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        } else {
          const seconds = Math.max(0, Math.min((params as any).duration || 0, 30));
          if (!seconds)
            return createErrorResponse('Duration parameter is required and must be > 0');
          await new Promise((r) => setTimeout(r, seconds * 1000));
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, action: 'wait', duration: seconds }),
              },
            ],
            isError: false,
          };
        }
      }
      case 'scroll_to': {
        if (!params.ref) {
          return createErrorResponse('ref is required for scroll_to action');
        }
        try {
          const target = resolveRefTarget(params.ref, params.frameId);
          await this.injectTreeHelper(tab.id, target.frameId);
          const resp = await this.sendMessageToTab(
            tab.id,
            {
              action: 'focusByRef',
              ref: target.ref,
            },
            target.frameId,
          );
          if (!resp || resp.success !== true) {
            return createErrorResponse(resp?.error || 'scroll_to failed: element not found');
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'scroll_to',
                  ref: params.ref,
                }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          return createErrorResponse(
            `scroll_to failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      case 'zoom': {
        const region = params.region;
        if (!region) {
          return createErrorResponse('region is required for zoom action');
        }
        const x0 = Number(region.x0);
        const y0 = Number(region.y0);
        const x1 = Number(region.x1);
        const y1 = Number(region.y1);
        if (![x0, y0, x1, y1].every(Number.isFinite)) {
          return createErrorResponse('region must contain finite numbers (x0, y0, x1, y1)');
        }
        if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) {
          return createErrorResponse('Invalid region: require x0>=0, y0>=0 and x1>x0, y1>y0');
        }

        // Project coordinates from screenshot space to viewport space
        const p0 = project({ x: x0, y: y0 })!;
        const p1 = project({ x: x1, y: y1 })!;
        const rx0 = Math.min(p0.x, p1.x);
        const ry0 = Math.min(p0.y, p1.y);
        const rx1 = Math.max(p0.x, p1.x);
        const ry1 = Math.max(p0.y, p1.y);
        const w = rx1 - rx0;
        const h = ry1 - ry0;
        if (w <= 0 || h <= 0) {
          return createErrorResponse('Invalid region after projection');
        }

        // Security check: verify domain hasn't changed since last screenshot
        {
          const getHostname = (url: string): string => {
            try {
              return new URL(url).hostname;
            } catch {
              return '';
            }
          };
          const ctx = screenshotContextManager.getContext(tab.id!);
          const contextHostname = (ctx as any)?.hostname as string | undefined;
          const currentHostname = getHostname(tab.url || '');
          if (contextHostname && contextHostname !== currentHostname) {
            return createErrorResponse(
              `Security check failed: Domain changed since last screenshot (from ${contextHostname} to ${currentHostname}) during zoom. Capture a new screenshot first.`,
            );
          }
        }

        try {
          await CDPHelper.attach(tab.id);
          const metrics: any = await CDPHelper.send(tab.id, 'Page.getLayoutMetrics', {});
          const viewport = metrics?.layoutViewport ||
            metrics?.visualViewport || {
              clientWidth: 800,
              clientHeight: 600,
              pageX: 0,
              pageY: 0,
            };
          const vw = Math.round(Number(viewport.clientWidth || 800));
          const vh = Math.round(Number(viewport.clientHeight || 600));
          if (rx1 > vw || ry1 > vh) {
            await CDPHelper.detach(tab.id);
            return createErrorResponse(
              `Region exceeds viewport boundaries (${vw}x${vh}). Choose a region within the visible viewport.`,
            );
          }
          const pageX = Number(viewport.pageX || 0);
          const pageY = Number(viewport.pageY || 0);

          const shot: any = await CDPHelper.send(tab.id, 'Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: false,
            fromSurface: true,
            clip: {
              x: pageX + rx0,
              y: pageY + ry0,
              width: w,
              height: h,
              scale: 1,
            },
          });
          await CDPHelper.detach(tab.id);

          const base64Data = String(shot?.data || '');
          if (!base64Data) {
            return createErrorResponse('Failed to capture zoom screenshot via CDP');
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'zoom',
                  mimeType: 'image/png',
                  base64Data,
                  region: { x0: rx0, y0: ry0, x1: rx1, y1: ry1 },
                }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          await CDPHelper.detach(tab.id);
          return createErrorResponse(`zoom failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      case 'screenshot': {
        // Reuse existing screenshot tool; it already supports base64 save option
        const result = await screenshotTool.execute({
          name: 'computer',
          storeBase64: true,
          fullPage: false,
        });
        return result;
      }
      default:
        return createErrorResponse(`Unsupported action: ${params.action}`);
    }
  }

  /**
   * DOM-based hover fallback when CDP is unavailable
   * Tries ref-based approach first (works with iframes), falls back to coordinates
   */
  private async domHoverFallback(
    tabId: number,
    coord?: Coordinates,
    resolvedBy?: 'ref' | 'selector' | 'coordinates',
    ref?: string,
  ): Promise<ToolResult> {
    // Try ref-based approach first (handles iframes correctly)
    if (ref) {
      try {
        const resp = await this.sendMessageToTab(tabId, {
          action: TOOL_MESSAGE_TYPES.DISPATCH_HOVER_FOR_REF,
          ref,
        });
        if (resp?.success) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'hover',
                  resolvedBy: 'ref',
                  transport: 'dom-ref',
                  target: resp.target,
                  note: 'DOM hover does not trigger CSS :hover',
                }),
              },
            ],
            isError: false,
          };
        }
      } catch (error) {
        console.warn('[ComputerTool] DOM ref hover failed, falling back to coordinates', error);
      }
    }

    // Fallback to coordinate-based approach
    if (!coord) {
      return createErrorResponse('Hover fallback requires coordinates or ref');
    }

    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (point) => {
          const target = document.elementFromPoint(point.x, point.y);
          if (!target) {
            return { success: false, error: 'No element found at coordinates' };
          }

          // Dispatch hover-related events
          for (const type of ['mousemove', 'mouseover', 'mouseenter']) {
            target.dispatchEvent(
              new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                clientX: point.x,
                clientY: point.y,
                view: window,
              }),
            );
          }

          return {
            success: true,
            target: {
              tagName: target.tagName,
              id: target.id,
              className: target.className,
              text: target.textContent?.trim()?.slice(0, 100) || '',
            },
          };
        },
        args: [coord],
      });

      const payload = injection?.result;
      if (!payload?.success) {
        return createErrorResponse(payload?.error || 'DOM hover fallback failed');
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              action: 'hover',
              coordinates: coord,
              resolvedBy,
              transport: 'dom',
              target: payload.target,
              note: 'DOM hover does not trigger CSS :hover',
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `DOM hover fallback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Trigger GIF auto-capture after a successful action.
   * This is a no-op if auto-capture is not active.
   */
  private async triggerAutoCapture(
    tabId: number,
    actionType: ActionType,
    metadata?: Partial<ActionMetadata>,
  ): Promise<void> {
    if (!isAutoCaptureActive(tabId)) {
      return;
    }

    try {
      await captureFrameOnAction(tabId, {
        type: actionType,
        ...metadata,
      });
    } catch (error) {
      // Log but don't fail the main action
      console.warn('[ComputerTool] Auto-capture failed:', error);
    }
  }
}

export const computerTool = new ComputerTool();
