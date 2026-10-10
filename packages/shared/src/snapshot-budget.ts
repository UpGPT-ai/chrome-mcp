/**
 * Context budget for chrome_snapshot and chrome_find.
 * Pure helpers: the extension collects entries, this decides how many reach the AI.
 */

export const SNAPSHOT_DEFAULT_MAX_ITEMS = 400;
export const SNAPSHOT_HARD_MAX_ITEMS = 2000;
export const SNAPSHOT_DEFAULT_MAX_CHARS = 6000;
export const SNAPSHOT_HARD_MAX_CHARS = 40000;
export const SNAPSHOT_DEFAULT_NAME_CHARS = 80;
export const SNAPSHOT_MIN_NAME_CHARS = 10;
export const SNAPSHOT_HARD_NAME_CHARS = 200;
export const FIND_DEFAULT_LIMIT = 20;
export const FIND_HARD_LIMIT = 100;
export const OUTLINE_MAX_GROUPS = 8;

export interface SnapshotEntry {
  line: string;
  /** Landmark/region the element sits in, such as `nav` or `main/form#checkout`. */
  group: string;
}

export interface SnapshotBudgetOptions {
  offset: number;
  maxItems: number;
  maxChars: number;
  /** Lines the collector dropped past its own limit. */
  extraOmitted?: number;
  extraGroups?: Record<string, number>;
}

export interface SnapshotPage {
  lines: string[];
  /** Lines returned. */
  shown: number;
  /** Lines still available after this page. */
  remaining: number;
  nextCursor?: number;
  truncated: boolean;
  /** `+N more: nav(22) main(9)` when something was left out. */
  outline?: string;
}

