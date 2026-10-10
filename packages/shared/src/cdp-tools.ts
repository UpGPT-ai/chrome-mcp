/**
 * Pure helpers for chrome_file_chooser, pierce snapshots, and chrome_print_pdf.
 * Argument checks and path containment live here. The extension applies them.
 * Live CDP behaviour is verified manually, not by these helpers.
 */

export const FILE_CHOOSER_ALLOW_DIRS_KEY = 'fileChooserAllowDirs';

/** Raw PDF bytes. Base64 plus the JSON envelope must stay under native messaging. */
export const NATIVE_PDF_BYTE_LIMIT = 2_500_000;

const DEFAULT_CHOOSER_TIMEOUT_MS = 8000;
const MIN_CHOOSER_TIMEOUT_MS = 500;
const MAX_CHOOSER_TIMEOUT_MS = 60_000;
const MAX_CHOOSER_PATHS = 20;
const MAX_PATH_LENGTH = 4096;
const PIERCE_NAME_LIMIT = 100;
const PIERCE_VALUE_LIMIT = 80;

const SKIP_WALK = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);
const SKIP_EMIT = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'HEAD',
  'HTML',
  'BODY',
  'META',
  'LINK',
  'TITLE',
  'BR',
  'WBR',
]);

const TAG_ROLES: Record<string, string> = {
  A: 'link',
  BUTTON: 'button',
  SELECT: 'combobox',
  TEXTAREA: 'textbox',
  SUMMARY: 'button',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
  IMG: 'image',
  NAV: 'navigation',
  MAIN: 'main',
  HEADER: 'banner',
  FOOTER: 'contentinfo',
  FORM: 'form',
  ASIDE: 'complementary',
  SECTION: 'region',
  ARTICLE: 'article',
  UL: 'list',
  OL: 'list',
  LI: 'listitem',
  TABLE: 'table',
  OPTION: 'option',
  LABEL: 'label',
  DIALOG: 'dialog',
  P: 'paragraph',
  IFRAME: 'iframe',
};

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'slider',
  'searchbox',
  'switch',
  'option',
]);

const LANDMARK_ROLES = new Set([
  'navigation',
  'main',
  'banner',
  'contentinfo',
  'complementary',
  'form',
  'region',
  'search',
  'dialog',
  'table',
  'list',
]);

const PAGE_RANGES = /^\d+(-\d+)?(\s*,\s*\d+(-\d+)?)*$/;
const CDP_REF = /^cdp_(\d+)$/;

export type PathStyle = 'posix' | 'win' | 'unc';

export interface NormalizedPath {
  path: string;
  style: PathStyle;
}

export interface ParsedFileChooserArgs {
  ref?: string;
  selector?: string;
  frameId?: number;
  tabId?: number;
  windowId?: number;
  timeoutMs: number;
}

export interface CdpDomNode {
  nodeType?: number;
  nodeName?: string;
  nodeValue?: string;
  backendNodeId?: number;
  attributes?: string[];
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
  contentDocument?: CdpDomNode;
}

export interface PierceFormatOptions {
  filter: 'interactive' | 'all';
  maxItems: number;
  /** When set, only these backendNodeIds are emitted. Children are still walked. */
  inViewport?: ReadonlySet<number>;
  /** Emit only this node's subtree. The node itself is included when it qualifies. */
  rootBackendNodeId?: number;
  /** Cap for each name and value. Defaults to the built-in pierce limits. */
  maxNameChars?: number;
}

export interface PierceSnapshotText {
  lines: string[];
  /** Nearest preceding landmark for each line, in document order. */
  groups: string[];
  omittedGroups: Record<string, number>;
  truncated: boolean;
  omitted: number;
  missingRoot: boolean;
}

export interface ViewportRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface LayoutViewportBox {
  pageX?: number;
  pageY?: number;
  clientWidth?: number;
  clientHeight?: number;
}

export interface ParsedPrintPdfArgs {
  landscape: boolean;
  printBackground: boolean;
  pageRanges?: string;
  saveName: string;
  tabId?: number;
  windowId?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFailure(value: unknown): value is { error: string } {
  return isRecord(value) && typeof value.error === 'string';
}

function optionalId(value: unknown, name: string): number | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { error: `${name} must be a non-negative integer` };
  }
  return value;
}

