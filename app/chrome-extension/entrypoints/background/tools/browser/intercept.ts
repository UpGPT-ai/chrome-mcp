import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { ERROR_MESSAGES } from '@/common/constants';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  TOOL_NAMES,
  fetchEnablePatterns,
  highRiskDisabledError,
  matchInterceptRule,
  mergeHeaders,
  mockResponseHeaders,
  parseInterceptRule,
  recordInterceptHit,
  type InterceptHeader,
  type InterceptHit,
  type ParsedInterceptRule,
} from 'chrome-mcp-shared';
import { readHighRiskFlags } from './high-risk';

/**
 * chrome_intercept — in-memory CDP Fetch rules for one tab.
 * Uses the shared debugger session (owner "intercept") so chrome_network_capture
 * can stay attached. Unmatched pauses are continued, or the page hangs.
 * Rules are dropped on tab close or debugger detach.
 * The tool stays off until highRiskTools.intercept is true.
 */

const OWNER = 'intercept';

interface StoredRule extends ParsedInterceptRule {
  id: string;
  hitCount: number;
  hits: InterceptHit[];
}

interface InterceptSession {
  rules: StoredRule[];
  attached: boolean;
  released: boolean;
  nextId: number;
}

interface PausedRequest {
  requestId: string;
  url: string;
  method: string;
  headers: InterceptHeader[];
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function viewRule(rule: StoredRule): Record<string, unknown> {
  return {
    ruleId: rule.id,
    urlPattern: rule.urlPattern,
    method: rule.method,
    action: rule.action,
    status: rule.status,
    headers: rule.headers,
    body: rule.body,
    contentType: rule.contentType,
    hitCount: rule.hitCount,
    hits: rule.hits.slice(),
  };
}

function pausedRequest(params: unknown): PausedRequest | null {
  if (!params || typeof params !== 'object') return null;
  const raw = params as {
    requestId?: unknown;
    request?: { url?: unknown; method?: unknown; headers?: unknown };
  };
  if (typeof raw.requestId !== 'string' || !raw.requestId) return null;
  return {
    requestId: raw.requestId,
    url: typeof raw.request?.url === 'string' ? raw.request.url : '',
    method: typeof raw.request?.method === 'string' ? raw.request.method : '',
    headers: cdpHeaders(raw.request?.headers),
  };
}

function cdpHeaders(value: unknown): InterceptHeader[] {
  if (!Array.isArray(value)) return [];
  const headers: InterceptHeader[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const name = (entry as { name?: unknown }).name;
    const headerValue = (entry as { value?: unknown }).value;
    if (typeof name !== 'string' || typeof headerValue !== 'string') continue;
    headers.push({ name, value: headerValue });
  }
  return headers;
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

class InterceptTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.INTERCEPT;
  private tabs = new Map<number, InterceptSession>();
  /** Tabs whose debugger session we still own. Avoids a one-shot reattach. */
  private connected = new Set<number>();
  private chains = new Map<number, Promise<void>>();
  private static instance: InterceptTool | null = null;

  constructor() {
    super();
    if (InterceptTool.instance) return InterceptTool.instance;
    InterceptTool.instance = this;
    chrome.debugger.onEvent.addListener(this.onEvent);
    chrome.debugger.onDetach.addListener(this.onDetach);
    chrome.tabs.onRemoved.addListener(this.onTabRemoved);
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const flags = await readHighRiskFlags();
    if (!flags.intercept) return createErrorResponse(highRiskDisabledError('intercept'));

    const action = args.action;
    if (
      action !== 'add_rule' &&
      action !== 'list_rules' &&
      action !== 'remove_rule' &&
      action !== 'clear'
    ) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: action must be add_rule, list_rules, remove_rule, or clear`,
      );
    }

    try {
      const tab = await this.resolveTab(args);
      if (!tab.id)
        return createErrorResponse(`${ERROR_MESSAGES.TAB_NOT_FOUND}: Active tab has no ID`);
      const tabId = tab.id;

      if (action === 'list_rules') return ok(this.list(tabId));
      if (action === 'clear') return ok(await this.clear(tabId));
      if (action === 'remove_rule') return await this.remove(tabId, args.ruleId);
      return await this.add(tabId, args.rule);
    } catch (error) {
      return createErrorResponse(`${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: ${errMsg(error)}`);
    }
  }

  private onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object): void => {
    if (method !== 'Fetch.requestPaused' || typeof source.tabId !== 'number') return;
    const tabId = source.tabId;
    void this.handlePaused(tabId, params).catch((error) => {
      console.warn('chrome_intercept paused request failed', error);
    });
  };

  private onDetach = (source: chrome.debugger.Debuggee): void => {
    if (typeof source.tabId !== 'number') return;
    const tabId = source.tabId;
    void this.chain(tabId, async () => {
      const session = this.tabs.get(tabId);
      if (!session) return;
      await this.releaseSession(session, tabId, false);
    });
  };

  private onTabRemoved = (tabId: number): void => {
    void this.chain(tabId, async () => {
      const session = this.tabs.get(tabId);
      if (!session) return;
      await this.releaseSession(session, tabId, false);
    });
  };

  private chain(tabId: number, job: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(tabId) ?? Promise.resolve();
    const next = prev.then(job, job);
    this.chains.set(
      tabId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async resolveTab(args: Record<string, unknown>): Promise<chrome.tabs.Tab> {
    if (args.tabId !== undefined && typeof args.tabId !== 'number') {
      throw new Error('tabId must be a number');
    }
    if (args.windowId !== undefined && typeof args.windowId !== 'number') {
      throw new Error('windowId must be a number');
    }
    if (typeof args.tabId === 'number') {
      const tab = await this.tryGetTab(args.tabId);
      if (!tab?.id) throw new Error(`${ERROR_MESSAGES.TAB_NOT_FOUND}: ${args.tabId}`);
      return tab;
    }
    return this.getActiveTabOrThrowInWindow(
      typeof args.windowId === 'number' ? args.windowId : undefined,
    );
  }

  private list(tabId: number): unknown {
    const session = this.tabs.get(tabId);
    return {
      tabId,
      rules: session ? session.rules.map((rule) => viewRule(rule)) : [],
    };
  }

  private async clear(tabId: number): Promise<unknown> {
    let cleared = 0;
    await this.chain(tabId, async () => {
      const session = this.tabs.get(tabId);
      if (!session) return;
      cleared = session.rules.length;
      await this.releaseSession(session, tabId, true);
    });
    return { tabId, cleared };
  }

  private async remove(tabId: number, ruleId: unknown): Promise<ToolResult> {
    if (typeof ruleId !== 'string' || !ruleId) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ruleId is required`);
    }
    let removed = false;
    await this.chain(tabId, async () => {
      const session = this.tabs.get(tabId);
      if (!session) return;
      const next = session.rules.filter((rule) => rule.id !== ruleId);
      if (next.length === session.rules.length) return;
      session.rules = next;
      removed = true;
      if (session.rules.length === 0) await this.releaseSession(session, tabId, true);
      else await this.enable(tabId, session);
    });
    if (!removed) return createErrorResponse(`Rule not found: ${ruleId}`);
    return ok({ tabId, removed: ruleId });
  }

