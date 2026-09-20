import { describe, expect, test, beforeEach, afterEach, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AUTH_DIR_ENV } from '../security/local-auth';
import { authStatus, clearTokenCache, getAccessToken } from './auth';
import {
  buildAuthUrl,
  codeChallengeS256,
  generateCodeVerifier,
  generateState,
  GOOGLE_AUTH_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  loginStatus,
  logout,
  refreshAccessToken,
  resetLoginForTests,
  startLogin,
  waitForLogin,
} from './oauth';
import { handleGoogleTool } from './index';
import { scopesCovered, scopesFor } from './scopes';
import {
  loadOAuthRecord,
  loadPolicy,
  NO_KEYCHAIN_ENV,
  parseOAuthClient,
  parseOAuthRecord,
  saveOAuthRecord,
} from './store';

let dir: string;
let fetchMock: jest.Mock<any>;
const realFetch = global.fetch;
const agentDir = () => process.env[AUTH_DIR_ENV] as string;
const CLIENT = {
  client_id: 'client-1234.apps.googleusercontent.com',
  client_secret: 'GOCSPX-secret',
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

function writeFile(name: string, content: object | string) {
  fs.mkdirSync(agentDir(), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir(), name),
    typeof content === 'string' ? content : JSON.stringify(content),
  );
}
const oauthPolicy = (extra: object = {}) =>
  writeFile('google-policy.json', { authMode: 'oauth', ...extra });

/** Plain node:http GET (the global fetch is mocked in these tests). */
function get(
  port: number,
  pathAndQuery: string,
  host?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathAndQuery, method: 'GET', headers: host ? { host } : {} },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
