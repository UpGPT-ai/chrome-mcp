/**
 * Pure pointer paths for chrome_computer hover and drag.
 * The browser dispatches these points; this module only plans them.
 */

export const HOVER_HOLD_DEFAULT_MS = 400;
export const HOVER_HOLD_MAX_MS = 5000;
export const DRAG_STEPS_DEFAULT = 8;
export const DRAG_STEPS_MAX = 40;

export interface PointerPoint {
  x: number;
  y: number;
}

export interface PointerOffset {
  x?: number;
  y?: number;
}

export type DragMode = 'pointer' | 'html5';

export function applyOffset(point: PointerPoint, offset?: PointerOffset | null): PointerPoint {
  const dx = offset && Number.isFinite(offset.x) ? Number(offset.x) : 0;
  const dy = offset && Number.isFinite(offset.y) ? Number(offset.y) : 0;
  return {
    x: Math.round(point.x + dx),
    y: Math.round(point.y + dy),
  };
}

export function parseOffset(
  value: unknown,
  name: string,
): PointerOffset | null | { error: string } {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return { error: `${name} must be { x, y }` };
  const raw = value as PointerOffset;
  const x = raw.x === undefined ? 0 : Number(raw.x);
  const y = raw.y === undefined ? 0 : Number(raw.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { error: `${name}.x and ${name}.y must be numbers` };
  }
  return { x, y };
}

/** Inclusive path. `steps` is the number of segments, so 2 steps yields 3 points. */
export function pointerSteps(
  start: PointerPoint,
  end: PointerPoint,
  steps: number = DRAG_STEPS_DEFAULT,
): PointerPoint[] {
  const requested = Number.isFinite(steps) ? Math.floor(steps) : DRAG_STEPS_DEFAULT;
  const segments = Math.min(DRAG_STEPS_MAX, Math.max(1, requested));
  const points: PointerPoint[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const next = {
      x: Math.round(start.x + (end.x - start.x) * t),
      y: Math.round(start.y + (end.y - start.y) * t),
    };
    const prev = points[points.length - 1];
    if (!prev || prev.x !== next.x || prev.y !== next.y) points.push(next);
  }
  if (points.length === 0) points.push({ x: Math.round(end.x), y: Math.round(end.y) });
  return points;
}

/** Approach from outside the target so the page sees mouseenter, ending on the target. */
export function hoverApproach(
  target: PointerPoint,
  approachPx: number = 24,
  steps: number = 5,
): PointerPoint[] {
  const distance = Number.isFinite(approachPx) ? Math.max(1, Math.round(approachPx)) : 24;
  const origin = {
    x: target.x - distance,
    y: target.y - Math.round(distance / 2),
  };
  const path = pointerSteps(origin, target, steps);
  const last = path[path.length - 1];
  const end = { x: Math.round(target.x), y: Math.round(target.y) };
  if (!last || last.x !== end.x || last.y !== end.y) path.push(end);
  return path;
}

export function parseHoldMs(holdMs: unknown, durationSeconds: unknown): number | { error: string } {
  if (holdMs !== undefined && holdMs !== null) {
    const n = Number(holdMs);
    if (!Number.isFinite(n) || n < 0) return { error: 'holdMs must be a non-negative number' };
    return Math.min(HOVER_HOLD_MAX_MS, Math.floor(n));
  }
  if (durationSeconds !== undefined && durationSeconds !== null) {
    const n = Number(durationSeconds);
    if (!Number.isFinite(n) || n < 0) return { error: 'duration must be a non-negative number' };
    return Math.min(HOVER_HOLD_MAX_MS, Math.floor(n * 1000));
  }
  return HOVER_HOLD_DEFAULT_MS;
}

export function parsePointerSteps(
  value: unknown,
  fallback: number = DRAG_STEPS_DEFAULT,
): number | { error: string } {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > DRAG_STEPS_MAX) {
    return { error: `steps must be an integer from 1 to ${DRAG_STEPS_MAX}` };
  }
  return n;
}

/**
 * Sliders and other pointer widgets use mouse events.
 * Elements that participate in HTML5 drag-and-drop use drag events.
 */
export function chooseDragMode(input: {
  dragMode?: unknown;
  range?: boolean;
  draggable?: boolean;
}): DragMode | { error: string } {
  const requested = input.dragMode;
  if (requested !== undefined && requested !== null && requested !== 'auto') {
    if (requested === 'pointer' || requested === 'html5') return requested;
    return { error: 'dragMode must be auto, pointer, or html5' };
  }
  if (input.range) return 'pointer';
  if (input.draggable) return 'html5';
  return 'pointer';
}
