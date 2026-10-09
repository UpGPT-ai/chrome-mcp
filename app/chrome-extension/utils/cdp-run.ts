import { devToolsAttachedMessage, isDebuggerAttachedError } from 'chrome-mcp-shared';
import { cdpSessionManager } from './cdp-session-manager';

/**
 * One attach / run / detach path for chrome.debugger tools.
 * Fails clearly when DevTools or another extension already owns the tab.
 * `send` may target a child session while this manager session stays attached.
 */

export type CdpSend = <T = any>(method: string, params?: object, sessionId?: string) => Promise<T>;

export interface CdpRun {
  send: CdpSend;
  tabId: number;
}

export async function runWithDebugger<T>(
  tabId: number,
  owner: string,
  fn: (run: CdpRun) => Promise<T>,
): Promise<T> {
  try {
    return await cdpSessionManager.withSession(tabId, owner, async () => {
      const send: CdpSend = (method, params, sessionId) => {
        const target: chrome.debugger.DebuggerSession = sessionId
          ? { tabId, sessionId }
          : { tabId };
        return chrome.debugger.sendCommand(target, method, params) as Promise<any>;
      };
      return fn({ send, tabId });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isDebuggerAttachedError(message) && !message.includes('Close DevTools')) {
      throw new Error(devToolsAttachedMessage(tabId));
    }
    throw error instanceof Error ? error : new Error(message);
  }
}
