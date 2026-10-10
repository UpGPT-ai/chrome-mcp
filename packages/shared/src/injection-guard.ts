/**
 * Pure injection-hardening decisions. The extension applies them.
 * These checks make prompt injection harder and bound the damage.
 * They cannot make it impossible.
 * No Node APIs. Live pages are verified manually.
 */

import { wrapUntrusted } from './page-access';

export const CROSS_ORIGIN_WINDOW_MS = 60_000;
export const OFFSCREEN_PX = 2000;
export const MIN_EXFIL_SECRET_LENGTH = 8;
export const AUDIT_READ_DEFAULT = 50;
export const AUDIT_READ_MAX = 200;

export const SITE_POLICY_MODE_KEY = 'sitePolicyMode';
export const SITE_POLICY_DENY_ORIGINS_KEY = 'sitePolicyDenyOrigins';

export const INCLUDE_HIDDEN_DESCRIPTION =
  'When true, keep text a person cannot see: display:none, visibility:hidden, aria-hidden, opacity 0, zero-size, off-screen (more than 2000px), font-size 0, text the same colour as its background, HTML comments, and noscript or template bodies. Default false drops that text.';

export const CONFIRM_CROSS_ORIGIN_DESCRIPTION =
  'Set true only when retrying after needs_confirmation. Never set it on the first call. The MCP client approval prompt is the human check. The tool never sets this flag itself.';

const ALLOW_KEY = 'sitePolicyAllowOrigins';

export interface HiddenTextFacts {
  display?: string | null;
  visibility?: string | null;
  ariaHidden?: boolean | null;
  opacity?: number | string | null;
  width?: number | null;
  height?: number | null;
  left?: number | null;
  top?: number | null;
  right?: number | null;
  bottom?: number | null;
  viewportWidth?: number | null;
  viewportHeight?: number | null;
  fontSize?: number | string | null;
  color?: string | null;
  backgroundColor?: string | null;
  htmlComment?: boolean | null;
  tagName?: string | null;
  inNoscriptOrTemplate?: boolean | null;
}

export interface ParsedColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface HttpOriginPattern {
  protocol: 'http:' | 'https:';
  /** Exact hostname, or the suffix after `*.` when wildcard is set. */
  hostname: string;
  port: string;
  wildcard: boolean;
}

export interface CrossOriginOk {
  ok: true;
}

