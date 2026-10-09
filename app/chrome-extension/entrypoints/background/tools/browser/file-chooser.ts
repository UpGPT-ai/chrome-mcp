import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  TOOL_NAMES,
  filesForChooserMode,
  parseCdpRef,
  parseFileChooserArgs,
  validateChooserPaths,
  viewportPointFromQuad,
  type LayoutViewportBox,
} from 'chrome-mcp-shared';
import { runWithDebugger, type CdpSend } from '@/utils/cdp-run';
import { readFileAllowDirs } from './high-risk';
import { resolveRefTarget } from './interaction';

/**
 * chrome_file_chooser — intercept the file dialog, click the control, set files.
 * Default on. Absolute paths are required. fileChooserAllowDirs narrows them
 * once that storage key is set. The click is a CDP mouse event, not a synthetic one.
 */

const ATTACH_WAIT_MS = 150;

interface ChooserOpened {
  backendNodeId: number;
  mode?: string;
  sessionId?: string;
}

interface BoxModel {
  model?: { border?: number[]; content?: number[] };
}

interface LayoutMetrics {
  cssVisualViewport?: LayoutViewportBox;
  cssLayoutViewport?: LayoutViewportBox;
  layoutViewport?: LayoutViewportBox;
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs in the isolated world. Must not close over extension state. */
function locateClickTarget(
  ref: string | null,
  selector: string | null,
): { x: number; y: number } | { error: string } {
  const host = window as unknown as {
    __claudeElementMap?: Record<string, { deref?: () => Element | undefined }>;
  };
  let element: Element | null = null;
  if (ref) {
    const held = host.__claudeElementMap?.[ref];
    element = held && typeof held.deref === 'function' ? held.deref() || null : null;
    if (!element) {
      return {
        error: `ref ${ref} was not found. Take a chrome_snapshot in this frame and retry.`,
      };
    }
  }
  if (!element && selector) {
    try {
      element = document.querySelector(selector);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `selector is invalid: ${message}` };
    }
    if (!element) return { error: `selector not found: ${selector}` };
  }
  if (!element) return { error: 'no element to click' };
  if (element instanceof HTMLElement && element.scrollIntoView) {
    element.scrollIntoView({ block: 'center', inline: 'center' });
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return {
      error: 'element has no layout box to click. Pass the visible control, not a hidden input.',
    };
  }
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  let view: Window = window;
  while (view !== view.top) {
    let frameElement: Element | null = null;
    try {
      frameElement = view.frameElement;
    } catch {
      frameElement = null;
    }
    if (!frameElement) {
      return {
        error:
          'element is in a cross-origin frame. Use a cdp_ ref from chrome_snapshot with pierce:true.',
      };
    }
    const frameRect = frameElement.getBoundingClientRect();
    x += frameRect.left;
    y += frameRect.top;
    view = view.parent;
  }
  return { x, y };
}

function layoutBox(metrics: LayoutMetrics | undefined): LayoutViewportBox | undefined {
  return metrics?.cssVisualViewport || metrics?.cssLayoutViewport || metrics?.layoutViewport;
}