const paramsOf = (authUrl: string) => new URL(authUrl).searchParams;
const tokenCalls = (): any[][] =>
  (fetchMock.mock.calls as any[][]).filter((c) => String(c[0]) === GOOGLE_TOKEN_URL);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-google-oauth-'));
  process.env[AUTH_DIR_ENV] = path.join(dir, 'agent');
  process.env[NO_KEYCHAIN_ENV] = '1';
  clearTokenCache();
  resetLoginForTests();
  fetchMock = jest.fn(async (url: any, init: any) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    if (String(url) === GOOGLE_TOKEN_URL && body.get('grant_type') === 'authorization_code')
      return json({
        access_token: 'AT-login',
        refresh_token: 'RT-secret-value',
        expires_in: 3600,
        scope: scopesFor('sheets', false).join(' '),
      });
    if (String(url) === GOOGLE_TOKEN_URL && body.get('grant_type') === 'refresh_token')
      return json({ access_token: 'AT-refreshed', expires_in: 3600 });
    if (String(url) === GOOGLE_REVOKE_URL) return json({});
    return json({ error: 'unexpected' }, 500);
  });
  (global as any).fetch = fetchMock;
});
afterEach(() => {
  resetLoginForTests();
  (global as any).fetch = realFetch;
  delete process.env[AUTH_DIR_ENV];
  delete process.env[NO_KEYCHAIN_ENV];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('PKCE primitives', () => {
  test('RFC 7636 appendix B vector', () => {
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
  test('verifier and state are unique, url-safe and long enough', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(generateCodeVerifier()).not.toBe(v);
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeChallengeS256(v)).toBe(createHash('sha256').update(v).digest('base64url'));
  });
  test('auth url carries S256, state, offline access and exact scopes', () => {
    const u = paramsOf(
      buildAuthUrl({
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:1234/callback',
        scopes: ['s1', 's2'],
        state: 'st',
        challenge: 'ch',
      }),
    );
    expect(Object.fromEntries(u)).toMatchObject({
      client_id: 'cid',
      redirect_uri: 'http://127.0.0.1:1234/callback',
      response_type: 'code',
      scope: 's1 s2',
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      access_type: 'offline',
    });
    expect(u.has('include_granted_scopes')).toBe(false);
  });
});

describe('scopes', () => {
  test('rw versus ro, and coverage', () => {
    expect(scopesFor('sheets', false)).toEqual(['https://www.googleapis.com/auth/spreadsheets']);
    expect(scopesFor('sheets', true)).toEqual([
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ]);
    expect(() => scopesFor('nope', false)).toThrow();
    const rw = scopesFor('sheets', false);
    expect(scopesCovered(rw, scopesFor('sheets', true))).toBe(true); // rw covers ro
    expect(scopesCovered(scopesFor('sheets', true), rw)).toBe(false);
  });
});

describe('store: client, record, policy', () => {
  test('parseOAuthClient accepts installed wrapper and rejects junk', () => {
    expect(parseOAuthClient(JSON.stringify({ installed: CLIENT })).client_id).toBe(
      CLIENT.client_id,
    );
    expect(() => parseOAuthClient('x')).toThrow(/valid JSON/);
    expect(() => parseOAuthClient('{}')).toThrow(/client_id/);
    expect(() =>
      parseOAuthClient(JSON.stringify({ client_id: 'abcdefgh1', client_secret: 5 })),
    ).toThrow(/client_secret/);
  });
  test('parseOAuthRecord validates', () => {
    expect(() => parseOAuthRecord('{}')).toThrow();
    expect(() => parseOAuthRecord('nope')).toThrow(/JSON/);
  });
  test('record round-trips through a 0600 file fallback', async () => {
    const src = await saveOAuthRecord({
      refresh_token: 'RT',
      scopes: ['a'],
      client_id: CLIENT.client_id,
      obtained_at: '2026-01-01T00:00:00Z',
    });
    expect(src).toBe('file');
    const f = path.join(agentDir(), 'google-oauth.json');
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect((await loadOAuthRecord())?.record.refresh_token).toBe('RT');
  });
  test('policy authMode and allowFormulas defaults and validation', () => {
    expect(loadPolicy()).toMatchObject({ authMode: 'service-account', allowFormulas: false });
    writeFile('google-policy.json', { authMode: 'oauth', allowFormulas: true });
    expect(loadPolicy()).toMatchObject({ authMode: 'oauth', allowFormulas: true });
    writeFile('google-policy.json', { authMode: 'both' });
    expect(loadPolicy()).toMatchObject({
      readOnly: true,
      invalid: expect.stringMatching(/authMode/),
    });
    writeFile('google-policy.json', { allowFormulas: 'yes' });
    expect(loadPolicy().invalid).toMatch(/allowFormulas/);
  });
});

describe('startLogin gating', () => {
  test('refuses unless policy.authMode is oauth', async () => {
    writeFile('google-oauth-client.json', CLIENT);
    await expect(startLogin({ services: ['sheets'] })).rejects.toThrow(/authMode/);
  });
  test('refuses an invalid policy, bad services, disallowed services and a missing client', async () => {
    writeFile('google-policy.json', '{bad');
    await expect(startLogin({ services: ['sheets'] })).rejects.toThrow(/rejected/);
    oauthPolicy();
    await expect(startLogin({ services: [] })).rejects.toThrow(/services/);
    await expect(startLogin({ services: ['sheets'] })).rejects.toThrow(/no OAuth client/);
    writeFile('google-oauth-client.json', CLIENT);
    await expect(startLogin({ services: ['bogus'] })).rejects.toThrow();
    oauthPolicy({ allowedServices: ['docs'] });
    await expect(startLogin({ services: ['sheets'] })).rejects.toThrow(/allowedServices/);
  });
  test('readOnly policy narrows the requested scopes', async () => {
    writeFile('google-oauth-client.json', CLIENT);
    oauthPolicy({ readOnly: true });
    const s = await startLogin({ services: ['sheets', 'docs'] });
    expect(s.scopes).toEqual([...scopesFor('sheets', true), ...scopesFor('docs', true)]);
    expect(paramsOf(s.authUrl).get('scope')).not.toMatch(/spreadsheets(?!\.readonly)(\s|$)/);
  });
});

describe('loopback login', () => {
  async function begin() {
    writeFile('google-oauth-client.json', CLIENT);
    oauthPolicy();
    const s = await startLogin({ services: ['sheets'] });
    return { s, state: paramsOf(s.authUrl).get('state')!, q: paramsOf(s.authUrl) };
  }
  test('auth url targets Google with a loopback redirect on the listener port', async () => {
    const { s, q } = await begin();
    expect(s.authUrl.startsWith(GOOGLE_AUTH_URL + '?')).toBe(true);
    expect(q.get('redirect_uri')).toBe(`http://127.0.0.1:${s.port}/callback`);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(loginStatus()).toMatchObject({ state: 'waiting', port: s.port });
  });
  test('full flow: exchange sends the verifier matching the challenge, refresh token is stored', async () => {
    const { s, state, q } = await begin();
    const r = await get(s.port, `/callback?state=${state}&code=CODE-abc`);
    expect(r.status).toBe(200);
    const status = await waitForLogin(2000);
    expect(status).toMatchObject({ state: 'complete', storedIn: 'file' });
    const ex = new URLSearchParams(String(tokenCalls()[0][1].body));
    expect(ex.get('code')).toBe('CODE-abc');
    expect(ex.get('redirect_uri')).toBe(`http://127.0.0.1:${s.port}/callback`);
    expect(ex.get('client_id')).toBe(CLIENT.client_id);
    expect(codeChallengeS256(ex.get('code_verifier')!)).toBe(q.get('code_challenge'));
    expect((await loadOAuthRecord())?.record).toMatchObject({
      refresh_token: 'RT-secret-value',
      client_id: CLIENT.client_id,
    });
    expect(fs.statSync(path.join(agentDir(), 'google-oauth.json')).mode & 0o777).toBe(0o600);
  });
  test('wrong state gets 400 and does not end or consume the login; the real callback still works', async () => {
    const { s, state } = await begin();
    expect((await get(s.port, '/callback?state=wrong&code=X')).status).toBe(400);
    expect((await get(s.port, '/callback?code=X')).status).toBe(400);
    expect(loginStatus().state).toBe('waiting');
    expect(tokenCalls()).toHaveLength(0);
    expect((await get(s.port, `/callback?state=${state}&code=REAL`)).status).toBe(200);
    expect((await waitForLogin(2000)).state).toBe('complete');
  });
  test('a callback with the wrong Host header is rejected (DNS rebinding)', async () => {
    const { s, state } = await begin();
    const r = await get(s.port, `/callback?state=${state}&code=X`, `evil.example:${s.port}`);
    expect(r.status).toBe(400);
    expect(loginStatus().state).toBe('waiting');
    expect(tokenCalls()).toHaveLength(0);
  });
  test('other paths are 404 and the code is single use', async () => {
    const { s, state } = await begin();
    expect((await get(s.port, `/x?state=${state}`)).status).toBe(404);
    await get(s.port, `/callback?state=${state}&code=ONE`);
    await waitForLogin(2000);
    await expect(get(s.port, `/callback?state=${state}&code=TWO`)).rejects.toBeDefined(); // server closed
    expect(tokenCalls()).toHaveLength(1);
  });
  test('user denial fails the login without a token call and without echoing arbitrary text', async () => {
    const { s, state } = await begin();
    await get(s.port, `/callback?state=${state}&error=access_denied`);
    const st = await waitForLogin(2000);
    expect(st).toMatchObject({ state: 'failed', error: 'authorization refused (access_denied)' });
    expect(tokenCalls()).toHaveLength(0);
    expect(await loadOAuthRecord()).toBeNull();
  });
  test('token exchange failure surfaces only Google error fields', async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: 'invalid_grant', error_description: 'Bad code <script>', secret: 'LEAK' }, 400),
    );
    const { s, state } = await begin();
    await get(s.port, `/callback?state=${state}&code=BAD`);
    const st = await waitForLogin(2000);
    expect(st.state).toBe('failed');
    expect(st.error).toContain('invalid_grant');
    expect(st.error).not.toContain('LEAK');
    expect(st.error).not.toContain('<');
  });
  test('no refresh token in the response fails the login', async () => {
    fetchMock.mockImplementation(async () => json({ access_token: 'AT', expires_in: 3600 }));
    const { s, state } = await begin();
    await get(s.port, `/callback?state=${state}&code=C`);
    expect(await waitForLogin(2000)).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/refresh token/),
    });
  });
  test('starting a second login cancels the first and closes its listener', async () => {
    const a = await begin();
    const b = await startLogin({ services: ['docs'] });
    expect(b.port).not.toBe(a.s.port);
    await expect(get(a.s.port, '/callback')).rejects.toBeDefined();
  });
  test('status and tool output never contain the verifier, state, code or tokens', async () => {
    const { s, state } = await begin();
    const verifierProbe = () => JSON.stringify({ l: loginStatus() });
    expect(verifierProbe()).not.toContain(state);
    await get(s.port, `/callback?state=${state}&code=CODE-abc`);
    await waitForLogin(2000);
    const all = verifierProbe() + JSON.stringify(await authStatus());
    for (const secret of ['RT-secret-value', 'AT-login', 'CODE-abc', state, CLIENT.client_secret])
      expect(all).not.toContain(secret);
  });
});

