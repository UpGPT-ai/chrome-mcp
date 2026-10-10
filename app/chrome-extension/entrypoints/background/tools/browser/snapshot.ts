import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  TOOL_NAMES,
  crossOriginFrameLine,
  diffSnapshotLines,
  formatPierceSnapshot,
  frameIsSameOrigin,
  listPierceBackendIds,
  matchFrameSlots,
  paginateSnapshot,
  parseSnapshotBudget,
  capLinesByChars,
  parseAgentRef,
  parseCdpRef,
  pierceBoxBudget,
  pierceFailureAction,
  pierceTreeHasBackendId,
  originFromUrl,
  prefixSnapshotLine,
  quadIntersectsRect,
  wrapPageLines,
  wrapUntrusted,
  unmatchedFrames,
  viewportRectFromLayout,
} from 'chrome-mcp-shared';
import type {
  CdpDomNode,
  FrameRecord,
  FrameSlot,
  LayoutViewportBox,
  SnapshotLineDiff,
  ViewportRect,
} from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { ERROR_MESSAGES } from '@/common/constants';
import { runWithDebugger, type CdpSend } from '@/utils/cdp-run';

/**
 * chrome_snapshot — compact accessibility lines with stable refs.
 * Previous snapshots are kept in memory so `since` can return a diff.
 */

const MAX_SNAPSHOTS_PER_TAB = 30;
const PIERCE_ATTACH_WAIT_MS = 150;

interface LayoutMetricSet {
  cssVisualViewport?: LayoutViewportBox;
  cssLayoutViewport?: LayoutViewportBox;
  layoutViewport?: LayoutViewportBox;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickLayout(metrics: LayoutMetricSet | undefined): LayoutViewportBox | undefined {
  return metrics?.cssVisualViewport || metrics?.cssLayoutViewport || metrics?.layoutViewport;
}

async function sessionViewport(send: CdpSend, sessionId?: string): Promise<ViewportRect | null> {
  try {
    const metrics = await send<LayoutMetricSet>('Page.getLayoutMetrics', {}, sessionId);
    return viewportRectFromLayout(pickLayout(metrics));
  } catch {
    return null;
  }
}

async function frameIntersectsViewport(
  send: CdpSend,
  sessionId: string,
  parentRect: ViewportRect,
): Promise<boolean> {
  try {
    const tree = await send<{ frameTree?: { frame?: { id?: string } } }>(
      'Page.getFrameTree',
      {},
      sessionId,
    );
    const frameId = tree?.frameTree?.frame?.id;
    if (!frameId) return true;
    const owner = await send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId });
    if (typeof owner?.backendNodeId !== 'number') return true;
    const box = await send<{ model?: { border?: number[]; content?: number[] } }>(
      'DOM.getBoxModel',
      { backendNodeId: owner.backendNodeId },
    );
    const quad = box?.model?.border || box?.model?.content;
    if (!quad) return true;
    return quadIntersectsRect(quad, parentRect);
  } catch {
    return true;
  }
}

export interface CapturedSnapshot {
  lines: string[];
  url: string;
  title: string;
  truncated: boolean;
  omitted: number;
  /** Landmark for each line, parallel to `lines`. */
  groups?: string[];
  /** Per-landmark counts of lines dropped at the collection limit. */
  omittedGroups?: Record<string, number>;
  /** Advice when the page is mostly pixels. */
  hint?: string;
}

interface StoredSnapshot extends CapturedSnapshot {
  id: string;
  tabId: number;
}

interface SnapshotParams {
  scope?: 'viewport' | 'page';
  filter?: 'interactive' | 'all';
  refId?: string;
  maxItems?: number;
  maxChars?: number;
  maxNameChars?: number;
  cursor?: number;
  collapseRepeats?: boolean;
  includeImages?: boolean;
  since?: string;
  tabId?: number;
  windowId?: number;
  /** When set, snapshot only this frame (used for cross-origin frameId targeting). */
  frameId?: number;
  /** CDP DOM.getDocument pierce. Omit to keep the accessibility snapshot. */
  includeHidden?: boolean;
  pierce?: boolean;
}