  private async add(tabId: number, rule: unknown): Promise<ToolResult> {
    const parsed = parseInterceptRule(rule);
    if ('error' in parsed) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${parsed.error}`);
    }
    const created: { rule?: StoredRule } = {};
    await this.chain(tabId, async () => {
      created.rule = await this.addRule(tabId, parsed);
    });
    if (!created.rule) {
      return createErrorResponse(`${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: rule was not added`);
    }
    return ok({ tabId, rule: viewRule(created.rule) });
  }

  private async addRule(tabId: number, rule: ParsedInterceptRule): Promise<StoredRule> {
    let session = this.tabs.get(tabId);
    if (!session || session.released) {
      session = { rules: [], attached: false, released: false, nextId: 1 };
      this.tabs.set(tabId, session);
      try {
        await cdpSessionManager.attach(tabId, OWNER);
        session.attached = true;
        this.connected.add(tabId);
      } catch (error) {
        if (this.tabs.get(tabId) === session) this.tabs.delete(tabId);
        throw error;
      }
    }

    const stored: StoredRule = {
      ...rule,
      id: `ir_${tabId}_${session.nextId}`,
      hitCount: 0,
      hits: [],
    };
    session.nextId += 1;
    session.rules.push(stored);
    try {
      await this.enable(tabId, session);
    } catch (error) {
      session.rules = session.rules.filter((item) => item.id !== stored.id);
      if (session.rules.length === 0 && !session.released) {
        await this.releaseSession(session, tabId, true);
      }
      throw error;
    }
    return stored;
  }

  private async enable(tabId: number, session: InterceptSession): Promise<void> {
    await cdpSessionManager.sendCommand(tabId, 'Fetch.enable', {
      patterns: fetchEnablePatterns(session.rules),
      handleAuthRequests: false,
    });
  }

  /**
   * Fetch.disable before dropping our debugger owner. If network capture still
   * holds the session, detach only releases this owner and leaves the debugger up.
   * External detach skips Fetch.disable so sendCommand cannot attach again.
   */
  private async releaseSession(
    session: InterceptSession,
    tabId: number,
    disableFetch: boolean,
  ): Promise<void> {
    if (session.released) return;
    session.released = true;
    if (this.tabs.get(tabId) === session) this.tabs.delete(tabId);
    try {
      if (disableFetch && session.attached && this.connected.has(tabId)) {
        try {
          await cdpSessionManager.sendCommand(tabId, 'Fetch.disable');
        } catch {
          /* The debugger is already gone. */
        }
      }
      if (session.attached) {
        try {
          await cdpSessionManager.detach(tabId, OWNER);
        } catch {
          /* Already detached. */
        }
      }
    } finally {
      this.connected.delete(tabId);
    }
  }

  private async handlePaused(tabId: number, params: unknown): Promise<void> {
    const paused = pausedRequest(params);
    if (!paused || !this.connected.has(tabId)) return;
    const session = this.tabs.get(tabId);
    const rule =
      session && !session.released
        ? matchInterceptRule(session.rules, { url: paused.url, method: paused.method })
        : null;
    if (!rule) {
      await this.safeCommand(tabId, 'Fetch.continueRequest', { requestId: paused.requestId });
      return;
    }
    const applied = await this.applyRule(tabId, paused, rule);
    this.noteHit(tabId, rule.id, {
      url: paused.url,
      method: paused.method,
      ts: Date.now(),
      applied,
    });
  }

  private async applyRule(
    tabId: number,
    paused: PausedRequest,
    rule: StoredRule,
  ): Promise<boolean> {
    try {
      if (rule.action === 'block') {
        await cdpSessionManager.sendCommand(tabId, 'Fetch.failRequest', {
          requestId: paused.requestId,
          errorReason: 'BlockedByClient',
        });
        return true;
      }
      if (rule.action === 'mock') {
        const payload: {
          requestId: string;
          responseCode: number;
          responseHeaders: InterceptHeader[];
          body?: string;
        } = {
          requestId: paused.requestId,
          responseCode: rule.status ?? 200,
          responseHeaders: mockResponseHeaders(rule),
        };
        if (rule.body !== undefined) payload.body = utf8ToBase64(rule.body);
        await cdpSessionManager.sendCommand(tabId, 'Fetch.fulfillRequest', payload);
        return true;
      }
      const command: { requestId: string; headers?: InterceptHeader[] } = {
        requestId: paused.requestId,
      };
      if (rule.headers.length > 0) command.headers = mergeHeaders(paused.headers, rule.headers);
      await cdpSessionManager.sendCommand(tabId, 'Fetch.continueRequest', command);
      return true;
    } catch (error) {
      console.warn('chrome_intercept failed to apply a rule', error);
      await this.safeCommand(tabId, 'Fetch.continueRequest', { requestId: paused.requestId });
      return false;
    }
  }

  private noteHit(tabId: number, ruleId: string, hit: InterceptHit): void {
    const session = this.tabs.get(tabId);
    if (!session || session.released) return;
    const rule = session.rules.find((item) => item.id === ruleId);
    if (!rule) return;
    rule.hitCount += 1;
    rule.hits = recordInterceptHit(rule.hits, hit);
  }

  private async safeCommand(tabId: number, method: string, params: object): Promise<void> {
    if (!this.connected.has(tabId)) return;
    try {
      await cdpSessionManager.sendCommand(tabId, method, params);
    } catch (error) {
      console.warn(`chrome_intercept ${method} failed`, error);
    }
  }
}

export const interceptTool = new InterceptTool();
