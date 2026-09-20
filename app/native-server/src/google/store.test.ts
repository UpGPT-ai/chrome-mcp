/**
 * store.ts: Keychain fallback ordering (L1) and atomic 0600 file creation (L6).
 * `security` is faked via a mocked child_process; the real Keychain is never touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const keychain = new Map<string, string>();
let failWrites = false;
const calls: string[] = [];

jest.mock('node:child_process', () => ({
  execFile: (_cmd: string, args: string[], _opts: any, cb: (e: any, out?: string) => void) => {
    const account = args[args.indexOf('-a') + 1];
    if (args[0] === 'find-generic-password') {
      calls.push(`read:${account}`);
      return keychain.has(account) ? cb(null, keychain.get(account) + '\n') : cb(new Error('nf'));
    }
    calls.push(`delete:${account}`);
    return keychain.delete(account) ? cb(null) : cb(new Error('nf'));
  },
  spawn: () => {
    const child: any = new EventEmitter();
    child.stdin = {
      write: (line: string) => {
        const m = /-a (\S+) -w (\S+)/.exec(line)!;
        calls.push(`write:${m[1]}`);
        if (!failWrites) keychain.set(m[1], m[2]);
      },
      end: () => setImmediate(() => child.emit('close', failWrites ? 1 : 0)),
    };
    return child;
  },
}));

import {
  KEYCHAIN_OAUTH_ACCOUNT,
  NO_KEYCHAIN_ENV,
  loadOAuthRecord,
  saveOAuthRecord,
  saveServiceAccountKey,
} from './store';

const AUTH_DIR_ENV = 'CHROME_MCP_AGENT_DIR';
let dir: string;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const rec = (rt: string) => ({
  client_id: 'cid',
  refresh_token: rt,
  scopes: ['s'],
  obtained_at: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-store-'));
  process.env[AUTH_DIR_ENV] = path.join(dir, 'agent');
  delete process.env[NO_KEYCHAIN_ENV];
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  keychain.clear();
  calls.length = 0;
  failWrites = false;
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  delete process.env[AUTH_DIR_ENV];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('saveOAuthRecord keychain fallback (L1)', () => {
  test('a failed Keychain write deletes the stale entry so the new file is not shadowed', async () => {
    await saveOAuthRecord(rec('old-token'));
    expect(keychain.has(KEYCHAIN_OAUTH_ACCOUNT)).toBe(true);
    failWrites = true;
    expect(await saveOAuthRecord(rec('new-token'))).toBe('file');
    expect(keychain.has(KEYCHAIN_OAUTH_ACCOUNT)).toBe(false);
    const loaded = await loadOAuthRecord();
    expect(loaded?.record.refresh_token).toBe('new-token');
    expect(loaded?.source).toBe('file');
  });
  test('a successful Keychain write leaves no fallback file and no delete', async () => {
    expect(await saveOAuthRecord(rec('t'))).toBe('keychain');
    expect(calls.some((c) => c.startsWith('delete:'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'agent', 'google-oauth.json'))).toBe(false);
  });
  test('service-account key fallback also clears a stale Keychain entry', async () => {
    const key = (n: string) =>
      JSON.stringify({
        client_email: `${n}@x.iam.gserviceaccount.com`,
        private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
      });
    expect(await saveServiceAccountKey(key('a'))).toBe('keychain');
    failWrites = true;
    expect(await saveServiceAccountKey(key('b'))).toBe('file');
    expect(keychain.has('service-account')).toBe(false);
  });
});

describe('fileWrite (L6)', () => {
  test('creates the file 0600 regardless of umask, with no chmod and no leftover temp', async () => {
    const oldUmask = process.umask(0o000);
    const chmod = jest.spyOn(fs, 'chmodSync');
    try {
      process.env[NO_KEYCHAIN_ENV] = '1';
      await saveOAuthRecord(rec('t1'));
      const file = path.join(dir, 'agent', 'google-oauth.json');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      // an existing permissive file is replaced by a 0600 one
      fs.chmodSync(file, 0o644);
      chmod.mockClear();
      await saveOAuthRecord(rec('t2'));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(chmod).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).refresh_token).toBe('t2');
      expect(fs.readdirSync(path.join(dir, 'agent')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      chmod.mockRestore();
      process.umask(oldUmask);
    }
  });
});
