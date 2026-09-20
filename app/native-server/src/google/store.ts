/**
 * Secret + policy storage for the Google tools.
 *
 * The native host is launched by Chrome, so it never sees ~/.zshrc: secrets live in the macOS
 * Keychain (via the `security` CLI) with a 0600 file fallback. Nothing here logs or returns key
 * material; callers get the parsed key object and only auth.ts uses the private key.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getAgentDir } from '../security/local-auth';

export const KEYCHAIN_SERVICE = 'chrome-mcp-google';
export const KEYCHAIN_ACCOUNT = 'service-account';
export const KEYCHAIN_OAUTH_ACCOUNT = 'oauth-refresh';
export const NO_KEYCHAIN_ENV = 'CHROME_MCP_GOOGLE_NO_KEYCHAIN';

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

export type KeySource = 'keychain' | 'file';
export type AuthMode = 'service-account' | 'oauth';
export const AUTH_MODES: readonly AuthMode[] = ['service-account', 'oauth'];

/** Server-side policy. Lives in a file the model cannot edit through any tool. */
export interface GooglePolicy {
  /** Block every non-GET call, including dry-run-approved ones. */
  readOnly: boolean;
  /** Permit delete/clear/trash/sharing/send methods at all. Off by default. */
  allowDestructive: boolean;
  /** When non-empty, every id-bearing path parameter must be in this list. */
  allowedResourceIds: string[];
  /** With an allowlist set, also permit calls that carry no id parameter (files.list, create...). */
  allowUnscoped: boolean;
  /** When non-empty, only these Discovery service names may be called. */
  allowedServices: string[];
  /**
   * Which credential source is used. Explicit and exclusive: 'service-account' (default) or
   * 'oauth' (the operator's own Google account via google_auth_login). There is no fallback
   * between the two, so a call never silently runs as a different identity.
   */
  authMode: AuthMode;
  /**
   * Permit google_sheets_* helpers to write formulas when the caller also passes allowFormulas.
   * Off by default: helper writes are RAW, so "=IMPORTRANGE(...)" stays inert text.
   */
  allowFormulas: boolean;
  /** Set when google-policy.json exists but cannot be trusted. Every call is then refused. */
  invalid?: string;
}

export const DEFAULT_POLICY: GooglePolicy = {
  readOnly: false,
  allowDestructive: false,
  allowedResourceIds: [],
  allowUnscoped: false,
  allowedServices: [],
  authMode: 'service-account',
  allowFormulas: false,
};

const keyFilePath = () => path.join(getAgentDir(), 'google-sa.json');
const oauthFilePath = () => path.join(getAgentDir(), 'google-oauth.json');
const oauthClientPath = () => path.join(getAgentDir(), 'google-oauth-client.json');
const policyFilePath = () => path.join(getAgentDir(), 'google-policy.json');
const useKeychain = () => process.platform === 'darwin' && process.env[NO_KEYCHAIN_ENV] !== '1';

export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('service account key is not valid JSON');
  }
  if (
    !parsed ||
    typeof parsed.client_email !== 'string' ||
    typeof parsed.private_key !== 'string'
  ) {
    throw new Error('service account key must contain client_email and private_key');
  }
  if (parsed.type !== undefined && parsed.type !== 'service_account') {
    throw new Error(`unsupported credential type "${parsed.type}" (expected service_account)`);
  }
  if (!parsed.private_key.includes('BEGIN')) {
    throw new Error('private_key is not a PEM block');
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    project_id: typeof parsed.project_id === 'string' ? parsed.project_id : undefined,
    token_uri: typeof parsed.token_uri === 'string' ? parsed.token_uri : undefined,
  };
}

function keychainRead(account: string = KEYCHAIN_ACCOUNT): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
      { timeout: 10000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** Writes through `security -i` so the secret is on stdin, never in argv / `ps`. */
function keychainWrite(secret: string, account: string = KEYCHAIN_ACCOUNT): Promise<boolean> {
  return new Promise((resolve) => {
    const b64 = Buffer.from(secret, 'utf8').toString('base64'); // base64 alphabet needs no quoting
    const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.write(`add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${b64}\n`);
    child.stdin.end();
  });
}

function keychainDelete(account: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account],
      { timeout: 10000 },
      (err) => resolve(!err),
    );
  });
}