export interface CrossOriginConfirm {
  needs_confirmation: true;
  readOrigin: string;
  targetOrigin: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasNullByte(value: string): boolean {
  return value.includes('\0');
}

function isZeroMeasure(value: number | string | null | undefined): boolean {
  if (typeof value === 'number') return value === 0;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const parsed = Number.parseFloat(trimmed);
  return parsed === 0;
}

/** rgb(), rgba(), and #rgb / #rrggbb. Returns null when the colour is not one of those. */
export function parseCssColor(input: string | null | undefined): ParsedColor | null {
  if (!input) return null;
  const raw = input.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(raw);
  if (short) {
    const hex = short[1];
    return {
      r: Number.parseInt(hex[0] + hex[0], 16),
      g: Number.parseInt(hex[1] + hex[1], 16),
      b: Number.parseInt(hex[2] + hex[2], 16),
      a: 1,
    };
  }
  const long = /^#([0-9a-f]{6})$/.exec(raw);
  if (long) {
    const hex = long[1];
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
    raw,
  );
  if (!rgb) return null;
  const r = Number(rgb[1]);
  const g = Number(rgb[2]);
  const b = Number(rgb[3]);
  if (r > 255 || g > 255 || b > 255) return null;
  const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
  if (!Number.isFinite(alpha)) return null;
  return { r, g, b, a: alpha };
}

function sameOpaqueColor(
  color: string | null | undefined,
  background: string | null | undefined,
): boolean {
  const foreground = parseCssColor(color);
  const back = parseCssColor(background);
  if (!foreground || !back) return false;
  if (foreground.a < 0.05 || back.a < 0.05) return false;
  return foreground.r === back.r && foreground.g === back.g && foreground.b === back.b;
}

/**
 * Why a human cannot see this text, or null when it should be kept.
 * includeHidden true keeps every reason below. Order matches the contract list.
 */
export function hiddenTextDropReason(
  facts: HiddenTextFacts,
  includeHidden?: boolean,
): string | null {
  if (includeHidden === true) return null;
  if (facts.htmlComment === true) return 'html-comment';
  const tag = String(facts.tagName || '').toLowerCase();
  if (tag === 'noscript' || tag === 'template' || facts.inNoscriptOrTemplate === true) {
    return 'noscript-or-template';
  }
  if (
    String(facts.display || '')
      .trim()
      .toLowerCase() === 'none'
  )
    return 'display-none';
  if (
    String(facts.visibility || '')
      .trim()
      .toLowerCase() === 'hidden'
  )
    return 'visibility-hidden';
  if (facts.ariaHidden === true) return 'aria-hidden';
  if (isZeroMeasure(facts.opacity)) return 'opacity-0';
  if (
    typeof facts.width === 'number' &&
    typeof facts.height === 'number' &&
    facts.width === 0 &&
    facts.height === 0
  ) {
    return 'zero-size';
  }
  if (isOffScreen(facts)) return 'off-screen';
  if (isZeroMeasure(facts.fontSize)) return 'font-size-0';
  if (sameOpaqueColor(facts.color, facts.backgroundColor)) return 'same-color-as-background';
  return null;
}

function isOffScreen(facts: HiddenTextFacts): boolean {
  if (typeof facts.right === 'number' && facts.right < -OFFSCREEN_PX) return true;
  if (typeof facts.bottom === 'number' && facts.bottom < -OFFSCREEN_PX) return true;
  if (
    typeof facts.viewportWidth === 'number' &&
    typeof facts.left === 'number' &&
    facts.left > facts.viewportWidth + OFFSCREEN_PX
  ) {
    return true;
  }
  if (
    typeof facts.viewportHeight === 'number' &&
    typeof facts.top === 'number' &&
    facts.top > facts.viewportHeight + OFFSCREEN_PX
  ) {
    return true;
  }
  return false;
}

export function filterHiddenText<T>(
  items: readonly T[],
  includeHidden: boolean | undefined,
  factsOf: (item: T) => HiddenTextFacts,
): T[] {
  if (includeHidden === true) return items.slice();
  return items.filter((item) => hiddenTextDropReason(factsOf(item), false) === null);
}

function isWebStoreHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'chrome.google.com' ||
    host === 'chromewebstore.google.com' ||
    host.endsWith('.chromewebstore.google.com')
  );
}

function normalizePort(protocol: string, port: string): string {
  if (protocol === 'https:' && port === '443') return '';
  if (protocol === 'http:' && port === '80') return '';
  return port;
}

/** An allow-list entry: exact http(s) origin, or `https://*.example.com`. */
export function parseHttpOriginPattern(
  entry: unknown,
): { pattern: HttpOriginPattern } | { error: string } {
  if (typeof entry !== 'string') return { error: 'origin must be an http(s) URL' };
  const raw = entry.trim();
  if (!raw || hasNullByte(raw) || /[\r\n]/.test(raw))
    return { error: 'origin must be an http(s) URL' };
  if (raw.includes('*')) {
    const match = /^(https?):\/\/(\*\.[A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/i.exec(raw);
    if (!match) return { error: 'origin must be an http(s) URL' };
    const suffix = match[2].slice(2).toLowerCase();
    if (
      !suffix.includes('.') ||
      suffix.startsWith('.') ||
      suffix.endsWith('.') ||
      suffix.includes('..') ||
      suffix.includes('*')
    ) {
      return { error: 'origin must be an http(s) URL' };
    }
    const protocol = (match[1].toLowerCase() + ':') as 'http:' | 'https:';
    const port = normalizePort(protocol, match[3] ?? '');
    if (match[3]) {
      const n = Number(match[3]);
      if (!Number.isInteger(n) || n < 1 || n > 65535)
        return { error: 'origin must be an http(s) URL' };
    }
    return { pattern: { protocol, hostname: suffix, port, wildcard: true } };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'origin must be an http(s) URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'origin must be http or https' };
  }
  if (url.username || url.password) return { error: 'origin must not include credentials' };
  if (isWebStoreHost(url.hostname)) {
    return { error: 'Chrome Web Store origins cannot receive permissions' };
  }
  if (!url.hostname) return { error: 'origin must be an http(s) URL' };
  return {
    pattern: {
      protocol: url.protocol,
      hostname: url.hostname.toLowerCase(),
      port: normalizePort(url.protocol, url.port),
      wildcard: false,
    },
  };
}

export function httpOriginMatchesPattern(origin: string, pattern: HttpOriginPattern): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== pattern.protocol) return false;
  if (normalizePort(url.protocol, url.port) !== pattern.port) return false;
  const host = url.hostname.toLowerCase();
  if (!pattern.wildcard) return host === pattern.hostname;
  const suffix = '.' + pattern.hostname;
  return host.endsWith(suffix) && host.length > suffix.length;
}

