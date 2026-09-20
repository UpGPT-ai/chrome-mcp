/**
 * Service-account auth with zero dependencies: an RS256 JWT signed with node:crypto, exchanged
 * for an access token over global fetch. Tokens are cached in memory only.
 */
import { createSign } from 'node:crypto';
import { loadPolicy, loadServiceAccountKey, type ServiceAccountKey } from './store';

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';

/** Default (read-write) scope per Discovery service; a read-only policy narrows it. */
const SERVICE_SCOPES: Record<string, { rw: string; ro: string }> = {
  sheets: { rw: 'spreadsheets', ro: 'spreadsheets.readonly' },
  docs: { rw: 'documents', ro: 'documents.readonly' },
  drive: { rw: 'drive', ro: 'drive.readonly' },
  slides: { rw: 'presentations', ro: 'presentations.readonly' },
  calendar: { rw: 'calendar', ro: 'calendar.readonly' },
  forms: { rw: 'forms.body', ro: 'forms.body.readonly' },
};

const cache = new Map<string, { token: string; expiresAt: number }>();

const TOKEN_TIMEOUT_MS = 30_000;

export function scopesFor(service: string, readOnly: boolean): string[] {
  const s = SERVICE_SCOPES[service];
  if (!s)
    throw new Error(
      `no default scope for service "${service}"; supported: ${Object.keys(SERVICE_SCOPES).join(', ')}`,
    );
  return [SCOPE_PREFIX + (readOnly ? s.ro : s.rw)];
}

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function buildJwt(key: ServiceAccountKey, scopes: string[], nowSec: number): string {
  const tokenUri = key.token_uri || DEFAULT_TOKEN_URI;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: scopes.join(' '),
      aud: tokenUri,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;
}

function assertGoogleTokenUri(uri: string): void {
  const u = new URL(uri);
  if (
    u.protocol !== 'https:' ||
    !(u.hostname === 'googleapis.com' || u.hostname.endsWith('.googleapis.com'))
  ) {
    throw new Error('token_uri must be an https googleapis.com endpoint');
  }
}

export async function getAccessToken(scopes: string[]): Promise<string> {
  const loaded = await loadServiceAccountKey();
  if (!loaded) throw new Error('no Google service-account key configured (run google-import-key)');
  const cacheKey = `${loaded.key.client_email}|${scopes.slice().sort().join(' ')}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;

  const tokenUri = loaded.key.token_uri || DEFAULT_TOKEN_URI;
  assertGoogleTokenUri(tokenUri);
  const jwt = buildJwt(loaded.key, scopes, Math.floor(Date.now() / 1000));
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!res.ok) {
    // The body names the failure (invalid_grant, invalid_scope); it never echoes the assertion.
    throw new Error(`token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('token exchange returned no access_token');
  cache.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  });
  return data.access_token;
}

export function clearTokenCache(): void {
  cache.clear();
}

/** Never includes the private key or any token. */
export async function authStatus(): Promise<Record<string, unknown>> {
  const loaded = await loadServiceAccountKey();
  return {
    configured: loaded !== null,
    source: loaded?.source ?? null,
    clientEmail: loaded?.key.client_email ?? null,
    projectId: loaded?.key.project_id ?? null,
    cachedTokens: cache.size,
    policy: loadPolicy(),
    supportedServices: Object.keys(SERVICE_SCOPES),
  };
}
