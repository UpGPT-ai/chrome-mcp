/**
 * Pure chrome_wait_for parsing and condition evaluation.
 * The browser collects live signals; this module decides what is met.
 */

export const WAIT_TIMEOUT_DEFAULT_MS = 10000;
export const WAIT_TIMEOUT_MAX_MS = 60000;

export const WAIT_CONDITION_NAMES = [
  'text',
  'textGone',
  'selector',
  'selectorGone',
  'ref',
  'refGone',
  'urlMatches',
  'networkIdleMs',
  'domQuietMs',
] as const;

export type WaitConditionName = (typeof WAIT_CONDITION_NAMES)[number];

export interface WaitArgs {
  text?: unknown;
  textGone?: unknown;
  selector?: unknown;
  selectorGone?: unknown;
  ref?: unknown;
  refGone?: unknown;
  urlMatches?: unknown;
  networkIdleMs?: unknown;
  domQuietMs?: unknown;
  all?: unknown;
  timeoutMs?: unknown;
  frameId?: unknown;
}

export interface ParsedWait {
  conditions: WaitConditionName[];
  all: boolean;
  timeoutMs: number;
  text?: string;
  textGone?: string;
  selector?: string;
  selectorGone?: string;
  ref?: string;
  refGone?: string;
  urlMatches?: string;
  networkIdleMs?: number;
  domQuietMs?: number;
  frameId?: number;
}

export interface WaitSignals {
  /** True when the `text` needle is visible. */
  textFound?: boolean;
  /** True when the `textGone` needle is still visible. */
  textGoneFound?: boolean;
  selectorFound?: boolean;
  /** True when the `selectorGone` selector still matches a visible element. */
  selectorGoneFound?: boolean;
  refConnected?: boolean;
  /** True when the `refGone` ref still points at a connected element. */
  refGoneConnected?: boolean;
  urlMatched?: boolean;
  /** Milliseconds since the last request for this tab. */
  networkQuietMs?: number;
  /** Milliseconds since the last DOM mutation. */
  domQuietForMs?: number;
}

export interface WaitVerdict {
  done: boolean;
  met: WaitConditionName[];
  unmet: WaitConditionName[];
}

const STRING_CONDITIONS: Array<{ name: WaitConditionName; key: keyof WaitArgs }> = [
  { name: 'text', key: 'text' },
  { name: 'textGone', key: 'textGone' },
  { name: 'selector', key: 'selector' },
  { name: 'selectorGone', key: 'selectorGone' },
  { name: 'ref', key: 'ref' },
  { name: 'refGone', key: 'refGone' },
  { name: 'urlMatches', key: 'urlMatches' },
];

