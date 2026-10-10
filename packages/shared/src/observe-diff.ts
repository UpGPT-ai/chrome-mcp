/**
 * Pure observe-diff assembly. Browser code collects the before/after facts;
 * this module decides what the agent sees.
 */

import { capSnapshotDiff, diffSnapshotLines, type SnapshotLineDiff } from './snapshot-diff';

export const OBSERVE_SETTLE_DEFAULT_MS = 300;
export const OBSERVE_SETTLE_MAX_MS = 3000;
export const OBSERVE_REQUEST_CAP = 20;
export const OBSERVE_CONSOLE_CAP = 10;
export const OBSERVE_DOM_CAP = 40;
/** Default character budget for the diff text returned after an action. */
export const OBSERVE_DIFF_MAX_CHARS = 6000;

export interface ObservePair {
  before: string;
  after: string;
}

export interface ObserveRequest {
  method: string;
  url: string;
  status: number;
}

export interface ObserveDiff {
  url: ObservePair | null;
  title: ObservePair | null;
  domChanges: SnapshotLineDiff;
  /** Number of dom change entries dropped to stay inside the character budget. */
  domChangesCut?: number;
  newRequests: ObserveRequest[];
  newConsoleErrors: string[];
  dialogOpened: boolean;
}

export interface ObserveFacts {
  urlBefore: string;
  urlAfter: string;
  titleBefore: string;
  titleAfter: string;
  linesBefore: readonly string[];
  linesAfter: readonly string[];
  requests: readonly ObserveRequest[];
  consoleErrors: readonly string[];
  dialogOpened: boolean;
}

export type ParsedObserve = { settleMs: number; full?: true };

/**
 * observe:true or {settleMs} returns the diff only. observe:'full' returns the
 * diff plus a fresh bounded snapshot (viewport, interactive, paginated).
 */
export function parseObserve(value: unknown): ParsedObserve | { error: string } | null {
  if (value === undefined || value === null || value === false) return null;
  if (value === true) return { settleMs: OBSERVE_SETTLE_DEFAULT_MS };
  if (value === 'full') return { settleMs: OBSERVE_SETTLE_DEFAULT_MS, full: true };
  if (typeof value !== 'object') {
    return { error: "observe must be true, 'full', or { settleMs }" };
  }
  const raw = (value as { settleMs?: unknown }).settleMs;
  if (raw === undefined) return { settleMs: OBSERVE_SETTLE_DEFAULT_MS };
  const settle = Number(raw);
  if (!Number.isFinite(settle) || settle < 0) {
    return { error: 'observe.settleMs must be a non-negative number' };
  }
  return { settleMs: Math.min(OBSERVE_SETTLE_MAX_MS, Math.floor(settle)) };
}

/**
 * Keep the serialized diff inside maxChars by dropping dom change entries from
 * the tail (changed first, then removed, then added). Reports how many were cut.
 */
export function capObserveDiffChars(
  diff: ObserveDiff,
  maxChars: number = OBSERVE_DIFF_MAX_CHARS,
): ObserveDiff {
  const limit = Number.isFinite(maxChars)
    ? Math.max(200, Math.floor(maxChars))
    : OBSERVE_DIFF_MAX_CHARS;
  if (JSON.stringify(diff).length <= limit) return diff;
  const added = [...diff.domChanges.added];
  const removed = [...diff.domChanges.removed];
  const changed = [...diff.domChanges.changed];
  let cut = 0;
  const build = (): ObserveDiff => ({
    ...diff,
    domChanges: { added, removed, changed },
    domChangesCut: cut,
  });
  let out = build();
  while (JSON.stringify(out).length > limit && added.length + removed.length + changed.length > 0) {
    if (changed.length) changed.pop();
    else if (removed.length) removed.pop();
    else added.pop();
    cut++;
    out = build();
  }
  return out;
}

export function changedPair(before: string, after: string): ObservePair | null {
  if (before === after) return null;
  return { before, after };
}

/**
 * Strings present in `after` that are not accounted for by `before`.
 * Repeated identical messages are matched one-for-one.
 */
export function newStringEntries(
  before: readonly string[],
  after: readonly string[],
  cap: number = OBSERVE_CONSOLE_CAP,
): string[] {
  const counts = new Map<string, number>();
  for (const text of before) counts.set(text, (counts.get(text) || 0) + 1);
  const fresh: string[] = [];
  for (const text of after) {
    const left = counts.get(text) || 0;
    if (left > 0) {
      counts.set(text, left - 1);
      continue;
    }
    fresh.push(text);
  }
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : OBSERVE_CONSOLE_CAP;
  return fresh.slice(0, limit);
}

export function buildObserveDiff(facts: ObserveFacts): ObserveDiff {
  return {
    url: changedPair(facts.urlBefore, facts.urlAfter),
    title: changedPair(facts.titleBefore, facts.titleAfter),
    domChanges: capSnapshotDiff(
      diffSnapshotLines(facts.linesBefore, facts.linesAfter),
      OBSERVE_DOM_CAP,
    ),
    newRequests: facts.requests.slice(0, OBSERVE_REQUEST_CAP),
    newConsoleErrors: facts.consoleErrors.slice(0, OBSERVE_CONSOLE_CAP),
    dialogOpened: facts.dialogOpened === true,
  };
}
