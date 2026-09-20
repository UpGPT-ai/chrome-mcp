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
export const NO_KEYCHAIN_ENV = 'CHROME_MCP_GOOGLE_NO_KEYCHAIN';

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
  token_uri?: string;
}

export type KeySource = 'keychain' | 'file';

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
  /** Set when google-policy.json exists but cannot be trusted. Every call is then refused. */
  invalid?: string;
}

export const DEFAULT_POLICY: GooglePolicy = {
  readOnly: false,
  allowDestructive: false,
  allowedResourceIds: [],
  allowUnscoped: false,
  allowedServices: [],
};

const keyFilePath = () => path.join(getAgentDir(), 'google-sa.json');
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

function keychainRead(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
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
function keychainWrite(secret: string): Promise<boolean> {
  return new Promise((resolve) => {
    const b64 = Buffer.from(secret, 'utf8').toString('base64'); // base64 alphabet needs no quoting
    const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.write(
      `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${b64}\n`,
    );
    child.stdin.end();
  });
}

function fileWrite(secret: string): void {
  const file = keyFilePath();
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

const BOOLEAN_FIELDS = ['readOnly', 'allowDestructive', 'allowUnscoped'] as const;
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
  return {
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