function nonEmptyString(value: unknown, name: string): string | { error: string } {
  if (typeof value !== 'string') return { error: `${name} must be a non-empty string` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${name} must be a non-empty string` };
  return trimmed;
}

function positiveMs(value: unknown, name: string): number | { error: string } {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return { error: `${name} must be a positive number` };
  const ms = Math.floor(n);
  if (ms <= 0) return { error: `${name} must be a positive number` };
  if (ms > WAIT_TIMEOUT_MAX_MS) {
    return { error: `${name} cannot exceed ${WAIT_TIMEOUT_MAX_MS}` };
  }
  return ms;
}

export function urlMatchesPattern(url: string, pattern: string): boolean {
  return new RegExp(pattern).test(url);
}

export function parseWaitArgs(args: WaitArgs | null | undefined): ParsedWait | { error: string } {
  if (args === null || args === undefined || typeof args !== 'object') {
    return { error: 'at least one wait condition is required' };
  }

  let timeoutMs = WAIT_TIMEOUT_DEFAULT_MS;
  if (args.timeoutMs !== undefined) {
    const n = typeof args.timeoutMs === 'number' ? args.timeoutMs : Number(args.timeoutMs);
    if (!Number.isFinite(n) || n < 0) {
      return { error: 'timeoutMs must be a non-negative number' };
    }
    timeoutMs = Math.min(WAIT_TIMEOUT_MAX_MS, Math.floor(n));
  }

  let all = false;
  if (args.all !== undefined) {
    if (typeof args.all !== 'boolean') return { error: 'all must be a boolean' };
    all = args.all;
  }

  let frameId: number | undefined;
  if (args.frameId !== undefined) {
    const n = typeof args.frameId === 'number' ? args.frameId : Number(args.frameId);
    if (!Number.isInteger(n) || n < 0) {
      return { error: 'frameId must be a non-negative integer' };
    }
    frameId = n;
  }

  const parsed: ParsedWait = { conditions: [], all, timeoutMs, frameId };
  const requested = new Set<WaitConditionName>();

  for (const field of STRING_CONDITIONS) {
    if (args[field.key] === undefined) continue;
    const value = nonEmptyString(args[field.key], field.name);
    if (typeof value !== 'string') return value;
    if (field.name === 'urlMatches') {
      try {
        new RegExp(value);
      } catch {
        return { error: 'urlMatches is not a valid regular expression' };
      }
      parsed.urlMatches = value;
    } else if (field.name === 'text') parsed.text = value;
    else if (field.name === 'textGone') parsed.textGone = value;
    else if (field.name === 'selector') parsed.selector = value;
    else if (field.name === 'selectorGone') parsed.selectorGone = value;
    else if (field.name === 'ref') parsed.ref = value;
    else parsed.refGone = value;
    requested.add(field.name);
  }

  if (args.networkIdleMs !== undefined) {
    const ms = positiveMs(args.networkIdleMs, 'networkIdleMs');
    if (typeof ms !== 'number') return ms;
    if (ms > timeoutMs) return { error: 'networkIdleMs cannot exceed timeoutMs' };
    parsed.networkIdleMs = ms;
    requested.add('networkIdleMs');
  }

  if (args.domQuietMs !== undefined) {
    const ms = positiveMs(args.domQuietMs, 'domQuietMs');
    if (typeof ms !== 'number') return ms;
    if (ms > timeoutMs) return { error: 'domQuietMs cannot exceed timeoutMs' };
    parsed.domQuietMs = ms;
    requested.add('domQuietMs');
  }

  parsed.conditions = WAIT_CONDITION_NAMES.filter((name) => requested.has(name));
  if (parsed.conditions.length === 0) {
    return { error: 'at least one wait condition is required' };
  }
  return parsed;
}

function conditionMet(
  name: WaitConditionName,
  request: { networkIdleMs?: number; domQuietMs?: number },
  signals: WaitSignals,
): boolean {
  switch (name) {
    case 'text':
      return signals.textFound === true;
    case 'textGone':
      return signals.textGoneFound === false;
    case 'selector':
      return signals.selectorFound === true;
    case 'selectorGone':
      return signals.selectorGoneFound === false;
    case 'ref':
      return signals.refConnected === true;
    case 'refGone':
      return signals.refGoneConnected === false;
    case 'urlMatches':
      return signals.urlMatched === true;
    case 'networkIdleMs':
      return (
        typeof request.networkIdleMs === 'number' &&
        typeof signals.networkQuietMs === 'number' &&
        signals.networkQuietMs >= request.networkIdleMs
      );
    case 'domQuietMs':
      return (
        typeof request.domQuietMs === 'number' &&
        typeof signals.domQuietForMs === 'number' &&
        signals.domQuietForMs >= request.domQuietMs
      );
    default:
      return false;
  }
}

/**
 * `all` waits until every requested condition is true.
 * Otherwise the wait finishes as soon as any requested condition is true.
 * `met` lists every condition that is true on this check.
 */
export function evaluateWaitConditions(
  request: {
    conditions: readonly WaitConditionName[];
    all: boolean;
    networkIdleMs?: number;
    domQuietMs?: number;
  },
  signals: WaitSignals,
): WaitVerdict {
  const met: WaitConditionName[] = [];
  const unmet: WaitConditionName[] = [];
  for (const name of request.conditions) {
    if (conditionMet(name, request, signals)) met.push(name);
    else unmet.push(name);
  }
  const done = request.all ? unmet.length === 0 && met.length > 0 : met.length > 0;
  return { done, met, unmet };
}

export function formatWaitTimeout(timeoutMs: number, unmet: readonly string[]): string {
  const names = unmet.length > 0 ? unmet.join(', ') : 'none';
  return `Timed out after ${timeoutMs}ms. Unmet: ${names}`;
}