export interface SnapshotQuery {
  scope: 'viewport' | 'page';
  filter: 'interactive' | 'all';
  refId?: string;
  /** Page size. */
  maxItems: number;
  maxChars: number;
  maxNameChars: number;
  /** Line offset to start from. */
  offset: number;
  collapseRepeats: boolean;
  includeImages: boolean;
  frameId?: number;
  includeHidden?: boolean;
  /** chrome_find matching, applied inside the page. */
  find?: { text?: string; role?: string; nearRef?: string };
}

interface LocalFrameSnapshot {
  lines: string[];
  childFrames: FrameSlot[];
  url: string;
  title: string;
  truncated: boolean;
  omitted: number;
  groups: string[];
  omittedGroups: Record<string, number>;
  hint?: string;
}

const snapshotsById = new Map<string, StoredSnapshot>();
const snapshotOrderByTab = new Map<number, string[]>();
let snapshotSeq = 0;

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeSnapshotQuery(
  args: SnapshotParams | undefined,
): SnapshotQuery | { error: string } {
  const scope = args?.scope === undefined ? 'viewport' : args.scope;
  if (scope !== 'page' && scope !== 'viewport') {
    return { error: 'scope must be "viewport" or "page"' };
  }
  const filter = args?.filter === undefined ? 'interactive' : args.filter;
  if (filter !== 'all' && filter !== 'interactive') {
    return { error: 'filter must be "interactive" or "all"' };
  }
  const refId = typeof args?.refId === 'string' ? args.refId.trim() : '';
  if (args?.refId !== undefined && !refId) {
    return { error: 'refId must be a non-empty string' };
  }
  const budget = parseSnapshotBudget(args);
  if ('error' in budget) return budget;
  if (args?.collapseRepeats !== undefined && typeof args.collapseRepeats !== 'boolean') {
    return { error: 'collapseRepeats must be a boolean' };
  }
  if (args?.includeImages !== undefined && typeof args.includeImages !== 'boolean') {
    return { error: 'includeImages must be a boolean' };
  }
  let frameId: number | undefined;
  if (args?.frameId !== undefined) {
    if (!Number.isInteger(args.frameId) || args.frameId < 0) {
      return { error: 'frameId must be a non-negative integer' };
    }
    frameId = args.frameId;
  }
  return {
    scope,
    filter,
    refId: refId || undefined,
    maxItems: budget.maxItems,
    maxChars: budget.maxChars,
    maxNameChars: budget.maxNameChars,
    offset: budget.offset,
    collapseRepeats: args?.collapseRepeats !== false,
    includeImages: args?.includeImages === true,
    frameId,
    includeHidden: args?.includeHidden === true,
  };
}

/** Split one character budget across added, removed, changed (in that order). */
function capDiff(
  diff: SnapshotLineDiff,
  maxChars: number,
): { added: string[]; removed: string[]; changed: string[]; cut: number } {
  let left = maxChars;
  let cut = 0;
  const take = (lines: string[]): string[] => {
    const res = capLinesByChars(lines, Math.max(left, 200));
    const used = res.lines.reduce((acc, line) => acc + line.length + 1, 0);
    left = Math.max(0, left - used);
    cut += res.cut;
    return left === 0 && res.lines.length === 0 ? [] : res.lines;
  };
  const added = take(diff.added);
  const removed = take(diff.removed);
  const changed = take(diff.changed);
  return { added, removed, changed, cut };
}

function rememberSnapshot(tabId: number, captured: CapturedSnapshot): string {
  const id = `snap_${++snapshotSeq}`;
  snapshotsById.set(id, { ...captured, id, tabId });
  const order = snapshotOrderByTab.get(tabId) || [];
  order.push(id);
  while (order.length > MAX_SNAPSHOTS_PER_TAB) {
    const dropped = order.shift();
    if (dropped) snapshotsById.delete(dropped);
  }
  snapshotOrderByTab.set(tabId, order);
  return id;
}

