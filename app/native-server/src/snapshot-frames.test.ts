import { describe, expect, test } from '@jest/globals';
import {
  absoluteFrameSrc,
  crossOriginFrameLine,
  frameIsSameOrigin,
  matchFrameSlots,
  prefixSnapshotLine,
  unmatchedFrames,
  type FrameRecord,
} from 'chrome-mcp-shared';

const child = (frameId: number, url: string): FrameRecord => ({
  frameId,
  parentFrameId: 0,
  url,
});

describe('snapshot frames', () => {
  test('resolves a relative iframe src against the parent url', () => {
    expect(absoluteFrameSrc('/embed', 'https://shop.example/products/1')).toBe(
      'https://shop.example/embed',
    );
    expect(absoluteFrameSrc('', 'https://shop.example/')).toBe('');
  });

  test('treats about:blank as same-origin and rejects a different host', () => {
    expect(frameIsSameOrigin('https://shop.example/a', 'about:blank')).toBe(true);
    expect(frameIsSameOrigin('https://shop.example/a', 'https://shop.example/frame')).toBe(true);
    expect(frameIsSameOrigin('https://shop.example/a', 'https://ads.example/unit')).toBe(false);
  });

  test('pairs slots in order and does not reuse a frame', () => {
    const slots = [
      { src: 'https://shop.example/one', sameOrigin: true },
      { src: 'https://ads.example/unit', sameOrigin: false },
      { src: '', sameOrigin: true },
    ];
    const children = [
      child(2, 'https://shop.example/one'),
      child(3, 'https://ads.example/unit'),
      child(4, 'about:blank'),
    ];
    const matched = matchFrameSlots(slots, children, 'https://shop.example/');
    expect(matched.map((pair) => pair.frame?.frameId)).toEqual([2, 3, 4]);
    expect(unmatchedFrames(children, [2, 3, 4])).toEqual([]);
  });

  test('leaves an unmatched cross-origin child for the caller to list', () => {
    const children = [child(8, 'https://other.example/x')];
    expect(unmatchedFrames(children, [])).toEqual(children);
  });

  test('prefixes only the local ref and keeps an existing frame suffix', () => {
    expect(prefixSnapshotLine('ref_4 button "Go"', 6)).toBe('ref_4@6 button "Go"');
    expect(prefixSnapshotLine('ref_4@6 button "Go"', 6)).toBe('ref_4@6 button "Go"');
    expect(prefixSnapshotLine('ref_4 button "Go"', 0)).toBe('ref_4 button "Go"');
  });

  test('formats the cross-origin marker the agent is told to expect', () => {
    expect(crossOriginFrameLine('https://ads.example/a?q="x"', 9)).toBe(
      'frame[src="https://ads.example/a?q=\\"x\\""] (cross-origin, not traversed) frameId=9',
    );
  });
});