/**
 * Fail closed for grant and recording. A listed entry may be an exact origin
 * or a host wildcard. The candidate origin must already be a normalized http(s) origin.
 */
export function matchNormalizedOrigin(
  origin: string,
  stored: unknown,
  toolName = 'chrome_grant_permission',
): { origin: string } | { error: string } {
  if (stored === undefined || stored === null) {
    return {
      error: `Origin is not listed in site policy (storage key ${ALLOW_KEY}). ${toolName} refused.`,
    };
  }
  if (!Array.isArray(stored)) {
    return { error: `${ALLOW_KEY} is malformed. Expected an array of http(s) origins.` };
  }
  let matched = false;
  for (const entry of stored) {
    const pattern = parseHttpOriginPattern(entry);
    if ('error' in pattern) return { error: `${ALLOW_KEY} is malformed. ${pattern.error}` };
    if (httpOriginMatchesPattern(origin, pattern.pattern)) matched = true;
  }
  if (!matched) {
    return {
      error: `Origin ${origin} is not listed in site policy (storage key ${ALLOW_KEY}). ${toolName} refused.`,
    };
  }
  return { origin };
}

export type DenyPattern =
  | { kind: 'scheme'; protocol: string }
  | { kind: 'http'; pattern: HttpOriginPattern };

export function parseDenyPattern(entry: unknown): DenyPattern | { error: string } {
  if (typeof entry !== 'string') return { error: 'origin pattern must be a string' };
  const raw = entry.trim();
  if (!raw || hasNullByte(raw)) return { error: 'origin pattern must be a string' };
  if (/^[a-z][a-z0-9+.-]*:$/i.test(raw)) {
    return { kind: 'scheme', protocol: raw.toLowerCase() };
  }
  if (
    /^(chrome|chrome-extension|edge|moz-extension|about|file|view-source|data|blob):/i.test(raw)
  ) {
    const protocol = raw.slice(0, raw.indexOf(':')).toLowerCase() + ':';
    return { kind: 'scheme', protocol };
  }
  const http = parseHttpOriginPattern(raw);
  if ('error' in http) {
    return {
      error: 'origin pattern must be http(s), a host wildcard, or a scheme such as chrome:',
    };
  }
  return { kind: 'http', pattern: http.pattern };
}

function denyMatches(url: URL, pattern: DenyPattern): boolean {
  if (pattern.kind === 'scheme') return url.protocol === pattern.protocol;
  return httpOriginMatchesPattern(url.origin, pattern.pattern);
}

const DENIED_PROTOCOLS = new Set([
  'chrome:',
  'chrome-extension:',
  'edge:',
  'moz-extension:',
  'view-source:',
  'file:',
  'data:',
  'blob:',
  'javascript:',
  'about:',
]);

/** Origin label used by the cross-origin guard. about:blank stays about:blank. */
export function policyOrigin(url: string | null | undefined): string {
  if (!url) return 'unknown';
  const raw = url.trim();
  if (!raw) return 'unknown';
  if (isAboutBlank(raw)) return 'about:blank';
  try {
    const parsed = new URL(raw);
    if (!parsed.origin || parsed.origin === 'null') return 'unknown';
    return parsed.origin;
  } catch {
    return 'unknown';
  }
}

function isAboutBlank(url: string): boolean {
  return (
    url === 'about:blank' ||
    url.startsWith('about:blank#') ||
    url.startsWith('about:blank?') ||
    url === 'about:srcdoc'
  );
}

/**
 * The one site-policy decision. Default mode denies browser-internal pages and
 * any extra deny patterns, and allows other http(s) origins. Allowlist mode
 * also requires a matching allow pattern. The default denylist always wins.
 */