function optionalBool(value: unknown, name: string): boolean | undefined | { error: string } {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') return { error: `${name} must be a boolean` };
  return value;
}

export function isAbsolutePath(input: string): boolean {
  if (typeof input !== 'string' || !input || input.includes('\0')) return false;
  if (input.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(input)) return true;
  if (input.startsWith('\\\\')) return true;
  return false;
}

/** Collapse `.` and `..` and repeated separators. Absolute paths only. */
export function normalizePath(input: string): NormalizedPath | { error: string } {
  if (typeof input !== 'string') return { error: 'path must be a string' };
  if (input.includes('\0')) return { error: 'path contains a null byte' };
  const raw = input.trim();
  if (!raw) return { error: 'path is empty' };

  let style: PathStyle;
  let prefix = '';
  let rest = raw;

  if (/^[A-Za-z]:(?:[\\/]|$)/.test(raw)) {
    style = 'win';
    prefix = raw.slice(0, 2).toUpperCase();
    rest = raw.slice(2);
  } else if (raw.startsWith('\\\\')) {
    style = 'unc';
    const body = raw
      .slice(2)
      .split(/[\\/]+/)
      .filter(Boolean);
    if (body.length < 2) return { error: 'UNC path needs a server and a share' };
    prefix = `\\\\${body[0]}\\${body[1]}`;
    rest = body.slice(2).join('\\');
  } else if (raw.startsWith('/')) {
    style = 'posix';
    prefix = '';
    rest = raw;
  } else {
    return { error: 'path must be absolute' };
  }

  const parts = rest.split(/[\\/]+/).filter((part) => part.length > 0 && part !== '.');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }

  const sep = style === 'posix' ? '/' : '\\';
  let path: string;
  if (style === 'posix') path = `/${stack.join('/')}`;
  else if (stack.length === 0) path = style === 'unc' ? prefix : `${prefix}${sep}`;
  else path = `${prefix}${sep}${stack.join(sep)}`;
  return { path, style };
}

/**
 * True when `target` is a file strictly inside `dir`.
 * `/tmp/allow` does not contain `/tmp/allow-extra`.
 */
export function pathInsideDir(dir: string, target: string): boolean {
  const root = normalizePath(dir);
  const child = normalizePath(target);
  if ('error' in root || 'error' in child) return false;
  if (root.style !== child.style) return false;
  const sep = root.style === 'posix' ? '/' : '\\';
  const fold = (value: string) => (root.style === 'posix' ? value : value.toLowerCase());
  const prefix = fold(root.path).replace(/[\\/]+$/, '') + sep;
  return fold(child.path).startsWith(prefix);
}

/**
 * null means no allow-list is configured, so absolute paths are accepted.
 * A malformed value is an error. Item 8's options page is not required.
 */
export function parseFileAllowDirs(stored: unknown): string[] | null | { error: string } {
  if (stored === undefined || stored === null || stored === '') return null;
  let items: unknown[];
  if (typeof stored === 'string') {
    const lines = stored
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    items = lines;
  } else if (Array.isArray(stored)) {
    if (stored.length === 0) return null;
    items = stored;
  } else {
    return { error: 'fileChooserAllowDirs must be a list of absolute directories' };
  }

  const dirs: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string' || !item.trim()) {
      return { error: 'fileChooserAllowDirs entries must be absolute directories' };
    }
    const trimmed = item.trim();
    if (!isAbsolutePath(trimmed)) {
      return { error: 'fileChooserAllowDirs entries must be absolute directories' };
    }
    const normalized = normalizePath(trimmed);
    if ('error' in normalized) return { error: normalized.error };
    dirs.push(normalized.path);
  }
  return dirs;
}

