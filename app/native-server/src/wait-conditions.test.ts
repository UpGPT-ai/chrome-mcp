import { describe, expect, test } from '@jest/globals';
import {
  evaluateWaitConditions,
  formatWaitTimeout,
  parseWaitArgs,
  urlMatchesPattern,
} from 'chrome-mcp-shared';

describe('parseWaitArgs', () => {
  test('requires a condition and defaults the timeout', () => {
    expect(parseWaitArgs(undefined)).toEqual({
      error: 'at least one wait condition is required',
    });
    expect(parseWaitArgs({})).toEqual({ error: 'at least one wait condition is required' });
    const parsed = parseWaitArgs({ text: ' Ready ' });
    expect(parsed).toMatchObject({
      conditions: ['text'],
      all: false,
      timeoutMs: 10000,
      text: 'Ready',
    });
  });

  test('caps timeout and rejects a quiet period longer than the timeout', () => {
    expect(parseWaitArgs({ text: 'Ready', timeoutMs: 90000 })).toMatchObject({ timeoutMs: 60000 });
    expect(parseWaitArgs({ networkIdleMs: 20000 })).toEqual({
      error: 'networkIdleMs cannot exceed timeoutMs',
    });
    expect(parseWaitArgs({ domQuietMs: 0, text: 'Ready' })).toEqual({
      error: 'domQuietMs must be a positive number',
    });
    expect(parseWaitArgs({ networkIdleMs: 500, timeoutMs: 2000 })).toMatchObject({
      conditions: ['networkIdleMs'],
      networkIdleMs: 500,
      timeoutMs: 2000,
    });
  });

  test('rejects a bad regex, a blank selector, and a non-boolean all flag', () => {
    expect(parseWaitArgs({ urlMatches: '(' })).toEqual({
      error: 'urlMatches is not a valid regular expression',
    });
    expect(parseWaitArgs({ selector: '   ' })).toEqual({
      error: 'selector must be a non-empty string',
    });
    expect(parseWaitArgs({ text: 'Ready', all: 'yes' })).toEqual({
      error: 'all must be a boolean',
    });
  });
});

describe('urlMatchesPattern', () => {
  test('tests the page url against the pattern source', () => {
    expect(urlMatchesPattern('https://example.com/a', 'example\\.com/a')).toBe(true);
    expect(urlMatchesPattern('https://example.com/b', 'example\\.com/a$')).toBe(false);
  });
});

describe('evaluateWaitConditions', () => {
  test('any mode finishes when one condition is true and lists every true one', () => {
    const verdict = evaluateWaitConditions(
      { conditions: ['text', 'selector', 'urlMatches'], all: false },
      { textFound: true, selectorFound: false, urlMatched: true },
    );
    expect(verdict.done).toBe(true);
    expect(verdict.met).toEqual(['text', 'urlMatches']);
    expect(verdict.unmet).toEqual(['selector']);
  });

  test('all mode stays open until every condition is true', () => {
    const request = {
      conditions: ['text', 'ref'] as const,
      all: true,
    };
    expect(evaluateWaitConditions(request, { textFound: true, refConnected: false })).toEqual({
      done: false,
      met: ['text'],
      unmet: ['ref'],
    });
    expect(evaluateWaitConditions(request, { textFound: true, refConnected: true })).toEqual({
      done: true,
      met: ['text', 'ref'],
      unmet: [],
    });
  });

  test('treats gone conditions as met only when the target is absent', () => {
    const request = {
      conditions: ['textGone', 'selectorGone', 'refGone'] as const,
      all: true,
    };
    expect(
      evaluateWaitConditions(request, {
        textGoneFound: true,
        selectorGoneFound: false,
        refGoneConnected: false,
      }),
    ).toEqual({
      done: false,
      met: ['selectorGone', 'refGone'],
      unmet: ['textGone'],
    });
    expect(
      evaluateWaitConditions(request, {
        textGoneFound: false,
        selectorGoneFound: false,
        refGoneConnected: false,
      }).done,
    ).toBe(true);
  });

  test('compares quiet durations to the requested thresholds', () => {
    const request = {
      conditions: ['networkIdleMs', 'domQuietMs'] as const,
      all: true,
      networkIdleMs: 500,
      domQuietMs: 300,
    };
    expect(
      evaluateWaitConditions(request, { networkQuietMs: 500, domQuietForMs: 299 }).unmet,
    ).toEqual(['domQuietMs']);
    expect(
      evaluateWaitConditions(request, { networkQuietMs: 500, domQuietForMs: 300 }),
    ).toMatchObject({ done: true, met: ['networkIdleMs', 'domQuietMs'], unmet: [] });
  });

  test('does not treat a missing signal as met', () => {
    expect(
      evaluateWaitConditions({ conditions: ['textGone', 'networkIdleMs'], all: false }, {}),
    ).toEqual({
      done: false,
      met: [],
      unmet: ['textGone', 'networkIdleMs'],
    });
  });
});

describe('formatWaitTimeout', () => {
  test('names the unmet conditions', () => {
    expect(formatWaitTimeout(10000, ['selector', 'networkIdleMs'])).toBe(
      'Timed out after 10000ms. Unmet: selector, networkIdleMs',
    );
  });
});
