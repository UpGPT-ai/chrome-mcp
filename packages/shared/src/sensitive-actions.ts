/**
 * Pure helpers for chrome_grant_permission, chrome_clipboard, and chrome_request_human.
 * The extension applies them. Live CDP and the overlay are verified manually.
 * Site-policy allow entries are exact http(s) origins or host wildcards
 * such as https://*.example.com. The choke point for every tool lives in
 * evaluateSitePolicy. This file does not build an options page.
 */

import { matchNormalizedOrigin } from './injection-guard';

export const SITE_POLICY_ALLOW_ORIGINS_KEY = 'sitePolicyAllowOrigins';

/** Rotate ~/.chrome-mcp-agent/audit.log once it reaches this size. */
export const AUDIT_ROTATE_BYTES = 5_000_000;

export const HANDOFF_BANNER_TEXT = 'Waiting for you';

export const DEFAULT_HANDOFF_TIMEOUT_MS = 120_000;
export const MIN_HANDOFF_TIMEOUT_MS = 1_000;
export const MAX_HANDOFF_TIMEOUT_MS = 600_000;

export const MAX_CLIPBOARD_CHARS = 100_000;
export const MAX_HANDOFF_REASON_CHARS = 240;
export const MAX_SELECTOR_CHARS = 1_000;

export const GRANT_PERMISSION_NAMES = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'clipboardReadWrite',
] as const;

export type GrantPermissionName = (typeof GRANT_PERMISSION_NAMES)[number];

/** Contract names mapped to CDP Browser.PermissionType values. */
export const CDP_PERMISSION_BY_NAME: Record<GrantPermissionName, string> = {
  camera: 'videoCapture',
  microphone: 'audioCapture',
  geolocation: 'geolocation',
  notifications: 'notifications',
  clipboardReadWrite: 'clipboardReadWrite',
};

const AGENT_REF = /^(ref_\d+)(?:@(\d+))?$/;
const CDP_REF = /^cdp_\d+$/;

const HANDOFF_REFUSED_KEYS = [
  'solve',
  'bypass',
  'token',
  'captcha',
  'captchaToken',
  'autoClick',
  'autoSolve',
  'passkey',
] as const;

const WEBSTORE_DENIED = 'Chrome Web Store origins cannot receive permissions';
const ORIGIN_DENIED = 'origin must be http or https';
const ORIGIN_SHAPE = 'origin must be an http(s) URL';

export interface ParsedGrant {
  mode: 'grant';
  origin: string;
  permissions: GrantPermissionName[];
  cdpPermissions: string[];
  tabId?: number;
  windowId?: number;
}

export interface ParsedReset {
  mode: 'reset';
  origin: string;
  tabId?: number;
  windowId?: number;
}

export type ParsedGrantArgs = ParsedGrant | ParsedReset;

export interface ParsedClipboardRead {
  action: 'read';
  tabId?: number;
  windowId?: number;
}

export interface ParsedClipboardWrite {
  action: 'write';
  text: string;
  tabId?: number;
  windowId?: number;
}

export type ParsedClipboardArgs = ParsedClipboardRead | ParsedClipboardWrite;

export interface ParsedRequestHuman {
  timeoutMs: number;
  /** Local ref inside the target frame, without a @frameId suffix. */
  ref?: string;
  frameId?: number;
  selector?: string;
  reason?: string;
  tabId?: number;
  windowId?: number;
}

export interface AuditLineInput {
  time: string;
  tool: string;
  origin: string;
  summary: string;
  result: 'ok' | 'error';
  detail?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFailure(value: unknown): value is { error: string } {
  return isRecord(value) && typeof value.error === 'string';
}

function hasNullByte(value: string): boolean {
  return value.includes('\0');
}

function oneLine(value: string, max: number): string {
  return value.replace(/[\r\n]/g, ' ').slice(0, max);
}

function optionalId(value: unknown, name: string): number | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { error: `${name} must be a non-negative integer` };
  }
  return value;
}

function isWebStoreHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'chrome.google.com' ||
    host === 'chromewebstore.google.com' ||
    host.endsWith('.chromewebstore.google.com')
  );
}

/** Exact http(s) origin. Rejects chrome://, extensions, and the Chrome Web Store. */
export function httpOrigin(input: unknown): { origin: string } | { error: string } {
  if (typeof input !== 'string') return { error: ORIGIN_SHAPE };
  const raw = input.trim();
  if (!raw || hasNullByte(raw)) return { error: ORIGIN_SHAPE };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: ORIGIN_SHAPE };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: ORIGIN_DENIED };
  if (url.username || url.password) return { error: 'origin must not include credentials' };
  if (isWebStoreHost(url.hostname)) return { error: WEBSTORE_DENIED };
  if (!url.origin || url.origin === 'null') return { error: ORIGIN_DENIED };
  return { origin: url.origin };
}

