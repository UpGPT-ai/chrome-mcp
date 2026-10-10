import type { ToolResult } from '@/common/tool-handler';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  OBSERVE_DIFF_MAX_CHARS,
  SNAPSHOT_DEFAULT_MAX_CHARS,
  SNAPSHOT_DEFAULT_MAX_ITEMS,
  SNAPSHOT_DEFAULT_NAME_CHARS,
  buildObserveDiff,
  originFromUrl,
  paginateSnapshot,
  wrapPageLines,
  capObserveDiffChars,
  newStringEntries,
  type ObserveDiff,
  type ObserveRequest,
} from 'chrome-mcp-shared';
import { consoleBuffer } from './console-buffer';
import { snapshotTool, type SnapshotQuery } from './snapshot';

/**
 * Action-then-diff support for click, fill, and computer.
 * Snapshot diffing is pure (packages/shared). This file only collects
 * browser facts: DOM lines, url/title, webRequest hits, console errors, dialogs.
 */

const OBSERVE_SNAPSHOT: SnapshotQuery = {
  scope: 'page',
  filter: 'all',
  maxItems: 800,
  maxChars: 200000,
  maxNameChars: 120,
  offset: 0,
  collapseRepeats: false,
  includeImages: false,
};

interface RequestHit {
  tabId: number;
  method: string;
  url: string;
  status: number;
  timeStamp: number;
}

const requestHits: RequestHit[] = [];
let requestListeners = 0;

function onRequestCompleted(details: chrome.webRequest.WebResponseCacheDetails): void {
  if (typeof details.tabId !== 'number' || details.tabId < 0) return;
  requestHits.push({
    tabId: details.tabId,
    method: details.method || 'GET',
    url: details.url || '',
    status: typeof details.statusCode === 'number' ? details.statusCode : 0,
    timeStamp: typeof details.timeStamp === 'number' ? details.timeStamp : Date.now(),
  });
  if (requestHits.length > 1000) requestHits.splice(0, requestHits.length - 1000);
}

function beginRequestTap(tabId: number): () => ObserveRequest[] {
  const start = Date.now();
  let armed = false;
  try {
    if (requestListeners === 0) {
      chrome.webRequest.onCompleted.addListener(onRequestCompleted, { urls: ['<all_urls>'] });
    }
    requestListeners++;
    armed = true;
  } catch (error) {
    console.warn('observe webRequest tap failed:', error);
  }
  return () => {
    if (armed) {
      requestListeners = Math.max(0, requestListeners - 1);
      if (requestListeners === 0) {
        try {
          chrome.webRequest.onCompleted.removeListener(onRequestCompleted);
        } catch {
          /* already removed */
        }
      }
    }
    return requestHits
      .filter((hit) => hit.tabId === tabId && hit.timeStamp >= start - 5)
      .map((hit) => ({ method: hit.method, url: hit.url, status: hit.status }));
  };
}

async function beginDialogWatch(tabId: number): Promise<() => Promise<boolean>> {
  let opened = false;
  const listener = (source: chrome.debugger.Debuggee, method: string) => {
    if (source.tabId === tabId && method === 'Page.javascriptDialogOpening') opened = true;
  };
  try {
    await cdpSessionManager.attach(tabId, 'observe-dialog');
    await cdpSessionManager.sendCommand(tabId, 'Page.enable');
    chrome.debugger.onEvent.addListener(listener);
  } catch (error) {
    console.warn('observe dialog watch failed:', error);
    return async () => false;
  }
  return async () => {
    try {
      chrome.debugger.onEvent.removeListener(listener);
    } catch {
      /* ignore */
    }
    await cdpSessionManager.detach(tabId, 'observe-dialog').catch(() => {});
    return opened;
  };
}

async function consoleErrorTexts(tabId: number): Promise<string[]> {
  try {
    await consoleBuffer.ensureStarted(tabId);
  } catch (error) {
    console.warn('observe console buffer failed:', error);
    return [];
  }
  const read = consoleBuffer.read(tabId, { onlyErrors: true, includeExceptions: true });
  if (!read) return [];
  return [
    ...read.messages.map((message) => message.text).filter((text) => text.length > 0),
    ...read.exceptions.map((exception) => exception.text).filter((text) => text.length > 0),
  ];
}

async function readTabMeta(tabId: number): Promise<{ url: string; title: string }> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url || '', title: tab.title || '' };
  } catch {
    return { url: '', title: '' };
  }
}

async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (tab.status === 'complete') return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, timeoutMs);
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/** Wait until mutations pause for settleMs, or until a hard cap so a busy page cannot hang the tool. */
async function waitForDomQuiet(tabId: number, settleMs: number): Promise<void> {
  await waitForTabComplete(tabId, Math.min(3000, Math.max(settleMs, 400)));
  const maxWait = Math.min(8000, Math.max(settleMs * 4, settleMs + 200));
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (settle: number, cap: number) => {
        return new Promise((resolve) => {
          const start = Date.now();
          let timer = window.setTimeout(finish, settle);
          const observer = new MutationObserver(() => {
            window.clearTimeout(timer);
            if (Date.now() - start >= cap) {
              finish();
              return;
            }
            timer = window.setTimeout(finish, settle);
          });
          try {
            observer.observe(document.documentElement || document, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
          } catch {
            /* document may be mid-navigation */
          }
          const killer = window.setTimeout(finish, cap);
          function finish() {
            window.clearTimeout(timer);
            window.clearTimeout(killer);
            try {
              observer.disconnect();
            } catch {
              /* ignore */
            }
            resolve(true);
          }
        });
      },
      args: [settleMs, maxWait],
    });
  } catch (error) {
    console.warn('observe DOM quiet wait failed, sleeping instead:', error);
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
}

