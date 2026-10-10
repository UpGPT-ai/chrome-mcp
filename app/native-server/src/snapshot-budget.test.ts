import {
  TOOL_NAMES,
  TOOL_SCHEMAS,
  SNAPSHOT_DEFAULT_MAX_ITEMS,
  SNAPSHOT_DEFAULT_MAX_CHARS,
  SNAPSHOT_HARD_MAX_ITEMS,
  SNAPSHOT_HARD_MAX_CHARS,
  capLabel,
  capLinesByChars,
  formatOutline,
  paginateSnapshot,
  parseFindQuery,
  parseSnapshotBudget,
} from 'chrome-mcp-shared';

const entries = (n: number, group = 'page') =>
  Array.from({ length: n }, (_, i) => ({ line: `ref_${i} button "b${i}"`, group }));

describe('snapshot budget', () => {
  test('defaults and clamps', () => {
    const d = parseSnapshotBudget({});
    expect(d).toMatchObject({
      maxItems: SNAPSHOT_DEFAULT_MAX_ITEMS,
      maxChars: SNAPSHOT_DEFAULT_MAX_CHARS,
      offset: 0,
    });
    expect(SNAPSHOT_DEFAULT_MAX_CHARS).toBe(6000);
    const big = parseSnapshotBudget({ maxItems: 99999, maxChars: 999999 });
    expect(big).toMatchObject({
      maxItems: SNAPSHOT_HARD_MAX_ITEMS,
      maxChars: SNAPSHOT_HARD_MAX_CHARS,
    });
    expect(parseSnapshotBudget({ cursor: 25 })).toMatchObject({ offset: 25 });
    expect('error' in parseSnapshotBudget({ maxChars: 'x' })).toBe(true);
  });

  test('capLabel adds an ellipsis', () => {
    expect(capLabel('abcdef', 4)).toHaveLength(4);
    expect(capLabel('abcdef', 4).endsWith('…')).toBe(true);
    expect(capLabel('abc', 4)).toBe('abc');
  });

  test('paginate by items reports remaining and nextCursor', () => {
    const page = paginateSnapshot(entries(10), { offset: 0, maxItems: 4, maxChars: 40000 });
    expect(page.shown).toBe(4);
    expect(page.remaining).toBe(6);
    expect(page.nextCursor).toBe(4);
    expect(page.truncated).toBe(true);
    const next = paginateSnapshot(entries(10), { offset: 4, maxItems: 4, maxChars: 40000 });
    expect(next.lines[0]).toContain('ref_4 ');
    expect(next.nextCursor).toBe(8);
  });

  test('paginate by chars and always returns a line', () => {
    const page = paginateSnapshot(entries(50), { offset: 0, maxItems: 50, maxChars: 200 });
    expect(page.lines.join('\n').length).toBeLessThanOrEqual(200);
    expect(page.lines.length).toBeGreaterThan(0);
    expect(page.remaining).toBe(50 - page.shown);
    const long = Array.from({ length: 3 }, () => ({ line: 'y'.repeat(500), group: 'page' }));
    const tiny = paginateSnapshot(long, { offset: 0, maxItems: 3, maxChars: 200 });
    expect(tiny.lines).toHaveLength(1);
  });

  test('outline names the omitted groups', () => {
    const all = [...entries(2, 'main'), ...entries(5, 'nav'), ...entries(3, 'footer')];
    const page = paginateSnapshot(all, { offset: 0, maxItems: 2, maxChars: 40000 });
    expect(page.outline).toMatch(/^\+8 more: /);
    expect(page.outline).toContain('nav(5)');
    expect(page.outline).toContain('footer(3)');
    expect(formatOutline({ a: 1 })).toContain('a(1)');
  });

  test('complete page has no outline', () => {
    const page = paginateSnapshot(entries(3), { offset: 0, maxItems: 10, maxChars: 40000 });
    expect(page.truncated).toBe(false);
    expect(page.outline).toBeUndefined();
    expect(page.nextCursor).toBeUndefined();
  });

  test('capLinesByChars cuts', () => {
    const line = 'x'.repeat(99);
    const r = capLinesByChars([line, line, line], 200);
    expect(r.lines).toHaveLength(2);
    expect(r.cut).toBe(1);
  });

  test('parseFindQuery', () => {
    expect('error' in parseFindQuery({})).toBe(true);
    const ok = parseFindQuery({ text: 'Buy', role: 'button' });
    expect('error' in ok).toBe(false);
    if (!('error' in ok)) {
      expect(ok.limit).toBe(20);
      expect(ok.query).toEqual({ text: 'Buy', role: 'button' });
    }
    const capped = parseFindQuery({ text: 'x', limit: 5000 });
    if (!('error' in capped)) expect(capped.limit).toBe(100);
  });

  test('chrome_snapshot and chrome_find schemas', () => {
    expect(TOOL_NAMES.BROWSER.FIND).toBe('chrome_find');
    const snap = TOOL_SCHEMAS.find((t) => t.name === 'chrome_snapshot');
    const props = (snap?.inputSchema as { properties: Record<string, any> }).properties;
    for (const key of ['maxChars', 'maxNameChars', 'cursor', 'collapseRepeats', 'includeImages']) {
      expect(props[key]).toBeTruthy();
    }
    const find = TOOL_SCHEMAS.find((t) => t.name === 'chrome_find');
    expect(find).toBeTruthy();
    const findProps = (find?.inputSchema as { properties: Record<string, unknown> }).properties;
    for (const key of ['text', 'role', 'nearRef', 'limit', 'tabId', 'windowId', 'frameId']) {
      expect(findProps[key]).toBeTruthy();
    }
    expect(String(find?.description)).toContain('chrome_snapshot');
  });
});