function fileWrite(secret: string, file: string = keyFilePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Stores a validated key. Returns where it landed. */
export async function saveServiceAccountKey(raw: string): Promise<KeySource> {
  parseServiceAccountKey(raw); // refuse to store garbage
  if (useKeychain() && (await keychainWrite(raw))) {
    // Round-trip so a silent failure is caught here, not at first API call.
    const back = await keychainRead();
    if (back === raw) return 'keychain';
  }
  fileWrite(raw);
  return 'file';
}

export async function loadServiceAccountKey(): Promise<{
  key: ServiceAccountKey;
  source: KeySource;
} | null> {
  if (useKeychain()) {
    const raw = await keychainRead();
    if (raw) {
      try {
        return { key: parseServiceAccountKey(raw), source: 'keychain' };
      } catch {
        /* fall through to file */
      }
    }
  }
  try {
    const raw = fs.readFileSync(keyFilePath(), 'utf8');
    return { key: parseServiceAccountKey(raw), source: 'file' };
  } catch {
    return null;
  }
}

const BOOLEAN_FIELDS = ['readOnly', 'allowDestructive', 'allowUnscoped', 'allowFormulas'] as const;
const LIST_FIELDS = ['allowedResourceIds', 'allowedServices'] as const;

/**
 * A missing policy file means "defaults". A file that exists but is unreadable, malformed or
 * wrong-typed fails CLOSED: a typo in an allowlist must never silently widen access.
 */
export function loadPolicy(): GooglePolicy {
  let raw: string;
  try {
    raw = fs.readFileSync(policyFilePath(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { ...DEFAULT_POLICY };
    return invalidPolicy(`policy file is unreadable (${(e as Error)?.message ?? e})`);
  }
  let p: unknown;
  try {
    p = JSON.parse(raw);
  } catch {
    return invalidPolicy('policy file is not valid JSON');
  }
  if (p === null || typeof p !== 'object' || Array.isArray(p)) {
    return invalidPolicy('policy file must be a JSON object');
  }
  const o = p as Record<string, unknown>;
  for (const f of BOOLEAN_FIELDS) {
    if (o[f] !== undefined && typeof o[f] !== 'boolean')
      return invalidPolicy(`policy.${f} must be a boolean`);
  }
  for (const f of LIST_FIELDS) {
    const v = o[f];
    if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string')))
      return invalidPolicy(`policy.${f} must be an array of strings`);
  }
  if (o.authMode !== undefined && !AUTH_MODES.includes(o.authMode as AuthMode))
    return invalidPolicy(`policy.authMode must be one of ${AUTH_MODES.join(', ')}`);
  return {
    authMode: (o.authMode as AuthMode | undefined) ?? 'service-account',
    allowFormulas: o.allowFormulas === true,
    readOnly: o.readOnly === true,
    allowDestructive: o.allowDestructive === true,
    allowedResourceIds: (o.allowedResourceIds as string[] | undefined) ?? [],
    allowUnscoped: o.allowUnscoped === true,
    allowedServices: (o.allowedServices as string[] | undefined) ?? [],
  };
}

function invalidPolicy(reason: string): GooglePolicy {
  return { ...DEFAULT_POLICY, readOnly: true, invalid: reason };
}

// ---------------------------------------------------------------------------------------------
// OAuth (own Google account): client config + refresh-token record
// ---------------------------------------------------------------------------------------------

/** OAuth client identifiers. Read from google-oauth-client.json; never compiled in. */
export interface OAuthClient {
  client_id: string;
  /** Desktop-app clients carry a "secret" that Google documents as non-confidential; optional. */
  client_secret?: string;
}

/** What is persisted for a logged-in account. The refresh token is the only long-lived secret. */
export interface OAuthRecord {
  refresh_token: string;
  /** Scopes Google actually granted (may be fewer than requested). */
  scopes: string[];
  client_id: string;
  obtained_at: string;
}

/**
 * Accepts either {client_id, client_secret} or the JSON Google's console downloads
 * ({"installed": {...}}). Kept apart from google-policy.json because google_auth_status echoes the
 * policy and must never be able to echo a client secret.
 */
export function parseOAuthClient(raw: string): OAuthClient {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('google-oauth-client.json is not valid JSON');
  }
  const c = parsed?.installed ?? parsed;
  if (!c || typeof c.client_id !== 'string' || !/^[\w.-]{8,300}$/.test(c.client_id)) {
    throw new Error('google-oauth-client.json needs a client_id (see docs/google-workspace.md)');
  }
  if (c.client_secret !== undefined && typeof c.client_secret !== 'string') {
    throw new Error('google-oauth-client.json client_secret must be a string');
  }
  return {
    client_id: c.client_id,
    client_secret: c.client_secret || undefined,
  };
}

export function loadOAuthClient(): OAuthClient | null {
  let raw: string;
  try {
    raw = fs.readFileSync(oauthClientPath(), 'utf8');
  } catch {
    return null;
  }
  return parseOAuthClient(raw); // a present-but-bad file throws so the operator sees why
}

export function parseOAuthRecord(raw: string): OAuthRecord {
  let p: any;
  try {
    p = JSON.parse(raw);
  } catch {
    throw new Error('stored OAuth record is not valid JSON');
  }
  if (
    !p ||
    typeof p.refresh_token !== 'string' ||
    !p.refresh_token ||
    typeof p.client_id !== 'string' ||
    !Array.isArray(p.scopes) ||
    !p.scopes.every((s: unknown) => typeof s === 'string')
  ) {
    throw new Error('stored OAuth record is malformed');
  }
  return {
    refresh_token: p.refresh_token,
    scopes: p.scopes,
    client_id: p.client_id,
    obtained_at: typeof p.obtained_at === 'string' ? p.obtained_at : '',
  };
}

export async function saveOAuthRecord(rec: OAuthRecord): Promise<KeySource> {
  const raw = JSON.stringify(rec);
  parseOAuthRecord(raw);
  if (useKeychain() && (await keychainWrite(raw, KEYCHAIN_OAUTH_ACCOUNT))) {
    const back = await keychainRead(KEYCHAIN_OAUTH_ACCOUNT);
    if (back === raw) {
      // A stale fallback file must not outlive a successful Keychain write.
      fs.rmSync(oauthFilePath(), { force: true });
      return 'keychain';
    }
  }
  fileWrite(raw, oauthFilePath());
  return 'file';
}

export async function loadOAuthRecord(): Promise<{
  record: OAuthRecord;
  source: KeySource;
} | null> {
  if (useKeychain()) {
    const raw = await keychainRead(KEYCHAIN_OAUTH_ACCOUNT);
    if (raw) {
      try {
        return { record: parseOAuthRecord(raw), source: 'keychain' };
      } catch {
        /* fall through to file */
      }
    }
  }
  try {
    return { record: parseOAuthRecord(fs.readFileSync(oauthFilePath(), 'utf8')), source: 'file' };
  } catch {
    return null;
  }
}

/** Removes the refresh token from every place it may live. */
export async function deleteOAuthRecord(): Promise<void> {
  if (useKeychain()) await keychainDelete(KEYCHAIN_OAUTH_ACCOUNT);
  fs.rmSync(oauthFilePath(), { force: true });
}
