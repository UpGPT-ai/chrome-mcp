/**
 * Panels: an app-like popup window that Claude fills with HTML, to deliver data to the person
 * (images to rank, options to pick, a form to fill) and capture what they send back.
 *
 * Why this lives in the native server and not in the extension:
 *  - Extension pages run under a strict CSP (no inline scripts, no remote images) and native
 *    messaging caps a message at 1MB. A plain local web page has neither limit.
 *  - Results never travel through the extension: the page POSTs to this process, and
 *    chrome_panel_wait resolves from an in-memory queue.
 *
 * Isolation: panels are served by their OWN loopback HTTP server on a random port, never by the
 * bridge. A panel page therefore cannot reach the token-guarded bridge or the /agent routes, and
 * the Content-Security-Policy below (connect-src 'self', form-action 'self') stops panel scripts
 * from phoning home. Each panel is addressed by an unguessable id.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { isAllowedHost } from '../security/local-auth';

// ---------------------------------------------------------------------------
// Types and limits
// ---------------------------------------------------------------------------

export interface PanelEvent {
  seq: number;
  type: 'submit' | 'event' | 'closed';
  name?: string;
  data?: unknown;
  at: string;
}

interface PanelAsset {
  name: string;
  file: string;
  mime: string;
}

interface Panel {
  id: string;
  title: string;
  html: string;
  version: number;
  assets: Map<string, PanelAsset>;
  events: PanelEvent[];
  /** Index into `events` of the first event not yet returned by wait. */
  cursor: number;
  nextSeq: number;
  waiters: Set<() => void>;
  status: 'open' | 'closed';
  windowId?: number;
  tabId?: number;
  createdAt: number;
  closeTimer?: NodeJS.Timeout;
}

export const PANEL_LIMITS = {
  maxHtmlBytes: 5 * 1024 * 1024,
  maxOpenPanels: 20,
  maxAssets: 200,
  maxEventBytes: 1024 * 1024,
  maxEventsPerPanel: 1000,
  /** Keep below the stdio proxy's 2 minute per-call timeout. */
  maxWaitMs: 110_000,
  defaultWaitMs: 100_000,
  /** Grace before a vanished page counts as closed, so a reload is not mistaken for a close. */
  closeGraceMs: 2500,
  /** A closed panel's record is dropped after this long. */
  closedRetentionMs: 60 * 60 * 1000,
} as const;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

// ---------------------------------------------------------------------------
// HTML assembly
// ---------------------------------------------------------------------------

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const BASE_STYLE = `<style>
:root{color-scheme:light dark}
body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:20px}
</style>`;

/** Runs inside the panel page. Kept dependency free and ES5 so it works anywhere. */
function bootstrapScript(version: number): string {
  return `<script>(function(){
var base=location.pathname.replace(/\\/?$/,'/');
var version=${version};
var reloading=false;
function post(p,b){return fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{}),keepalive:true}).then(function(r){return r.json()}).catch(function(){return null})}
function toast(t){try{var d=document.createElement('div');d.textContent=t;d.setAttribute('style','position:fixed;right:16px;bottom:16px;padding:8px 14px;border-radius:8px;background:#111;color:#fff;font:13px sans-serif;opacity:.92;z-index:2147483647');document.body.appendChild(d);setTimeout(function(){d.remove()},1800)}catch(e){}}
window.ClaudePanel={
submit:function(data){return post('event',{type:'submit',data:data}).then(function(r){toast(r&&r.ok?'Sent to Claude':'Could not send');return r})},
event:function(name,data){return post('event',{type:'event',name:name,data:data})},
close:function(){return post('close',{}).then(function(){window.close()})}
};
document.addEventListener('submit',function(e){
var f=e.target;if(!f||f.tagName!=='FORM'||f.hasAttribute('data-no-capture'))return;
e.preventDefault();
var data={};new FormData(f).forEach(function(v,k){var val=typeof v==='string'?v:'[file:'+v.name+']';if(k in data){if(!Array.isArray(data[k]))data[k]=[data[k]];data[k].push(val)}else data[k]=val});
window.ClaudePanel.submit({form:f.id||f.getAttribute('name')||null,values:data});
},true);
setInterval(function(){fetch(base+'state',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){
if(s.status==='closed'){window.close();return}
if(s.version!==version){reloading=true;location.reload()}
}).catch(function(){})},1000);
window.addEventListener('pagehide',function(){if(!reloading)navigator.sendBeacon(base+'closed','{}')});
})();</script>`;
}