export function validateChooserPaths(
  paths: unknown,
  allowDirs?: readonly string[] | null,
): { paths: string[] } | { error: string } {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { error: 'paths must be a non-empty array of absolute file paths' };
  }
  if (paths.length > MAX_CHOOSER_PATHS) {
    return { error: `paths accepts at most ${MAX_CHOOSER_PATHS} files` };
  }
  const out: string[] = [];
  for (const entry of paths) {
    if (typeof entry !== 'string') return { error: 'each path must be a string' };
    if (entry.includes('\0')) return { error: 'path contains a null byte' };
    if (entry.length > MAX_PATH_LENGTH) return { error: 'path is too long' };
    const trimmed = entry.trim();
    if (!trimmed) return { error: 'path is empty' };
    if (!isAbsolutePath(trimmed)) return { error: `path must be absolute: ${trimmed}` };
    const normalized = normalizePath(trimmed);
    if ('error' in normalized) return normalized;
    if (allowDirs && allowDirs.length > 0) {
      const allowed = allowDirs.some((dir) => pathInsideDir(dir, normalized.path));
      if (!allowed) {
        return { error: `path is outside the file chooser allow-list: ${normalized.path}` };
      }
    }
    out.push(normalized.path);
  }
  return { paths: out };
}

export function parseFileChooserArgs(args: unknown): ParsedFileChooserArgs | { error: string } {
  if (!isRecord(args)) return { error: 'arguments must be an object' };
  const hasRef = typeof args.ref === 'string' ? args.ref.trim().length > 0 : args.ref != null;
  const hasSelector =
    typeof args.selector === 'string' ? args.selector.trim().length > 0 : args.selector != null;
  if (hasRef === hasSelector) return { error: 'provide exactly one of ref or selector' };

  let ref: string | undefined;
  let selector: string | undefined;
  if (hasRef) {
    if (typeof args.ref !== 'string' || !args.ref.trim()) {
      return { error: 'ref must be a non-empty string' };
    }
    ref = args.ref.trim();
  } else {
    if (typeof args.selector !== 'string' || !args.selector.trim()) {
      return { error: 'selector must be a non-empty string' };
    }
    if (args.selector.trim().length > 2000) return { error: 'selector is too long' };
    selector = args.selector.trim();
  }

  const frameId = optionalId(args.frameId, 'frameId');
  if (isFailure(frameId)) return frameId;
  const tabId = optionalId(args.tabId, 'tabId');
  if (isFailure(tabId)) return tabId;
  const windowId = optionalId(args.windowId, 'windowId');
  if (isFailure(windowId)) return windowId;

  let timeoutMs = DEFAULT_CHOOSER_TIMEOUT_MS;
  if (args.timeoutMs !== undefined && args.timeoutMs !== null) {
    if (typeof args.timeoutMs !== 'number' || !Number.isInteger(args.timeoutMs)) {
      return { error: 'timeoutMs must be an integer' };
    }
    if (args.timeoutMs < MIN_CHOOSER_TIMEOUT_MS || args.timeoutMs > MAX_CHOOSER_TIMEOUT_MS) {
      return {
        error: `timeoutMs must be from ${MIN_CHOOSER_TIMEOUT_MS} to ${MAX_CHOOSER_TIMEOUT_MS}`,
      };
    }
    timeoutMs = args.timeoutMs;
  }

  return { ref, selector, frameId, tabId, windowId, timeoutMs };
}

/** selectSingle keeps the first path and reports the rest. */
export function filesForChooserMode(
  mode: string | undefined,
  paths: readonly string[],
): { files: string[]; ignored: string[] } {
  if (mode === 'selectSingle' && paths.length > 1) {
    return { files: [paths[0]], ignored: paths.slice(1) };
  }
  return { files: [...paths], ignored: [] };
}

export function parseCdpRef(input: string): { backendNodeId: number } | null {
  const match = String(input ?? '')
    .trim()
    .match(CDP_REF);
  if (!match) return null;
  const backendNodeId = Number(match[1]);
  if (!Number.isSafeInteger(backendNodeId)) return null;
  return { backendNodeId };
}

export function formatCdpRef(backendNodeId: number): string {
  return `cdp_${backendNodeId}`;
}

export function devToolsAttachedMessage(tabId: number): string {
  return `Debugger is already attached to tab ${tabId} by DevTools or another extension. Close DevTools on that tab and retry.`;
}

export function isDebuggerAttachedError(message: string): boolean {
  return /already attached/i.test(message);
}

/** DevTools is an error. Any other CDP failure may fall back to the accessibility snapshot. */
export function pierceFailureAction(message: string): 'devtools' | 'fallback' {
  return isDebuggerAttachedError(message) ? 'devtools' : 'fallback';
}