export function evaluateSitePolicy(input: {
  url?: string | null;
  allow?: unknown;
  deny?: unknown;
  mode?: unknown;
}): { ok: true; origin: string } | { error: string } {
  const raw = String(input.url ?? '').trim();
  if (!raw) return { error: 'Site policy could not read a tab URL. The call was refused.' };
  if (isAboutBlank(raw)) return { ok: true, origin: 'about:blank' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `Site policy denied an unreadable URL. The call was refused.` };
  }

  const shown = raw.length > 180 ? raw.slice(0, 180) : raw;
  if (DENIED_PROTOCOLS.has(url.protocol) || !url.origin || url.origin === 'null') {
    return {
      error: `Site policy denied ${shown}. Browser-internal pages are on the default denylist (chrome://, extension pages, the Chrome Web Store, password-manager, and OS settings).`,
    };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      error: `Site policy denied ${shown}. Only http(s) pages are allowed, plus about:blank.`,
    };
  }
  if (isWebStoreHost(url.hostname)) {
    return {
      error: `Site policy denied ${url.origin}. The Chrome Web Store is on the default denylist.`,
    };
  }

  if (input.deny !== undefined && input.deny !== null) {
    if (!Array.isArray(input.deny)) {
      return {
        error: `${SITE_POLICY_DENY_ORIGINS_KEY} is malformed. Expected an array of origin patterns.`,
      };
    }
    for (const entry of input.deny) {
      const pattern = parseDenyPattern(entry);
      if ('error' in pattern) {
        return { error: `${SITE_POLICY_DENY_ORIGINS_KEY} is malformed. ${pattern.error}` };
      }
      if (denyMatches(url, pattern)) {
        return {
          error: `Origin ${url.origin} is denied by site policy (storage key ${SITE_POLICY_DENY_ORIGINS_KEY}).`,
        };
      }
    }
  }

  const mode = input.mode;
  if (mode !== undefined && mode !== null && mode !== 'default' && mode !== 'allowlist') {
    return { error: `${SITE_POLICY_MODE_KEY} is malformed. Expected "default" or "allowlist".` };
  }
  if (mode === 'allowlist') {
    const listed = matchNormalizedOrigin(url.origin, input.allow, 'this tool');
    if ('error' in listed) {
      if (listed.error.includes('malformed')) return listed;
      return {
        error: `Origin ${url.origin} is not listed in site policy (storage key ${ALLOW_KEY}). Allowlist-only mode refused the call.`,
      };
    }
  }
  return { ok: true, origin: url.origin };
}

/** True only when the argument is the boolean true. A string never counts. */
export function confirmCrossOriginFlag(args: unknown): boolean {
  return isRecord(args) && args.confirmCrossOrigin === true;
}

export function decideCrossOrigin(input: {
  readOrigin?: string | null;
  readAtMs?: number | null;
  nowMs: number;
  targetOrigin?: string | null;
  confirmCrossOrigin?: boolean;
}): CrossOriginOk | CrossOriginConfirm {
  if (input.confirmCrossOrigin === true) return { ok: true };
  const readOrigin = String(input.readOrigin || '').trim();
  const targetOrigin = String(input.targetOrigin || '').trim();
  if (!readOrigin || readOrigin === 'unknown' || !targetOrigin || targetOrigin === 'unknown') {
    return { ok: true };
  }
  if (typeof input.readAtMs !== 'number' || !Number.isFinite(input.readAtMs)) return { ok: true };
  const elapsed = input.nowMs - input.readAtMs;
  if (elapsed < 0 || elapsed > CROSS_ORIGIN_WINDOW_MS) return { ok: true };
  if (readOrigin === targetOrigin) return { ok: true };
  return {
    needs_confirmation: true,
    readOrigin,
    targetOrigin,
    message: `Needs confirmation before acting on ${targetOrigin}. The last page read was ${readOrigin} within the last 60s. Retry the same call with confirmCrossOrigin:true. Do not set that flag unless a person approved it.`,
  };
}

function queryAndBody(url: string, body: unknown): string {
  let search = '';
  try {
    const parsed = new URL(url);
    search = parsed.search;
    parsed.searchParams.forEach((value, key) => {
      search += ` ${key} ${value}`;
    });
  } catch {
    const query = url.indexOf('?');
    if (query >= 0) search = url.slice(query);
  }
  let bodyText = '';
  if (typeof body === 'string') bodyText = body;
  else if (body !== undefined && body !== null) {
    try {
      bodyText = JSON.stringify(body) ?? '';
    } catch {
      bodyText = '';
    }
  }
  return `${search}\n${bodyText}`;
}

/**
 * Refuse when a URL query or body contains a cookie or token value this
 * session already returned. The error does not repeat the value.
 * confirmCrossOrigin true is the only bypass, and the caller must not set it.
 */
