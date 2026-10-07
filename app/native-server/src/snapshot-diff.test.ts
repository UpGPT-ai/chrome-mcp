import { describe, expect, test } from '@jest/globals';
import {
  capSnapshotDiff,
  diffSnapshotLines,
  formatAgentRef,
  parseAgentRef,
  snapshotLineKey,
} from 'chrome-mcp-shared';

describe('diffSnapshotLines', () => {
  test('reports added, removed, and changed refs and ignores unchanged lines', () => {
    const before = [
      'ref_1 button "Save"',
      'ref_2 textbox "Email" value="a"',
      'ref_3 checkbox "Remember"',
    ];
    const after = ['ref_1 button "Save"', 'ref_2 textbox "Email" value="b"', 'ref_4 link "Next"'];

    expect(diffSnapshotLines(before, after)).toEqual({
      added: ['ref_4 link "Next"'],
      removed: ['ref_3 checkbox "Remember"'],
      changed: ['ref_2 textbox "Email" value="b"'],
    });
  });

  test('keeps document order and treats a frame-qualified ref as its own element', () => {
    const before = ['ref_1 button "Go"', 'ref_1@4 button "Go"'];
    const after = ['ref_1@4 button "Go now"', 'ref_2 link "Docs"', 'ref_1 button "Go"'];

    expect(diffSnapshotLines(before, after)).toEqual({
      added: ['ref_2 link "Docs"'],
      removed: [],
      changed: ['ref_1@4 button "Go now"'],
    });
  });

  test('diffs lines that have no ref by their full text', () => {
    const marker = 'frame[src="https://ads.example/unit"] (cross-origin, not traversed)';
    const next = 'frame[src="https://ads.example/other"] (cross-origin, not traversed)';
    expect(diffSnapshotLines([marker, 'ref_1 button "Ok"'], [next, 'ref_1 button "Ok"'])).toEqual({
      added: [next],
      removed: [marker],
      changed: [],
    });
  });

  test('skips blank lines and lets a repeated ref take the latest text', () => {
    expect(
      diffSnapshotLines(
        ['', 'ref_8 generic "One"', 'ref_8 generic "Two"'],
        ['ref_8 generic "Two"'],
      ),
    ).toEqual({ added: [], removed: [], changed: [] });
  });

  test('caps each bucket independently', () => {
    const before = ['ref_1 button "A"', 'ref_2 button "B"'];
    const after = ['ref_2 button "B2"', 'ref_3 button "C"', 'ref_4 button "D"'];
    const capped = capSnapshotDiff(diffSnapshotLines(before, after), 1);
    expect(capped.added).toEqual(['ref_3 button "C"']);
    expect(capped.removed).toEqual(['ref_1 button "A"']);
    expect(capped.changed).toEqual(['ref_2 button "B2"']);
  });
});

describe('agent refs', () => {
  test('parses a main-frame ref and a frame-qualified ref', () => {
    expect(parseAgentRef('ref_12')).toEqual({ ref: 'ref_12' });
    expect(parseAgentRef(' ref_12@7 ')).toEqual({ ref: 'ref_12', frameId: 7 });
    expect(parseAgentRef('not-a-ref')).toEqual({ ref: 'not-a-ref' });
  });

  test('formats frame 0 without a suffix', () => {
    expect(formatAgentRef('ref_3', 0)).toBe('ref_3');
    expect(formatAgentRef('ref_3', 9)).toBe('ref_3@9');
    expect(formatAgentRef('ref_3')).toBe('ref_3');
  });

  test('keys a snapshot line by its ref token', () => {
    expect(snapshotLineKey('ref_2@3 textbox "Name" value="a"')).toBe('ref:ref_2@3');
    expect(snapshotLineKey('frame[src="https://x"] (cross-origin, not traversed)')).toBe(
      'raw:frame[src="https://x"] (cross-origin, not traversed)',
    );
  });
});