export function pierceBoxBudget(maxItems: number): number {
  const count = Number.isFinite(maxItems) ? Math.max(1, Math.floor(maxItems)) : 400;
  return Math.max(count * 4, 200);
}

export function viewportRectFromLayout(
  metrics: LayoutViewportBox | null | undefined,
): ViewportRect | null {
  if (!metrics) return null;
  const { pageX, pageY, clientWidth, clientHeight } = metrics;
  if (
    typeof pageX !== 'number' ||
    typeof pageY !== 'number' ||
    typeof clientWidth !== 'number' ||
    typeof clientHeight !== 'number' ||
    !Number.isFinite(pageX) ||
    !Number.isFinite(pageY) ||
    !Number.isFinite(clientWidth) ||
    !Number.isFinite(clientHeight) ||
    clientWidth <= 0 ||
    clientHeight <= 0
  ) {
    return null;
  }
  return { left: pageX, top: pageY, right: pageX + clientWidth, bottom: pageY + clientHeight };
}

function quadBounds(
  quad: readonly number[] | undefined,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!quad || quad.length < 8) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < quad.length; i += 2) {
    const x = quad[i];
    const y = quad[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (maxX <= minX || maxY <= minY) return null;
  return { minX, minY, maxX, maxY };
}

/** Quads and the rect must be in the same coordinate space (document CSS pixels). */
export function quadIntersectsRect(
  quad: readonly number[] | undefined,
  rect: ViewportRect,
): boolean {
  const bounds = quadBounds(quad);
  if (!bounds) return false;
  return (
    bounds.maxX > rect.left &&
    bounds.minX < rect.right &&
    bounds.maxY > rect.top &&
    bounds.minY < rect.bottom
  );
}

export function viewportPointFromQuad(
  quad: readonly number[],
  scrollX: number,
  scrollY: number,
  which: 'center' | 'origin',
): { x: number; y: number } | null {
  const bounds = quadBounds(quad);
  if (!bounds) return null;
  const x = which === 'center' ? (bounds.minX + bounds.maxX) / 2 : bounds.minX;
  const y = which === 'center' ? (bounds.minY + bounds.maxY) / 2 : bounds.minY;
  return { x: x - scrollX, y: y - scrollY };
}

function attributeMap(attributes: string[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!attributes) return map;
  for (let i = 0; i + 1 < attributes.length; i += 2) map[attributes[i]] = attributes[i + 1];
  return map;
}

function cleanText(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit).replace(/"/g, '\\"');
}

function inputRole(type: string | undefined): string {
  switch ((type || 'text').toLowerCase()) {
    case 'submit':
    case 'button':
    case 'reset':
    case 'image':
    case 'file':
    case 'color':
      return 'button';
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'range':
      return 'slider';
    case 'hidden':
      return 'generic';
    case 'search':
      return 'searchbox';
    default:
      return 'textbox';
  }
}

function isContentEditable(attrs: Record<string, string>): boolean {
  if (!Object.prototype.hasOwnProperty.call(attrs, 'contenteditable')) return false;
  return attrs.contenteditable.toLowerCase() !== 'false';
}

function roleFor(tag: string, attrs: Record<string, string>): string {
  const explicit = (attrs.role || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (isContentEditable(attrs)) return 'textbox';
  if (tag === 'INPUT') return inputRole(attrs.type);
  return TAG_ROLES[tag] || 'generic';
}

function isInteractive(tag: string, attrs: Record<string, string>, role: string): boolean {
  if (tag === 'INPUT') return (attrs.type || 'text').toLowerCase() !== 'hidden';
  if (
    tag === 'A' ||
    tag === 'BUTTON' ||
    tag === 'SELECT' ||
    tag === 'TEXTAREA' ||
    tag === 'SUMMARY' ||
    tag === 'OPTION'
  ) {
    return true;
  }
  if (isContentEditable(attrs)) return true;
  if (Object.prototype.hasOwnProperty.call(attrs, 'tabindex')) {
    const index = Number(attrs.tabindex);
    if (Number.isFinite(index) && index >= 0) return true;
  }
  return INTERACTIVE_ROLES.has(role);
}

function descendantText(node: CdpDomNode): string {
  let out = '';
  const stack = [...(node.children || [])];
  while (stack.length > 0 && out.length < PIERCE_NAME_LIMIT) {
    const current = stack.shift();
    if (!current) break;
    const name = String(current.nodeName || '');
    if (name === '#text' && current.nodeValue) out = `${out} ${current.nodeValue}`;
    else if (current.nodeType === 1 && !SKIP_WALK.has(name.toUpperCase()) && current.children) {
      stack.unshift(...current.children);
    }
  }
  return cleanText(out, PIERCE_NAME_LIMIT);
}

function attributeName(attrs: Record<string, string>): string {
  return cleanText(
    attrs['aria-label'] || attrs.alt || attrs.title || attrs.placeholder || '',
    PIERCE_NAME_LIMIT,
  );
}

function classifyNode(
  node: CdpDomNode,
  tag: string,
  filter: 'interactive' | 'all',
): { include: boolean; role: string; name: string; value: string; flags: string[] } {
  const empty = { include: false, role: 'generic', name: '', value: '', flags: [] as string[] };
  if (node.nodeType !== 1 || SKIP_EMIT.has(tag)) return empty;
  const attrs = attributeMap(node.attributes);
  if (tag === 'INPUT' && (attrs.type || '').toLowerCase() === 'hidden') return empty;
  const role = roleFor(tag, attrs);
  const interactive = isInteractive(tag, attrs, role);
  const named = attributeName(attrs);
  const text = descendantText(node);
  if (filter === 'interactive') {
    if (!interactive) return empty;
  } else if (role === 'none' || role === 'presentation') {
    return empty;
  } else if (!interactive && role === 'generic') {
    if (!named) return empty;
  } else if (!interactive && !LANDMARK_ROLES.has(role) && !named && !text) {
    return empty;
  }

  let name = named;
  if (!name && (interactive || role !== 'generic')) name = text;
  if (!name && (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA')) {
    name = cleanText(attrs.name || '', PIERCE_NAME_LIMIT);
  }
  if (tag === 'TEXTAREA' && text) name = named || cleanText(attrs.name || '', PIERCE_NAME_LIMIT);

  let value = '';
  if (tag === 'TEXTAREA') value = text;
  else if (attrs.value) value = cleanText(attrs.value, PIERCE_VALUE_LIMIT);
  else if (attrs['aria-valuenow']) value = cleanText(attrs['aria-valuenow'], PIERCE_VALUE_LIMIT);
  if (value && value === name) name = named;

  const flags: string[] = [];
  if (
    Object.prototype.hasOwnProperty.call(attrs, 'disabled') ||
    attrs['aria-disabled'] === 'true'
  ) {
    flags.push('disabled');
  }
  if (
    Object.prototype.hasOwnProperty.call(attrs, 'checked') ||
    attrs['aria-checked'] === 'true' ||
    attrs['aria-pressed'] === 'true'
  ) {
    flags.push('checked');
  }
  if (attrs['aria-expanded'] === 'true') flags.push('expanded');
  else if (attrs['aria-expanded'] === 'false') flags.push('collapsed');
  if (
    Object.prototype.hasOwnProperty.call(attrs, 'required') ||
    attrs['aria-required'] === 'true'
  ) {
    flags.push('required');
  }
  if (attrs['aria-invalid'] === 'true') flags.push('invalid');

  return { include: true, role, name, value, flags };
}

export function formatPierceLine(
  refId: string,
  role: string,
  name: string,
  value: string,
  flags: readonly string[],
): string {
  let line = `${refId} ${role}`;
  if (name) line += ` "${name}"`;
  if (value) line += ` value="${value}"`;
  if (flags.length) line += ` ${flags.join(' ')}`;
  return line;
}

function visitPierce(
  root: CdpDomNode | undefined,
  rootBackendNodeId: number | undefined,
  onElement: (node: CdpDomNode, tag: string) => 'stop' | void,
): boolean {
  let found = rootBackendNodeId === undefined;
  const walk = (node: CdpDomNode | undefined, active: boolean): boolean => {
    if (!node || typeof node !== 'object') return false;
    const tag = String(node.nodeName || '').toUpperCase();
    let next = active;
    if (!next && node.nodeType === 1 && node.backendNodeId === rootBackendNodeId) {
      next = true;
      found = true;
    }
    if (next && node.nodeType === 1) {
      if (onElement(node, tag) === 'stop') return true;
    }
    if (SKIP_WALK.has(tag)) return false;
    for (const shadow of node.shadowRoots || []) {
      if (walk(shadow, next)) return true;
    }
    for (const child of node.children || []) {
      if (walk(child, next)) return true;
    }
    if (node.contentDocument && walk(node.contentDocument, next)) return true;
    return false;
  };
  walk(root, rootBackendNodeId === undefined);
  return found;
}

export function pierceTreeHasBackendId(
  root: CdpDomNode | undefined,
  backendNodeId: number,
): boolean {
  const stack: CdpDomNode[] = root ? [root] : [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.backendNodeId === backendNodeId) return true;
    if (current.contentDocument) stack.push(current.contentDocument);
    if (current.shadowRoots) stack.push(...current.shadowRoots);
    if (current.children) stack.push(...current.children);
  }
  return false;
}

export function listPierceBackendIds(
  root: CdpDomNode | undefined,
  options: { filter: 'interactive' | 'all'; rootBackendNodeId?: number; limit: number },
): { ids: number[]; capped: boolean } {
  const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 0;
  const ids: number[] = [];
  const seen = new Set<number>();
  let capped = false;
  visitPierce(root, options.rootBackendNodeId, (node, tag) => {
    const decision = classifyNode(node, tag, options.filter);
    if (!decision.include || typeof node.backendNodeId !== 'number') return;
    if (seen.has(node.backendNodeId)) return;
    seen.add(node.backendNodeId);
    if (ids.length >= limit) {
      capped = true;
      return 'stop';
    }
    ids.push(node.backendNodeId);
  });
  return { ids, capped };
}

export function formatPierceSnapshot(
  root: CdpDomNode | undefined,
  options: PierceFormatOptions,
): PierceSnapshotText {
  const maxItems = Number.isFinite(options.maxItems)
    ? Math.max(0, Math.floor(options.maxItems))
    : 0;
  const lines: string[] = [];
  const groups: string[] = [];
  const omittedGroups: Record<string, number> = {};
  const seen = new Set<number>();
  const nameCap =
    typeof options.maxNameChars === 'number' && options.maxNameChars >= 2
      ? Math.floor(options.maxNameChars)
      : 0;
  let landmark = 'page';
  let truncated = false;
  let omitted = 0;
  const found = visitPierce(root, options.rootBackendNodeId, (node, tag) => {
    const decision = classifyNode(node, tag, options.filter);
    if (!decision.include || typeof node.backendNodeId !== 'number') return;
    if (seen.has(node.backendNodeId)) return;
    if (options.inViewport && !options.inViewport.has(node.backendNodeId)) return;
    seen.add(node.backendNodeId);
    if (LANDMARK_ROLES.has(decision.role)) landmark = decision.role;
    if (lines.length >= maxItems) {
      truncated = true;
      omitted += 1;
      omittedGroups[landmark] = (omittedGroups[landmark] || 0) + 1;
      return;
    }
    const capText = (text: string | undefined) =>
      nameCap && typeof text === 'string' && text.length > nameCap
        ? `${text.slice(0, nameCap - 1)}\u2026`
        : text;
    lines.push(
      formatPierceLine(
        formatCdpRef(node.backendNodeId),
        decision.role,
        capText(decision.name) as typeof decision.name,
        capText(decision.value as string | undefined) as typeof decision.value,
        decision.flags,
      ),
    );
    groups.push(landmark);
  });
  return {
    lines,
    groups,
    omittedGroups,
    truncated,
    omitted,
    missingRoot: options.rootBackendNodeId !== undefined && !found,
  };
}

export function defaultPdfFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `page-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}.pdf`;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 32) return true;
  }
  return false;
}

