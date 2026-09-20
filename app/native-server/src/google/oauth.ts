/**
 * OAuth 2.0 for a user's own Google account: authorization-code flow with PKCE (RFC 7636, S256)
 * over a loopback redirect (RFC 8252 section 7.3). Zero dependencies: node:http, node:crypto and
 * global fetch.
 *
 * Security shape:
 *  - Endpoints are compile-time constants; nothing in the policy or a tool argument can point the
 *    flow (or a token) at another host.
 *  - The listener binds 127.0.0.1 on a random port, lives at most LOGIN_TTL_MS, accepts one valid
 *    callback, checks `Host` (DNS rebinding) and compares `state` in constant time. A request with a
 *    wrong state gets a 400 and does NOT end the login, so a stray page cannot cancel it.
 *  - The PKCE verifier never leaves this module. The authUrl (which carries `state` and the
 *    `code_challenge`) IS returned by startLogin and shown to the user: it has to be, since it is
 *    what gets opened in a browser. `state` is therefore not a secret from whoever holds the URL:
 *    that party can end a login early with GET /callback?state=S&error=x (a denial of service, not
 *    a token theft: without the browser-held code and the verifier nothing can be exchanged).
 *    Codes, verifiers and tokens are never logged and never appear in error text: token-endpoint
 *    failures surface only Google's `error` / `error_description` fields.
 *  - The refresh token goes to the Keychain (0600 file fallback); access tokens are cached in
 *    memory by auth.ts and never written anywhere.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { clearTokenCache } from './auth';
import { SCOPE_PREFIX, SERVICE_SCOPES, scopesCovered, scopesFor } from './scopes';
import {
  deleteOAuthRecord,
  loadOAuthClient,
  loadOAuthRecord,
  loadPolicy,
  saveOAuthRecord,
  type KeySource,
  type OAuthClient,
} from './store';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const LOGIN_TTL_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 30_000;

// ---- PKCE / state primitives ------------------------------------------------------------------

export const base64url = (b: Buffer): string =>
  b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** RFC 7636 section 4.1: 43-128 unreserved chars. 32 random bytes -> 43 chars. */
export const generateCodeVerifier = (): string => base64url(randomBytes(32));
/** RFC 7636 section 4.2: BASE64URL(SHA256(ASCII(verifier))). */
export const codeChallengeS256 = (verifier: string): string =>
  base64url(createHash('sha256').update(verifier, 'ascii').digest());
export const generateState = (): string => base64url(randomBytes(32));

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function buildAuthUrl(p: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
}): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', p.scopes.join(' '));
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('access_type', 'offline'); // ask for a refresh token
  u.searchParams.set('prompt', 'consent'); // Google only re-issues one on explicit consent
  // include_granted_scopes is left off on purpose: the grant is exactly what was asked for.
  return u.toString();
}

// ---- token endpoint ---------------------------------------------------------------------------

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** Google's error body is {error, error_description}; nothing else is ever echoed. */
async function describeFailure(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: unknown; error_description?: unknown };
    const parts = [j.error, j.error_description]
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.replace(/[^\w .:,'()-]/g, '').slice(0, 120));
    if (parts.length) return `${res.status} ${parts.join(': ')}`;
  } catch {
    /* not JSON */
  }
  return String(res.status);
}

async function postForm(url: string, fields: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

function requireClient(): OAuthClient {
  const c = loadOAuthClient();
  if (!c)
    throw new Error(
      'no OAuth client configured: create ~/.chrome-mcp-agent/google-oauth-client.json with {"client_id": "...", "client_secret": "..."} (see docs/google-workspace.md)',
    );
  return c;
}

/** Exchanges the stored refresh token for a short-lived access token limited to `scopes`. */
export async function refreshAccessToken(
  scopes: string[],
): Promise<{ token: string; expiresIn: number; identity: string }> {
  const client = requireClient();
  const stored = await loadOAuthRecord();
  if (!stored) throw new Error('not logged in: run google_auth_login (authMode is "oauth")');
  const { record } = stored;
  if (record.client_id !== client.client_id)
    throw new Error(
      'stored login belongs to a different OAuth client; run google_auth_logout then google_auth_login',
    );
  if (!scopesCovered(record.scopes, scopes))
    throw new Error(
      `the login does not grant ${scopes.join(' ')} (granted: ${record.scopes.join(' ') || 'none'}); run google_auth_login with the needed services`,
    );
  const res = await postForm(GOOGLE_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: record.refresh_token,
    client_id: client.client_id,
    ...(client.client_secret ? { client_secret: client.client_secret } : {}),
    scope: scopes.join(' '), // downscope: a read-only policy gets a read-only token
  });
  if (!res.ok) {
    const why = await describeFailure(res);
    throw new Error(
      `OAuth refresh failed (${why})${/invalid_grant/.test(why) ? '; the login was revoked or expired, run google_auth_login again' : ''}`,
    );
  }
  const data = (await res.json()) as TokenResponse;
  if (!data.access_token) throw new Error('OAuth refresh returned no access_token');
  return {
    token: data.access_token,
    expiresIn: data.expires_in ?? 3600,
    identity: `${client.client_id}|${record.obtained_at}`,
  };
}

