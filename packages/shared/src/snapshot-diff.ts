/**
 * Pure snapshot diffing for chrome_snapshot and action observe diffs.
 * A line is keyed by its leading ref token (`ref_12` or `ref_12@3`).
 * Lines without a ref (for example cross-origin frame markers) are keyed
 * by their full text, so they only show up as added or removed.
 */

export const SNAPSHOT_DIFF_CAP = 40;

export interface SnapshotLineDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

const REF_TOKEN = /^(ref_\d+(?:@\d+)?)\b/;
const AGENT_REF = /^(ref_\d+)(?:@(\d+))?$/;

export function snapshotLineKey(line: string): string {
  const trimmed = line.trim();
  const match = trimmed.match(REF_TOKEN);
  if (match) return `ref:${match[1]}`;
  return `raw:${trimmed}`;
}

function indexLines(lines: readonly string[]): { order: string[]; byKey: Map<string, string> } {
  const order: string[] = [];
  const byKey = new Map<string, string>();
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    const key = snapshotLineKey(line);
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, line.trim());
  }
  return { order, byKey };
}

/**
 * Diff two compact snapshots. `changed` entries are the new line for a ref
 * whose text changed. Order follows the later snapshot for added/changed
 * and the earlier snapshot for removed.
 */
export function diffSnapshotLines(
  before: readonly string[],
  after: readonly string[],
): SnapshotLineDiff {
  const prev = indexLines(before);
  const next = indexLines(after);
  const added: string[] = [];
  const changed: string[] = [];
  for (const key of next.order) {
    const previousLine = prev.byKey.get(key);
    const nextLine = next.byKey.get(key);
    if (nextLine === undefined) continue;
    if (previousLine === undefined) added.push(nextLine);
    else if (previousLine !== nextLine) changed.push(nextLine);
  }
  const removed: string[] = [];
  for (const key of prev.order) {
    if (!next.byKey.has(key)) {
      const line = prev.byKey.get(key);
      if (line !== undefined) removed.push(line);
    }
  }
  return { added, removed, changed };
}

export function capSnapshotDiff(
  diff: SnapshotLineDiff,
  cap: number = SNAPSHOT_DIFF_CAP,
): SnapshotLineDiff {
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : SNAPSHOT_DIFF_CAP;
  return {
    added: diff.added.slice(0, limit),
    removed: diff.removed.slice(0, limit),
    changed: diff.changed.slice(0, limit),
  };
}

/** Split an agent-facing ref. `ref_12@7` means local ref `ref_12` in frame 7. */
export function parseAgentRef(input: string): { ref: string; frameId?: number } {
  const raw = String(input ?? '').trim();
  const match = raw.match(AGENT_REF);
  if (!match) return { ref: raw };
  if (match[2] === undefined) return { ref: match[1] };
  return { ref: match[1], frameId: Number(match[2]) };
}

/** Main-frame refs stay `ref_N`. Other frames are `ref_N@frameId`. */
export function formatAgentRef(localRef: string, frameId?: number): string {
  if (typeof frameId === 'number' && Number.isFinite(frameId) && frameId !== 0) {
    return `${localRef}@${frameId}`;
  }
  return localRef;
}