export interface ObserveSession {
  tabId: number;
  settleMs: number;
  /** observe:'full' also returns a bounded fresh snapshot. */
  full: boolean;
  lines: string[];
  url: string;
  title: string;
  consoleErrors: string[];
  stopRequests: () => ObserveRequest[];
  stopDialog: () => Promise<boolean>;
}

export async function beginObserve(
  tabId: number,
  settleMs: number,
  full = false,
): Promise<ObserveSession> {
  const stopRequests = beginRequestTap(tabId);
  let stopDialog: () => Promise<boolean> = async () => false;
  try {
    const [dialogStop, consoleErrors, snap, meta] = await Promise.all([
      beginDialogWatch(tabId),
      consoleErrorTexts(tabId),
      snapshotTool.capture(tabId, OBSERVE_SNAPSHOT).catch(() => ({
        lines: [] as string[],
        url: '',
        title: '',
        truncated: false,
        omitted: 0,
      })),
      readTabMeta(tabId),
    ]);
    stopDialog = dialogStop;
    return {
      tabId,
      settleMs,
      full,
      lines: snap.lines,
      url: meta.url || snap.url,
      title: meta.title || snap.title,
      consoleErrors,
      stopRequests,
      stopDialog,
    };
  } catch (error) {
    stopRequests();
    await stopDialog().catch(() => {});
    throw error;
  }
}

export async function finishObserve(session: ObserveSession): Promise<ObserveDiff> {
  let requests: ObserveRequest[] = [];
  let dialogOpened = false;
  try {
    await waitForDomQuiet(session.tabId, session.settleMs);
  } finally {
    requests = session.stopRequests();
    try {
      dialogOpened = await session.stopDialog();
    } catch {
      dialogOpened = false;
    }
  }

  const [consoleAfter, snap, meta] = await Promise.all([
    consoleErrorTexts(session.tabId),
    snapshotTool.capture(session.tabId, OBSERVE_SNAPSHOT).catch(() => ({
      lines: [] as string[],
      url: '',
      title: '',
      truncated: false,
      omitted: 0,
    })),
    readTabMeta(session.tabId),
  ]);

  return capObserveDiffChars(
    buildObserveDiff({
      urlBefore: session.url,
      urlAfter: meta.url || snap.url,
      titleBefore: session.title,
      titleAfter: meta.title || snap.title,
      linesBefore: session.lines,
      linesAfter: snap.lines,
      requests,
      consoleErrors: newStringEntries(session.consoleErrors, consoleAfter),
      dialogOpened,
    }),
    OBSERVE_DIFF_MAX_CHARS,
  );
}

export async function attachObserve(
  session: ObserveSession | null,
  result: ToolResult,
): Promise<ToolResult> {
  if (!session) return result;
  try {
    const diff = await finishObserve(session);
    const out = withDiff(result, diff);
    return session.full ? await withFreshSnapshot(out, session.tabId) : out;
  } catch (error) {
    console.warn('observe diff failed:', error);
    return result;
  }
}

export function withDiff(result: ToolResult, diff: ObserveDiff): ToolResult {
  const first = result.content?.[0];
  if (!first || first.type !== 'text') {
    return {
      ...result,
      content: [...(result.content || []), { type: 'text', text: JSON.stringify({ diff }) }],
    };
  }
  try {
    const parsed = JSON.parse(first.text);
    if (parsed && typeof parsed === 'object') {
      (parsed as { diff?: ObserveDiff }).diff = diff;
      return {
        ...result,
        content: [{ type: 'text', text: JSON.stringify(parsed) }, ...result.content.slice(1)],
      };
    }
  } catch {
    /* response was not JSON */
  }
  return {
    ...result,
    content: [...result.content, { type: 'text', text: JSON.stringify({ diff }) }],
  };
}

/**
 * observe:'full' extra: a fresh viewport/interactive snapshot, paginated to the
 * default budget. Page-derived lines are wrapped as untrusted.
 */
async function withFreshSnapshot(result: ToolResult, tabId: number): Promise<ToolResult> {
  try {
    const query: SnapshotQuery = {
      scope: 'viewport',
      filter: 'interactive',
      maxItems: SNAPSHOT_DEFAULT_MAX_ITEMS,
      maxChars: SNAPSHOT_DEFAULT_MAX_CHARS,
      maxNameChars: SNAPSHOT_DEFAULT_NAME_CHARS,
      offset: 0,
      collapseRepeats: true,
      includeImages: false,
    };
    const captured = await snapshotTool.capture(tabId, query);
    const page = paginateSnapshot(
      captured.lines.map((line, i) => ({ line, group: captured.groups?.[i] || 'page' })),
      {
        offset: 0,
        maxItems: query.maxItems,
        maxChars: query.maxChars,
        extraOmitted: captured.omitted,
        extraGroups: captured.omittedGroups,
      },
    );
    const origin = originFromUrl(captured.url);
    const snapshot = {
      lines: wrapPageLines(origin, page.lines),
      truncated: page.truncated,
      ...(page.truncated ? { remaining: page.remaining, nextCursor: page.nextCursor } : {}),
      ...(captured.hint ? { hint: captured.hint } : {}),
    };
    const first = result.content?.[0];
    if (first && first.type === 'text') {
      const parsed = JSON.parse(first.text);
      if (parsed && typeof parsed === 'object') {
        (parsed as { snapshot?: unknown }).snapshot = snapshot;
        return {
          ...result,
          content: [{ type: 'text', text: JSON.stringify(parsed) }, ...result.content.slice(1)],
        };
      }
    }
    return result;
  } catch (error) {
    console.warn('observe full snapshot failed:', error);
    return result;
  }
}