// ---- login (loopback listener) ----------------------------------------------------------------

export type LoginState = 'idle' | 'waiting' | 'complete' | 'failed' | 'expired' | 'cancelled';

interface Login {
  /** Value of the module epoch when this login was created; a bump means it was superseded. */
  epoch: number;
  services: string[];
  /** The in-flight code exchange + save, so logout / a replacing login can wait for it. */
  exchange?: Promise<void>;
  state: string;
  verifier: string;
  scopes: string[];
  client: OAuthClient;
  redirectUri: string;
  port: number;
  expiresAt: number;
  server: http.Server;
  timer: NodeJS.Timeout;
  status: LoginState;
  error?: string;
  storedIn?: KeySource;
  grantedScopes?: string[];
  consumed: boolean;
  settled: Promise<void>;
  settle: () => void;
}

let current: Login | null = null;
/**
 * Bumped by startLogin and logout. A login captures it at creation; if it has moved by the time an
 * await returns, that login was superseded or logged out and must not persist anything.
 */
let epoch = 0;

const PAGE = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>chrome-mcp Google login</title><body style="font:16px system-ui;margin:3em"><p>${msg}</p></body>`;

function respond(res: http.ServerResponse, code: number, msg: string): void {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    connection: 'close',
  });
  res.end(PAGE(msg)); // static text only: nothing from the request is reflected
}

function finish(l: Login, status: LoginState, error?: string): void {
  if (l.status !== 'waiting') return;
  l.status = status;
  l.error = error;
  clearTimeout(l.timer);
  l.server.close(); // stop listening now
  // Let an in-flight response (the success/failure page) drain before dropping stragglers.
  const t = setTimeout(() => (l.server as any).closeAllConnections?.(), 2000);
  t.unref?.();
  l.settle();
}

/** Best-effort: a token that was issued but must not be kept is revoked at Google. */
async function revokeQuietly(token: string | undefined): Promise<void> {
  if (!token) return;
  try {
    await postForm(GOOGLE_REVOKE_URL, { token });
  } catch {
    /* nothing more can be done; the token is never stored */
  }
}

/** Why a freshly obtained grant may not be stored under the CURRENT policy, or null. */
function storeForbidden(l: Login, granted: string[]): string | null {
  const policy = loadPolicy();
  if (policy.invalid) return `google-policy.json rejected: ${policy.invalid}`;
  if (policy.authMode !== 'oauth') return 'policy.authMode is no longer "oauth"';
  if (policy.allowedServices.length) {
    const bad = l.services.find((s) => !policy.allowedServices.includes(s));
    if (bad) return `service "${bad}" is no longer in policy.allowedServices`;
  }
  if (
    policy.readOnly &&
    Object.values(SERVICE_SCOPES).some((s) => granted.includes(SCOPE_PREFIX + s.rw))
  )
    return 'policy.readOnly is now set but the grant includes write scopes';
  return null;
}

const isLive = (l: Login): boolean => l.status === 'waiting' && l.epoch === epoch;

async function completeLogin(l: Login, code: string): Promise<void> {
  // Every await below is followed by an isLive check: a login that was cancelled, replaced, logged
  // out or expired while the exchange was in flight must never reach saveOAuthRecord.
  let issued: string | undefined;
  try {
    const res = await postForm(GOOGLE_TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      code_verifier: l.verifier,
      redirect_uri: l.redirectUri,
      client_id: l.client.client_id,
      ...(l.client.client_secret ? { client_secret: l.client.client_secret } : {}),
    });
    if (!res.ok) {
      const why = await describeFailure(res);
      return finish(l, 'failed', `token exchange failed (${why})`);
    }
    const data = (await res.json()) as TokenResponse;
    issued = data.refresh_token ?? data.access_token;
    if (!isLive(l)) return void (await revokeQuietly(issued));
    if (!data.refresh_token)
      return finish(
        l,
        'failed',
        'Google returned no refresh token; remove this app at myaccount.google.com/permissions and log in again',
      );
    const granted = (data.scope ?? '').split(/\s+/).filter(Boolean);
    const grantedScopes = granted.length ? granted : l.scopes;
    const forbidden = storeForbidden(l, grantedScopes);
    if (forbidden) {
      await revokeQuietly(issued);
      return finish(l, 'failed', `login not stored: ${forbidden}`);
    }
    const stored = await saveOAuthRecord({
      refresh_token: data.refresh_token,
      scopes: grantedScopes,
      client_id: l.client.client_id,
      obtained_at: new Date().toISOString(),
    });
    if (!isLive(l)) {
      // Cancelled while the record was being written: take back exactly what we wrote.
      const now = await loadOAuthRecord();
      if (now?.record.refresh_token === data.refresh_token) await deleteOAuthRecord();
      await revokeQuietly(issued);
      return;
    }
    l.grantedScopes = grantedScopes;
    l.storedIn = stored;
    finish(l, 'complete');
  } catch (e) {
    finish(l, 'failed', `login failed (${(e as Error)?.name ?? 'error'})`);
  }
}

function handleCallback(l: Login, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.headers.host !== `127.0.0.1:${l.port}`) return respond(res, 400, 'Bad host.');
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://127.0.0.1:${l.port}`);
  } catch {
    return respond(res, 400, 'Bad request.');
  }
  if (req.method !== 'GET' || url.pathname !== '/callback') return respond(res, 404, 'Not found.');
  const state = url.searchParams.get('state');
  // Wrong or missing state: refuse and keep waiting for the real redirect.
  if (!state || !safeEqual(state, l.state)) return respond(res, 400, 'State mismatch.');
  if (l.consumed) return respond(res, 400, 'This login was already used.');
  l.consumed = true;
  const err = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  if (err || !code) {
    respond(res, 400, 'Login was not completed. You can close this tab.');
    return finish(
      l,
      'failed',
      `authorization refused (${/^[a-z_]{1,40}$/.test(err ?? '') ? err : 'error'})`,
    );
  }
  l.exchange = completeLogin(l, code).then(() =>
    respond(
      res,
      l.status === 'complete' ? 200 : 400,
      l.status === 'complete'
        ? 'Signed in. You can close this tab.'
        : l.status === 'cancelled' || l.status === 'expired'
          ? 'This login was cancelled or expired and nothing was saved. You can close this tab.'
          : 'Login failed. Return to the terminal or agent for details.',
    ),
  );
}

