/**
 * Access-token source, selected explicitly by policy.authMode:
 *  - "service-account" (default): an RS256 JWT signed with node:crypto, exchanged over global fetch.
 *  - "oauth": the stored refresh token (see oauth.ts), exchanged for a downscoped access token.
 * There is no fallback between the two: a misconfigured mode fails loudly instead of silently
 * switching identity. Tokens are cached in memory only.
 */
import { createHash, createSign } from 'node:crypto';
import { loginStatus, refreshAccessToken } from './oauth';
import { SERVICE_SCOPES, scopesFor } from './scopes';
import {
  loadOAuthClient,
  loadOAuthRecord,
  loadPolicy,
  loadServiceAccountKey,
  type ServiceAccountKey,
} from './store';

export { scopesFor };

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

const cache = new Map<string, { token: string; expiresAt: number }>();

const TOKEN_TIMEOUT_MS = 30_000;

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
  const policy = loadPolicy();
  if (policy.invalid) throw new Error(`google-policy.json rejected: ${policy.invalid}`);
  if (policy.authMode === 'oauth') return getOAuthAccessToken(scopes);
  return getServiceAccountToken(scopes);
}

async function getOAuthAccessToken(scopes: string[]): Promise<string> {
  const stored = await loadOAuthRecord();
  if (!stored) throw new Error('not logged in: run google_auth_login (policy.authMode is "oauth")');
  // A cached token is only valid for the client config that is current NOW: a swapped or edited
  // google-oauth-client.json must not keep serving tokens minted under the previous one.
  const client = loadOAuthClient();
  if (!client) throw new Error('no OAuth client configured (google-oauth-client.json)');
  if (client.client_id !== stored.record.client_id)
    throw new Error(
      'stored login belongs to a different OAuth client; run google_auth_logout then google_auth_login',
    );
  const clientTag = createHash('sha256')
    .update(`${client.client_id}\0${client.client_secret ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  const cacheKey = `oauth|${clientTag}|${stored.record.obtained_at}|${scopes.slice().sort().join(' ')}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;
  const fresh = await refreshAccessToken(scopes);
  cache.set(cacheKey, { token: fresh.token, expiresAt: Date.now() + fresh.expiresIn * 1000 });
  return fresh.token;
}

async function getServiceAccountToken(scopes: string[]): Promise<string> {
  const loaded = await loadServiceAccountKey();
  if (!loaded) throw new Error('no Google service-account key configured (run google-import-key)');
  const cacheKey = `sa|${loaded.key.client_email}|${scopes.slice().sort().join(' ')}`;
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

/** Never includes the private key, refresh token, verifier, state or any access token. */
export async function authStatus(): Promise<Record<string, unknown>> {
  const policy = loadPolicy();
  const sa = await loadServiceAccountKey();
  const oauthRec = await loadOAuthRecord();
  let client: ReturnType<typeof loadOAuthClient> = null;
  let clientFileInvalid: string | null = null;
  try {
    client = loadOAuthClient();
  } catch (e: any) {
    clientFileInvalid = e?.message ?? String(e); // status must still answer on a bad client file
  }
  return {
    authMode: policy.authMode,
    // Kept for phase 2 callers: describes the service-account credential.
    configured: sa !== null,
    source: sa?.source ?? null,
    clientEmail: sa?.key.client_email ?? null,
    projectId: sa?.key.project_id ?? null,
    serviceAccount: {
      configured: sa !== null,
      source: sa?.source ?? null,
      clientEmail: sa?.key.client_email ?? null,
      projectId: sa?.key.project_id ?? null,
    },
    oauth: {
      clientConfigured: client !== null,
      clientFileInvalid,
      loggedIn: oauthRec !== null,
      source: oauthRec?.source ?? null,
      grantedScopes: oauthRec?.record.scopes ?? [],
      obtainedAt: oauthRec?.record.obtained_at ?? null,
      login: loginStatus(),
    },
    activeCredentialReady:
      policy.authMode === 'oauth' ? oauthRec !== null && client !== null : sa !== null,
    cachedTokens: cache.size,
    policy,
    supportedServices: Object.keys(SERVICE_SCOPES),
  };
}
