import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {
  AUTH_DIR_ENV,
  authHeaders,
  getAuthTokenPath,
  getOrCreateAuthToken,
  isAllowedHost,
  isAllowedOrigin,
  isTokenProtectedPath,
  registerLocalAuth,
  verifyBearer,
} from './local-auth';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-'));
  process.env[AUTH_DIR_ENV] = path.join(dir, 'agent');
});
afterEach(() => {
  delete process.env[AUTH_DIR_ENV];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('isAllowedHost', () => {
  test.each(['127.0.0.1:12306', 'localhost:12306', '[::1]:12306', 'LOCALHOST', '127.0.0.1'])(
    'allows %s',
    (h) => expect(isAllowedHost(h)).toBe(true),
  );
  test.each([
    undefined,
    '',
    'evil.com',
    '127.0.0.1.evil.com:12306',
    'localhost.evil.com',
    '10.0.0.1:12306',
  ])('rejects %s', (h) => expect(isAllowedHost(h as string | undefined)).toBe(false));
});

describe('isAllowedHost strictness', () => {
  test.each([
    '127.0.0.1:80@evil.com',
    '127.0.0.1.evil.com',
    'localhost:abc',
    'localhost:',
    '[::1]x',
    'evil.com:127.0.0.1',
  ])('rejects %s', (h) => expect(isAllowedHost(h)).toBe(false));
});

describe('isAllowedOrigin', () => {
  test.each([
    undefined,
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    'http://127.0.0.1:12306',
    'http://localhost',
  ])('allows %s', (o) => expect(isAllowedOrigin(o)).toBe(true));
  test.each([
    'http://127.0.0.1.evil.com', // the old startsWith bug
    'http://127.0.0.1@evil.com',
    'https://127.0.0.1',
    'http://evil.com',
    'chrome-extension://abc.evil.com',
    'null',
  ])('rejects %s', (o) => expect(isAllowedOrigin(o)).toBe(false));
});

describe('isTokenProtectedPath', () => {
  test('protects everything except the exempt list', () => {
    expect(isTokenProtectedPath('/mcp')).toBe(true);
    expect(isTokenProtectedPath('/mcp?x=1')).toBe(true);
    expect(isTokenProtectedPath('/sse')).toBe(true);
    expect(isTokenProtectedPath('/messages/abc')).toBe(true);
    expect(isTokenProtectedPath('/mcpx')).toBe(true);
    expect(isTokenProtectedPath('/anything-new')).toBe(true);
    expect(isTokenProtectedPath('/ping')).toBe(false);
    expect(isTokenProtectedPath('/ping?a=1')).toBe(false);
    expect(isTokenProtectedPath('/ask-extension')).toBe(false);
    expect(isTokenProtectedPath('/agent/chat')).toBe(false);
  });

  test.each([
    '/%6dcp',
    '/m%63p',
    '/%73se',
    '/%6Dessages/x',
    '/%256dcp',
    '//mcp',
    '/./mcp',
    '/agent/../mcp',
    '/agent/%2e%2e/mcp',
    '/mcp/',
    '/MCP'.toLowerCase() + ';x',
    'http://127.0.0.1:12306/mcp',
    'http://127.0.0.1:12306/%6dcp?x=1',
    '/mcp#frag',
    '/%',
    '/%E0%A4%A',
    '/agent%2f..%2fmcp',
  ])('stays protected for encoded or odd spelling %s', (u) =>
    expect(isTokenProtectedPath(u)).toBe(true),
  );
});

describe('verifyBearer', () => {
  test('accepts exact token only', () => {
    expect(verifyBearer('Bearer abc', 'abc')).toBe(true);
    expect(verifyBearer('bearer abc', 'abc')).toBe(true);
    expect(verifyBearer('Bearer abd', 'abc')).toBe(false);
    expect(verifyBearer('Bearer abcd', 'abc')).toBe(false);
    expect(verifyBearer('abc', 'abc')).toBe(false);
    expect(verifyBearer(undefined, 'abc')).toBe(false);
    expect(verifyBearer('Bearer ', '')).toBe(false);
  });
});

describe('token file', () => {
  test('is created 0600 in a 0700 dir and is stable across calls', () => {
    const t1 = getOrCreateAuthToken();
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(getAuthTokenPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(getAuthTokenPath())).mode & 0o777).toBe(0o700);
    expect(getOrCreateAuthToken()).toBe(t1);
    expect(authHeaders()).toEqual({ Authorization: `Bearer ${t1}` });
  });
  test('authHeaders is empty before a token exists', () => {
    expect(authHeaders()).toEqual({});
  });
  test('fails closed (null) when the dir cannot be created', () => {
    process.env[AUTH_DIR_ENV] = '/dev/null/nope';
    expect(getOrCreateAuthToken()).toBeNull();
  });
});

describe('registerLocalAuth hook', () => {
  async function app() {
    const f = Fastify();
    registerLocalAuth(f);
    f.get('/ping', async () => ({ ok: true }));
    f.post('/mcp', async () => ({ ok: true }));
    f.get('/agent/x', async () => ({ ok: true }));
    await f.ready();
    return f;
  }
  const host = { host: '127.0.0.1:12306' };

  test('rejects bad Host with 403 (DNS rebinding)', async () => {
    const f = await app();
    const r = await f.inject({ method: 'GET', url: '/ping', headers: { host: 'evil.com' } });
    expect(r.statusCode).toBe(403);
  });
  test('rejects lookalike Origin with 403', async () => {
    const f = await app();
    const r = await f.inject({
      method: 'GET',
      url: '/ping',
      headers: { ...host, origin: 'http://127.0.0.1.evil.com' },
    });
    expect(r.statusCode).toBe(403);
  });
  test('/ping and /agent need no token but do get Host/Origin checks', async () => {
    const f = await app();
    expect((await f.inject({ method: 'GET', url: '/ping', headers: host })).statusCode).toBe(200);
    expect(
      (
        await f.inject({
          method: 'GET',
          url: '/agent/x',
          headers: { ...host, origin: 'chrome-extension://abcdef' },
        })
      ).statusCode,
    ).toBe(200);
  });
  test('/mcp requires the bearer token', async () => {
    const f = await app();
    const token = getOrCreateAuthToken() as string;
    expect((await f.inject({ method: 'POST', url: '/mcp', headers: host })).statusCode).toBe(401);
    expect(
      (
        await f.inject({
          method: 'POST',
          url: '/mcp',
          headers: { ...host, authorization: 'Bearer wrong' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.inject({
          method: 'POST',
          url: '/mcp',
          headers: { ...host, authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
  });
  test.each(['/%6dcp', '/m%63p', '/%6dcp?x=1', '//mcp', '/./mcp'])(
    'cannot reach /mcp without the token via %s (router-normalized spelling)',
    async (url) => {
      const f = await app();
      const r = await f.inject({ method: 'POST', url, headers: host });
      expect(r.statusCode).toBe(401);
    },
  );
  test('token is re-read per request, so rotation needs no restart', async () => {
    const f = await app();
    const file = getAuthTokenPath();
    const rotated = 'r'.repeat(40);
    fs.writeFileSync(file, `${rotated}\n`, { mode: 0o600 });
    const ok = await f.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...host, authorization: `Bearer ${rotated}` },
    });
    expect(ok.statusCode).toBe(200);
  });
  test('/mcp fails closed when no token could be stored', async () => {
    process.env[AUTH_DIR_ENV] = '/dev/null/nope';
    const f = await app();
    const r = await f.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...host, authorization: 'Bearer anything' },
    });
    expect(r.statusCode).toBe(401);
  });
});
