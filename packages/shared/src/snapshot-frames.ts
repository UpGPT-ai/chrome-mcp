/**
 * Pure frame-stitching helpers for chrome_snapshot.
 * The page reports iframe slots in DOM order. webNavigation reports frame ids.
 * These functions pair the two without touching Chrome APIs.
 */

export interface FrameSlot {
  src: string;
  sameOrigin: boolean;
}

export interface FrameRecord {
  frameId: number;
  parentFrameId: number;
  url: string;
}

export interface MatchedFrameSlot {
  slot: FrameSlot;
  frame?: FrameRecord;
}

export function absoluteFrameSrc(src: string, parentUrl: string): string {
  const raw = String(src || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, parentUrl || undefined).href;
  } catch {
    return raw;
  }
}

/** about:blank and about:srcdoc inherit the parent's origin. */
export function frameIsSameOrigin(parentUrl: string, frameUrl: string): boolean {
  const url = String(frameUrl || '');
  if (!url || url === 'about:blank' || url === 'about:srcdoc') return true;
  try {
    const parent = new URL(parentUrl);
    const child = new URL(url);
    return parent.origin === child.origin;
  } catch {
    return false;
  }
}

export function prefixSnapshotLine(line: string, frameId: number): string {
  if (!frameId) return line;
  if (/^ref_\d+@\d+\b/.test(line)) return line;
  // Collapsed-run lines carry the container ref in parentheses at the end.
  const collapsed = line.match(/^(\u2026 \d+ more similar rows \()(ref_\d+)\)$/);
  if (collapsed) return `${collapsed[1]}${collapsed[2]}@${frameId})`;
  return line.replace(/^(ref_\d+)\b/, `$1@${frameId}`);
}

export function crossOriginFrameLine(src: string, frameId?: number): string {
  const safe = String(src || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  const id = typeof frameId === 'number' ? ` frameId=${frameId}` : '';
  return `frame[src="${safe}"] (cross-origin, not traversed)${id}`;
}

function isInheritedBlank(src: string): boolean {
  return !src || src === 'about:blank' || src === 'about:srcdoc';
}

/**
 * Pair DOM iframe slots with child frame records. Each child frame is used at most once.
 * A single slot and a single child are paired when URL matching fails.
 */
export function matchFrameSlots(
  slots: readonly FrameSlot[],
  children: readonly FrameRecord[],
  parentUrl: string,
): MatchedFrameSlot[] {
  const used = new Set<number>();
  return slots.map((slot) => {
    const abs = absoluteFrameSrc(slot.src, parentUrl);
    const candidates = children.filter((child) => !used.has(child.frameId));
    let frame: FrameRecord | undefined;
    if (abs) {
      frame = candidates.find((child) => child.url === abs || child.url === slot.src);
    }
    if (!frame && isInheritedBlank(slot.src)) {
      frame = candidates.find(
        (child) =>
          child.url === 'about:blank' ||
          child.url === 'about:srcdoc' ||
          child.url.startsWith('about:'),
      );
    }
    if (!frame && candidates.length === 1 && slots.length === 1) frame = candidates[0];
    if (frame) used.add(frame.frameId);
    return { slot, frame };
  });
}

export function unmatchedFrames(
  children: readonly FrameRecord[],
  usedFrameIds: readonly number[],
): FrameRecord[] {
  const used = new Set(usedFrameIds);
  return children.filter((child) => !used.has(child.frameId));
}