/** A file name or a relative path inside the downloads directory. Never absolute. */
export function sanitizeDownloadName(savePath: string): { name: string } | { error: string } {
  if (typeof savePath !== 'string') return { error: 'savePath must be a string' };
  if (savePath.includes('\0')) return { error: 'savePath contains a null byte' };
  const raw = savePath.trim();
  if (!raw) return { error: 'savePath is empty' };
  if (isAbsolutePath(raw) || /^[A-Za-z]:/.test(raw)) {
    return { error: 'savePath must be a file name or a path inside the downloads directory' };
  }
  const segments = raw.split(/[\\/]+/);
  if (segments.some((segment) => segment.length === 0)) {
    return { error: 'savePath has an empty path segment' };
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return { error: 'savePath must not contain . or ..' };
  }
  for (const segment of segments) {
    if (segment.length > 255 || /[<>:"|?*]/.test(segment) || hasControlChar(segment)) {
      return { error: 'savePath has an invalid file name' };
    }
  }
  const last = segments[segments.length - 1];
  if (last.endsWith('.')) return { error: 'savePath file name is invalid' };
  if (!/\.[A-Za-z0-9]{1,8}$/.test(last)) segments[segments.length - 1] = `${last}.pdf`;
  return { name: segments.join('/') };
}

export function resolveDownloadPath(
  downloadsDir: string,
  saveName: string,
): { filePath: string } | { error: string } {
  if (typeof downloadsDir !== 'string' || !isAbsolutePath(downloadsDir)) {
    return { error: 'downloads directory must be an absolute path' };
  }
  const dir = normalizePath(downloadsDir);
  if ('error' in dir) return dir;
  const relative = sanitizeDownloadName(saveName);
  if ('error' in relative) return relative;
  const sep = dir.style === 'posix' ? '/' : '\\';
  const base = dir.path.replace(/[\\/]+$/, '');
  const filePath = `${base}${sep}${relative.name.split('/').join(sep)}`;
  if (!pathInsideDir(base, filePath)) {
    return { error: 'savePath escapes the downloads directory' };
  }
  return { filePath };
}

export function parsePageRanges(value: unknown): string | undefined | { error: string } {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return { error: 'pageRanges must be a string like "1-5, 8"' };
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 200 || !PAGE_RANGES.test(trimmed)) {
    return { error: 'pageRanges must look like "1-5, 8"' };
  }
  for (const part of trimmed.split(',')) {
    const bits = part
      .trim()
      .split('-')
      .map((piece) => Number(piece));
    if (bits.some((page) => !Number.isInteger(page) || page < 1)) {
      return { error: 'pageRanges pages start at 1' };
    }
    if (bits.length === 2 && bits[0] > bits[1]) {
      return { error: 'pageRanges start must be less than or equal to end' };
    }
  }
  return trimmed;
}

