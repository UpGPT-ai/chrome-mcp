import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { ERROR_MESSAGES } from '@/common/constants';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import {
  TOOL_NAMES,
  evaluateWaitConditions,
  formatWaitTimeout,
  parseAgentRef,
  parseWaitArgs,
  policyOrigin,
  urlMatchesPattern,
  wrapUntrusted,
  type ParsedWait,
  type WaitArgs,
  type WaitConditionName,
  type WaitSignals,
} from 'chrome-mcp-shared';

/**
 * chrome_wait_for — block until any (or every) page condition is met.
 * Text appearance and disappearance go through wait-helper.js.
 * Other conditions are polled, and the pure evaluator decides what is met.
 */

const POLL_MS = 100;

interface WaitToolArgs extends WaitArgs {
  tabId?: number;
  windowId?: number;
}

interface PageWaitState {
  success?: boolean;
  error?: string;
  textFound?: boolean;
  textGoneFound?: boolean;
  selectorFound?: boolean;
  selectorGoneFound?: boolean;
  refConnected?: boolean;
  refGoneConnected?: boolean;
  domQuietForMs?: number;
}

interface NetSession {
  tabId: number;
  lastActivity: number;
}

const netSessions = new Set<NetSession>();
let netListeners = 0;
const NET_FILTER: chrome.webRequest.RequestFilter = { urls: ['<all_urls>'] };

function onNetActivity(details: { tabId?: number }): void {
  if (typeof details.tabId !== 'number' || details.tabId < 0) return;
  const now = Date.now();
  for (const session of netSessions) {
    if (session.tabId === details.tabId) session.lastActivity = now;
  }
}

function removeNetListeners(): void {
  chrome.webRequest.onBeforeRequest.removeListener(
    onNetActivity as (details: chrome.webRequest.WebRequestBodyDetails) => void,
  );
  chrome.webRequest.onCompleted.removeListener(
    onNetActivity as (details: chrome.webRequest.WebResponseCacheDetails) => void,
  );
  chrome.webRequest.onErrorOccurred.removeListener(
    onNetActivity as (details: chrome.webRequest.WebRequestDetails) => void,
  );
}

function beginNetworkWatch(tabId: number): { quietMs: () => number; stop: () => void } {
  const session: NetSession = { tabId, lastActivity: Date.now() };
  netSessions.add(session);
  if (netListeners === 0) {
    try {
      chrome.webRequest.onBeforeRequest.addListener(
        onNetActivity as (details: chrome.webRequest.WebRequestBodyDetails) => void,
        NET_FILTER,
      );
      chrome.webRequest.onCompleted.addListener(
        onNetActivity as (details: chrome.webRequest.WebResponseCacheDetails) => void,
        NET_FILTER,
      );
      chrome.webRequest.onErrorOccurred.addListener(
        onNetActivity as (details: chrome.webRequest.WebRequestDetails) => void,
        NET_FILTER,
      );
    } catch (error) {
      netSessions.delete(session);
      try {
        removeNetListeners();
      } catch {
        /* listener was not added */
      }
      throw error;
    }
    netListeners = 1;
  }
  return {
    quietMs: () => Date.now() - session.lastActivity,
    stop: () => {
      netSessions.delete(session);
      if (netSessions.size === 0 && netListeners) {
        try {
          removeNetListeners();
        } catch {
          /* already removed */
        }
        netListeners = 0;
      }
    },
  };
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

async function originOfTab(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return policyOrigin(tab.url || tab.pendingUrl || '');
  } catch {
    return 'unknown';
  }
}

