import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { ERROR_MESSAGES } from '@/common/constants';
import {
  TOOL_NAMES,
  cookieContentOrigin,
  cookieForRead,
  highRiskDisabledError,
  parseCookieArgs,
  redactCookie,
  type ParsedCookieArgs,
} from 'chrome-mcp-shared';
import { readHighRiskFlags } from './high-risk';

/**
 * chrome_cookies — get, set, delete, or list cookies for a url or domain.
 * The whole tool is off until highRiskTools.cookies is true.
 * list returns metadata only. get wraps the value in the untrusted envelope.
 */

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class CookiesTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.COOKIES;

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const flags = await readHighRiskFlags();
    if (!flags.cookies) return createErrorResponse(highRiskDisabledError('cookies'));

    const parsed = parseCookieArgs(args);
    if ('error' in parsed) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: ${parsed.error}`);
    }
    if (!chrome.cookies) {
      return createErrorResponse(
        'The cookies permission is missing. Re-approve the extension and retry.',
      );
    }

    try {
      if (parsed.action === 'list') return ok(await this.list(parsed));
      if (parsed.action === 'get') return ok(await this.get(parsed));
      if (parsed.action === 'set') return ok(await this.set(parsed));
      return ok(await this.remove(parsed));
    } catch (error) {
      return createErrorResponse(`${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: ${errMsg(error)}`);
    }
  }

  private async list(parsed: ParsedCookieArgs): Promise<unknown> {
    const cookies = await chrome.cookies.getAll(this.filter(parsed));
    return {
      cookies: cookies.map((cookie) => redactCookie(cookie)),
      count: cookies.length,
    };
  }

  private async get(parsed: ParsedCookieArgs): Promise<unknown> {
    if (parsed.url && parsed.name) {
      const details: chrome.cookies.CookieDetails = { url: parsed.url, name: parsed.name };
      if (parsed.storeId) details.storeId = parsed.storeId;
      const cookie = await chrome.cookies.get(details);
      if (!cookie) throw new Error(`Cookie not found: ${parsed.name}`);
      return { cookie: cookieForRead(cookieContentOrigin(cookie, parsed.url), cookie) };
    }

    const cookies = await chrome.cookies.getAll(this.filter(parsed));
    if (cookies.length === 0) throw new Error(`Cookie not found: ${parsed.name}`);
    return {
      cookies: cookies.map((cookie) => cookieForRead(cookieContentOrigin(cookie), cookie)),
    };
  }

  private async set(parsed: ParsedCookieArgs): Promise<unknown> {
    if (!parsed.url || !parsed.name) throw new Error('set needs an http(s) url and a name');
    const details: chrome.cookies.SetDetails = {
      url: parsed.url,
      name: parsed.name,
      value: parsed.value ?? '',
    };
    if (parsed.domain) details.domain = parsed.domain;
    if (parsed.path) details.path = parsed.path;
    if (parsed.secure !== undefined) details.secure = parsed.secure;
    if (parsed.httpOnly !== undefined) details.httpOnly = parsed.httpOnly;
    if (parsed.sameSite) details.sameSite = parsed.sameSite;
    if (parsed.expirationDate !== undefined) details.expirationDate = parsed.expirationDate;
    if (parsed.storeId) details.storeId = parsed.storeId;

    const cookie = await chrome.cookies.set(details);
    if (!cookie) throw new Error('Cookie was not set');
    return { set: true, cookie: redactCookie(cookie) };
  }

  private async remove(parsed: ParsedCookieArgs): Promise<unknown> {
    if (!parsed.url || !parsed.name) throw new Error('delete needs an http(s) url and a name');
    const details: chrome.cookies.CookieDetails = { url: parsed.url, name: parsed.name };
    if (parsed.storeId) details.storeId = parsed.storeId;
    const removed = await chrome.cookies.remove(details);
    return {
      removed: true,
      url: removed?.url ?? parsed.url,
      name: removed?.name ?? parsed.name,
    };
  }

  private filter(parsed: ParsedCookieArgs): chrome.cookies.GetAllDetails {
    const details: chrome.cookies.GetAllDetails = {};
    if (parsed.url) details.url = parsed.url;
    if (parsed.domain) details.domain = parsed.domain;
    if (parsed.name) details.name = parsed.name;
    if (parsed.path) details.path = parsed.path;
    if (parsed.secure !== undefined) details.secure = parsed.secure;
    if (parsed.storeId) details.storeId = parsed.storeId;
    return details;
  }
}

export const cookiesTool = new CookiesTool();