function isGrantName(value: string): value is GrantPermissionName {
  return (GRANT_PERMISSION_NAMES as readonly string[]).includes(value);
}

export function parseGrantPermissionArgs(args: unknown): ParsedGrantArgs | { error: string } {
  if (!isRecord(args)) return { error: 'arguments must be an object' };
  const origin = httpOrigin(args.origin);
  if ('error' in origin) return origin;

  const resetGiven = args.reset !== undefined && args.reset !== null;
  if (resetGiven && typeof args.reset !== 'boolean') return { error: 'reset must be a boolean' };
  const reset = args.reset === true;
  const permissionsGiven = args.permissions !== undefined && args.permissions !== null;
  if (reset && permissionsGiven) {
    return { error: 'pass reset or permissions, not both' };
  }
  if (reset) {
    const tabId = optionalId(args.tabId, 'tabId');
    if (isFailure(tabId)) return tabId;
    const windowId = optionalId(args.windowId, 'windowId');
    if (isFailure(windowId)) return windowId;
    return { mode: 'reset', origin: origin.origin, tabId, windowId };
  }
  if (!permissionsGiven) return { error: 'permissions or reset is required' };
  if (!Array.isArray(args.permissions) || args.permissions.length === 0) {
    return { error: 'permissions must be a non-empty array' };
  }

  const permissions: GrantPermissionName[] = [];
  const seen = new Set<string>();
  for (const entry of args.permissions) {
    if (typeof entry !== 'string' || !isGrantName(entry)) {
      return {
        error: `unknown permission. Expected one of: ${GRANT_PERMISSION_NAMES.join(', ')}`,
      };
    }
    if (seen.has(entry)) return { error: `permissions contain a duplicate: ${entry}` };
    seen.add(entry);
    permissions.push(entry);
  }
  const tabId = optionalId(args.tabId, 'tabId');
  if (isFailure(tabId)) return tabId;
  const windowId = optionalId(args.windowId, 'windowId');
  if (isFailure(windowId)) return windowId;
  return {
    mode: 'grant',
    origin: origin.origin,
    permissions,
    cdpPermissions: permissions.map((name) => CDP_PERMISSION_BY_NAME[name]),
    tabId,
    windowId,
  };
}

/**
 * Fail closed. A missing or empty list refuses the grant. A present list
 * matches exact http(s) origins and host wildcards such as https://*.example.com.
 */
export function matchSitePolicyOrigin(
  origin: string,
  stored: unknown,
  toolName = 'chrome_grant_permission',
): { origin: string } | { error: string } {
  const normalized = httpOrigin(origin);
  if ('error' in normalized) return normalized;
  return matchNormalizedOrigin(normalized.origin, stored, toolName);
}

export function parseClipboardArgs(args: unknown): ParsedClipboardArgs | { error: string } {
  if (!isRecord(args)) return { error: 'arguments must be an object' };
  if (args.action !== 'read' && args.action !== 'write') {
    return { error: 'action must be read or write' };
  }
  const tabId = optionalId(args.tabId, 'tabId');
  if (isFailure(tabId)) return tabId;
  const windowId = optionalId(args.windowId, 'windowId');
  if (isFailure(windowId)) return windowId;
  if (args.action === 'read') return { action: 'read', tabId, windowId };
  if (typeof args.text !== 'string') return { error: 'write needs text' };
  if (hasNullByte(args.text)) return { error: 'text contains a null byte' };
  if (args.text.length > MAX_CLIPBOARD_CHARS) {
    return { error: `text is longer than ${MAX_CLIPBOARD_CHARS} characters` };
  }
  return { action: 'write', text: args.text, tabId, windowId };
}