export function findExfiltratedSecret(input: {
  url: string;
  body?: unknown;
  secrets: readonly string[];
  confirmCrossOrigin?: boolean;
}): { ok: true } | { error: string } {
  if (input.confirmCrossOrigin === true) return { ok: true };
  const haystack = queryAndBody(input.url, input.body);
  for (const secret of input.secrets) {
    if (typeof secret !== 'string' || secret.length < MIN_EXFIL_SECRET_LENGTH) continue;
    if (haystack.includes(secret)) {
      return {
        error:
          'Refused: the URL query or body contains a cookie or token value returned earlier in this session. Retry with confirmCrossOrigin:true only after a person approves. The value was not repeated in this error.',
      };
    }
  }
  return { ok: true };
}

const SKIP_SITE_POLICY = new Set([
  'get_windows_and_tabs',
  'search_tabs_content',
  'chrome_history',
  'chrome_bookmark_search',
  'chrome_bookmark_add',
  'chrome_bookmark_delete',
  'chrome_close_tabs',
  'chrome_switch_tab',
  'chrome_move_tabs',
  'chrome_create_window',
  'chrome_update_window',
  'chrome_close_window',
  'chrome_update_tab',
  'chrome_discard_tabs',
  'chrome_duplicate_tab',
  'chrome_reload_tabs',
  'chrome_query_tabs',
  'chrome_group_tabs',
  'chrome_ungroup_tabs',
  'chrome_update_tab_group',
  'chrome_list_tab_groups',
  'chrome_flow_list',
  'chrome_flow_export',
  'chrome_audit_log',
  'chrome_reload_extension',
  'record_replay_list_published',
  'chrome_handle_download',
]);

const PAGE_READ_TOOLS = new Set([
  'chrome_read_page',
  'chrome_snapshot',
  'chrome_find',
  'chrome_get_web_content',
  'chrome_console',
  'chrome_network_capture',
  'chrome_network_request',
  'chrome_cookies',
  'chrome_storage',
  'chrome_clipboard',
  'chrome_wait_for',
  'chrome_get_interactive_elements',
  'chrome_javascript',
]);

function absoluteUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'back' || trimmed === 'forward') return '';
  try {
    const url = new URL(trimmed);
    if (!url.protocol || url.protocol === 'about:') return trimmed;
    return trimmed;
  } catch {
    return '';
  }
}

/** What the choke point must check before the tool touches a tab. */
export function collectSitePolicyTargets(
  toolName: string,
  args: unknown,
): { urls: string[]; needsTab: boolean } {
  const record = isRecord(args) ? args : {};
  const url = absoluteUrl(record.url);
  if (toolName === 'chrome_navigate') {
    if (record.refresh === true || record.url === 'back' || record.url === 'forward') {
      return { urls: [], needsTab: true };
    }
    return { urls: url ? [url] : [], needsTab: !url };
  }
  if (toolName === 'chrome_network_request') {
    return { urls: url ? [url] : [], needsTab: true };
  }
  if (toolName === 'chrome_cookies') {
    if (url) return { urls: [url], needsTab: false };
    if (typeof record.domain === 'string' && record.domain.trim()) {
      const host = record.domain.trim().replace(/^\./, '');
      return { urls: [`https://${host}`], needsTab: false };
    }
    return { urls: [], needsTab: false };
  }
  if (toolName === 'chrome_grant_permission') {
    return {
      urls: typeof record.origin === 'string' && record.origin.trim() ? [record.origin.trim()] : [],
      needsTab: false,
    };
  }
  if (
    toolName === 'chrome_get_web_content' ||
    toolName === 'chrome_console' ||
    toolName === 'chrome_network_capture'
  ) {
    return { urls: url ? [url] : [], needsTab: !url };
  }
  if (SKIP_SITE_POLICY.has(toolName)) {
    return { urls: url ? [url] : [], needsTab: false };
  }
  return { urls: url ? [url] : [], needsTab: true };
}

export function toolNotesPageRead(toolName: string): boolean {
  return PAGE_READ_TOOLS.has(toolName);
}

export function highRiskToggleForTool(
  toolName: string,
): 'javascript' | 'upload' | 'userscript' | null {
  if (toolName === 'chrome_javascript') return 'javascript';
  if (toolName === 'chrome_upload_file') return 'upload';
  if (toolName === 'chrome_userscript') return 'userscript';
  return null;
}

