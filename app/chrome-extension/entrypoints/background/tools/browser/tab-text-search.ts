import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, evaluateSitePolicy, policyOrigin, wrapUntrusted } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { readSitePolicySettings } from './high-risk';

const MAX_TABS = 40;
const CONCURRENCY = 4;
const ATTEMPTS = 3;
const ACTIVATE_SETTLE_MS = 250;
const RETRY_DELAY_MS = 400;
const MAX_TEXT_CHARS = 300_000;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;
const SNIPPET_RADIUS = 110;
const SNIPPETS_PER_TAB = 2;

interface SearchArgs {
  query?: unknown;
  limit?: unknown;
  windowId?: unknown;
  currentWindowOnly?: unknown;
  activateUnreadable?: unknown;
}

interface Hit {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  score: number;
  matchedTerms: number;
  snippets: string[];
}

function tokenize(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= 2) seen.add(raw);
  }
  return [...seen];
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

function buildSnippets(text: string, lower: string, terms: string[]): string[] {
  const spots: number[] = [];
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at !== -1) spots.push(at);
  }
  spots.sort((a, b) => a - b);
  const out: string[] = [];
  let lastEnd = -1;
  for (const at of spots) {
    if (out.length >= SNIPPETS_PER_TAB) break;
    if (at < lastEnd) continue;
    const start = Math.max(0, at - SNIPPET_RADIUS);
    const end = Math.min(text.length, at + SNIPPET_RADIUS);
    lastEnd = end;
    const piece = text.slice(start, end).replace(/\s+/g, ' ').trim();
    out.push(`${start > 0 ? '…' : ''}${piece}${end < text.length ? '…' : ''}`);
  }
  return out;
}

/**
 * Keyword search across open tabs. Reads each tab's text on demand and keeps
 * nothing afterwards: no index, no model download, no background crawling.
 */
class SearchTabsContentTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT;

  async execute(args: SearchArgs): Promise<ToolResult> {
    const query = typeof args?.query === 'string' ? args.query.trim() : '';
    if (!query) return createErrorResponse('query is required');
    const terms = tokenize(query);
    if (terms.length === 0) return createErrorResponse('query has no searchable words');

    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, typeof args.limit === 'number' ? Math.floor(args.limit) : DEFAULT_LIMIT),
    );

    const policy = await readSitePolicySettings();
    if ('error' in policy) return createErrorResponse(policy.error);

    const query_: chrome.tabs.QueryInfo = {};
    if (typeof args.windowId === 'number') query_.windowId = args.windowId;
    else if (args.currentWindowOnly === true) query_.currentWindow = true;
    const tabs = await chrome.tabs.query(query_);

    let skippedPolicy = 0;
    let sleeping = 0;
    const candidates: chrome.tabs.Tab[] = [];
    for (const tab of tabs) {
      if (tab.id == null || !tab.url) continue;
      const decision = evaluateSitePolicy({
        url: tab.url,
        allow: policy.allow,
        deny: policy.deny,
        mode: policy.mode,
      });
      if ('error' in decision) {
        skippedPolicy += 1;
        continue;
      }
      if (tab.discarded) {
        sleeping += 1; // never wake a sleeping tab just to search it
        continue;
      }
      candidates.push(tab);
    }
    const searched = candidates.slice(0, MAX_TABS);
    const truncated = candidates.length > searched.length;

    const reasons = new Map<string, number>();
    const noteReason = (message: string): void => {
      const key = message.replace(/\d{4,}/g, 'N').slice(0, 260);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    };

    const failures = new Map<number, { tab: chrome.tabs.Tab; message: string }>();
    const phrase = query.toLowerCase();
    const hits: Hit[] = [];
    const readTab = async (tab: chrome.tabs.Tab, attempt = 1): Promise<void> => {
      const tabId = tab.id as number;
      try {
        await this.injectContentScript(tabId, ['inject-scripts/web-fetcher-helper.js']);
        const response = await this.sendMessageToTab(tabId, {
          action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT,
        });
        if (!response?.success || typeof response.textContent !== 'string') {
          throw new Error(String(response?.error || 'no text returned'));
        }
        const text: string = response.textContent.slice(0, MAX_TEXT_CHARS);
        const lower = text.toLowerCase();
        const title = (tab.title || '').toLowerCase();

        let score = 0;
        let matched = 0;
        for (const term of terms) {
          const inBody = countOccurrences(lower, term);
          const inTitle = title.includes(term) ? 1 : 0;
          if (inBody > 0 || inTitle > 0) matched += 1;
          score += Math.log2(1 + inBody) + inTitle * 4;
        }
        if (matched === 0) return;
        score *= matched / terms.length;
        if (terms.length > 1 && lower.includes(phrase)) score += 5;

        hits.push({
          tabId,
          windowId: tab.windowId,
          url: tab.url as string,
          title: tab.title || '',
          score: Math.round(score * 100) / 100,
          matchedTerms: matched,
          snippets: buildSnippets(text, lower, terms),
        });
      } catch (error) {
        if (attempt < ATTEMPTS) {
          // Background tabs Chrome has frozen often reject the first injection and
          // accept the next one; give them a moment and try again.
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          return readTab(tab, attempt + 1);
        }
        failures.set(tabId, {
          tab,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    // Bounded concurrency: injecting into dozens of tabs at once makes Chrome reject
    // most of them with a misleading host-permission error.
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < searched.length) await readTab(searched[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, searched.length) }, worker));

    // Chrome grants this extension a background tab's content only after the tab has
    // been visited. Visit each unreadable tab once, read it, then put the user's
    // original active tab back in every window we touched.
    let activated = 0;
    if (args.activateUnreadable !== false && failures.size > 0) {
      const originalActive = new Map<number, number>();
      for (const tab of tabs) {
        if (tab.active && tab.id != null) originalActive.set(tab.windowId, tab.id);
      }
      const touched = new Set<number>();
      for (const [tabId, { tab }] of [...failures]) {
        try {
          await chrome.tabs.update(tabId, { active: true });
          touched.add(tab.windowId);
          activated += 1;
          await new Promise((resolve) => setTimeout(resolve, ACTIVATE_SETTLE_MS));
          failures.delete(tabId);
          await readTab(tab);
        } catch (error) {
          failures.set(tabId, {
            tab,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      for (const windowId of touched) {
        const back = originalActive.get(windowId);
        if (back != null) await chrome.tabs.update(back, { active: true }).catch(() => undefined);
      }
    }
    const failedReads = failures.size;
    for (const { message } of failures.values()) noteReason(message);

    hits.sort((a, b) => b.score - a.score);
    const results = hits.slice(0, limit).map((hit) => {
      const origin = policyOrigin(hit.url);
      return {
        tabId: hit.tabId,
        windowId: hit.windowId,
        url: hit.url,
        title: wrapUntrusted(origin, hit.title),
        score: hit.score,
        matchedTerms: hit.matchedTerms,
        snippets: hit.snippets.map((s) => wrapUntrusted(origin, s)),
      };
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            query,
            tabsSearched: searched.length - failedReads,
            tabsSkippedByPolicy: skippedPolicy,
            tabsUnreadable: failedReads,
            tabsAsleep: sleeping,
            tabsActivated: activated,
            unreadableTabs: [...failures.entries()]
              .slice(0, 50)
              .map(([id, f]) => `${id} ${(f.tab.url || '').slice(0, 60)}`),
            unreadableReasons: Object.fromEntries(reasons),
            truncated,
            totalMatches: hits.length,
            results,
          }),
        },
      ],
      isError: false,
    };
  }
}

export const searchTabsContentTool = new SearchTabsContentTool();