export function parseRequestHumanArgs(args: unknown): ParsedRequestHuman | { error: string } {
  if (!isRecord(args)) return { error: 'arguments must be an object' };
  for (const key of HANDOFF_REFUSED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      return {
        error: 'chrome_request_human does not solve CAPTCHA, passkey, or security-key prompts.',
      };
    }
  }

  let timeoutMs = DEFAULT_HANDOFF_TIMEOUT_MS;
  if (args.timeoutMs !== undefined && args.timeoutMs !== null) {
    if (typeof args.timeoutMs !== 'number' || !Number.isInteger(args.timeoutMs)) {
      return { error: 'timeoutMs must be an integer' };
    }
    if (args.timeoutMs < MIN_HANDOFF_TIMEOUT_MS || args.timeoutMs > MAX_HANDOFF_TIMEOUT_MS) {
      return {
        error: `timeoutMs must be from ${MIN_HANDOFF_TIMEOUT_MS} to ${MAX_HANDOFF_TIMEOUT_MS}`,
      };
    }
    timeoutMs = args.timeoutMs;
  }

  const refGiven = args.ref !== undefined && args.ref !== null && args.ref !== '';
  const selectorGiven =
    args.selector !== undefined && args.selector !== null && args.selector !== '';
  if (refGiven && selectorGiven) return { error: 'pass ref or selector, not both' };

  let ref: string | undefined;
  let frameFromRef: number | undefined;
  if (refGiven) {
    if (typeof args.ref !== 'string') return { error: 'ref must be a string' };
    const raw = args.ref.trim();
    if (CDP_REF.test(raw)) {
      return {
        error: 'cdp_ refs cannot be highlighted. Pass a ref_ ref or a CSS selector.',
      };
    }
    const match = raw.match(AGENT_REF);
    if (!match) return { error: 'ref must look like ref_N or ref_N@frameId' };
    ref = match[1];
    if (match[2] !== undefined) frameFromRef = Number(match[2]);
  }

  let selector: string | undefined;
  if (selectorGiven) {
    if (typeof args.selector !== 'string') return { error: 'selector must be a string' };
    const raw = args.selector.trim();
    if (!raw) return { error: 'selector is empty' };
    if (hasNullByte(raw) || raw.length > MAX_SELECTOR_CHARS) {
      return { error: 'selector is invalid' };
    }
    selector = raw;
  }

  const frameId = optionalId(args.frameId, 'frameId');
  if (isFailure(frameId)) return frameId;
  if (frameFromRef !== undefined && frameId !== undefined && frameFromRef !== frameId) {
    return { error: 'frameId does not match the ref suffix' };
  }

  let reason: string | undefined;
  if (args.reason !== undefined && args.reason !== null) {
    if (typeof args.reason !== 'string') return { error: 'reason must be a string' };
    const raw = args.reason.trim();
    if (hasNullByte(raw) || raw.length > MAX_HANDOFF_REASON_CHARS) {
      return { error: `reason must be at most ${MAX_HANDOFF_REASON_CHARS} characters` };
    }
    if (raw) reason = raw;
  }

  const tabId = optionalId(args.tabId, 'tabId');
  if (isFailure(tabId)) return tabId;
  const windowId = optionalId(args.windowId, 'windowId');
  if (isFailure(windowId)) return windowId;

  return {
    timeoutMs,
    ref,
    frameId: frameFromRef ?? frameId,
    selector,
    reason,
    tabId,
    windowId,
  };
}

export function auditShouldRotate(sizeBytes: number): boolean {
  return Number.isFinite(sizeBytes) && sizeBytes >= AUDIT_ROTATE_BYTES;
}

/** One JSON object and no raw newline, so the native host can append it as JSONL. */
export function formatAuditLine(input: AuditLineInput): string {
  const record: Record<string, string> = {
    time: oneLine(String(input.time ?? ''), 40),
    tool: oneLine(String(input.tool ?? ''), 80),
    origin: oneLine(String(input.origin ?? ''), 200),
    summary: oneLine(String(input.summary ?? ''), 300),
    result: input.result === 'ok' ? 'ok' : 'error',
  };
  if (input.detail) record.detail = oneLine(String(input.detail), 300);
  return JSON.stringify(record);
}

export function grantAuditInput(input: {
  time: string;
  origin: string;
  action: 'grant' | 'reset' | 'disabled' | 'invalid';
  permissions?: readonly string[];
  result: 'ok' | 'error';
  detail?: string;
}): AuditLineInput {
  const summary =
    input.action === 'grant' ? `grant ${(input.permissions ?? []).join(',')}` : input.action;
  return {
    time: input.time,
    tool: 'chrome_grant_permission',
    origin: input.origin,
    summary,
    result: input.result,
    detail: input.detail,
  };
}

export function auditGrantLine(input: {
  time: string;
  origin: string;
  action: 'grant' | 'reset' | 'disabled' | 'invalid';
  permissions?: readonly string[];
  result: 'ok' | 'error';
  detail?: string;
}): string {
  return formatAuditLine(grantAuditInput(input));
}

export function clipboardAuditInput(input: {
  time: string;
  origin: string;
  action: 'read' | 'write' | 'disabled' | 'invalid';
  result: 'ok' | 'error';
  detail?: string;
}): AuditLineInput {
  return {
    time: input.time,
    tool: 'chrome_clipboard',
    origin: input.origin,
    summary: input.action,
    result: input.result,
    detail: input.detail,
  };
}

/** Drop written clipboard text if a CDP error echoes the evaluate expression. */
export function redactClipboardDetail(message: string, text: string | undefined): string {
  if (!text) return message;
  return message.split(text).join('[redacted]');
}

/** action and result only. Clipboard text is not a parameter and is not stored. */
export function auditClipboardLine(input: {
  time: string;
  origin: string;
  action: 'read' | 'write' | 'disabled' | 'invalid';
  result: 'ok' | 'error';
  detail?: string;
}): string {
  return formatAuditLine(clipboardAuditInput(input));
}
