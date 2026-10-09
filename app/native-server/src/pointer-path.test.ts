import { describe, expect, test } from '@jest/globals';
import {
  applyOffset,
  chooseDragMode,
  hoverApproach,
  parseHoldMs,
  parseOffset,
  parsePointerSteps,
  pointerSteps,
} from 'chrome-mcp-shared';

describe('pointerSteps', () => {
  test('includes both ends and drops duplicate rounded points', () => {
    expect(pointerSteps({ x: 0, y: 0 }, { x: 10, y: 0 }, 2)).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(pointerSteps({ x: 5, y: 5 }, { x: 5, y: 5 }, 4)).toEqual([{ x: 5, y: 5 }]);
  });
});

describe('hoverApproach', () => {
  test('ends on the target after approaching from outside it', () => {
    const path = hoverApproach({ x: 100, y: 80 }, 24, 4);
    expect(path[0]).toEqual({ x: 76, y: 68 });
    expect(path[path.length - 1]).toEqual({ x: 100, y: 80 });
    expect(path.length).toBeGreaterThan(2);
  });
});

describe('applyOffset', () => {
  test('adds viewport pixels and rounds', () => {
    expect(applyOffset({ x: 10.2, y: 4 }, { x: 1.4, y: -2 })).toEqual({ x: 12, y: 2 });
    expect(applyOffset({ x: 3.4, y: 8.6 }, null)).toEqual({ x: 3, y: 9 });
  });
});

describe('parseHoldMs', () => {
  test('defaults to 400, prefers holdMs, and caps at 5000', () => {
    expect(parseHoldMs(undefined, undefined)).toBe(400);
    expect(parseHoldMs(250, 2)).toBe(250);
    expect(parseHoldMs(undefined, 1.5)).toBe(1500);
    expect(parseHoldMs(9000, undefined)).toBe(5000);
    expect(parseHoldMs(-1, undefined)).toEqual({ error: 'holdMs must be a non-negative number' });
  });
});

describe('parsePointerSteps and parseOffset', () => {
  test('rejects a bad step count and a bad offset', () => {
    expect(parsePointerSteps(undefined, 8)).toBe(8);
    expect(parsePointerSteps(0, 8)).toEqual({ error: 'steps must be an integer from 1 to 40' });
    expect(parseOffset(undefined, 'offset')).toBeNull();
    expect(parseOffset({ x: 'no' }, 'startOffset')).toEqual({
      error: 'startOffset.x and startOffset.y must be numbers',
    });
  });
});

describe('chooseDragMode', () => {
  test('uses pointer for sliders and html5 for draggable elements', () => {
    expect(chooseDragMode({ range: true, draggable: true })).toBe('pointer');
    expect(chooseDragMode({ draggable: true })).toBe('html5');
    expect(chooseDragMode({})).toBe('pointer');
    expect(chooseDragMode({ dragMode: 'html5', range: true })).toBe('html5');
    expect(chooseDragMode({ dragMode: 'slide' })).toEqual({
      error: 'dragMode must be auto, pointer, or html5',
    });
  });
});