export function lookupSnapshot(snapshotId: string): StoredSnapshot | undefined {
  return snapshotsById.get(snapshotId);
}

/** Drop stored snapshots for a tab. Tests and navigation resets can call this. */
export function clearStoredSnapshots(tabId?: number): void {
  if (typeof tabId !== 'number') {
    snapshotsById.clear();
    snapshotOrderByTab.clear();
    return;
  }
  const order = snapshotOrderByTab.get(tabId) || [];
  for (const id of order) snapshotsById.delete(id);
  snapshotOrderByTab.delete(tabId);
}

export class SnapshotTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SNAPSHOT;

  async execute(args: SnapshotParams): Promise<ToolResult> {
    const query = normalizeSnapshotQuery(args);
    if ('error' in query) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${query.error}`);
    }

    if (args?.pierce !== undefined && typeof args.pierce !== 'boolean') {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: pierce must be a boolean`);
    }
    if (args?.includeHidden !== undefined && typeof args.includeHidden !== 'boolean') {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: includeHidden must be a boolean`,
      );
    }

    const since = typeof args?.since === 'string' ? args.since.trim() : '';
    if (args?.since !== undefined && !since) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: since must be a non-empty snapshotId`,
      );
    }

    try {
      const explicit = await this.tryGetTab(args?.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args?.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      let baseline: StoredSnapshot | undefined;
      if (since) {
        baseline = lookupSnapshot(since);
        if (!baseline) {
          return createErrorResponse(
            `Unknown snapshotId "${since}". Call chrome_snapshot without since to start a new baseline.`,
          );
        }
        if (baseline.tabId !== tab.id) {
          return createErrorResponse(
            `snapshotId "${since}" belongs to a different tab. Take a fresh chrome_snapshot on this tab.`,
          );
        }
      }

      let captured: CapturedSnapshot;
      let pierceUsed = false;
      let pierceFallback: string | undefined;
      if (args?.pierce === true) {
        if (query.refId && !parseCdpRef(query.refId)) {
          return createErrorResponse(
            `${ERROR_MESSAGES.INVALID_PARAMETERS}: pierce refId must be a cdp_N ref from a pierce snapshot`,
          );
        }
        try {
          captured = await this.capturePierce(tab.id, query);
          pierceUsed = true;
        } catch (error) {
          const message = errMsg(error);
          if (pierceFailureAction(message) === 'devtools' || message.includes('was not found')) {
            return createErrorResponse(message);
          }
          try {
            const fallbackQuery =
              query.refId && parseCdpRef(query.refId) ? { ...query, refId: undefined } : query;
            captured = await this.capture(tab.id, fallbackQuery);
            pierceFallback =
              fallbackQuery === query
                ? message
                : `${message} (the cdp ref was not applied on the accessibility fallback)`;
          } catch (fallbackError) {
            return createErrorResponse(
              `Error generating snapshot: ${errMsg(fallbackError)} (pierce: ${message})`,
            );
          }
        }
      } else if (query.refId && parseCdpRef(query.refId)) {
        return createErrorResponse(
          `${ERROR_MESSAGES.INVALID_PARAMETERS}: cdp_ refs need pierce:true`,
        );
      } else {
        captured = await this.capture(tab.id, query);
      }
      const entries = captured.lines.map((line, i) => ({
        line,
        group: captured.groups?.[i] || 'page',
      }));
      const page = paginateSnapshot(entries, {
        offset: query.offset,
        maxItems: query.maxItems,
        maxChars: query.maxChars,
        extraOmitted: captured.omitted,
        extraGroups: captured.omittedGroups,
      });
      const snapshotId = rememberSnapshot(tab.id, {
        ...captured,
        lines: page.lines,
        truncated: page.truncated,
        omitted: page.remaining,
      });
      const pierceFields = pierceUsed
        ? { pierce: true as const }
        : pierceFallback
          ? { pierceFallback }
          : {};

      const origin = originFromUrl(captured.url || tab.url);
      if (baseline) {
        const diff: SnapshotLineDiff = diffSnapshotLines(baseline.lines, page.lines);
        const capped = capDiff(diff, query.maxChars);
        return ok({
          success: true,
          snapshotId,
          since,
          scope: query.scope,
          filter: query.filter,
          url: captured.url,
          title: wrapUntrusted(origin, captured.title),
          truncated: page.truncated || capped.cut > 0,
          ...(page.remaining > 0 ? { remaining: page.remaining } : {}),
          ...(capped.cut > 0 ? { diffLinesCut: capped.cut } : {}),
          added: wrapPageLines(origin, capped.added),
          removed: wrapPageLines(origin, capped.removed),
          changed: wrapPageLines(origin, capped.changed),
          ...pierceFields,
        });
      }

      return ok({
        success: true,
        snapshotId,
        scope: query.scope,
        filter: query.filter,
        url: captured.url,
        title: wrapUntrusted(origin, captured.title),
        count: page.shown,
        truncated: page.truncated,
        ...(page.truncated ? { remaining: page.remaining, nextCursor: page.nextCursor } : {}),
        ...(query.offset > 0 ? { cursor: query.offset } : {}),
        lines: wrapPageLines(origin, page.outline ? [...page.lines, page.outline] : page.lines),
        ...(captured.hint ? { hint: captured.hint } : {}),
        ...pierceFields,
        tips: pierceUsed
          ? 'Pierce refs look like cdp_N and are the CDP backendNodeId. chrome_file_chooser accepts them. chrome_click_element and chrome_fill_or_select still use ref_ refs from a snapshot without pierce. Pass since to diff, or observe:true on an action. Screenshot only if layout matters.'
          : 'Next: act by ref (chrome_click_element, chrome_fill_or_select, or chrome_computer). Pass observe:true to get a diff, or call chrome_snapshot again with since set to this snapshotId. Screenshot only if layout matters.',
      });
    } catch (error) {
      return createErrorResponse(`Error generating snapshot: ${errMsg(error)}`);
    }
  }

  /**
   * Capture the current compact snapshot without storing it.
   * Same-origin iframes are stitched in. Their refs are `ref_N@frameId`.
   * Cross-origin iframes are listed and not entered unless `frameId` targets one
   * and the extension has host access for that URL.
   */
  async capture(tabId: number, query: SnapshotQuery): Promise<CapturedSnapshot> {
    const parsedRef = query.refId ? parseAgentRef(query.refId) : undefined;
    let rootFrame = 0;
    if (typeof query.frameId === 'number') rootFrame = query.frameId;
    else if (parsedRef?.frameId !== undefined) rootFrame = parsedRef.frameId;
    const rootRef =
      parsedRef && (parsedRef.frameId === undefined || parsedRef.frameId === rootFrame)
        ? parsedRef.ref
        : undefined;

    const frames = await this.listFrames(tabId);
    const byParent = new Map<number, FrameRecord[]>();
    for (const frame of frames) {
      const list = byParent.get(frame.parentFrameId) || [];
      list.push(frame);
      byParent.set(frame.parentFrameId, list);
    }

    const lines: string[] = [];
    const groups: string[] = [];
    const omittedGroups: Record<string, number> = {};
    let url = '';
    let title = '';
    let truncated = false;
    let omitted = 0;
    let hint: string | undefined;
    // Collect enough lines to serve this page. Later pages re-collect with a larger offset.
    let budget = query.offset + query.maxItems;
    const visited = new Set<number>();
    const nearRef = query.find?.nearRef ? parseAgentRef(query.find.nearRef) : undefined;
    const nearFrame = nearRef ? (nearRef.frameId ?? 0) : undefined;

    const pushLine = (line: string, group = 'page') => {
      if (budget <= 0) {
        truncated = true;
        omitted++;
        omittedGroups[group] = (omittedGroups[group] || 0) + 1;
        return;
      }
      lines.push(line);
      groups.push(group);
      budget--;
    };

    const walk = async (frameId: number, refId?: string): Promise<void> => {
      if (visited.has(frameId)) return;
      visited.add(frameId);
      // nearRef scopes a find to the frame the ref lives in.
      if (nearFrame !== undefined && frameId !== nearFrame) return;
      let local: LocalFrameSnapshot;
      try {
        local = await this.captureFrame(
          tabId,
          frameId,
          { ...query, maxItems: Math.max(budget, 1) },
          refId,
        );
      } catch (error) {
        if (frameId === rootFrame) throw error;
        pushLine(crossOriginFrameLine('', frameId));
        return;
      }
      if (!url) {
        url = local.url;
        title = local.title;
      }
      if (local.truncated) truncated = true;
      omitted += local.omitted;
      for (const [name, n] of Object.entries(local.omittedGroups)) {
        omittedGroups[name] = (omittedGroups[name] || 0) + n;
      }
      if (!hint && local.hint) hint = local.hint;
      local.lines.forEach((line, i) =>
        pushLine(prefixSnapshotLine(line, frameId), local.groups[i] || 'page'),
      );

      const children = byParent.get(frameId) || [];
      const matched = matchFrameSlots(local.childFrames, children, local.url);
      const used: number[] = [];
      for (const pair of matched) {
        if (pair.frame) used.push(pair.frame.frameId);
        if (pair.slot.sameOrigin && pair.frame) {
          await walk(pair.frame.frameId);
          continue;
        }
        if (!pair.slot.sameOrigin) {
          pushLine(
            crossOriginFrameLine(pair.slot.src || pair.frame?.url || '', pair.frame?.frameId),
          );
        }
      }
      for (const child of unmatchedFrames(children, used)) {
        if (frameIsSameOrigin(local.url, child.url)) await walk(child.frameId);
        else pushLine(crossOriginFrameLine(child.url, child.frameId));
      }
    };

    await walk(nearFrame ?? rootFrame, nearFrame !== undefined ? undefined : rootRef);
    return { lines, groups, omittedGroups, url, title, truncated, omitted, hint };
  }

  private async listFrames(tabId: number): Promise<FrameRecord[]> {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return (frames || []).map((frame) => ({
        frameId: frame.frameId,
        parentFrameId: frame.parentFrameId,
        url: frame.url || '',
      }));
    } catch {
      return [];
    }
  }

  /**
   * CDP snapshot of closed shadow roots and out-of-process frames.
   * Refs are `cdp_<backendNodeId>`. DevTools attached throws. Other CDP
   * failures throw so the caller can fall back to capture().
   */
  private async capturePierce(tabId: number, query: SnapshotQuery): Promise<CapturedSnapshot> {
    const rootBackendNodeId = query.refId ? parseCdpRef(query.refId)?.backendNodeId : undefined;
    return runWithDebugger(tabId, 'snapshot-pierce', async ({ send }) => {
      const childSessions: string[] = [];
      const listener = (
        source: chrome.debugger.DebuggerSession,
        method: string,
        params?: object,
      ) => {
        if (source.tabId !== tabId || method !== 'Target.attachedToTarget') return;
        const body = (params || {}) as {
          sessionId?: string;
          targetInfo?: { type?: string };
          waitingForDebugger?: boolean;
        };
        if (!body.sessionId) return;
        if (body.targetInfo?.type && body.targetInfo.type !== 'iframe') return;
        if (!childSessions.includes(body.sessionId)) childSessions.push(body.sessionId);
        if (body.waitingForDebugger) {
          void send('Runtime.runIfWaitingForDebugger', {}, body.sessionId).catch(() => undefined);
        }
      };
      chrome.debugger.onEvent.addListener(listener);
      try {
        await send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
        await delay(PIERCE_ATTACH_WAIT_MS);
        await send('DOM.enable');
        const documentNode = await send<{ root?: CdpDomNode }>('DOM.getDocument', {
          depth: -1,
          pierce: true,
        });
        if (!documentNode?.root) throw new Error('DOM.getDocument returned no root');

        const docs: { sessionId?: string; root: CdpDomNode }[] = [{ root: documentNode.root }];
        const notes: string[] = [];
        const loadChild = async (sessionId: string) => {
          try {
            await send('DOM.enable', {}, sessionId);
            const child = await send<{ root?: CdpDomNode }>(
              'DOM.getDocument',
              { depth: -1, pierce: true },
              sessionId,
            );
            if (child?.root) docs.push({ sessionId, root: child.root });
            else notes.push('frame (pierce unavailable: empty document)');
          } catch (error) {
            notes.push(`frame (pierce unavailable: ${errMsg(error)})`);
          }
        };
        const first = [...childSessions];
        for (const sessionId of first) await loadChild(sessionId);
        await delay(50);
        for (const sessionId of childSessions) {
          if (!first.includes(sessionId)) await loadChild(sessionId);
        }

        let selected = docs;
        if (rootBackendNodeId !== undefined) {
          const owner = docs.find((doc) => pierceTreeHasBackendId(doc.root, rootBackendNodeId));
          if (!owner) {
            throw new Error(`cdp ref ${query.refId} was not found. Take a fresh pierce snapshot.`);
          }
          selected = [owner];
        }

        const visibleByRoot = new Map<CdpDomNode, Set<number>>();
        let boxCapped = false;
        if (query.scope === 'viewport') {
          const metrics = await send<LayoutMetricSet>('Page.getLayoutMetrics');
          const rect = viewportRectFromLayout(pickLayout(metrics));
          if (!rect) throw new Error('Page.getLayoutMetrics did not return a viewport');
          const budget = pierceBoxBudget(query.maxItems);
          let used = 0;
          for (const doc of selected) {
            if (used >= budget) {
              boxCapped = true;
              break;
            }
            if (doc.sessionId && !(await frameIntersectsViewport(send, doc.sessionId, rect))) {
              visibleByRoot.set(doc.root, new Set());
              continue;
            }
            const listed = listPierceBackendIds(doc.root, {
              filter: query.filter,
              rootBackendNodeId,
              limit: budget - used,
            });
            if (listed.capped) boxCapped = true;
            used += listed.ids.length;
            const childRect = doc.sessionId ? await sessionViewport(send, doc.sessionId) : rect;
            const visibleIds = new Set<number>();
            if (!childRect) {
              for (const id of listed.ids) visibleIds.add(id);
            } else {
              for (const id of listed.ids) {
                try {
                  const box = await send<{ model?: { border?: number[]; content?: number[] } }>(
                    'DOM.getBoxModel',
                    { backendNodeId: id },
                    doc.sessionId,
                  );
                  const quad = box?.model?.border || box?.model?.content;
                  if (quadIntersectsRect(quad, childRect)) visibleIds.add(id);
                } catch {
                  // No box means the node is not in the viewport.
                }
              }
            }
            visibleByRoot.set(doc.root, visibleIds);
          }
        }

        const lines: string[] = [];
        const groups: string[] = [];
        const omittedGroups: Record<string, number> = {};
        let truncated = boxCapped;
        let omitted = 0;
        let remaining = query.offset + query.maxItems;
        for (const doc of selected) {
          const formatted = formatPierceSnapshot(doc.root, {
            filter: query.filter,
            maxItems: remaining,
            maxNameChars: query.maxNameChars,
            inViewport:
              query.scope === 'viewport' ? visibleByRoot.get(doc.root) || new Set() : undefined,
            rootBackendNodeId,
          });
          if (formatted.missingRoot) {
            throw new Error(`cdp ref ${query.refId} was not found. Take a fresh pierce snapshot.`);
          }
          lines.push(...formatted.lines);
          groups.push(...formatted.groups);
          for (const [name, n] of Object.entries(formatted.omittedGroups)) {
            omittedGroups[name] = (omittedGroups[name] || 0) + n;
          }
          remaining -= formatted.lines.length;
          truncated = truncated || formatted.truncated;
          omitted += formatted.omitted;
          if (remaining <= 0) break;
        }
        for (const note of notes) {
          if (remaining <= 0) {
            truncated = true;
            omitted += 1;
            omittedGroups.page = (omittedGroups.page || 0) + 1;
            continue;
          }
          lines.push(note);
          groups.push('page');
          remaining -= 1;
        }

        let url = '';
        let title = '';
        try {
          const tree = await send<{ frameTree?: { frame?: { url?: string } } }>(
            'Page.getFrameTree',
          );
          url = tree?.frameTree?.frame?.url || '';
        } catch {
          url = '';
        }
        try {
          const evaluated = await send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
            expression: 'document.title',
            returnByValue: true,
          });
          title = typeof evaluated?.result?.value === 'string' ? evaluated.result.value : '';
        } catch {
          title = '';
        }
        return { lines, groups, omittedGroups, url, title, truncated, omitted };
      } finally {
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

  /** Run the in-page snapshot in one frame. Host access is required for cross-origin frames. */
  private async captureFrame(
    tabId: number,
    frameId: number,
    query: SnapshotQuery,
    refId?: string,
  ): Promise<LocalFrameSnapshot> {
    await this.injectContentScript(
      tabId,
      ['inject-scripts/accessibility-tree-helper.js'],
      false,
      'ISOLATED',
      false,
      [frameId],
    );
    const resp = await this.sendMessageToTab(
      tabId,
      {
        action: TOOL_MESSAGE_TYPES.GENERATE_SNAPSHOT,
        scope: query.scope,
        filter: query.filter,
        refId,
        maxItems: query.maxItems,
        maxNameChars: query.maxNameChars,
        collapseRepeats: query.collapseRepeats,
        includeImages: query.includeImages,
        find: query.find,
        includeHidden: query.includeHidden === true,
      },
      frameId,
    );
    if (!resp || resp.success !== true) {
      throw new Error(resp?.error || `Failed to generate snapshot in frame ${frameId}`);
    }
    const lines = Array.isArray(resp.lines)
      ? resp.lines.filter((line: unknown) => typeof line === 'string')
      : [];
    const childFrames: FrameSlot[] = Array.isArray(resp.childFrames)
      ? resp.childFrames
          .filter((slot: unknown) => slot && typeof slot === 'object')
          .map((slot: { src?: unknown; sameOrigin?: unknown }) => ({
            src: typeof slot.src === 'string' ? slot.src : '',
            sameOrigin: slot.sameOrigin === true,
          }))
      : [];
    return {
      lines,
      childFrames,
      url: typeof resp.url === 'string' ? resp.url : '',
      title: typeof resp.title === 'string' ? resp.title : '',
      truncated: resp.truncated === true,
      omitted: typeof resp.omitted === 'number' ? resp.omitted : 0,
      groups: Array.isArray(resp.groups)
        ? resp.groups.map((group: unknown) => (typeof group === 'string' ? group : 'page'))
        : [],
      omittedGroups:
        resp.omittedGroups && typeof resp.omittedGroups === 'object'
          ? Object.fromEntries(
              Object.entries(resp.omittedGroups as Record<string, unknown>).filter(
                ([, n]) => typeof n === 'number',
              ) as [string, number][],
            )
          : {},
      hint: typeof resp.hint === 'string' && resp.hint ? resp.hint : undefined,
    };
  }
}

export const snapshotTool = new SnapshotTool();