export interface LoginStart {
  authUrl: string;
  port: number;
  expiresAt: string;
  scopes: string[];
}

function openInBrowser(url: string): void {
  if (!url.startsWith(`${GOOGLE_AUTH_URL}?`)) return;
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : '';
  if (!cmd) return;
  try {
    const c = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    c.on('error', () => undefined);
    c.unref();
  } catch {
    /* the URL is also returned to the caller */
  }
}

/**
 * Starts a login. Refuses unless policy.authMode is "oauth" (operator opt-in), the policy is
 * valid, and every requested service is permitted. Scopes come from the service list, narrowed to
 * `.readonly` under policy.readOnly. Replaces any login still pending.
 */
export async function startLogin(args: {
  services?: unknown;
  openBrowser?: boolean;
}): Promise<LoginStart> {
  const policy = loadPolicy();
  if (policy.invalid) throw new Error(`google-policy.json rejected: ${policy.invalid}`);
  if (policy.authMode !== 'oauth')
    throw new Error(
      'policy.authMode is not "oauth"; set it in google-policy.json to opt in to logging in with a Google account',
    );
  const services = args.services;
  if (
    !Array.isArray(services) ||
    services.length === 0 ||
    !services.every((s) => typeof s === 'string')
  )
    throw new Error(
      '"services" must be a non-empty array of service names, e.g. ["sheets","docs"]',
    );
  const names = Array.from(new Set(services as string[]));
  for (const s of names) {
    if (policy.allowedServices.length && !policy.allowedServices.includes(s))
      throw new Error(`service "${s}" is not in policy.allowedServices`);
  }
  const scopes = Array.from(new Set(names.flatMap((s) => scopesFor(s, policy.readOnly))));
  const client = requireClient();

  epoch++; // supersedes any login (including one already exchanging its code)
  if (current) {
    const old = current;
    finish(old, 'cancelled');
    await old.exchange; // let an in-flight save settle (and undo itself) before starting anew
  }

  const state = generateState();
  const verifier = generateCodeVerifier();
  let settle!: () => void;
  const settled = new Promise<void>((r) => (settle = r));
  const server = http.createServer();
  const login = {
    epoch: ++epoch,
    services: names,
    state,
    verifier,
    scopes,
    client,
    server,
    status: 'waiting',
    consumed: false,
    settled,
    settle,
  } as unknown as Login;
  server.on('request', (req, res) => handleCallback(login, req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  login.port = (server.address() as AddressInfo).port;
  login.redirectUri = `http://127.0.0.1:${login.port}/callback`;
  login.expiresAt = Date.now() + LOGIN_TTL_MS;
  login.timer = setTimeout(() => finish(login, 'expired', 'login timed out'), LOGIN_TTL_MS);
  login.timer.unref?.();
  if (login.epoch !== epoch) {
    // A logout or another startLogin ran while this listener was coming up.
    finish(login, 'cancelled');
    throw new Error('login was cancelled while starting');
  }
  current = login;

  const authUrl = buildAuthUrl({
    clientId: client.client_id,
    redirectUri: login.redirectUri,
    scopes,
    state,
    challenge: codeChallengeS256(verifier),
  });
  if (args.openBrowser === true) openInBrowser(authUrl);
  return {
    authUrl,
    port: login.port,
    expiresAt: new Date(login.expiresAt).toISOString(),
    scopes,
  };
}

/** Resolves when the current login settles or after timeoutMs, whichever is first. */
export async function waitForLogin(timeoutMs: number): Promise<LoginStatus> {
  const l = current;
  if (l && l.status === 'waiting' && timeoutMs > 0) {
    await Promise.race([
      l.settled,
      new Promise<void>((r) => setTimeout(r, Math.min(timeoutMs, LOGIN_TTL_MS)).unref?.()),
    ]);
  }
  return loginStatus();
}

export interface LoginStatus {
  state: LoginState;
  port?: number;
  expiresAt?: string;
  error?: string;
  storedIn?: KeySource;
  grantedScopes?: string[];
}

/** No verifier, state, code or token is ever included. */
export function loginStatus(): LoginStatus {
  const l = current;
  if (!l) return { state: 'idle' };
  return {
    state: l.status,
    port: l.status === 'waiting' ? l.port : undefined,
    expiresAt: new Date(l.expiresAt).toISOString(),
    error: l.error,
    storedIn: l.storedIn,
    grantedScopes: l.grantedScopes,
  };
}

/** Test hook: abandon any pending login and forget the last outcome. */
export function resetLoginForTests(): void {
  if (current) finish(current, 'cancelled');
  current = null;
}

// ---- logout -----------------------------------------------------------------------------------

export interface LogoutResult {
  hadCredential: boolean;
  revoked: boolean;
  deleted: boolean;
  revokeError?: string;
}

/**
 * Revokes the refresh token at Google, then deletes it locally whether or not the revoke worked
 * (a dead network must not leave a live credential on disk).
 */
export async function logout(): Promise<LogoutResult> {
  epoch++;
  if (current) {
    const l = current;
    finish(l, 'cancelled');
    await l.exchange; // a consumed login may be mid-save; wait so it cannot undo this logout
  }
  clearTokenCache();
  const stored = await loadOAuthRecord();
  const out: LogoutResult = { hadCredential: stored !== null, revoked: false, deleted: false };
  if (stored) {
    try {
      const res = await postForm(GOOGLE_REVOKE_URL, { token: stored.record.refresh_token });
      out.revoked = res.ok;
      if (!res.ok) out.revokeError = await describeFailure(res);
    } catch (e) {
      out.revokeError = `revoke request failed (${(e as Error)?.name ?? 'error'})`;
    }
  }
  await deleteOAuthRecord();
  clearTokenCache();
  out.deleted = (await loadOAuthRecord()) === null;
  return out;
}
