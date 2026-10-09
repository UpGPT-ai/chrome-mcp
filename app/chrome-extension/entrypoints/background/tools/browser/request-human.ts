import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { BaseBrowserToolExecutor } from '../base-browser';
import { HANDOFF_BANNER_TEXT, TOOL_NAMES, parseRequestHumanArgs } from 'chrome-mcp-shared';

/**
 * chrome_request_human — banner and optional highlight, then wait for Done.
 * Default on. Does not attach the element-picker click listeners, click the
 * page, or solve a CAPTCHA, passkey, or security-key prompt.
 */

interface HandoffCallResult {
  missing?: boolean;
  highlighted?: boolean;
  banner?: boolean;
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createHandoffWait(
  sessionId: string,
  timeoutMs: number,
): { finished: Promise<boolean>; stop: () => void } {
  let stop = () => {};
  const finished = new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (resumed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(onMessage);
      resolve(resumed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onMessage = (message: { type?: string; sessionId?: string }) => {
      if (!message || message.type !== 'human_handoff_done' || message.sessionId !== sessionId) {
        return;
      }
      finish(true);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    stop = () => finish(false);
  });
  return { finished, stop };
}

class RequestHumanTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.REQUEST_HUMAN;

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseRequestHumanArgs(args);
    if ('error' in parsed) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${parsed.error}`);
    }

    let tab: chrome.tabs.Tab;
    try {
      const explicit = await this.tryGetTab(parsed.tabId);
      tab = explicit || (await this.getActiveTabOrThrowInWindow(parsed.windowId));
    } catch (error) {
      return createErrorResponse(`${ERROR_MESSAGES.TAB_NOT_FOUND}: ${errMsg(error)}`);
    }
    if (!tab.id) {
      return createErrorResponse(`${ERROR_MESSAGES.TAB_NOT_FOUND}: Active tab has no ID`);
    }
    const tabId = tab.id;
    const sessionId = `hh_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const waiter = createHandoffWait(sessionId, parsed.timeoutMs);

    try {
      try {
        await this.ensureFocus(tab, { activate: true, focusWindow: true });
      } catch {
        // The banner can still show when the window cannot be focused.
      }
      await this.injectPicker(tabId);

      const frameId = parsed.frameId;
      const childFrame = typeof frameId === 'number' && frameId !== 0;
      const top = await this.callHandoff(tabId, undefined, {
        sessionId,
        role: childFrame ? 'banner' : 'both',
        ref: childFrame ? undefined : parsed.ref,
        selector: childFrame ? undefined : parsed.selector,
        reason: parsed.reason,
        bannerText: HANDOFF_BANNER_TEXT,
      });
      let highlight = top.highlighted === true;
      if (childFrame) {
        const child = await this.callHandoff(tabId, frameId, {
          sessionId,
          role: 'highlight',
          ref: parsed.ref,
          selector: parsed.selector,
        });
        highlight = child.highlighted === true;
      }
      if (top.banner !== true) {
        throw new Error('The Waiting for you banner did not appear. Reload the tab and retry.');
      }

      const resumed = await waiter.finished;
      return ok({ resumed, highlight });
    } catch (error) {
      return createErrorResponse(`${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: ${errMsg(error)}`);
    } finally {
      waiter.stop();
      await this.stopHandoff(tabId, sessionId);
    }
  }

  private async injectPicker(tabId: number): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['inject-scripts/element-picker.js'],
      world: 'ISOLATED',
    } as any);
  }

  private async callHandoff(
    tabId: number,
    frameId: number | undefined,
    payload: Record<string, unknown>,
  ): Promise<HandoffCallResult> {
    const target: { tabId: number; frameIds?: number[] } = { tabId };
    if (typeof frameId === 'number') target.frameIds = [frameId];
    const results = (await chrome.scripting.executeScript({
      target,
      world: 'ISOLATED',
      func: (data: Record<string, unknown>) => {
        const api = (
          globalThis as unknown as {
            __mcpElementPicker?: {
              startHandoff?: (value: Record<string, unknown>) => HandoffCallResult;
            };
          }
        ).__mcpElementPicker;
        if (!api || typeof api.startHandoff !== 'function') return { missing: true };
        const value = api.startHandoff(data);
        return value && typeof value === 'object' ? value : { missing: true };
      },
      args: [payload],
    } as any)) as Array<{ result?: HandoffCallResult; error?: { message?: string } }>;
    const entry = results?.[0];
    if (entry?.error) {
      throw new Error(entry.error.message || 'Human handoff overlay failed');
    }
    const first = entry?.result;
    if (!first || first.missing) {
      throw new Error(
        'Reload the tab so chrome_request_human can show the Waiting for you banner.',
      );
    }
    return first;
  }

  private async stopHandoff(tabId: number, sessionId: string): Promise<void> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'ISOLATED',
        func: (id: string) => {
          const api = (
            globalThis as unknown as {
              __mcpElementPicker?: { stopHandoff?: (value: { sessionId: string }) => void };
            }
          ).__mcpElementPicker;
          if (api && typeof api.stopHandoff === 'function') api.stopHandoff({ sessionId: id });
        },
        args: [sessionId],
      } as any);
    } catch {
      // The banner is removed on the next successful handoff if this frame is gone.
    }
  }
}

export const requestHumanTool = new RequestHumanTool();
