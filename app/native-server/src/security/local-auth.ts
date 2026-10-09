/**
 * Local bridge hardening.
 *
 * The bridge listens on 127.0.0.1 with no authentication, which leaves it open to (a) DNS
 * rebinding from any web page, (b) cross-origin requests whose Origin merely *starts with*
 * "http://127.0.0.1" (e.g. http://127.0.0.1.evil.com), and (c) any other local process.
 *
 * Three independent layers:
 *  1. Host header must be a loopback name          -> defeats DNS rebinding
 *  2. Origin, when present, must be an extension or an exact loopback origin
 *  3. Bearer token (0600 file) on the MCP transports -> defeats other local processes
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

export const AUTH_DIR_ENV = 'CHROME_MCP_AGENT_DIR';

export function getAgentDir(): string {
  return process.env[AUTH_DIR_ENV] || path.join(os.homedir(), '.chrome-mcp-agent');
}

export function getAuthTokenPath(): string {
  return path.join(getAgentDir(), 'auth-token');
}

/**
 * Paths that may be called WITHOUT the bearer token. Everything else requires it, so a route
 * added later (or a path spelled in a way the router normalizes) fails closed instead of open.
 * /agent/* and /ask-extension serve the extension UI, which has no token; they are protected only
 * by the Host and Origin checks (documented residual risk).
 *
 * /agent/* stays exempt on purpose. The side panel opens the agent stream with
 * `new EventSource(url)` (useAgentServer.ts), and EventSource cannot set an
 * Authorization header. The extension also cannot read ~/.chrome-mcp-agent/auth-token.
 * Requiring a bearer token here would break that stream. Host and Origin checks
 * still apply. This residual risk remains until those callers can send the token.
 */
const TOKEN_EXEMPT_EXACT = new Set(['/ping', '/ask-extension']);
const TOKEN_EXEMPT_PREFIXES = ['/agent/'];

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HOST_HEADER = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i;
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;

/** True when the Host header is exactly a loopback name with an optional numeric port. */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const value = hostHeader.trim();
  const m = HOST_HEADER.exec(value);
  return m !== null && LOOPBACK_HOSTNAMES.has(m[1].toLowerCase());
}

/** No Origin (curl, server-to-server) is allowed; otherwise it must match exactly. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return EXTENSION_ORIGIN.test(origin) || LOOPBACK_ORIGIN.test(origin);
}

/**
 * Every spelling of the request path the router might act on: as sent, after one percent-decode
 * (what Fastify does) and fully decoded. Dot segments and duplicate slashes are collapsed.
 * Returns null when the path cannot be decoded, which the caller treats as protected.
 */
function pathSpellings(url: string): string[] | null {
  let raw = url;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(raw);
  if (scheme) raw = raw.slice(scheme[0].length) || '/'; // absolute-form request target
  raw = raw.split(/[?#]/)[0];
  const spellings = [raw];
  try {
    let current = raw;
    for (let i = 0; i < 4; i++) {
      const next = decodeURIComponent(current);
      if (next === current) break;
      spellings.push(next);
      current = next;
    }
  } catch {
    return null;
  }
  return spellings.map((p) => path.posix.normalize(p.replace(/\\/g, '/')).replace(/\/{2,}/g, '/'));
}

function isExemptPath(p: string): boolean {
  return TOKEN_EXEMPT_EXACT.has(p) || TOKEN_EXEMPT_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/** True unless EVERY spelling of the path is on the exempt list. Undecodable paths are protected. */
export function isTokenProtectedPath(url: string): boolean {
  const spellings = pathSpellings(url);
  if (spellings === null) return true;
  return !spellings.every(isExemptPath);
}

export function verifyBearer(authorization: string | undefined, token: string): boolean {
  if (!authorization || !token) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Reads the token, creating it (0600, dir 0700) on first use. Returns null if it cannot be stored. */
export function getOrCreateAuthToken(): string | null {
  const file = getAuthTokenPath();
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8').trim();
      if (existing.length >= 32) {
        fs.chmodSync(file, 0o600);
        return existing;
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(file), 0o700);
    const token = randomBytes(32).toString('hex');
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return token;
  } catch {
    return null;
  }
}

/** Token for outbound clients of our own /mcp endpoint (stdio proxy, agent bridge). */
export function readAuthToken(): string | null {
  try {
    const value = fs.readFileSync(getAuthTokenPath(), 'utf8').trim();
    return value.length >= 32 ? value : null;
  } catch {
    return null;
  }
}

export function authHeaders(): Record<string, string> {
  const token = readAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Registers the onRequest guard. If a token cannot be read the protected paths fail closed rather
 * than silently running unauthenticated.
 */
export function registerLocalAuth(fastify: FastifyInstance): void {
  getOrCreateAuthToken(); // create it up front; verification re-reads it so rotation needs no restart
  fastify.addHook('onRequest', async (request, reply) => {
    if (!isAllowedHost(request.headers.host)) {
      return reply.status(403).send({ error: 'Forbidden: invalid Host header' });
    }
    if (!isAllowedOrigin(request.headers.origin)) {
      return reply.status(403).send({ error: 'Forbidden: origin not allowed' });
    }
    if (request.method !== 'OPTIONS' && isTokenProtectedPath(request.url)) {
      const token = readAuthToken();
      if (token === null || !verifyBearer(request.headers.authorization, token)) {
        return reply.status(401).send({ error: 'Unauthorized: missing or invalid bearer token' });
      }
    }
  });
}