export function parsePrintPdfArgs(
  args: unknown,
  now: Date = new Date(),
): ParsedPrintPdfArgs | { error: string } {
  if (!isRecord(args)) return { error: 'arguments must be an object' };
  const landscape = optionalBool(args.landscape, 'landscape');
  if (isFailure(landscape)) return landscape;
  const printBackground = optionalBool(args.printBackground, 'printBackground');
  if (isFailure(printBackground)) return printBackground;
  const pageRanges = parsePageRanges(args.pageRanges);
  if (isFailure(pageRanges)) return pageRanges;

  let saveName: string;
  if (args.savePath === undefined || args.savePath === null || args.savePath === '') {
    saveName = defaultPdfFileName(now);
  } else if (typeof args.savePath !== 'string') {
    return { error: 'savePath must be a string' };
  } else {
    const sanitized = sanitizeDownloadName(args.savePath);
    if ('error' in sanitized) return sanitized;
    saveName = sanitized.name;
  }

  const tabId = optionalId(args.tabId, 'tabId');
  if (isFailure(tabId)) return tabId;
  const windowId = optionalId(args.windowId, 'windowId');
  if (isFailure(windowId)) return windowId;

  return {
    landscape: landscape ?? false,
    printBackground: printBackground ?? false,
    pageRanges,
    saveName,
    tabId,
    windowId,
  };
}

export function base64ByteLength(data: string): number | { error: string } {
  if (typeof data !== 'string') return { error: 'PDF data is not valid base64' };
  const raw = data.replace(/\s+/g, '');
  if (!raw) return { error: 'PDF data is empty' };
  if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    return { error: 'PDF data is not valid base64' };
  }
  const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
  return (raw.length / 4) * 3 - padding;
}

export function pdfTooLarge(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'PDF data is empty';
  if (bytes > NATIVE_PDF_BYTE_LIMIT) {
    return `PDF is ${bytes} bytes, which is over the ${NATIVE_PDF_BYTE_LIMIT} byte native messaging limit`;
  }
  return null;
}
