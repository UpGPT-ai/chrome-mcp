import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';

/**
 * Tab / window management tools.
 *
 * These complement navigate / close_tabs / switch_tab with the Chrome APIs that
 * were previously unreachable from the bridge: moving tabs between windows,
 * creating windows that adopt existing tabs, tab groups, pin/mute/discard/
 * duplicate/reload, window focus/state, and a filterable tab query.
 *
 * Every tool defaults to NOT stealing focus. Callers opt into focus with an
 * explicit `focus: true` (or `background: false`).
 */

type TabSummary = {
  tabId: number;
  windowId: number;
  index: number;
  url: string;
  title: string;
  active: boolean;
  pinned: boolean;
  groupId: number;
  discarded: boolean;
  audible: boolean;
  muted: boolean;
  status: string;
};

type GroupSummary = {
  groupId: number;
  windowId: number;
  title: string;
  color: string;
  collapsed: boolean;
};

export function summarizeTab(tab: chrome.tabs.Tab): TabSummary {
  return {
    tabId: tab.id ?? -1,
    windowId: tab.windowId,
    index: tab.index,
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || '',
    active: tab.active === true,
    pinned: tab.pinned === true,
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
    discarded: tab.discarded === true,
    audible: tab.audible === true,
    muted: tab.mutedInfo?.muted === true,
    status: tab.status || '',
  };
}