async function pointForBackendNode(
  send: CdpSend,
  backendNodeId: number,
  sessionId?: string,
): Promise<{ x: number; y: number } | null> {
  try {
    await send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, sessionId);
  } catch {
    // The node can still have a box when scroll is unsupported.
  }
  let box: BoxModel;
  try {
    box = await send<BoxModel>('DOM.getBoxModel', { backendNodeId }, sessionId);
  } catch {
    return null;
  }
  const quad = box?.model?.border || box?.model?.content;
  if (!quad) return null;
  let metrics: LayoutMetrics;
  try {
    metrics = await send<LayoutMetrics>('Page.getLayoutMetrics', {}, sessionId);
  } catch {
    return null;
  }
  const css = layoutBox(metrics);
  if (!css || typeof css.pageX !== 'number' || typeof css.pageY !== 'number') return null;
  const local = viewportPointFromQuad(quad, css.pageX, css.pageY, 'center');
  if (!local) return null;
  if (!sessionId) return local;
  try {
    const tree = await send<{ frameTree?: { frame?: { id?: string } } }>(
      'Page.getFrameTree',
      {},
      sessionId,
    );
    const frameId = tree?.frameTree?.frame?.id;
    if (!frameId) return null;
    const owner = await send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId });
    if (typeof owner?.backendNodeId !== 'number') return null;
    const ownerBox = await send<BoxModel>('DOM.getBoxModel', {
      backendNodeId: owner.backendNodeId,
    });
    const ownerQuad = ownerBox?.model?.border || ownerBox?.model?.content;
    const parentMetrics = await send<LayoutMetrics>('Page.getLayoutMetrics');
    const parent = layoutBox(parentMetrics);
    if (
      !ownerQuad ||
      !parent ||
      typeof parent.pageX !== 'number' ||
      typeof parent.pageY !== 'number'
    ) {
      return null;
    }
    const origin = viewportPointFromQuad(ownerQuad, parent.pageX, parent.pageY, 'origin');
    if (!origin) return null;
    return { x: origin.x + local.x, y: origin.y + local.y };
  } catch {
    return null;
  }
}

class FileChooserTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILE_CHOOSER;

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseFileChooserArgs(args);
    if ('error' in parsed) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${parsed.error}`);
    }
    const allowDirs = await readFileAllowDirs();
    if (allowDirs && 'error' in allowDirs) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${allowDirs.error}`);
    }
    const paths = validateChooserPaths(args.paths, allowDirs);
    if ('error' in paths) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${paths.error}`);
    }

    try {
      const explicit = await this.tryGetTab(parsed.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(parsed.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }
      const result = await this.choose(tab.id, parsed, paths.paths);
      return ok(result);
    } catch (error) {
      return createErrorResponse(`${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: ${errMsg(error)}`);
    }
  }

  private async choose(
    tabId: number,
    parsed: {
      ref?: string;
      selector?: string;
      frameId?: number;
      timeoutMs: number;
    },
    paths: string[],
  ): Promise<unknown> {
    return runWithDebugger(tabId, 'file-chooser', async ({ send }) => {
      const childSessions: string[] = [];
      let opened: ChooserOpened | null = null;
      let waiter: ((event: ChooserOpened) => void) | null = null;
      const listener = (
        source: chrome.debugger.DebuggerSession,
        method: string,
        params?: object,
      ) => {
        if (source.tabId !== tabId) return;
        const body = (params || {}) as {
          sessionId?: string;
          backendNodeId?: number;
          mode?: string;
          targetInfo?: { type?: string };
          waitingForDebugger?: boolean;
        };
        if (method === 'Target.attachedToTarget' && body.sessionId) {
          const type = body.targetInfo?.type;
          if (type && type !== 'iframe') return;
          if (!childSessions.includes(body.sessionId)) childSessions.push(body.sessionId);
          if (body.waitingForDebugger) {
            void send('Runtime.runIfWaitingForDebugger', {}, body.sessionId).catch(() => undefined);
          }
          return;
        }
        if (method !== 'Page.fileChooserOpened' || typeof body.backendNodeId !== 'number') return;
        const event: ChooserOpened = {
          backendNodeId: body.backendNodeId,
          mode: body.mode,
          sessionId: source.sessionId,
        };
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve(event);
        } else {
          opened = event;
        }
      };

      chrome.debugger.onEvent.addListener(listener);
      const enabled: (string | undefined)[] = [];
      try {
        await send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
        await delay(ATTACH_WAIT_MS);
        for (const sessionId of [undefined, ...childSessions]) {
          try {
            await send('Page.enable', {}, sessionId);
            await send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId);
            enabled.push(sessionId);
          } catch (error) {
            if (sessionId === undefined) throw error;
          }
        }

        const point = await this.clickPoint(tabId, send, parsed, childSessions);
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
          buttons: 1,
        });
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button: 'left',
          clickCount: 1,
          buttons: 0,
        });

        const event = await this.waitForOpened(
          parsed.timeoutMs,
          () => opened,
          (next) => {
            waiter = next;
          },
        );
        opened = event;
        const chosen = filesForChooserMode(event.mode, paths);
        await send('DOM.enable', {}, event.sessionId);
        await send(
          'DOM.setFileInputFiles',
          { backendNodeId: event.backendNodeId, files: chosen.files },
          event.sessionId,
        );
        opened = null;
        return {
          success: true,
          files: chosen.files,
          ignored: chosen.ignored,
          mode: event.mode || 'selectSingle',
          backendNodeId: event.backendNodeId,
          ...(parsed.ref ? { ref: parsed.ref } : { selector: parsed.selector }),
          ...(chosen.ignored.length
            ? { message: 'The control accepts one file. Extra paths were ignored.' }
            : {}),
        };
      } catch (error) {
        if (opened) {
          try {
            await send('DOM.enable', {}, opened.sessionId);
            await send(
              'DOM.setFileInputFiles',
              { backendNodeId: opened.backendNodeId, files: [] },
              opened.sessionId,
            );
          } catch {
            // Disabling interception below still releases the dialog.
          }
        }
        throw error;
      } finally {
        for (const sessionId of enabled) {
          try {
            await send('Page.setInterceptFileChooserDialog', { enabled: false }, sessionId);
          } catch {
            // Detach still drops the session.
          }
        }
        try {
          await send('Target.setAutoAttach', {
            autoAttach: false,
            waitForDebuggerOnStart: false,
            flatten: true,
          });
        } catch {
          // The shared helper detaches next.
        }
        chrome.debugger.onEvent.removeListener(listener);
      }
    });
  }

  private waitForOpened(
    timeoutMs: number,
    current: () => ChooserOpened | null,
    arm: (resolve: (event: ChooserOpened) => void) => void,
  ): Promise<ChooserOpened> {
    const existing = current();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        arm(() => undefined);
        reject(
          new Error(
            `File chooser did not open within ${timeoutMs}ms. The click may have missed the control. Interception was turned off.`,
          ),
        );
      }, timeoutMs);
      arm((event) => {
        clearTimeout(timer);
        if (event) resolve(event);
      });
    });
  }

  private async clickPoint(
    tabId: number,
    send: CdpSend,
    parsed: { ref?: string; selector?: string; frameId?: number },
    childSessions: readonly string[],
  ): Promise<{ x: number; y: number }> {
    const cdp = parsed.ref ? parseCdpRef(parsed.ref) : null;
    if (cdp) {
      const main = await pointForBackendNode(send, cdp.backendNodeId);
      if (main) return roundPoint(main);
      for (const sessionId of childSessions) {
        const nested = await pointForBackendNode(send, cdp.backendNodeId, sessionId);
        if (nested) return roundPoint(nested);
      }
      throw new Error(
        `cdp ref ${parsed.ref} has no box. Take a fresh pierce snapshot and pass the visible control.`,
      );
    }

    const target = resolveRefTarget(parsed.ref, parsed.frameId);
    const injected = await chrome.scripting.executeScript({
      target:
        typeof target.frameId === 'number' ? { tabId, frameIds: [target.frameId] } : { tabId },
      world: 'ISOLATED',
      func: locateClickTarget,
      args: [target.ref || null, parsed.selector || null],
    });
    const found = injected?.[0]?.result as { x?: number; y?: number; error?: string } | undefined;
    if (!found || typeof found.x !== 'number' || typeof found.y !== 'number') {
      throw new Error(found?.error || 'Could not find the control to click');
    }
    return roundPoint({ x: found.x, y: found.y });
  }
}

function roundPoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

export const fileChooserTool = new FileChooserTool();
