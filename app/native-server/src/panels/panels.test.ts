import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PanelStore, PanelServer, assemblePanelHtml, handlePanelTool, PANEL_LIMITS } from './index';

function req(
  port: number,
  method: string,
  p: string,
  opts: { host?: string; origin?: string; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: p,
        headers: {
          ...(opts.host ? { host: opts.host } : {}),
          ...(opts.origin ? { origin: opts.origin } : {}),
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, headers: res.headers, body: b }),
        );
      },
    );
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

describe('assemblePanelHtml', () => {
  it('wraps a fragment and injects title and bridge', () => {
    const out = assemblePanelHtml('<h1>Hi</h1>', 'A <b>', 3);
    expect(out).toContain('<title>A &#60;b&#62;</title>');
    expect(out).toContain('window.ClaudePanel');
    expect(out).toContain('var version=3');
  });
  it('injects into a full document before </body>', () => {
    const out = assemblePanelHtml('<html><head></head><body>x</body></html>', 'T', 1);
    expect(out.indexOf('ClaudePanel')).toBeLessThan(out.indexOf('</body>'));
    expect(out).toContain('<title>T</title>');
  });
});

describe('PanelStore', () => {
  it('delivers events once and wakes waiters', async () => {
    const s = new PanelStore();
    const p = s.create({ title: 't', html: '<p>x</p>' });
    const waiting = s.wait(p, 5000);
    s.pushEvent(p, { type: 'submit', data: { a: 1 } });
    const r = await waiting;
    expect(r.status).toBe('events');
    expect(r.events[0].data).toEqual({ a: 1 });
    expect((await s.wait(p, 0)).status).toBe('timeout');
  });
  it('times out and reports closed with remaining events', async () => {
    const s = new PanelStore();
    const p = s.create({ title: 't', html: '<p>x</p>' });
    expect((await s.wait(p, 20)).status).toBe('timeout');
    s.pushEvent(p, { type: 'event', name: 'n' });
    s.close(p, 'test');
    const r = await s.wait(p, 0);
    expect(r.status).toBe('closed');
    expect(r.events.map((e) => e.type)).toEqual(['event', 'closed']);
  });
  it('caps wait and open panels, rejects empty html and relative assets', () => {
    const s = new PanelStore();
    expect(() => s.create({ title: 't', html: ' ' })).toThrow();
    expect(() => s.create({ title: 't', html: 'x', assets: ['rel.png'] })).toThrow(/absolute/);
    for (let i = 0; i < PANEL_LIMITS.maxOpenPanels; i++) s.create({ title: 't', html: 'x' });
    expect(() => s.create({ title: 't', html: 'x' })).toThrow(/Too many/);
  });
  it('update bumps version and dedupes asset names', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-'));
    fs.writeFileSync(path.join(dir, 'a.png'), 'x');
    fs.writeFileSync(path.join(dir, '.hidden'), 'x');
    const s = new PanelStore();
    const p = s.create({ title: 't', html: 'x', assets: [dir] });
    expect([...p.assets.keys()]).toEqual(['a.png']);
    const added = s.update(p, { html: 'y', assets: [path.join(dir, 'a.png')] });
    expect(p.version).toBe(2);
    expect(added[0].name).toBe('a-2.png');
  });
});

describe('PanelServer', () => {
  let store: PanelStore;
  let server: PanelServer;
  let port: number;
  let dir: string;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-srv-'));
    fs.writeFileSync(path.join(dir, 'pic.png'), 'PNGDATA');
    store = new PanelStore();
    server = new PanelServer(store);
    port = await server.start();
  });
  afterAll(() => server.stop());

  it('serves html, assets, and records events', async () => {
    const p = store.create({ title: 'T', html: '<p>hello</p>', assets: [dir] });
    const page = await req(port, 'GET', `/p/${p.id}/`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('hello');
    expect(page.headers['content-security-policy']).toContain("connect-src 'self'");
    const asset = await req(port, 'GET', `/p/${p.id}/assets/pic.png`);
    expect(asset.body).toBe('PNGDATA');
    expect(asset.headers['content-type']).toBe('image/png');
    expect((await req(port, 'GET', `/p/${p.id}/assets/..%2Fx`)).status).toBe(404);
    const ev = await req(port, 'POST', `/p/${p.id}/event`, {
      body: JSON.stringify({ type: 'submit', data: { pick: 'b' } }),
    });
    expect(JSON.parse(ev.body).ok).toBe(true);
    const w = await store.wait(p, 0);
    expect(w.events[0]).toMatchObject({ type: 'submit', data: { pick: 'b' } });
  });

  it('rejects bad host, foreign origin, unknown ids', async () => {
    const p = store.create({ title: 'T', html: 'x' });
    expect((await req(port, 'GET', `/p/${p.id}/`, { host: 'evil.com' })).status).toBe(403);
    expect(
      (await req(port, 'POST', `/p/${p.id}/event`, { origin: 'http://evil.com', body: '{}' }))
        .status,
    ).toBe(403);
    expect((await req(port, 'GET', `/p/${'0'.repeat(32)}/`)).status).toBe(404);
    expect((await req(port, 'GET', '/mcp')).status).toBe(404);
  });

  it('page-gone beacon closes only if the page does not return', async () => {
    const p = store.create({ title: 'T', html: 'x' });
    await req(port, 'POST', `/p/${p.id}/closed`, { body: '{}' });
    await req(port, 'GET', `/p/${p.id}/`);
    await new Promise((r) => setTimeout(r, PANEL_LIMITS.closeGraceMs + 300));
    expect(p.status).toBe('open');
    await req(port, 'POST', `/p/${p.id}/closed`, { body: '{}' });
    await new Promise((r) => setTimeout(r, PANEL_LIMITS.closeGraceMs + 300));
    expect(p.status).toBe('closed');
  }, 10000);
});

describe('handlePanelTool', () => {
  it('opens via the extension, waits, closes', async () => {
    const store = new PanelStore();
    const server = new PanelServer(store);
    const calls: any[] = [];
    const callExtension = async (name: string, args: any) => {
      calls.push({ name, args });
      return { windowId: 7, tabs: [{ tabId: 9 }] };
    };
    const deps = { store, server, callExtension };
    const opened = JSON.parse(
      (
        (await handlePanelTool('chrome_panel_open', { html: '<p>x</p>', title: 'Rank' }, deps))
          .content[0] as any
      ).text,
    );
    expect(opened).toMatchObject({ windowId: 7, tabId: 9 });
    expect(calls[0].args).toMatchObject({ type: 'popup', focus: false });
    expect(calls[0].args.urls[0]).toContain(`/p/${opened.panelId}/`);
    const waited = JSON.parse(
      (
        (
          await handlePanelTool(
            'chrome_panel_wait',
            { panelId: opened.panelId, timeoutMs: 10 },
            deps,
          )
        ).content[0] as any
      ).text,
    );
    expect(waited.status).toBe('timeout');
    const closed = JSON.parse(
      (
        (await handlePanelTool('chrome_panel_close', { panelId: opened.panelId }, deps))
          .content[0] as any
      ).text,
    );
    expect(closed.windowClosed).toBe(true);
    expect(calls[1]).toEqual({ name: 'chrome_close_window', args: { windowIds: [7] } });
    const bad = await handlePanelTool('chrome_panel_wait', { panelId: 'nope' }, deps);
    expect(bad.isError).toBe(true);
    await server.stop();
  });
});
