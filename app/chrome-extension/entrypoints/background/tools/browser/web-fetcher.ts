import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, policyOrigin, wrapUntrusted } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';

interface WebFetcherToolParams {
  htmlContent?: boolean; // get the visible HTML content of the current page. default: false
  textContent?: boolean; // get the visible text content of the current page. default: true
  url?: string; // optional URL to fetch content from (if not provided, uses active tab)
  selector?: string; // optional CSS selector to get content from a specific element
  tabId?: number; // target existing tab id
  background?: boolean; // do not activate/focus
  windowId?: number; // target window id to pick active tab or create tab
  reuseTab?: boolean; // reuse ONE dedicated tab, navigating it in place (no tab/window explosion)
  includeHidden?: boolean;
}

function sealPageText(origin: string, value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return value;
  return wrapUntrusted(origin, value);
}

function sealPageFields(origin: string, value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  for (const key of keys) next[key] = sealPageText(origin, record[key]);
  return next;
}

// A single dedicated tab reused across every `reuseTab: true` fetch. Module-level
// so it survives across tool calls within one service-worker lifetime. When the
// worker is evicted and respawned this resets to null and we re-adopt/create one
// tab on the next call — still at most one tab, never an accumulating pile.
let reusableTabId: number | null = null;

/**
 * Navigate the shared reusable tab to `url` and resolve once it finishes loading.
 * Creates the dedicated tab on first use (or if the previous one was closed).
 * Uses chrome.tabs.onUpdated (status 'complete') rather than a fixed timeout so
 * we read the page only after it has actually rendered.
 */
async function navigateReusableTab(url: string, background: boolean): Promise<chrome.tabs.Tab> {
  // Adopt the existing dedicated tab if it's still alive.
  let tab: chrome.tabs.Tab | undefined;
  if (reusableTabId !== null) {
    try {
      tab = await chrome.tabs.get(reusableTabId);
    } catch {
      reusableTabId = null; // it was closed — fall through to create a fresh one
    }
  }

  if (!tab) {
    tab = await chrome.tabs.create({ url, active: !background });
    reusableTabId = tab.id ?? null;
    if (tab.id == null) return tab;
    await waitForTabComplete(tab.id, url);
    return chrome.tabs.get(tab.id);
  }

  // Navigate the existing dedicated tab in place.
  const tabId = tab.id!;
  await chrome.tabs.update(tabId, { url, active: !background });
  await waitForTabComplete(tabId, url);
  return chrome.tabs.get(tabId);
}

/** Resolve when `tabId` reaches status 'complete', with a hard timeout fallback. */
function waitForTabComplete(tabId: number, url: string, timeoutMs = 30000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      // Brief settle for late client-side rendering after 'complete'.
      setTimeout(resolve, 400);
    };

    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') done();
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Fallback: if 'complete' never fires (hung load, blank navigation), don't hang.
    // The listener is attached synchronously after the update()/create() await, before
    // the freshly-navigated page can reach 'complete', so we don't miss the event.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      console.warn(`Reusable-tab load timed out after ${timeoutMs}ms for ${url}`);
      resolve();
    }, timeoutMs);
  });
}

class WebFetcherTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WEB_FETCHER;

  /**
   * Execute web fetcher operation
   */
  async execute(args: WebFetcherToolParams): Promise<ToolResult> {
    if (args.includeHidden !== undefined && typeof args.includeHidden !== 'boolean') {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: includeHidden must be a boolean`,
      );
    }
    // Handle mutually exclusive parameters: if htmlContent is true, textContent is forced to false
    const htmlContent = args.htmlContent === true;
    const textContent = htmlContent ? false : args.textContent !== false; // Default is true, unless htmlContent is true or textContent is explicitly set to false
    const includeHidden = args.includeHidden === true;
    const url = args.url;
    const selector = args.selector;
    const explicitTabId = args.tabId;
    const background = args.background === true;
    const windowId = args.windowId;
    const reuseTab = args.reuseTab === true;

    console.log(`Starting web fetcher with options:`, {
      htmlContent,
      textContent,
      url,
      selector,
    });

    try {
      // Get tab to fetch content from
      let tab;

      if (reuseTab && url) {
        // Single-tab mode: navigate ONE dedicated tab in place. Never spawns a
        // tab per URL, so a long harvest crawl stays at exactly one open tab.
        tab = await navigateReusableTab(url, background);
      } else if (typeof explicitTabId === 'number') {
        tab = await chrome.tabs.get(explicitTabId);
      } else if (url) {
        // If URL is provided, check if it's already open
        console.log(`Checking if URL is already open: ${url}`);
        const allTabs = await chrome.tabs.query({});

        // Find tab with matching URL
        const matchingTabs = allTabs.filter((t) => {
          // Normalize URLs for comparison (remove trailing slashes)
          const tabUrl = t.url?.endsWith('/') ? t.url.slice(0, -1) : t.url;
          const targetUrl = url.endsWith('/') ? url.slice(0, -1) : url;
          return tabUrl === targetUrl;
        });

        if (matchingTabs.length > 0) {
          // Use existing tab
          tab = matchingTabs[0];
          console.log(`Found existing tab with URL: ${url}, tab ID: ${tab.id}`);
        } else {
          // Create new tab with the URL
          console.log(`No existing tab found with URL: ${url}, creating new tab`);
          tab = await chrome.tabs.create({ url, active: background ? false : true });

          // Wait for page to load
          console.log('Waiting for page to load...');
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      } else {
        // Use active tab (prefer specified window)
        const tabs =
          typeof windowId === 'number'
            ? await chrome.tabs.query({ active: true, windowId })
            : await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]) {
          return createErrorResponse('No active tab found');
        }
        tab = tabs[0];
      }

      if (!tab.id) {
        return createErrorResponse('Tab has no ID');
      }

      // Optionally bring tab/window to foreground
      if (!background) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }

      const origin = policyOrigin(tab.url);
      // Prepare result object. Page text is wrapped. The URL stays raw.
      const result: any = {
        success: true,
        url: tab.url,
        title: sealPageText(origin, tab.title),
      };

      await this.injectContentScript(tab.id, ['inject-scripts/web-fetcher-helper.js']);

      // Get HTML content if requested
      if (htmlContent) {
        const htmlResponse = await this.sendMessageToTab(tab.id, {
          action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_HTML_CONTENT,
          selector: selector,
          includeHidden,
        });

        if (htmlResponse.success) {
          result.htmlContent = sealPageText(origin, htmlResponse.htmlContent);
        } else {
          console.error('Failed to get HTML content:', htmlResponse.error);
          result.htmlContentError = htmlResponse.error;
        }
      }

      // Get text content if requested (and htmlContent is not true)
      if (textContent) {
        const textResponse = await this.sendMessageToTab(tab.id, {
          action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT,
          selector: selector,
          includeHidden,
        });

        if (textResponse.success) {
          result.textContent = sealPageText(origin, textResponse.textContent);

          // Include article metadata if available. lang is a code, not page prose.
          if (textResponse.article) {
            const article = sealPageFields(origin, textResponse.article, [
              'title',
              'byline',
              'siteName',
              'excerpt',
            ]) as Record<string, unknown>;
            result.article = {
              title: article.title,
              byline: article.byline,
              siteName: article.siteName,
              excerpt: article.excerpt,
              lang: textResponse.article.lang,
            };
          }

          // Include page metadata if available
          if (textResponse.metadata) {
            result.metadata = sealPageFields(origin, textResponse.metadata, [
              'title',
              'description',
              'author',
              'keywords',
              'published',
              'siteName',
            ]);
          }
        } else {
          console.error('Failed to get text content:', textResponse.error);
          result.textContentError = textResponse.error;
        }
      }

      // Interactive elements feature has been removed

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in web fetcher:', error);
      return createErrorResponse(
        `Error fetching web content: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const webFetcherTool = new WebFetcherTool();

interface GetInteractiveElementsToolParams {
  textQuery?: string; // Text to search for within interactive elements (fuzzy search)
  selector?: string; // CSS selector to filter interactive elements
  includeCoordinates?: boolean; // Include element coordinates in the response (default: true)
  types?: string[]; // Types of interactive elements to include (default: all types)
}

class GetInteractiveElementsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_INTERACTIVE_ELEMENTS;

  /**
   * Execute get interactive elements operation
   */
  async execute(args: GetInteractiveElementsToolParams): Promise<ToolResult> {
    const { textQuery, selector, includeCoordinates = true, types } = args;

    console.log(`Starting get interactive elements with options:`, args);

    try {
      // Get current tab
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        return createErrorResponse('No active tab found');
      }

      const tab = tabs[0];
      if (!tab.id) {
        return createErrorResponse('Active tab has no ID');
      }

      // Ensure content script is injected
      await this.injectContentScript(tab.id, ['inject-scripts/interactive-elements-helper.js']);

      // Send message to content script
      const result = await this.sendMessageToTab(tab.id, {
        action: TOOL_MESSAGE_TYPES.GET_INTERACTIVE_ELEMENTS,
        textQuery,
        selector,
        includeCoordinates,
        types,
      });

      if (!result.success) {
        return createErrorResponse(result.error || 'Failed to get interactive elements');
      }

      const origin = policyOrigin(tab.url);
      const elements = Array.isArray(result.elements)
        ? result.elements.map((element: { text?: unknown }) => {
            if (!element || typeof element !== 'object' || typeof element.text !== 'string') {
              return element;
            }
            if (!element.text) return element;
            return { ...element, text: wrapUntrusted(origin, element.text) };
          })
        : result.elements;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              elements,
              count: Array.isArray(elements) ? elements.length : 0,
              query: {
                textQuery,
                selector,
                types: types || 'all',
              },
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in get interactive elements operation:', error);
      return createErrorResponse(
        `Error getting interactive elements: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const getInteractiveElementsTool = new GetInteractiveElementsTool();
