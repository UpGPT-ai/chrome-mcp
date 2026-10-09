import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { ERROR_MESSAGES } from '@/common/constants';
import {
  TOOL_NAMES,
  highRiskDisabledError,
  limitNames,
  originFromUrl,
  parseStorageArgs,
  storageActionUsesValues,
  wrapUntrusted,
  type ParsedStorageArgs,
} from 'chrome-mcp-shared';
import { readHighRiskFlags } from './high-risk';

/**
 * chrome_storage — localStorage, sessionStorage, and IndexedDB names on the tab origin.
 * Runs in the page main world. Value actions stay off until highRiskTools.storageValues is true.
 * list returns keys or database/store names, never values.
 */

interface PageStorageResult {
  keys?: string[];
  key?: string;
  value?: string | null;
  found?: boolean;
  set?: boolean;
  removed?: boolean;
  cleared?: number;
  databases?: { name: string; version?: number; stores: string[] }[];
  error?: string;
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serialized into the page. Keep it free of module bindings.
 * indexedDB.open is called without a version so an existing database is not upgraded.
 */
function readPageStorage(
  action: string,
  area: string,
  key: string | null,
  value: string | null,
): PageStorageResult | Promise<PageStorageResult> {
  function storageError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  if (area === 'indexeddb') {
    return listDatabases();
  }

  const store = area === 'session' ? sessionStorage : localStorage;
  try {
    if (action === 'list') {
      const keys: string[] = [];
      for (let index = 0; index < store.length; index++) {
        const storedKey = store.key(index);
        if (storedKey !== null) keys.push(storedKey);
      }
      return { keys };
    }
    if (action === 'get') {
      const stored = store.getItem(key ?? '');
      return { key: key ?? '', value: stored, found: stored !== null };
    }
    if (action === 'set') {
      store.setItem(key ?? '', value ?? '');
      return { key: key ?? '', set: true };
    }
    if (action === 'remove') {
      store.removeItem(key ?? '');
      return { key: key ?? '', removed: true };
    }
    const cleared = store.length;
    store.clear();
    return { cleared };
  } catch (error) {
    return { error: storageError(error) };
  }

  function listDatabases(): Promise<PageStorageResult> {
    const factory = indexedDB;
    if (!factory || typeof factory.databases !== 'function') {
      return Promise.resolve({ error: 'indexedDB.databases() is not available on this page' });
    }
    return factory.databases().then(async (found) => {
      const databases: { name: string; version?: number; stores: string[] }[] = [];
      for (const entry of found) {
        if (!entry.name) continue;
        const stores = await readStoreNames(entry.name);
        databases.push({
          name: entry.name,
          version: typeof entry.version === 'number' ? entry.version : undefined,
          stores,
        });
      }
      return { databases };
    });
  }

  function readStoreNames(name: string): Promise<string[]> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (stores: string[]) => {
        if (settled) return;
        settled = true;
        resolve(stores);
      };
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(name);
      } catch {
        finish([]);
        return;
      }
      const timer = setTimeout(() => {
        try {
          request.transaction?.abort();
        } catch {
          /* The open already finished. */
        }
        finish([]);
      }, 3000);
      request.onupgradeneeded = () => {
        clearTimeout(timer);
        try {
          request.transaction?.abort();
        } catch {
          /* Aborting a new database is best-effort. */
        }
        finish([]);
      };
      request.onerror = () => {
        clearTimeout(timer);
        finish([]);
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        const db = request.result;
        let stores: string[] = [];
        try {
          stores = Array.from(db.objectStoreNames);
        } catch {
          stores = [];
        }
        try {
          db.close();
        } catch {
          /* Already closed. */
        }
        finish(stores);
      };
    });
  }
}

class StorageTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.STORAGE;

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const parsed = parseStorageArgs(args);
    if ('error' in parsed) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${parsed.error}`);
    }
    if (storageActionUsesValues(parsed.action, parsed.area)) {
      const flags = await readHighRiskFlags();
      if (!flags.storageValues) return createErrorResponse(highRiskDisabledError('storageValues'));
    }

    try {
      const tab = await this.resolveTab(args);
      if (!tab.id)
        return createErrorResponse(`${ERROR_MESSAGES.TAB_NOT_FOUND}: Active tab has no ID`);
      const origin = originFromUrl(tab.url);
      const result = await this.read(tab.id, parsed);
      if (result.error) {
        return createErrorResponse(`${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: ${result.error}`);
      }
      return ok(this.present(parsed, origin, result));
    } catch (error) {
      return createErrorResponse(`${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: ${errMsg(error)}`);
    }
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

  private async read(tabId: number, parsed: ParsedStorageArgs): Promise<PageStorageResult> {
    const [first] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: readPageStorage,
      args: [parsed.action, parsed.area, parsed.key ?? null, parsed.valueText ?? null],
    });
    if (!first || first.result == null) throw new Error('The page returned no storage result');
    return first.result;
  }

  private present(parsed: ParsedStorageArgs, origin: string, result: PageStorageResult): unknown {
    if (parsed.area === 'indexeddb') {
      const databases = (result.databases ?? []).map((database) => {
        const stores = limitNames(database.stores);
        return {
          name: database.name,
          version: database.version,
          stores: stores.names,
          storesTruncated: stores.truncated || undefined,
        };
      });
      const limited = limitNames(databases.map((database) => database.name));
      return {
        area: parsed.area,
        origin,
        databases: databases.slice(0, limited.names.length),
        count: databases.length,
        truncated: limited.truncated || undefined,
      };
    }

    if (parsed.action === 'list') {
      const keys = limitNames(result.keys ?? []);
      return {
        area: parsed.area,
        origin,
        keys: keys.names,
        count: (result.keys ?? []).length,
        truncated: keys.truncated || undefined,
      };
    }
    if (parsed.action === 'get') {
      if (!result.found) return { area: parsed.area, origin, key: parsed.key, found: false };
      return {
        area: parsed.area,
        origin,
        key: parsed.key,
        found: true,
        value: wrapUntrusted(origin, result.value ?? ''),
      };
    }
    if (parsed.action === 'set') return { area: parsed.area, origin, key: parsed.key, set: true };
    if (parsed.action === 'remove') {
      return { area: parsed.area, origin, key: parsed.key, removed: true };
    }
    return { area: parsed.area, origin, cleared: result.cleared ?? 0 };
  }
}

export const storageTool = new StorageTool();
