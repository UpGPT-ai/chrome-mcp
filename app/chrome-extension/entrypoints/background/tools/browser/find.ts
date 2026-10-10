import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  TOOL_NAMES,
  originFromUrl,
  paginateSnapshot,
  parseFindQuery,
  wrapPageLines,
  wrapUntrusted,
} from 'chrome-mcp-shared';
import { ERROR_MESSAGES } from '@/common/constants';
import { SnapshotTool, type SnapshotQuery } from './snapshot';

interface FindParams {
  text?: string;
  role?: string;
  nearRef?: string;
  limit?: number;
  tabId?: number;
  windowId?: number;
  frameId?: number;
  includeHidden?: boolean;
}

/**
 * chrome_find: targeted lookup. Returns only the matching elements, as refs in the
 * same line format and untrusted envelope as chrome_snapshot.
 */
class FindTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FIND;

  async execute(args: FindParams): Promise<ToolResult> {
    const parsed = parseFindQuery(args);
    if ('error' in parsed) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${parsed.error}`);
    }
    if (args?.includeHidden !== undefined && typeof args.includeHidden !== 'boolean') {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: includeHidden must be a boolean`,
      );
    }
    try {
      const explicit = await this.tryGetTab(args?.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args?.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }
      const query: SnapshotQuery = {
        scope: 'page',
        filter: 'all',
        maxItems: parsed.limit,
        maxChars: 40000,
        maxNameChars: 120,
        offset: 0,
        collapseRepeats: false,
        includeImages: false,
        frameId: typeof args?.frameId === 'number' ? args.frameId : undefined,
        includeHidden: args?.includeHidden === true,
        find: parsed.query,
      };
      const snapshot = new SnapshotTool();
      const captured = await snapshot.capture(tab.id, query);
      const page = paginateSnapshot(
        captured.lines.map((line, i) => ({ line, group: captured.groups?.[i] || 'page' })),
        {
          offset: 0,
          maxItems: parsed.limit,
          maxChars: 40000,
          extraOmitted: captured.omitted,
          extraGroups: captured.omittedGroups,
        },
      );
      const origin = originFromUrl(captured.url || tab.url);
      const noMatch = captured.lines.length === 0;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              url: captured.url,
              title: wrapUntrusted(origin, captured.title),
              count: noMatch ? 0 : page.shown,
              truncated: page.truncated,
              ...(page.truncated ? { remaining: page.remaining } : {}),
              lines: wrapPageLines(origin, noMatch ? [] : page.lines),
              tips: 'Act by ref with chrome_click_element, chrome_fill_or_select or chrome_computer. Refs come from the same page state as chrome_snapshot.',
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error finding elements: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const findTool = new FindTool();
