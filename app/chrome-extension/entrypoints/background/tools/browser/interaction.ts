import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, parseAgentRef, parseObserve } from 'chrome-mcp-shared';
import { attachObserve, beginObserve, type ObserveSession } from './observe';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';

interface Coordinates {
  x: number;
  y: number;
}

interface ClickToolParams {
  selector?: string; // CSS selector or XPath for the element to click
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree (window.__claudeElementMap)
  coordinates?: Coordinates; // Coordinates to click at (x, y relative to viewport)
  waitForNavigation?: boolean; // Whether to wait for navigation to complete after click
  timeout?: number; // Timeout in milliseconds for waiting for the element or navigation
  frameId?: number; // Target frame for ref/selector resolution
  double?: boolean; // Perform double click when true
  button?: 'left' | 'right' | 'middle';
  bubbles?: boolean;
  cancelable?: boolean;
  modifiers?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  observe?: boolean | { settleMs?: number };
}

/**
 * `ref_12@7` addresses local ref `ref_12` inside frame 7.
 * An explicit frameId is used when the ref has no suffix.
 */
export function resolveRefTarget(
  ref?: string,
  frameId?: number,
): { ref?: string; frameId?: number } {
  if (typeof ref !== 'string' || !ref.trim()) return { frameId };
  const parsed = parseAgentRef(ref);
  return { ref: parsed.ref, frameId: parsed.frameId ?? frameId };
}

function frameIdsFor(frameId?: number): number[] | undefined {
  return typeof frameId === 'number' ? [frameId] : undefined;
}

/**
 * Tool for clicking elements on web pages
 */
class ClickTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLICK;

  /**
   * Execute click operation
   */
  async execute(args: ClickToolParams): Promise<ToolResult> {
    const {
      selector,
      selectorType = 'css',
      coordinates,
      waitForNavigation = false,
      timeout = TIMEOUTS.DEFAULT_WAIT * 5,
      frameId,
      button,
      bubbles,
      cancelable,
      modifiers,
    } = args;

    console.log(`Starting click operation with options:`, args);

    if (!selector && !coordinates && !args.ref) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector or coordinates',
      );
    }

    const observe = parseObserve(args.observe);
    if (observe && 'error' in observe) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${observe.error}`);
    }

    let session: ObserveSession | null = null;
    try {
      // Resolve tab
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      const target = resolveRefTarget(args.ref, frameId);
      const finalFrameId = target.frameId;
      let finalRef = target.ref;
      let finalSelector = selector;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/accessibility-tree-helper.js'],
          false,
          'ISOLATED',
          false,
          frameIdsFor(finalFrameId),
        );
        try {
          const resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            finalFrameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            finalSelector = undefined; // Use ref instead of selector
          } else {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
            );
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (observe) session = await beginObserve(tab.id, observe.settleMs);

      await this.injectContentScript(
        tab.id,
        ['inject-scripts/click-helper.js'],
        false,
        'ISOLATED',
        false,
        frameIdsFor(finalFrameId),
      );

      // Send click message to content script
      const result = await this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.CLICK_ELEMENT,
          selector: finalSelector,
          coordinates,
          ref: finalRef,
          waitForNavigation,
          timeout,
          double: args.double === true,
          button,
          bubbles,
          cancelable,
          modifiers,
        },
        finalFrameId,
      );

      // Determine actual click method used
      let clickMethod: string;
      if (coordinates) {
        clickMethod = 'coordinates';
      } else if (finalRef) {
        clickMethod = 'ref';
      } else if (finalSelector) {
        clickMethod = 'selector';
      } else {
        clickMethod = 'unknown';
      }

      return attachObserve(session, {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Click operation successful',
              elementInfo: result.elementInfo,
              navigationOccurred: result.navigationOccurred,
              clickMethod,
            }),
          },
        ],
        isError: false,
      });
    } catch (error) {
      console.error('Error in click operation:', error);
      return attachObserve(
        session,
        createErrorResponse(
          `Error performing click: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
}

export const clickTool = new ClickTool();

interface FillToolParams {
  selector?: string;
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree
  // Accept string | number | boolean for broader form input coverage
  value: string | number | boolean;
  frameId?: number;
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  observe?: boolean | { settleMs?: number };
}

/**
 * Tool for filling form elements on web pages
 */
class FillTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL;

  /**
   * Execute fill operation
   */
  async execute(args: FillToolParams): Promise<ToolResult> {
    const { selector, selectorType = 'css', value, frameId } = args;

    console.log(`Starting fill operation with options:`, args);

    if (!selector && !args.ref) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector');
    }

    if (value === undefined || value === null) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': Value must be provided');
    }

    const observe = parseObserve(args.observe);
    if (observe && 'error' in observe) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${observe.error}`);
    }

    let session: ObserveSession | null = null;
    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      const target = resolveRefTarget(args.ref, frameId);
      const finalFrameId = target.frameId;
      let finalRef = target.ref;
      let finalSelector = selector;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/accessibility-tree-helper.js'],
          false,
          'ISOLATED',
          false,
          frameIdsFor(finalFrameId),
        );
        try {
          const resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            finalFrameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            finalSelector = undefined; // Use ref instead of selector
          } else {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
            );
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (observe) session = await beginObserve(tab.id, observe.settleMs);

      await this.injectContentScript(
        tab.id,
        ['inject-scripts/fill-helper.js'],
        false,
        'ISOLATED',
        false,
        frameIdsFor(finalFrameId),
      );

      // Send fill message to content script
      const result = await this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.FILL_ELEMENT,
          selector: finalSelector,
          ref: finalRef,
          value,
        },
        finalFrameId,
      );

      if (result && result.error) {
        return attachObserve(session, createErrorResponse(result.error));
      }

      return attachObserve(session, {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Fill operation successful',
              elementInfo: result.elementInfo,
            }),
          },
        ],
        isError: false,
      });
    } catch (error) {
      console.error('Error in fill operation:', error);
      return attachObserve(
        session,
        createErrorResponse(
          `Error filling element: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
}

export const fillTool = new FillTool();
