import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, diffSnapshotLines, parseAgentRef } from 'chrome-mcp-shared';
import type { SnapshotLineDiff } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { ERROR_MESSAGES } from '@/common/constants';

/**
 * chrome_snapshot — compact accessibility lines with stable refs.
 * Previous snapshots are kept in memory so `since` can return a diff.
 */

const DEFAULT_MAX_ITEMS = 400;
const HARD_MAX_ITEMS = 2000;
const MAX_SNAPSHOTS_PER_TAB = 30;

export interface CapturedSnapshot {
  lines: string[];
  url: string;
  title: string;
  truncated: boolean;
  omitted: number;
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
  since?: string;
  tabId?: number;
  windowId?: number;
  /** When set, snapshot only this frame (used for cross-origin frameId targeting). */
  frameId?: number;
}

export interface SnapshotQuery {
  scope: 'viewport' | 'page';
  filter: 'interactive' | 'all';
  refId?: string;
  maxItems: number;
  frameId?: number;
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
  const scope = args?.scope === undefined ? 'page' : args.scope;
  if (scope !== 'page' && scope !== 'viewport') {
    return { error: 'scope must be "viewport" or "page"' };
  }
  const filter = args?.filter === undefined ? 'all' : args.filter;
  if (filter !== 'all' && filter !== 'interactive') {
    return { error: 'filter must be "interactive" or "all"' };
  }
  const refId = typeof args?.refId === 'string' ? args.refId.trim() : '';
  if (args?.refId !== undefined && !refId) {
    return { error: 'refId must be a non-empty string' };
  }
  let maxItems = DEFAULT_MAX_ITEMS;
  if (args?.maxItems !== undefined) {
    const n = Number(args.maxItems);
    if (!Number.isInteger(n) || n < 1) return { error: 'maxItems must be a positive integer' };
    maxItems = Math.min(n, HARD_MAX_ITEMS);
  }
  let frameId: number | undefined;
  if (args?.frameId !== undefined) {
    if (!Number.isInteger(args.frameId) || args.frameId < 0) {
      return { error: 'frameId must be a non-negative integer' };
    }
    frameId = args.frameId;
  }
  return { scope, filter, refId: refId || undefined, maxItems, frameId };
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

class SnapshotTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SNAPSHOT;

  async execute(args: SnapshotParams): Promise<ToolResult> {
    const query = normalizeSnapshotQuery(args);
    if ('error' in query) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${query.error}`);
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

      const captured = await this.capture(tab.id, query);
      const snapshotId = rememberSnapshot(tab.id, captured);

      if (baseline) {
        const diff: SnapshotLineDiff = diffSnapshotLines(baseline.lines, captured.lines);
        return ok({
          success: true,
          snapshotId,
          since,
          scope: query.scope,
          filter: query.filter,
          url: captured.url,
          title: captured.title,
          truncated: captured.truncated,
          added: diff.added,
          removed: diff.removed,
          changed: diff.changed,
        });
      }

      return ok({
        success: true,
        snapshotId,
        scope: query.scope,
        filter: query.filter,
        url: captured.url,
        title: captured.title,
        count: captured.lines.length,
        truncated: captured.truncated,
        lines: captured.lines,
        tips: 'Next: act by ref (chrome_click_element, chrome_fill_or_select, or chrome_computer). Pass observe:true to get a diff, or call chrome_snapshot again with since set to this snapshotId. Screenshot only if layout matters.',
      });
    } catch (error) {
      return createErrorResponse(`Error generating snapshot: ${errMsg(error)}`);
    }
  }

  /**
   * Capture the current compact snapshot without storing it.
   * Item 2 extends this to stitch same-origin frames.
   */
  async capture(tabId: number, query: SnapshotQuery): Promise<CapturedSnapshot> {
    const frameIds = typeof query.frameId === 'number' ? [query.frameId] : undefined;
    await this.injectContentScript(
      tabId,
      ['inject-scripts/accessibility-tree-helper.js'],
      false,
      'ISOLATED',
      false,
      frameIds,
    );

    const localRef = query.refId ? parseAgentRef(query.refId).ref : undefined;
    const resp = await this.sendMessageToTab(
      tabId,
      {
        action: TOOL_MESSAGE_TYPES.GENERATE_SNAPSHOT,
        scope: query.scope,
        filter: query.filter,
        refId: localRef,
        maxItems: query.maxItems,
      },
      query.frameId,
    );

    if (!resp || resp.success !== true) {
      throw new Error(resp?.error || 'Failed to generate snapshot');
    }

    const lines = Array.isArray(resp.lines)
      ? resp.lines.filter((line: unknown) => typeof line === 'string')
      : [];
    return {
      lines,
      url: typeof resp.url === 'string' ? resp.url : '',
      title: typeof resp.title === 'string' ? resp.title : '',
      truncated: resp.truncated === true,
      omitted: typeof resp.omitted === 'number' ? resp.omitted : 0,
    };
  }
}

export const snapshotTool = new SnapshotTool();