/** The matched page text is wrapped. Other wait fields stay structured. */
function withMatchedText(
  payload: { met: readonly string[]; waitedMs: number },
  origin: string,
  parsed: ParsedWait,
): Record<string, unknown> {
  const parts: string[] = [];
  if (payload.met.includes('text') && parsed.text) parts.push(parsed.text);
  if (payload.met.includes('textGone') && parsed.textGone) parts.push(parsed.textGone);
  if (parts.length === 0) return { ...payload };
  return { ...payload, match: wrapUntrusted(origin, parts.join('\n')) };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function frameIdsFor(frameId?: number): number[] | undefined {
  return typeof frameId === 'number' ? [frameId] : undefined;
}

/** DOM checks run in one frame: an explicit frameId, or the frame encoded on a ref. */
function resolveDomFrame(parsed: ParsedWait): number | undefined | { error: string } {
  const frames: number[] = [];
  if (typeof parsed.frameId === 'number') frames.push(parsed.frameId);
  for (const ref of [parsed.ref, parsed.refGone]) {
    if (!ref) continue;
    const parsedRef = parseAgentRef(ref);
    if (typeof parsedRef.frameId === 'number') frames.push(parsedRef.frameId);
  }
  const unique = [...new Set(frames)];
  if (unique.length > 1) return { error: 'frameId and ref frame suffixes must match' };
  return unique[0];
}

function needsDom(conditions: readonly WaitConditionName[]): boolean {
  return conditions.some((name) => name !== 'urlMatches' && name !== 'networkIdleMs');
}

function isTextOnly(parsed: ParsedWait): 'text' | 'textGone' | null {
  if (parsed.conditions.length !== 1) return null;
  if (parsed.conditions[0] === 'text' && parsed.text) return 'text';
  if (parsed.conditions[0] === 'textGone' && parsed.textGone) return 'textGone';
  return null;
}

class WaitForTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WAIT_FOR;

  async execute(args: WaitToolArgs): Promise<ToolResult> {
    const parsed = parseWaitArgs(args);
    if ('error' in parsed) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${parsed.error}`);
    }

    const frame = resolveDomFrame(parsed);
    if (typeof frame === 'object') {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${frame.error}`);
    }

    let network: { quietMs: () => number; stop: () => void } | null = null;
    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      const textOnly = isTextOnly(parsed);
      if (textOnly) {
        return await this.waitForText(tab.id, frame, parsed, textOnly);
      }

      if (needsDom(parsed.conditions)) {
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/wait-helper.js'],
          false,
          'ISOLATED',
          false,
          frameIdsFor(frame),
        );
      }
      if (parsed.networkIdleMs !== undefined) network = beginNetworkWatch(tab.id);

      const started = Date.now();
      const deadline = started + parsed.timeoutMs;
      while (true) {
        const signals = await this.collectSignals(tab.id, frame, parsed, network);
        const verdict = evaluateWaitConditions(parsed, signals);
        if (verdict.done) {
          const payload = { met: verdict.met, waitedMs: Date.now() - started };
          if (verdict.met.includes('text') || verdict.met.includes('textGone')) {
            return ok(withMatchedText(payload, await originOfTab(tab.id), parsed));
          }
          return ok(payload);
        }
        if (Date.now() >= deadline) {
          return createErrorResponse(formatWaitTimeout(parsed.timeoutMs, verdict.unmet));
        }
        await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
      }
    } catch (error) {
      return createErrorResponse(`chrome_wait_for failed: ${errMsg(error)}`);
    } finally {
      network?.stop();
    }
  }

  /** Single text condition uses wait-helper's MutationObserver wait. */
  private async waitForText(
    tabId: number,
    frameId: number | undefined,
    parsed: ParsedWait,
    kind: 'text' | 'textGone',
  ): Promise<ToolResult> {
    await this.injectContentScript(
      tabId,
      ['inject-scripts/wait-helper.js'],
      false,
      'ISOLATED',
      false,
      frameIdsFor(frameId),
    );
    const resp = await this.sendMessageToTab(
      tabId,
      {
        action: TOOL_MESSAGE_TYPES.WAIT_FOR_TEXT,
        text: kind === 'text' ? parsed.text : parsed.textGone,
        appear: kind === 'text',
        timeout: parsed.timeoutMs,
      },
      frameId,
    );
    if (resp && resp.success === true) {
      const waitedMs = typeof resp.tookMs === 'number' ? resp.tookMs : parsed.timeoutMs;
      return ok(withMatchedText({ met: [kind], waitedMs }, await originOfTab(tabId), parsed));
    }
    if (resp && resp.reason === 'timeout') {
      return createErrorResponse(formatWaitTimeout(parsed.timeoutMs, [kind]));
    }
    return createErrorResponse(
      `chrome_wait_for failed: ${resp && resp.error ? resp.error : 'unknown error'}`,
    );
  }

  private async collectSignals(
    tabId: number,
    frameId: number | undefined,
    parsed: ParsedWait,
    network: { quietMs: () => number } | null,
  ): Promise<WaitSignals> {
    const signals: WaitSignals = {};
    if (needsDom(parsed.conditions)) {
      const page = (await this.sendMessageToTab(
        tabId,
        {
          action: TOOL_MESSAGE_TYPES.WAIT_CHECK_STATE,
          text: parsed.text,
          textGone: parsed.textGone,
          selector: parsed.selector,
          selectorGone: parsed.selectorGone,
          ref: parsed.ref ? parseAgentRef(parsed.ref).ref : undefined,
          refGone: parsed.refGone ? parseAgentRef(parsed.refGone).ref : undefined,
          trackDomQuiet: parsed.domQuietMs !== undefined,
        },
        frameId,
      )) as PageWaitState;
      if (!page || page.success !== true) {
        throw new Error(
          page?.error || 'wait helper did not return a state. Reload the page and retry.',
        );
      }
      if (parsed.text) signals.textFound = page?.textFound === true;
      if (parsed.textGone) signals.textGoneFound = page?.textGoneFound === true;
      if (parsed.selector) signals.selectorFound = page?.selectorFound === true;
      if (parsed.selectorGone) signals.selectorGoneFound = page?.selectorGoneFound === true;
      if (parsed.ref) signals.refConnected = page?.refConnected === true;
      if (parsed.refGone) signals.refGoneConnected = page?.refGoneConnected === true;
      if (parsed.domQuietMs !== undefined) {
        signals.domQuietForMs = typeof page?.domQuietForMs === 'number' ? page.domQuietForMs : 0;
      }
    }
    if (parsed.urlMatches) {
      let url = '';
      try {
        const tab = await chrome.tabs.get(tabId);
        url = tab.url || tab.pendingUrl || '';
      } catch {
        url = '';
      }
      signals.urlMatched = urlMatchesPattern(url, parsed.urlMatches);
    }
    if (parsed.networkIdleMs !== undefined && network) {
      signals.networkQuietMs = network.quietMs();
    }
    return signals;
  }
}

export const waitForTool = new WaitForTool();