describe('tokens and status', () => {
  const seed = () =>
    saveOAuthRecord({
      refresh_token: 'RT-1',
      scopes: scopesFor('sheets', false),
      client_id: CLIENT.client_id,
      obtained_at: '2026-01-01T00:00:00Z',
    });
  test('oauth mode refreshes with a downscoped request and caches in memory only', async () => {
    writeFile('google-oauth-client.json', CLIENT);
    oauthPolicy();
    await seed();
    const ro = scopesFor('sheets', true);
    expect(await getAccessToken(ro)).toBe('AT-refreshed');
    expect(await getAccessToken(ro)).toBe('AT-refreshed');
    expect(tokenCalls()).toHaveLength(1);
    const body = new URLSearchParams(String(tokenCalls()[0][1].body));
    expect(body.get('scope')).toBe(ro.join(' '));
    expect(body.get('refresh_token')).toBe('RT-1');
    expect(body.get('client_secret')).toBe(CLIENT.client_secret);
    // nothing but the record and client config on disk
    expect(fs.readdirSync(agentDir()).sort()).toEqual(
      ['google-oauth-client.json', 'google-oauth.json', 'google-policy.json'].sort(),
    );
  });
  test('service-account mode never falls back to the OAuth login, and vice versa', async () => {
    writeFile('google-oauth-client.json', CLIENT);
    await seed();
    await expect(getAccessToken(scopesFor('sheets', false))).rejects.toThrow(/service-account/);
    expect(tokenCalls()).toHaveLength(0);
    oauthPolicy();
    await expect(getAccessToken(scopesFor('docs', false))).rejects.toThrow(/does not grant/);
  });
  test('refresh failures explain invalid_grant without leaking the token', async () => {
    writeFile('google-oauth-client.json', CLIENT);
    oauthPolicy();
    await seed();
    fetchMock.mockImplementation(async () => json({ error: 'invalid_grant' }, 400));
    const e: any = await refreshAccessToken(scopesFor('sheets', false)).catch((x) => x);
    expect(e.message).toMatch(/invalid_grant.*login again/);
    expect(e.message).not.toContain('RT-1');
  });
  test('a login from a different client is refused', async () => {
    writeFile('google-oauth-client.json', {
      client_id: 'other-client-0000.apps.googleusercontent.com',
    });
    oauthPolicy();
    await seed();
    await expect(refreshAccessToken(scopesFor('sheets', false))).rejects.toThrow(
      /different OAuth client/,
    );
  });
  test('an invalid policy blocks token issuance', async () => {
    writeFile('google-policy.json', '{bad');
    await expect(getAccessToken(scopesFor('sheets', false))).rejects.toThrow();
  });
  test('google_auth_status is explicit about the token source', async () => {
    let s: any = await authStatus();
    expect(s).toMatchObject({ authMode: 'service-account', activeCredentialReady: false });
    writeFile('google-oauth-client.json', CLIENT);
    oauthPolicy();
    await seed();
    s = await authStatus();
    expect(s).toMatchObject({
      authMode: 'oauth',
      activeCredentialReady: true,
      oauth: { clientConfigured: true, loggedIn: true, source: 'file' },
    });
    expect(s.oauth.grantedScopes).toEqual(scopesFor('sheets', false));
    expect(JSON.stringify(s)).not.toContain('RT-1');
  });
});