function summarizeGroup(group: chrome.tabGroups.TabGroup): GroupSummary {
  return {
    groupId: group.id,
    windowId: group.windowId,
    title: group.title || '',
    color: group.color,
    collapsed: group.collapsed === true,
  };
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueNumbers(ids: unknown): number[] {
  if (!Array.isArray(ids)) return [];
  const out: number[] = [];
  for (const id of ids) {
    if (typeof id === 'number' && Number.isFinite(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Resolve which tab ids are still alive; report the ones that are not. */
async function partitionTabIds(ids: number[]): Promise<{ live: number[]; missing: number[] }> {
  const live: number[] = [];
  const missing: number[] = [];
  for (const id of ids) {
    try {
      await chrome.tabs.get(id);
      live.push(id);
    } catch {
      missing.push(id);
    }
  }
  return { live, missing };
}

async function windowExists(windowId: number): Promise<boolean> {
  try {
    await chrome.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// chrome_move_tabs
// ---------------------------------------------------------------------------

interface MoveTabsParams {
  tabIds: number[];
  windowId?: number;
  index?: number;
  focus?: boolean;
}

class MoveTabsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.MOVE_TABS;

  async execute(args: MoveTabsParams): Promise<ToolResult> {
    try {
      const tabIds = uniqueNumbers(args?.tabIds);
      if (tabIds.length === 0) return createErrorResponse('tabIds must be a non-empty array');

      const { live, missing } = await partitionTabIds(tabIds);
      if (live.length === 0) {
        return createErrorResponse(`None of the given tabs exist: ${missing.join(', ')}`);
      }

      if (typeof args.windowId === 'number' && !(await windowExists(args.windowId))) {
        return createErrorResponse(`Window ${args.windowId} does not exist`);
      }

      const moveProps: chrome.tabs.MoveProperties = {
        index: typeof args.index === 'number' ? args.index : -1,
      };
      if (typeof args.windowId === 'number') moveProps.windowId = args.windowId;

      // Pinned tabs can only live at the start of the tab strip; Chrome rejects a
      // cross-window move of a pinned tab unless it is unpinned first. Unpin, move, repin.
      const repin: number[] = [];
      if (typeof args.windowId === 'number') {
        for (const id of live) {
          const t = await chrome.tabs.get(id);
          if (t.pinned && t.windowId !== args.windowId) {
            await chrome.tabs.update(id, { pinned: false });
            repin.push(id);
          }
        }
      }

      const movedRaw = await chrome.tabs.move(live, moveProps);
      const moved = Array.isArray(movedRaw) ? movedRaw : [movedRaw];

      for (const id of repin) {
        try {
          await chrome.tabs.update(id, { pinned: true });
        } catch {
          /* best effort */
        }
      }

      if (args.focus === true && moved[0]?.id !== undefined) {
        await this.ensureFocus(moved[0], { activate: true, focusWindow: true });
      }

      const refreshed = await Promise.all(
        moved.map(async (t) => summarizeTab(t.id !== undefined ? await chrome.tabs.get(t.id) : t)),
      );

      return ok({
        success: true,
        movedCount: refreshed.length,
        tabs: refreshed,
        missingTabIds: missing,
      });
    } catch (error) {
      return createErrorResponse(`Error moving tabs: ${errMsg(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// chrome_create_window
// ---------------------------------------------------------------------------

interface CreateWindowParams {
  tabIds?: number[];
  urls?: string[];
  focus?: boolean;
  incognito?: boolean;
  state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
  type?: 'normal' | 'popup';
  width?: number;
  height?: number;
  left?: number;
  top?: number;
}

class CreateWindowTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CREATE_WINDOW;

  async execute(args: CreateWindowParams): Promise<ToolResult> {
    try {
      const tabIds = uniqueNumbers(args?.tabIds);
      const urls = Array.isArray(args?.urls)
        ? args.urls.filter((u): u is string => typeof u === 'string' && u.length > 0)
        : [];

      const { live, missing } = await partitionTabIds(tabIds);
      if (live.length === 0 && urls.length === 0) {
        return createErrorResponse(
          'Provide at least one existing tabId to adopt or one url to open' +
            (missing.length ? ` (missing tabs: ${missing.join(', ')})` : ''),
        );
      }

      const createData: chrome.windows.CreateData = {
        focused: args.focus === true,
      };
      if (args.incognito === true) createData.incognito = true;
      if (args.state) createData.state = args.state;
      if (args.type === 'popup') createData.type = 'popup';
      if (typeof args.width === 'number') createData.width = args.width;
      if (typeof args.height === 'number') createData.height = args.height;
      if (typeof args.left === 'number') createData.left = args.left;
      if (typeof args.top === 'number') createData.top = args.top;

      // A window must be born with either one adopted tab or a url list.
      // Adopt the first live tab (so no throwaway new-tab page is created), then
      // move the rest in. If there are only urls, open them directly.
      let seededWithTab = false;
      if (live.length > 0) {
        const first = await chrome.tabs.get(live[0]);
        if (first.pinned) await chrome.tabs.update(live[0], { pinned: false });
        createData.tabId = live[0];
        seededWithTab = true;
      } else {
        createData.url = urls;
      }

      const win = await chrome.windows.create(createData);
      if (!win || win.id === undefined) return createErrorResponse('Window creation failed');

      const rest = seededWithTab ? live.slice(1) : [];
      if (rest.length > 0) {
        for (const id of rest) {
          const t = await chrome.tabs.get(id);
          if (t.pinned) await chrome.tabs.update(id, { pinned: false });
        }
        await chrome.tabs.move(rest, { windowId: win.id, index: -1 });
      }

      if (seededWithTab && urls.length > 0) {
        for (const url of urls) {
          await chrome.tabs.create({ windowId: win.id, url, active: false });
        }
      }

      const populated = await chrome.windows.get(win.id, { populate: true });
      return ok({
        success: true,
        windowId: win.id,
        state: populated.state,
        focused: populated.focused,
        tabCount: populated.tabs?.length ?? 0,
        tabs: (populated.tabs || []).map(summarizeTab),
        missingTabIds: missing,
      });
    } catch (error) {
      return createErrorResponse(`Error creating window: ${errMsg(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// chrome_update_window / chrome_close_window
// ---------------------------------------------------------------------------

interface UpdateWindowParams {
  windowId: number;
  focused?: boolean;
  state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  drawAttention?: boolean;
}

class UpdateWindowTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.UPDATE_WINDOW;

  async execute(args: UpdateWindowParams): Promise<ToolResult> {
    try {
      if (typeof args?.windowId !== 'number') return createErrorResponse('windowId is required');
      if (!(await windowExists(args.windowId))) {
        return createErrorResponse(`Window ${args.windowId} does not exist`);
      }
      const update: chrome.windows.UpdateInfo = {};
      if (typeof args.focused === 'boolean') update.focused = args.focused;
      if (args.state) update.state = args.state;
      if (typeof args.width === 'number') update.width = args.width;
      if (typeof args.height === 'number') update.height = args.height;
      if (typeof args.left === 'number') update.left = args.left;
      if (typeof args.top === 'number') update.top = args.top;
      if (typeof args.drawAttention === 'boolean') update.drawAttention = args.drawAttention;
      if (Object.keys(update).length === 0) {
        return createErrorResponse('No window properties to update were provided');
      }
      const win = await chrome.windows.update(args.windowId, update);
      return ok({
        success: true,
        windowId: win.id,
        state: win.state,
        focused: win.focused,
        left: win.left,
        top: win.top,
        width: win.width,
        height: win.height,
      });
    } catch (error) {
      return createErrorResponse(`Error updating window: ${errMsg(error)}`);
    }
  }
}

interface CloseWindowParams {
  windowIds: number[];
}

class CloseWindowTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLOSE_WINDOW;

  async execute(args: CloseWindowParams): Promise<ToolResult> {
    try {
      const ids = uniqueNumbers(args?.windowIds);
      if (ids.length === 0) return createErrorResponse('windowIds must be a non-empty array');
      const closed: number[] = [];
      const missing: number[] = [];
      for (const id of ids) {
        if (await windowExists(id)) {
          await chrome.windows.remove(id);
          closed.push(id);
        } else {
          missing.push(id);
        }
      }
      return ok({ success: true, closedWindowIds: closed, missingWindowIds: missing });
    } catch (error) {
      return createErrorResponse(`Error closing window: ${errMsg(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// chrome_update_tab (pin / mute / active / highlighted / url)
// ---------------------------------------------------------------------------

interface UpdateTabParams {
  tabIds: number[];
  pinned?: boolean;
  muted?: boolean;
  active?: boolean;
  highlighted?: boolean;
  autoDiscardable?: boolean;
  url?: string;
  focusWindow?: boolean;
}

class UpdateTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.UPDATE_TAB;

  async execute(args: UpdateTabParams): Promise<ToolResult> {
    try {
      const ids = uniqueNumbers(args?.tabIds);
      if (ids.length === 0) return createErrorResponse('tabIds must be a non-empty array');

      const update: chrome.tabs.UpdateProperties = {};
      if (typeof args.pinned === 'boolean') update.pinned = args.pinned;
      if (typeof args.muted === 'boolean') update.muted = args.muted;
      if (typeof args.active === 'boolean') update.active = args.active;
      if (typeof args.highlighted === 'boolean') update.highlighted = args.highlighted;
      if (typeof args.autoDiscardable === 'boolean') update.autoDiscardable = args.autoDiscardable;
      if (typeof args.url === 'string' && args.url) update.url = args.url;
      if (Object.keys(update).length === 0) {
        return createErrorResponse('No tab properties to update were provided');
      }
      if (update.active === true && ids.length > 1) {
        return createErrorResponse('active:true can only be applied to a single tab');
      }

      const { live, missing } = await partitionTabIds(ids);
      const updated: TabSummary[] = [];
      for (const id of live) {
        const t = await chrome.tabs.update(id, update);
        if (t) {
          if (args.focusWindow === true && update.active === true) {
            await this.ensureFocus(t, { focusWindow: true });
          }
          updated.push(summarizeTab(await chrome.tabs.get(id)));
        }
      }
      return ok({ success: true, tabs: updated, missingTabIds: missing });
    } catch (error) {
      return createErrorResponse(`Error updating tab: ${errMsg(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// chrome_discard_tabs / chrome_duplicate_tab / chrome_reload_tabs
// ---------------------------------------------------------------------------

interface DiscardTabsParams {
  tabIds?: number[];
  windowId?: number;
  all?: boolean;
}

class DiscardTabsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.DISCARD_TABS;

  async execute(args: DiscardTabsParams): Promise<ToolResult> {
    try {
      let ids = uniqueNumbers(args?.tabIds);
      if (ids.length === 0) {
        if (args?.all === true || typeof args?.windowId === 'number') {
          const query: chrome.tabs.QueryInfo = { active: false, discarded: false };
          if (typeof args.windowId === 'number') query.windowId = args.windowId;
          const tabs = await chrome.tabs.query(query);
          ids = tabs.map((t) => t.id).filter((id): id is number => typeof id === 'number');
        } else {
          return createErrorResponse('Provide tabIds, a windowId, or all:true');
        }
      }

      const discarded: number[] = [];
      const skipped: { tabId: number; reason: string }[] = [];
      for (const id of ids) {
        try {
          const t = await chrome.tabs.get(id);
          if (t.active) {
            skipped.push({ tabId: id, reason: 'active tab cannot be discarded' });
            continue;
          }
          if (t.discarded) {
            skipped.push({ tabId: id, reason: 'already discarded' });
            continue;
          }
          const res = await chrome.tabs.discard(id);
          // discard() may return a new tab object (with the same id) or undefined when it refuses.
          if (res) discarded.push(res.id ?? id);
          else skipped.push({ tabId: id, reason: 'chrome refused to discard' });
        } catch (e) {
          skipped.push({ tabId: id, reason: errMsg(e) });
        }
      }
      return ok({ success: true, discardedTabIds: discarded, skipped });
    } catch (error) {
      return createErrorResponse(`Error discarding tabs: ${errMsg(error)}`);
    }
  }
}

interface DuplicateTabParams {
  tabId: number;
  focus?: boolean;
}

class DuplicateTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.DUPLICATE_TAB;

  async execute(args: DuplicateTabParams): Promise<ToolResult> {
    try {
      if (typeof args?.tabId !== 'number') return createErrorResponse('tabId is required');
      const src = await this.tryGetTab(args.tabId);
      if (!src) return createErrorResponse(`Tab ${args.tabId} does not exist`);
      const dup = await chrome.tabs.duplicate(args.tabId);
      if (!dup || dup.id === undefined) return createErrorResponse('Duplicate failed');
      // chrome.tabs.duplicate activates the copy; restore the original unless focus requested.
      if (args.focus !== true && src.active && src.id !== undefined) {
        await chrome.tabs.update(src.id, { active: true });
      } else if (args.focus === true) {
        await this.ensureFocus(dup, { activate: true, focusWindow: true });
      }
      return ok({ success: true, tab: summarizeTab(await chrome.tabs.get(dup.id)) });
    } catch (error) {
      return createErrorResponse(`Error duplicating tab: ${errMsg(error)}`);
    }
  }
}

interface ReloadTabsParams {
  tabIds: number[];
  bypassCache?: boolean;
}

class ReloadTabsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.RELOAD_TABS;

  async execute(args: ReloadTabsParams): Promise<ToolResult> {
    try {
      const ids = uniqueNumbers(args?.tabIds);
      if (ids.length === 0) return createErrorResponse('tabIds must be a non-empty array');
      const { live, missing } = await partitionTabIds(ids);
      for (const id of live) {
        await chrome.tabs.reload(id, { bypassCache: args.bypassCache === true });
      }
      return ok({ success: true, reloadedTabIds: live, missingTabIds: missing });
    } catch (error) {
      return createErrorResponse(`Error reloading tabs: ${errMsg(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// chrome_query_tabs
// ---------------------------------------------------------------------------

interface QueryTabsParams {
  urlPattern?: string | string[];
  titleContains?: string;
  windowId?: number;
  groupId?: number;
  pinned?: boolean;
  audible?: boolean;
  muted?: boolean;
  discarded?: boolean;
  active?: boolean;
  status?: 'loading' | 'complete';
  limit?: number;
}

class QueryTabsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.QUERY_TABS;

  async execute(args: QueryTabsParams): Promise<ToolResult> {
    try {
      const q: chrome.tabs.QueryInfo = {};
      if (args?.urlPattern) q.url = args.urlPattern;
      if (typeof args?.windowId === 'number') q.windowId = args.windowId;
      if (typeof args?.groupId === 'number') q.groupId = args.groupId;
      if (typeof args?.pinned === 'boolean') q.pinned = args.pinned;
      if (typeof args?.audible === 'boolean') q.audible = args.audible;
      if (typeof args?.muted === 'boolean') q.muted = args.muted;
      if (typeof args?.discarded === 'boolean') q.discarded = args.discarded;
      if (typeof args?.active === 'boolean') q.active = args.active;
      if (args?.status) q.status = args.status;

      let tabs = await chrome.tabs.query(q);
      if (typeof args?.titleContains === 'string' && args.titleContains) {
        const needle = args.titleContains.toLowerCase();
        tabs = tabs.filter((t) => (t.title || '').toLowerCase().includes(needle));
      }
      const total = tabs.length;
      if (typeof args?.limit === 'number' && args.limit > 0) tabs = tabs.slice(0, args.limit);

      return ok({ success: true, total, returned: tabs.length, tabs: tabs.map(summarizeTab) });
    } catch (error) {
      return createErrorResponse(`Error querying tabs: ${errMsg(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tab groups: chrome_group_tabs / chrome_ungroup_tabs / chrome_update_tab_group / chrome_list_tab_groups
// ---------------------------------------------------------------------------

type GroupColor = chrome.tabGroups.TabGroup['color'];

const GROUP_COLORS: GroupColor[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
];

function hasTabGroupsApi(): boolean {
  return typeof chrome.tabGroups !== 'undefined' && typeof chrome.tabGroups.update === 'function';
}

interface GroupTabsParams {
  tabIds: number[];
  groupId?: number;
  windowId?: number;
  title?: string;
  color?: GroupColor;
  collapsed?: boolean;
}

class GroupTabsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GROUP_TABS;

  async execute(args: GroupTabsParams): Promise<ToolResult> {
    try {
      const ids = uniqueNumbers(args?.tabIds);
      if (ids.length === 0) return createErrorResponse('tabIds must be a non-empty array');
      const { live, missing } = await partitionTabIds(ids);
      if (live.length === 0) {
        return createErrorResponse(`None of the given tabs exist: ${missing.join(', ')}`);
      }
      if (args.color && !GROUP_COLORS.includes(args.color)) {
        return createErrorResponse(`color must be one of ${GROUP_COLORS.join(', ')}`);
      }

      const options: chrome.tabs.GroupOptions = { tabIds: live };
      if (typeof args.groupId === 'number') {
        options.groupId = args.groupId;
      } else if (typeof args.windowId === 'number') {
        options.createProperties = { windowId: args.windowId };
      }

      const groupId = await chrome.tabs.group(options);

      let group: GroupSummary | null = null;
      if (hasTabGroupsApi()) {
        const props: chrome.tabGroups.UpdateProperties = {};
        if (typeof args.title === 'string') props.title = args.title;
        if (args.color) props.color = args.color;
        if (typeof args.collapsed === 'boolean') props.collapsed = args.collapsed;
        const updated =
          Object.keys(props).length > 0
            ? await chrome.tabGroups.update(groupId, props)
            : await chrome.tabGroups.get(groupId);
        if (!updated) throw new Error(`Tab group ${groupId} not found after grouping`);
        group = summarizeGroup(updated);
      }

      return ok({ success: true, groupId, group, groupedTabIds: live, missingTabIds: missing });
    } catch (error) {
      return createErrorResponse(`Error grouping tabs: ${errMsg(error)}`);
    }
  }
}

interface UngroupTabsParams {
  tabIds?: number[];
  groupId?: number;
}

class UngroupTabsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.UNGROUP_TABS;

  async execute(args: UngroupTabsParams): Promise<ToolResult> {
    try {
      let ids = uniqueNumbers(args?.tabIds);
      if (ids.length === 0 && typeof args?.groupId === 'number') {
        const tabs = await chrome.tabs.query({ groupId: args.groupId });
        ids = tabs.map((t) => t.id).filter((id): id is number => typeof id === 'number');
      }
      if (ids.length === 0) return createErrorResponse('Provide tabIds or a groupId');
      const { live, missing } = await partitionTabIds(ids);
      if (live.length > 0) await chrome.tabs.ungroup(live);
      return ok({ success: true, ungroupedTabIds: live, missingTabIds: missing });
    } catch (error) {
      return createErrorResponse(`Error ungrouping tabs: ${errMsg(error)}`);
    }
  }
}

interface UpdateTabGroupParams {
  groupId: number;
  title?: string;
  color?: GroupColor;
  collapsed?: boolean;
  moveToWindowId?: number;
  index?: number;
}

class UpdateTabGroupTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.UPDATE_TAB_GROUP;

  async execute(args: UpdateTabGroupParams): Promise<ToolResult> {
    try {
      if (!hasTabGroupsApi()) {
        return createErrorResponse(
          'chrome.tabGroups API unavailable (missing tabGroups permission?)',
        );
      }
      if (typeof args?.groupId !== 'number') return createErrorResponse('groupId is required');
      if (args.color && !GROUP_COLORS.includes(args.color)) {
        return createErrorResponse(`color must be one of ${GROUP_COLORS.join(', ')}`);
      }
      const props: chrome.tabGroups.UpdateProperties = {};
      if (typeof args.title === 'string') props.title = args.title;
      if (args.color) props.color = args.color;
      if (typeof args.collapsed === 'boolean') props.collapsed = args.collapsed;

      let group: chrome.tabGroups.TabGroup | undefined = await chrome.tabGroups.get(args.groupId);
      if (!group) throw new Error(`Tab group ${args.groupId} not found`);
      if (Object.keys(props).length > 0) {
        group = (await chrome.tabGroups.update(args.groupId, props)) ?? group;
      }

      if (typeof args.moveToWindowId === 'number' || typeof args.index === 'number') {
        const moveProps: chrome.tabGroups.MoveProperties = {
          index: typeof args.index === 'number' ? args.index : -1,
        };
        if (typeof args.moveToWindowId === 'number') moveProps.windowId = args.moveToWindowId;
        group = (await chrome.tabGroups.move(args.groupId, moveProps)) ?? group;
      }

      return ok({ success: true, group: summarizeGroup(group) });
    } catch (error) {
      return createErrorResponse(`Error updating tab group: ${errMsg(error)}`);
    }
  }
}

interface ListTabGroupsParams {
  windowId?: number;
}

class ListTabGroupsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.LIST_TAB_GROUPS;

  async execute(args: ListTabGroupsParams): Promise<ToolResult> {
    try {
      if (!hasTabGroupsApi()) {
        return createErrorResponse(
          'chrome.tabGroups API unavailable (missing tabGroups permission?)',
        );
      }
      const q: chrome.tabGroups.QueryInfo = {};
      if (typeof args?.windowId === 'number') q.windowId = args.windowId;
      const groups = await chrome.tabGroups.query(q);
      const result = [];
      for (const g of groups) {
        const tabs = await chrome.tabs.query({ groupId: g.id });
        result.push({ ...summarizeGroup(g), tabCount: tabs.length, tabs: tabs.map(summarizeTab) });
      }
      return ok({ success: true, groupCount: result.length, groups: result });
    } catch (error) {
      return createErrorResponse(`Error listing tab groups: ${errMsg(error)}`);
    }
  }
}

export const moveTabsTool = new MoveTabsTool();
export const createWindowTool = new CreateWindowTool();
export const updateWindowTool = new UpdateWindowTool();
export const closeWindowTool = new CloseWindowTool();
export const updateTabTool = new UpdateTabTool();
export const discardTabsTool = new DiscardTabsTool();
export const duplicateTabTool = new DuplicateTabTool();
export const reloadTabsTool = new ReloadTabsTool();
export const queryTabsTool = new QueryTabsTool();
export const groupTabsTool = new GroupTabsTool();
export const ungroupTabsTool = new UngroupTabsTool();
export const updateTabGroupTool = new UpdateTabGroupTool();
export const listTabGroupsTool = new ListTabGroupsTool();