/** Wraps a fragment or injects into a full document, adding the title and the ClaudePanel bridge. */
export function assemblePanelHtml(input: string, title: string, version: number): string {
  const boot = bootstrapScript(version);
  const isDoc = /<html[\s>]/i.test(input);
  if (!isDoc) {
    return (
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(title)}</title>${BASE_STYLE}</head><body>${input}${boot}</body></html>`
    );
  }
  let out = input;
  if (!/<title[\s>]/i.test(out) && title) {
    const t = `<title>${escapeHtml(title)}</title>`;
    out = /<head[^>]*>/i.test(out)
      ? out.replace(/<head[^>]*>/i, (m) => m + t)
      : out.replace(/<html[^>]*>/i, (m) => `${m}<head>${t}</head>`);
  }
  const idx = out.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  if (idx >= 0) return out.slice(0, idx) + boot + out.slice(idx);
  const h = out.search(/<\/html\s*>(?![\s\S]*<\/html\s*>)/i);
  return h >= 0 ? out.slice(0, h) + boot + out.slice(h) : out + boot;
}

// ---------------------------------------------------------------------------
// Asset registration
// ---------------------------------------------------------------------------

/** Accepts absolute file or directory paths. A directory contributes its files (not recursive). */
export function collectAssets(paths: unknown, existing: Map<string, PanelAsset>): PanelAsset[] {
  if (paths === undefined) return [];
  if (!Array.isArray(paths)) throw new Error('assets must be an array of absolute paths');
  const added: PanelAsset[] = [];
  const add = (file: string) => {
    if (existing.size >= PANEL_LIMITS.maxAssets) {
      throw new Error(`Too many assets (max ${PANEL_LIMITS.maxAssets})`);
    }
    const ext = path.extname(file);
    const stem = path.basename(file, ext);
    let name = path.basename(file);
    for (let n = 2; existing.has(name); n++) name = `${stem}-${n}${ext}`;
    const asset = { name, file, mime: MIME[ext.toLowerCase()] || 'application/octet-stream' };
    existing.set(name, asset);
    added.push(asset);
  };
  for (const raw of paths) {
    if (typeof raw !== 'string' || !path.isAbsolute(raw)) {
      throw new Error(`Asset path must be absolute: ${String(raw)}`);
    }
    const resolved = fs.realpathSync(raw);
    const st = fs.statSync(resolved);
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(resolved).sort()) {
        if (entry.startsWith('.')) continue;
        const full = path.join(resolved, entry);
        if (fs.statSync(full).isFile()) add(fs.realpathSync(full));
      }
    } else if (st.isFile()) {
      add(resolved);
    } else {
      throw new Error(`Not a file or directory: ${raw}`);
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// Store: panels, events, waiting
// ---------------------------------------------------------------------------

export class PanelStore {
  private panels = new Map<string, Panel>();

  create(args: { title: string; html: string; assets?: unknown }): Panel {
    if (typeof args.html !== 'string' || args.html.trim() === '') {
      throw new Error('html must be a non-empty string');
    }
    if (Buffer.byteLength(args.html) > PANEL_LIMITS.maxHtmlBytes) {
      throw new Error(
        `html exceeds ${PANEL_LIMITS.maxHtmlBytes} bytes; pass big files through assets instead`,
      );
    }
    this.sweep();
    const open = [...this.panels.values()].filter((p) => p.status === 'open').length;
    if (open >= PANEL_LIMITS.maxOpenPanels) {
      throw new Error(`Too many open panels (max ${PANEL_LIMITS.maxOpenPanels}); close some first`);
    }
    const assets = new Map<string, PanelAsset>();
    collectAssets(args.assets, assets);
    const panel: Panel = {
      id: randomBytes(16).toString('hex'),
      title: args.title,
      html: args.html,
      version: 1,
      assets,
      events: [],
      cursor: 0,
      nextSeq: 1,
      waiters: new Set(),
      status: 'open',
      createdAt: Date.now(),
    };
    this.panels.set(panel.id, panel);
    return panel;
  }

  get(id: string): Panel | undefined {
    return this.panels.get(id);
  }

  require(id: unknown): Panel {
    const panel = typeof id === 'string' ? this.panels.get(id) : undefined;
    if (!panel) throw new Error(`Unknown panelId: ${String(id)}`);
    return panel;
  }

  update(panel: Panel, patch: { html?: string; title?: string; assets?: unknown }): PanelAsset[] {
    if (panel.status === 'closed') throw new Error('Panel is closed');
    if (patch.html !== undefined) {
      if (typeof patch.html !== 'string' || patch.html.trim() === '') {
        throw new Error('html must be a non-empty string');
      }
      if (Buffer.byteLength(patch.html) > PANEL_LIMITS.maxHtmlBytes) {
        throw new Error(`html exceeds ${PANEL_LIMITS.maxHtmlBytes} bytes`);
      }
    }
    const added = collectAssets(patch.assets, panel.assets);
    if (patch.html !== undefined) panel.html = patch.html;
    if (patch.title !== undefined) panel.title = patch.title;
    panel.version += 1;
    return added;
  }

  pushEvent(panel: Panel, ev: { type: 'submit' | 'event'; name?: string; data?: unknown }): number {
    if (panel.status === 'closed') throw new Error('Panel is closed');
    if (panel.events.length >= PANEL_LIMITS.maxEventsPerPanel) {
      throw new Error('Too many unread events; call chrome_panel_wait');
    }
    const seq = panel.nextSeq++;
    panel.events.push({ seq, at: new Date().toISOString(), ...ev });
    this.wake(panel);
    return seq;
  }

  close(panel: Panel, reason: string): void {
    if (panel.closeTimer) clearTimeout(panel.closeTimer);
    panel.closeTimer = undefined;
    if (panel.status === 'closed') return;
    panel.status = 'closed';
    panel.events.push({
      seq: panel.nextSeq++,
      type: 'closed',
      data: { reason },
      at: new Date().toISOString(),
    });
    this.wake(panel);
  }

  /** The page went away. Treated as a close only if it does not come back (reload) shortly. */
  scheduleClose(panel: Panel): void {
    if (panel.status === 'closed' || panel.closeTimer) return;
    panel.closeTimer = setTimeout(
      () => this.close(panel, 'window closed by user'),
      PANEL_LIMITS.closeGraceMs,
    );
    panel.closeTimer.unref();
  }

  cancelScheduledClose(panel: Panel): void {
    if (panel.closeTimer) clearTimeout(panel.closeTimer);
    panel.closeTimer = undefined;
  }

  private wake(panel: Panel): void {
    for (const w of [...panel.waiters]) w();
  }

  private take(panel: Panel): PanelEvent[] {
    const out = panel.events.slice(panel.cursor);
    panel.cursor = panel.events.length;
    return out;
  }

  /** Resolves when there are unread events, the panel closes, or the timeout elapses. */
  async wait(
    panel: Panel,
    timeoutMs: number,
  ): Promise<{ status: 'events' | 'closed' | 'timeout'; events: PanelEvent[] }> {
    const ms = Math.min(Math.max(0, timeoutMs), PANEL_LIMITS.maxWaitMs);
    const ready = () => panel.cursor < panel.events.length || panel.status === 'closed';
    if (!ready() && ms > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          panel.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        panel.waiters.add(done);
      });
    }
    const events = this.take(panel);
    const status = panel.status === 'closed' ? 'closed' : events.length > 0 ? 'events' : 'timeout';
    return { status, events };
  }

  private sweep(): void {
    const cutoff = Date.now() - PANEL_LIMITS.closedRetentionMs;
    for (const [id, p] of this.panels) {
      if (p.status === 'closed' && p.createdAt < cutoff) this.panels.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP server (loopback, random port, panel routes only)
// ---------------------------------------------------------------------------

const PANEL_CSP =
  "default-src 'self' data: blob: http: https: 'unsafe-inline' 'unsafe-eval'; " +
  "connect-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'";

const ROUTE = /^\/p\/([0-9a-f]{32})(\/.*)?$/;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > PANEL_LIMITS.maxEventBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export class PanelServer {
  private server?: http.Server;
  private starting?: Promise<number>;
  constructor(readonly store: PanelStore) {}

  /** Starts on first use and returns the port. */
  start(): Promise<number> {
    if (this.server?.listening) return Promise.resolve((this.server.address() as AddressInfo).port);
    if (this.starting) return this.starting;
    this.starting = new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      server.once('error', (e) => {
        this.starting = undefined;
        reject(e);
      });
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        server.unref();
        this.starting = undefined;
        resolve((server.address() as AddressInfo).port);
      });
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private send(res: http.ServerResponse, code: number, type: string, body: string | Buffer): void {
    res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }

  private json(res: http.ServerResponse, code: number, value: unknown): void {
    this.send(res, code, 'application/json', JSON.stringify(value));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // DNS-rebinding guard: only loopback host names.
    if (!isAllowedHost(req.headers.host)) return this.json(res, 403, { error: 'forbidden' });
    const port = (req.socket.localPort as number) || 0;
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      return this.json(res, 403, { error: 'forbidden' });
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const m = ROUTE.exec(url.pathname);
    if (!m) return this.json(res, 404, { error: 'not found' });
    const panel = this.store.get(m[1]);
    if (!panel) return this.json(res, 404, { error: 'not found' });
    const rest = m[2] || '';
    const method = req.method || 'GET';

    if (method === 'GET' && rest === '') {
      res.writeHead(302, { Location: `/p/${panel.id}/` });
      return void res.end();
    }

    if (method === 'GET' && rest === '/') {
      this.store.cancelScheduledClose(panel);
      const html = assemblePanelHtml(panel.html, panel.title, panel.version);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': PANEL_CSP,
      });
      return void res.end(html);
    }

    if (method === 'GET' && rest === '/state') {
      return this.json(res, 200, { version: panel.version, status: panel.status });
    }

    if (method === 'GET' && rest.startsWith('/assets/')) {
      let name: string;
      try {
        name = decodeURIComponent(rest.slice('/assets/'.length));
      } catch {
        return this.json(res, 400, { error: 'bad path' });
      }
      const asset = panel.assets.get(name);
      if (!asset) return this.json(res, 404, { error: 'not found' });
      let size: number;
      try {
        size = fs.statSync(asset.file).size;
      } catch {
        return this.json(res, 404, { error: 'file missing' });
      }
      res.writeHead(200, {
        'Content-Type': asset.mime,
        'Content-Length': size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      });
      const stream = fs.createReadStream(asset.file);
      stream.on('error', () => res.destroy());
      return void stream.pipe(res);
    }

    if (method === 'POST' && rest === '/event') {
      let body: any;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return this.json(res, 400, { ok: false, error: 'bad json' });
      }
      const type = body?.type === 'submit' ? 'submit' : 'event';
      try {
        const seq = this.store.pushEvent(panel, {
          type,
          name: typeof body?.name === 'string' ? body.name.slice(0, 200) : undefined,
          data: body?.data,
        });
        return this.json(res, 200, { ok: true, seq });
      } catch (e) {
        return this.json(res, 409, { ok: false, error: (e as Error).message });
      }
    }

    if (method === 'POST' && rest === '/close') {
      await readBody(req).catch(() => '');
      this.store.close(panel, 'closed by page');
      return this.json(res, 200, { ok: true });
    }

    if (method === 'POST' && rest === '/closed') {
      await readBody(req).catch(() => '');
      this.store.scheduleClose(panel);
      return this.json(res, 200, { ok: true });
    }

    return this.json(res, 404, { error: 'not found' });
  }
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

export const PANEL_TOOL_NAMES = {
  OPEN: 'chrome_panel_open',
  WAIT: 'chrome_panel_wait',
  UPDATE: 'chrome_panel_update',
  CLOSE: 'chrome_panel_close',
} as const;

const API_NOTE =
  'The page gets window.ClaudePanel: submit(data) sends a result, event(name, data) sends a ' +
  'named interaction, close() closes the window. A <form> is captured automatically: on submit ' +
  'its fields arrive as one "submit" event (add data-no-capture to opt out). Network access from ' +
  'the page is limited to the panel itself (fetch/XHR to other hosts is blocked); images, media, ' +
  'fonts, styles and scripts may load from anywhere.';

export const panelToolSchemas: Tool[] = [
  {
    name: PANEL_TOOL_NAMES.OPEN,
    description:
      'Open an app-style window (no tab strip, no address bar) showing HTML you supply, to deliver ' +
      'content to the person (images to rank, options to choose, a form) and capture their answer. ' +
      'Then call chrome_panel_wait to receive what they submit. ' +
      API_NOTE +
      ' Local images/videos/files go in assets (absolute file or folder paths) and are referenced ' +
      'in the HTML by relative URL: assets/<file name>. Opens unfocused unless focus:true.',
    inputSchema: {
      type: 'object',
      properties: {
        html: {
          type: 'string',
          description:
            'Page body as a fragment, or a full HTML document. Inline <script> and <style> are allowed.',
        },
        title: { type: 'string', description: 'Window title. Defaults to "Claude".' },
        assets: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Absolute paths of files or folders to serve (a folder contributes its files, max 200). Use as assets/<name> in the HTML. The result lists the names.',
        },
        width: { type: 'number', description: 'Window width in px. Default 900.' },
        height: { type: 'number', description: 'Window height in px. Default 700.' },
        left: { type: 'number' },
        top: { type: 'number' },
        focus: {
          type: 'boolean',
          description:
            'Bring the window to the front. Default false so it does not steal focus; set true when you are waiting on the person.',
        },
      },
      required: ['html'],
    },
  },
  {
    name: PANEL_TOOL_NAMES.WAIT,
    description:
      'Wait for what the person does in a panel. Returns as soon as there are new events (status ' +
      '"events"), the window was closed (status "closed", with any remaining events), or the ' +
      'timeout passed (status "timeout"; call again to keep waiting). Each event is returned once. ' +
      'Event types: "submit" (form or ClaudePanel.submit), "event" (ClaudePanel.event name+data), "closed".',
    inputSchema: {
      type: 'object',
      properties: {
        panelId: { type: 'string' },
        timeoutMs: {
          type: 'number',
          description: `Max wait in ms, capped at ${PANEL_LIMITS.maxWaitMs}. Default ${PANEL_LIMITS.defaultWaitMs}. 0 returns unread events immediately.`,
        },
      },
      required: ['panelId'],
    },
  },
  {
    name: PANEL_TOOL_NAMES.UPDATE,
    description:
      "Replace a panel's HTML and/or title and add assets. The open window reloads itself within a second. Unread events are kept.",
    inputSchema: {
      type: 'object',
      properties: {
        panelId: { type: 'string' },
        html: { type: 'string' },
        title: { type: 'string' },
        assets: {
          type: 'array',
          items: { type: 'string' },
          description: 'More absolute file or folder paths to serve; existing assets stay.',
        },
      },
      required: ['panelId'],
    },
  },
  {
    name: PANEL_TOOL_NAMES.CLOSE,
    description:
      'Close a panel and its window. Unread events can still be read with chrome_panel_wait afterwards.',
    inputSchema: {
      type: 'object',
      properties: { panelId: { type: 'string' } },
      required: ['panelId'],
    },
  },
];

export const isPanelTool = (name: string): boolean =>
  (Object.values(PANEL_TOOL_NAMES) as string[]).includes(name);

/** Calls a tool in the Chrome extension and returns the parsed JSON of its first text block. */
export type ExtensionCaller = (name: string, args: Record<string, unknown>) => Promise<any>;

const result = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  isError,
});

export interface PanelDeps {
  store: PanelStore;
  server: PanelServer;
  callExtension: ExtensionCaller;
}

export async function handlePanelTool(
  name: string,
  rawArgs: any,
  deps: PanelDeps,
): Promise<CallToolResult> {
  const args = rawArgs || {};
  const { store, server, callExtension } = deps;
  try {
    switch (name) {
      case PANEL_TOOL_NAMES.OPEN: {
        const title = typeof args.title === 'string' && args.title ? args.title : 'Claude';
        const panel = store.create({ title, html: args.html, assets: args.assets });
        try {
          const port = await server.start();
          const url = `http://127.0.0.1:${port}/p/${panel.id}/`;
          const win = await callExtension('chrome_create_window', {
            urls: [url],
            type: 'popup',
            width: typeof args.width === 'number' ? args.width : 900,
            height: typeof args.height === 'number' ? args.height : 700,
            ...(typeof args.left === 'number' ? { left: args.left } : {}),
            ...(typeof args.top === 'number' ? { top: args.top } : {}),
            focus: args.focus === true,
          });
          panel.windowId = win?.windowId;
          panel.tabId = win?.tabs?.[0]?.tabId ?? win?.tabs?.[0]?.id;
          return result({
            panelId: panel.id,
            url,
            windowId: panel.windowId,
            tabId: panel.tabId,
            assets: [...panel.assets.values()].map((a) => `assets/${a.name}`),
          });
        } catch (e) {
          store.close(panel, 'open failed');
          throw e;
        }
      }
      case PANEL_TOOL_NAMES.WAIT: {
        const panel = store.require(args.panelId);
        const ms = typeof args.timeoutMs === 'number' ? args.timeoutMs : PANEL_LIMITS.defaultWaitMs;
        const out = await store.wait(panel, ms);
        return result({ panelId: panel.id, ...out });
      }
      case PANEL_TOOL_NAMES.UPDATE: {
        const panel = store.require(args.panelId);
        const added = store.update(panel, {
          html: args.html,
          title: args.title,
          assets: args.assets,
        });
        return result({
          panelId: panel.id,
          version: panel.version,
          addedAssets: added.map((a) => `assets/${a.name}`),
        });
      }
      case PANEL_TOOL_NAMES.CLOSE: {
        const panel = store.require(args.panelId);
        store.close(panel, 'closed by Claude');
        let windowClosed = false;
        if (typeof panel.windowId === 'number') {
          try {
            await callExtension('chrome_close_window', { windowIds: [panel.windowId] });
            windowClosed = true;
          } catch {
            // The window may already be gone.
          }
        }
        return result({ panelId: panel.id, status: 'closed', windowClosed });
      }
      default:
        return result({ error: `Unknown panel tool ${name}` }, true);
    }
  } catch (e) {
    return result({ error: (e as Error).message }, true);
  }
}

// ---------------------------------------------------------------------------
// Process-wide instance wiring (used by the MCP server)
// ---------------------------------------------------------------------------

let shared: { store: PanelStore; server: PanelServer } | undefined;

export function sharedPanels(): { store: PanelStore; server: PanelServer } {
  if (!shared) {
    const store = new PanelStore();
    shared = { store, server: new PanelServer(store) };
  }
  return shared;
}
