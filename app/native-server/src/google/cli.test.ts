import { describe, expect, test, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_DIR_ENV } from '../security/local-auth';
import { NO_KEYCHAIN_ENV } from './store';
import { clearTokenCache } from './auth';
import { resetLoginForTests } from './oauth';

const mockHandle = jest.fn<(name: string, args: any) => Promise<any>>();
jest.mock('./index', () => ({ handleGoogleTool: (n: string, a: any) => mockHandle(n, a) }));
jest.mock('../google', () => ({ handleGoogleTool: (n: string, a: any) => mockHandle(n, a) }));

import { parseArgs, runCli, USAGE } from '../cli/google-cli';

let dir: string;
let out: string[];
let err: string[];
const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
const ok = (o: unknown = { ok: true }) => ({
  content: [{ type: 'text', text: JSON.stringify(o) }],
});
const bad = () => ({ isError: true, content: [{ type: 'text', text: '{"error":"blocked"}' }] });
const lastCall = () => mockHandle.mock.calls[mockHandle.mock.calls.length - 1];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-google-cli-'));
  process.env[AUTH_DIR_ENV] = path.join(dir, 'agent');
  process.env[NO_KEYCHAIN_ENV] = '1';
  clearTokenCache();
  resetLoginForTests();
  mockHandle.mockReset();
  mockHandle.mockResolvedValue(ok());
  out = [];
  err = [];
});
afterEach(() => {
  resetLoginForTests();
  delete process.env[AUTH_DIR_ENV];
  delete process.env[NO_KEYCHAIN_ENV];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseArgs', () => {
  test('splits positionals and flags; booleans take no value', () => {
    expect(parseArgs(['call', 'sheets', 'x', '--params', '{"a":1}', '--execute', 'tail'])).toEqual({
      positional: ['call', 'sheets', 'x', 'tail'],
      flags: { params: '{"a":1}', execute: true },
    });
  });
  test('rejects a valueless flag', async () => {
    expect(() => parseArgs(['--params'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--'])).toThrow();
  });
});

describe('runCli usage and errors', () => {
  test('no command prints usage and exits 2; help exits 0', async () => {
    expect(await runCli([], io)).toBe(2);
    expect(err.join('\n')).toContain(USAGE);
    err = [];
    expect(await runCli(['--help'], io)).toBe(0);
    expect(await runCli(['help'], io)).toBe(0);
  });
  test('unknown command, missing args and bad JSON exit 2 without calling any tool', async () => {
    for (const argv of [
      ['frobnicate'],
      ['schema'],
      ['call', 'sheets'],
      ['sheets-append', 'id'],
      ['sheets-append', 'id', 'A1'],
      ['sheets-append', 'id', 'A1', '--values', '{nope'],
      ['sheets-append', 'id', 'A1', '--values', '[]', '--values-file', 'x'],
      ['call', 'sheets', 'm', '--params', 'nope'],
      ['docs-append', 'doc'],
      ['docs-read', 'D', '--max-chars', 'abc'],
      ['call', 'sheets', 'm', '--max-bytes', '-5'],
      ['login', '--services', 'sheets', '--wait', 'x'],
    ])
      expect(await runCli(argv, io)).toBe(2);
    expect(mockHandle).not.toHaveBeenCalled();
  });
  test('a tool error result exits 1 and a thrown error exits 1', async () => {
    mockHandle.mockResolvedValueOnce(bad());
    expect(await runCli(['status'], io)).toBe(1);
    mockHandle.mockRejectedValueOnce(new Error('boom'));
    expect(await runCli(['status'], io)).toBe(1);
    expect(err.join('')).toContain('boom');
  });
});

describe('runCli maps commands to tools', () => {
  test('status, schema, call default to dry-run (dryRun left undefined) and --execute sets false', async () => {
    await runCli(['status'], io);
    expect(lastCall()[0]).toBe('google_auth_status');
    await runCli(['schema', 'sheets', 'spreadsheets.get', '--query', 'q'], io);
    expect(lastCall()).toEqual([
      'google_api_schema',
      expect.objectContaining({ service: 'sheets', method: 'spreadsheets.get', query: 'q' }),
    ]);
    await runCli(['call', 'sheets', 'spreadsheets.get', '--params', '{"spreadsheetId":"a"}'], io);
    expect(lastCall()[1]).toMatchObject({ params: { spreadsheetId: 'a' }, dryRun: undefined });
    await runCli(['call', 'sheets', 'spreadsheets.batchUpdate', '--body', '{}', '--execute'], io);
    expect(lastCall()[1]).toMatchObject({ dryRun: false, body: {} });
  });
  test('sheets-read: one range vs many', async () => {
    await runCli(['sheets-read', 'S', 'A1:B2'], io);
    expect(lastCall()).toEqual([
      'google_sheets_read',
      expect.objectContaining({ spreadsheetId: 'S', range: 'A1:B2' }),
    ]);
    expect(lastCall()[1]).not.toHaveProperty('ranges');
    await runCli(['sheets-read', 'S', 'A1', 'B1', '--dimension', 'COLUMNS'], io);
    expect(lastCall()[1]).toMatchObject({ ranges: ['A1', 'B1'], majorDimension: 'COLUMNS' });
  });
  test('sheets writes are dry-run unless --execute, and formula flags are never implied', async () => {
    await runCli(['sheets-append', 'S', 'Tab!A1', '--values', '[["=1+1"]]'], io);
    expect(lastCall()).toEqual([
      'google_sheets_append',
      {
        spreadsheetId: 'S',
        range: 'Tab!A1',
        values: [['=1+1']],
        userEntered: false,
        allowFormulas: false,
        dryRun: true,
      },
    ]);
    await runCli(
      [
        'sheets-update',
        'S',
        'A1',
        '--values',
        '[[1]]',
        '--overwrite',
        '--user-entered',
        '--allow-formulas',
        '--execute',
      ],
      io,
    );
    expect(lastCall()[1]).toMatchObject({
      overwrite: true,
      userEntered: true,
      allowFormulas: true,
      dryRun: false,
    });
    await runCli(['sheets-update', 'S', 'A1', '--values', '[[1]]'], io);
    expect(lastCall()[1]).toMatchObject({ overwrite: false, dryRun: true });
  });
  test('--values-file and --text-file are read from disk', async () => {
    const vf = path.join(dir, 'v.json');
    const tf = path.join(dir, 't.txt');
    fs.writeFileSync(vf, '[["a","b"]]');
    fs.writeFileSync(tf, 'hello');
    await runCli(['sheets-append', 'S', 'A1', '--values-file', vf], io);
    expect(lastCall()[1].values).toEqual([['a', 'b']]);
    await runCli(['docs-append', 'D', '--text-file', tf, '--execute'], io);
    expect(lastCall()).toEqual([
      'google_docs_append_text',
      { documentId: 'D', text: 'hello', dryRun: false },
    ]);
    expect(await runCli(['docs-append', 'D', '--text-file', path.join(dir, 'missing')], io)).toBe(
      1,
    );
  });
  test('ensure-tab joins a multi-word title; docs-read passes maxChars', async () => {
    await runCli(['sheets-ensure-tab', 'S', 'My', 'Tab'], io);
    expect(lastCall()).toEqual([
      'google_sheets_ensure_tab',
      { spreadsheetId: 'S', title: 'My Tab', dryRun: true },
    ]);
    await runCli(['docs-read', 'D', '--max-chars', '500'], io);
    expect(lastCall()).toEqual(['google_docs_read', { documentId: 'D', maxChars: 500 }]);
  });
  test('logout goes through the tool', async () => {
    await runCli(['logout'], io);
    expect(lastCall()[0]).toBe('google_auth_logout');
  });
});

describe('login command (real oauth module, mocked network)', () => {
  test('is refused when policy.authMode is not oauth, with no URL printed', async () => {
    expect(await runCli(['login', '--services', 'sheets'], io)).toBe(1);
    expect(err.join('')).toMatch(/authMode/);
    expect(out).toEqual([]);
  });
  test('prints the auth URL to stderr only, and times out cleanly with --wait 0', async () => {
    fs.mkdirSync(process.env[AUTH_DIR_ENV]!, { recursive: true });
    fs.writeFileSync(
      path.join(process.env[AUTH_DIR_ENV]!, 'google-policy.json'),
      '{"authMode":"oauth"}',
    );
    fs.writeFileSync(
      path.join(process.env[AUTH_DIR_ENV]!, 'google-oauth-client.json'),
      '{"client_id":"client-1234.apps.googleusercontent.com"}',
    );
    const code = await runCli(['login', '--services', 'sheets', '--wait', '0'], io);
    expect(code).toBe(1); // nobody completed it
    expect(err.join('\n')).toContain('https://accounts.google.com/o/oauth2/v2/auth?');
    const stdout = out.join('\n');
    expect(stdout).not.toContain('accounts.google.com');
    expect(stdout).not.toMatch(/verifier|code_challenge/);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false });
  });
});