describe('logout', () => {
  test('revokes at Google and deletes the record', async () => {
    await saveOAuthRecord({
      refresh_token: 'RT-x',
      scopes: [],
      client_id: CLIENT.client_id,
      obtained_at: 't',
    });
    const r = await logout();
    expect(r).toMatchObject({ hadCredential: true, revoked: true, deleted: true });
    const revoke = (fetchMock.mock.calls as any[][]).find(
      (c) => String(c[0]) === GOOGLE_REVOKE_URL,
    )!;
    expect(new URLSearchParams(String(revoke[1].body)).get('token')).toBe('RT-x');
    expect(await loadOAuthRecord()).toBeNull();
  });
  test('deletes locally even when the revoke call fails, and never leaks the token', async () => {
    await saveOAuthRecord({
      refresh_token: 'RT-x',
      scopes: [],
      client_id: CLIENT.client_id,
      obtained_at: 't',
    });
    fetchMock.mockImplementation(async () => {
      throw new Error('network down RT-x');
    });
    const r = await logout();
    expect(r).toMatchObject({ revoked: false, deleted: true });
    expect(JSON.stringify(r)).not.toContain('RT-x');
    expect(await loadOAuthRecord()).toBeNull();
  });
  test('is a harmless no-op when nothing is stored', async () => {
    expect(await logout()).toMatchObject({ hadCredential: false, deleted: true });
  });
  test('google_auth_login / google_auth_logout tools', async () => {
    const denied: any = await handleGoogleTool('google_auth_login', { services: ['sheets'] });
    expect(denied.isError).toBe(true);
    writeFile('google-oauth-client.json', CLIENT);
    oauthPolicy();
    const ok: any = await handleGoogleTool('google_auth_login', { services: ['sheets'] });
    const body = JSON.parse(ok.content[0].text);
    expect(body.authUrl).toContain(GOOGLE_AUTH_URL);
    expect(JSON.stringify(body)).not.toMatch(/verifier/i);
    const out: any = await handleGoogleTool('google_auth_logout', {});
    expect(JSON.parse(out.content[0].text)).toMatchObject({ hadCredential: false });
  });
});