export function crossOriginAction(
  toolName: string,
  args: unknown,
): 'click' | 'fill' | 'javascript' | null {
  if (toolName === 'chrome_click_element') return 'click';
  if (
    toolName === 'chrome_fill_or_select' ||
    toolName === 'chrome_fill_form' ||
    toolName === 'chrome_keyboard'
  ) {
    return 'fill';
  }
  if (toolName === 'chrome_javascript') return 'javascript';
  if (toolName === 'chrome_computer') {
    const action = isRecord(args) ? args.action : undefined;
    if (typeof action !== 'string') return null;
    if (
      action === 'left_click' ||
      action === 'right_click' ||
      action === 'double_click' ||
      action === 'triple_click' ||
      action === 'left_click_drag' ||
      action === 'hover'
    ) {
      return 'click';
    }
    if (action === 'type' || action === 'fill' || action === 'fill_form' || action === 'key') {
      return 'fill';
    }
  }
  return null;
}

export function exfiltrationInput(
  toolName: string,
  args: unknown,
): { url: string; body?: unknown } | null {
  if (toolName !== 'chrome_network_request' && toolName !== 'chrome_navigate') return null;
  if (!isRecord(args) || typeof args.url !== 'string') return null;
  const url = args.url.trim();
  if (!url || url === 'back' || url === 'forward') return null;
  if (toolName === 'chrome_navigate') return { url };
  return { url, body: args.body !== undefined ? args.body : args.formData };
}

const REDACTED_ARG_KEYS = new Set([
  'value',
  'values',
  'text',
  'password',
  'secret',
  'token',
  'cookie',
  'cookies',
  'body',
  'code',
  'script',
  'base64data',
  'html',
  'htmlcontent',
  'prompttext',
]);

function redactQuery(url: string): string {
  const query = url.indexOf('?');
  if (query < 0) return url;
  return url.slice(0, query) + '?[redacted]';
}

/** Arg summary for the audit log. Fill values, cookie values, and URL queries are redacted. */
export function summarizeToolArgs(args: unknown): string {
  if (!isRecord(args)) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const lower = key.toLowerCase();
    if (
      REDACTED_ARG_KEYS.has(lower) ||
      lower.includes('password') ||
      lower.includes('secret') ||
      lower.includes('token') ||
      lower.includes('cookie')
    ) {
      parts.push(`${key}=[redacted]`);
      continue;
    }
    if (key === 'fields' || key === 'elements' || key === 'formData') {
      const count = Array.isArray(value) ? value.length : 1;
      parts.push(`${key}=${count} value=[redacted]`);
      continue;
    }
    if ((key === 'url' || key === 'origin') && typeof value === 'string') {
      parts.push(`${key}=${redactQuery(value).slice(0, 180)}`);
      continue;
    }
    if (typeof value === 'string') {
      parts.push(`${key}=${value.replace(/[\r\n]/g, ' ').slice(0, 80)}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${String(value)}`);
    } else if (value == null) {
      continue;
    } else {
      parts.push(`${key}=[object]`);
    }
  }
  return parts.join(' ').slice(0, 300);
}

/** Page-derived text, including a JSON value, inside the untrusted envelope. */
export function wrapPageValue(origin: string | null | undefined, value: unknown): string {
  let text = '';
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value) ?? '';
    } catch {
      text = '';
    }
  }
  return wrapUntrusted(origin, text);
}

export function wrapPageLines(origin: string | null | undefined, lines: readonly string[]): string {
  return wrapUntrusted(origin, lines.join('\n'));
}

const NETWORK_BODY_KEYS = new Set(['responseBody', 'requestBody', 'body']);

/** Wrap network response and request bodies. Other fields stay structured. */
export function sealNetworkBodies(value: unknown, origin?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => sealNetworkBodies(item, origin));
  if (!isRecord(value)) return value;
  const nextOrigin = typeof value.url === 'string' ? value.url : origin;
  const sealed: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      NETWORK_BODY_KEYS.has(key) &&
      child != null &&
      (typeof child === 'string' || typeof child === 'object')
    ) {
      sealed[key] = wrapPageValue(nextOrigin, child);
    } else {
      sealed[key] = sealNetworkBodies(child, nextOrigin);
    }
  }
  return sealed;
}

export function parseAuditLimit(value: unknown): number | { error: string } {
  if (value === undefined || value === null) return AUDIT_READ_DEFAULT;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > AUDIT_READ_MAX
  ) {
    return { error: `limit must be an integer from 1 to ${AUDIT_READ_MAX}` };
  }
  return value;
}
