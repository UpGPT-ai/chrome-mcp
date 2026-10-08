import { describe, expect, test } from '@jest/globals';
import { buildObserveDiff, newStringEntries, parseObserve } from 'chrome-mcp-shared';

describe('parseObserve', () => {
  test('treats omitted and false as off', () => {
    expect(parseObserve(undefined)).toBeNull();
    expect(parseObserve(false)).toBeNull();
    expect(parseObserve(null)).toBeNull();
  });

  test('defaults settle to 300ms and caps it at 3000ms', () => {
    expect(parseObserve(true)).toEqual({ settleMs: 300 });
    expect(parseObserve({})).toEqual({ settleMs: 300 });
    expect(parseObserve({ settleMs: 1200 })).toEqual({ settleMs: 1200 });
    expect(parseObserve({ settleMs: 9000 })).toEqual({ settleMs: 3000 });
  });

  test('rejects a bad settle value', () => {
    expect(parseObserve('yes')).toEqual({ error: 'observe must be true or { settleMs }' });
    expect(parseObserve({ settleMs: -1 })).toEqual({
      error: 'observe.settleMs must be a non-negative number',
    });
  });
});

describe('buildObserveDiff', () => {
  test('omits unchanged url and title and caps each change list', () => {
    const linesBefore = ['ref_1 button "Save"', 'ref_2 textbox "Email" value="a"'];
    const linesAfter = ['ref_1 button "Saved"', 'ref_3 link "Next"'];
    const requests = Array.from({ length: 25 }, (_, i) => ({
      method: 'GET',
      url: `https://example.com/${i}`,
      status: 200,
    }));
    const errors = Array.from({ length: 12 }, (_, i) => `error ${i}`);

    const diff = buildObserveDiff({
      urlBefore: 'https://example.com/a',
      urlAfter: 'https://example.com/a',
      titleBefore: 'Before',
      titleAfter: 'After',
      linesBefore,
      linesAfter,
      requests,
      consoleErrors: errors,
      dialogOpened: true,
    });

    expect(diff.url).toBeNull();
    expect(diff.title).toEqual({ before: 'Before', after: 'After' });
    expect(diff.domChanges.changed).toEqual(['ref_1 button "Saved"']);
    expect(diff.domChanges.removed).toEqual(['ref_2 textbox "Email" value="a"']);
    expect(diff.domChanges.added).toEqual(['ref_3 link "Next"']);
    expect(diff.newRequests).toHaveLength(20);
    expect(diff.newConsoleErrors).toHaveLength(10);
    expect(diff.dialogOpened).toBe(true);
  });
});

describe('newStringEntries', () => {
  test('returns only messages that were not already in the buffer', () => {
    expect(newStringEntries(['old', 'old'], ['old', 'old', 'new boom', 'old'])).toEqual([
      'new boom',
      'old',
    ]);
  });
});