/** Collapse whitespace and cap to `max` characters, ending in an ellipsis when cut. */
export function capLabel(text: string, max: number = SNAPSHOT_DEFAULT_NAME_CHARS): string {
  const limit = Number.isFinite(max) ? Math.max(2, Math.floor(max)) : SNAPSHOT_DEFAULT_NAME_CHARS;
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Format group counts as one line. Largest groups first, the tail folded into `other`. */
export function formatOutline(groups: Record<string, number>, total?: number): string {
  const entries = Object.entries(groups)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sum = entries.reduce((acc, [, n]) => acc + n, 0);
  const count = total !== undefined ? Math.max(total, sum) : sum;
  if (count <= 0) return '';
  const head = entries.slice(0, OUTLINE_MAX_GROUPS);
  const restCount = entries.slice(OUTLINE_MAX_GROUPS).reduce((acc, [, n]) => acc + n, 0);
  const parts = head.map(([name, n]) => `${name}(${n})`);
  if (restCount > 0) parts.push(`other(${restCount})`);
  const unaccounted = count - sum;
  if (unaccounted > 0) parts.push(`page(${unaccounted})`);
  return `+${count} more: ${parts.join(' ')}`;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** Take entries from `offset` until the item or character budget is spent. */
export function paginateSnapshot(
  entries: SnapshotEntry[],
  options: SnapshotBudgetOptions,
): SnapshotPage {
  const offset = clampInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const maxItems = clampInt(
    options.maxItems,
    SNAPSHOT_DEFAULT_MAX_ITEMS,
    1,
    SNAPSHOT_HARD_MAX_ITEMS,
  );
  const maxChars = clampInt(
    options.maxChars,
    SNAPSHOT_DEFAULT_MAX_CHARS,
    200,
    SNAPSHOT_HARD_MAX_CHARS,
  );
  const lines: string[] = [];
  let chars = 0;
  let index = offset;
  while (index < entries.length && lines.length < maxItems) {
    const cost = entries[index].line.length + 1;
    // Always return at least one line so a cursor makes progress.
    if (lines.length > 0 && chars + cost > maxChars) break;
    lines.push(entries[index].line);
    chars += cost;
    index++;
  }
  const cut = entries.slice(index);
  const groups: Record<string, number> = {};
  for (const entry of cut) groups[entry.group || 'page'] = (groups[entry.group || 'page'] || 0) + 1;
  for (const [name, n] of Object.entries(options.extraGroups || {})) {
    groups[name] = (groups[name] || 0) + n;
  }
  const extra = Math.max(0, Math.floor(options.extraOmitted || 0));
  const remaining = cut.length + extra;
  const page: SnapshotPage = {
    lines,
    shown: lines.length,
    remaining,
    truncated: remaining > 0,
  };
  if (remaining > 0) {
    page.nextCursor = index;
    page.outline = formatOutline(groups, remaining);
  }
  return page;
}

/** Cap a plain list of lines (diffs) by character budget. Returns the kept lines and how many were cut. */
export function capLinesByChars(
  lines: string[],
  maxChars: number,
): { lines: string[]; cut: number } {
  const budget = clampInt(maxChars, SNAPSHOT_DEFAULT_MAX_CHARS, 200, SNAPSHOT_HARD_MAX_CHARS);
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (kept.length > 0 && chars + line.length + 1 > budget) break;
    kept.push(line);
    chars += line.length + 1;
  }
  return { lines: kept, cut: lines.length - kept.length };
}

export interface FindQuery {
  text?: string;
  role?: string;
  nearRef?: string;
}

/** Validate chrome_find arguments. At least one of text, role or nearRef is required. */
export function parseFindQuery(
  args: unknown,
): { query: FindQuery; limit: number } | { error: string } {
  const record = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const query: FindQuery = {};
  for (const key of ['text', 'role', 'nearRef'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) {
      return { error: `${key} must be a non-empty string` };
    }
    query[key] = value.trim();
  }
  if (!query.text && !query.role && !query.nearRef) {
    return { error: 'give at least one of text, role or nearRef' };
  }
  let limit = FIND_DEFAULT_LIMIT;
  if (record.limit !== undefined) {
    const n = Number(record.limit);
    if (!Number.isInteger(n) || n < 1) return { error: 'limit must be a positive integer' };
    limit = Math.min(n, FIND_HARD_LIMIT);
  }
  return { query, limit };
}

export interface SnapshotBudgetArgs {
  maxItems: number;
  maxChars: number;
  maxNameChars: number;
  offset: number;
}

/** Validate maxItems, maxChars, maxNameChars and cursor, applying defaults and hard maxima. */
export function parseSnapshotBudget(args: unknown): SnapshotBudgetArgs | { error: string } {
  const record = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const read = (
    key: string,
    fallback: number,
    min: number,
    max: number,
    label: string,
  ): number | { error: string } => {
    const value = record[key];
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min) return { error: `${label} must be an integer >= ${min}` };
    return Math.min(n, max);
  };
  const maxItems = read(
    'maxItems',
    SNAPSHOT_DEFAULT_MAX_ITEMS,
    1,
    SNAPSHOT_HARD_MAX_ITEMS,
    'maxItems',
  );
  if (typeof maxItems !== 'number') return maxItems;
  const maxChars = read(
    'maxChars',
    SNAPSHOT_DEFAULT_MAX_CHARS,
    200,
    SNAPSHOT_HARD_MAX_CHARS,
    'maxChars',
  );
  if (typeof maxChars !== 'number') return maxChars;
  const maxNameChars = read(
    'maxNameChars',
    SNAPSHOT_DEFAULT_NAME_CHARS,
    SNAPSHOT_MIN_NAME_CHARS,
    SNAPSHOT_HARD_NAME_CHARS,
    'maxNameChars',
  );
  if (typeof maxNameChars !== 'number') return maxNameChars;
  const offset = read('cursor', 0, 0, Number.MAX_SAFE_INTEGER, 'cursor');
  if (typeof offset !== 'number') return offset;
  return { maxItems, maxChars, maxNameChars, offset };
}
