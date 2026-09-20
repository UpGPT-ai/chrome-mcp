import { describe, expect, test, beforeEach, afterEach, jest } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_DIR_ENV } from '../security/local-auth';
import { clearTokenCache } from './auth';
import { clearDiscoveryMemory } from './discovery';
import { NO_KEYCHAIN_ENV, saveServiceAccountKey } from './store';
import { DEFAULT_RESPONSE_BYTES, MAX_RESPONSE_BYTES, responseCap } from './api-call';
import { DANGEROUS_FUNCTION, FORMULA_TRIGGER } from './formulas';
import {
  chooseWriteMode,
  flattenDocContent,
  MAX_CELLS,
  sheetsDocsToolSchemas,
  validateValues,
} from './sheets-docs';
import { handleGoogleTool } from './index';

const SID = 'sheet_ID_0123456789';
const OTHER = 'other_ID_0123456789';
const DID = 'doc_ID_012345678901';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const keyJson = JSON.stringify({
  type: 'service_account',
  client_email: 'bot@proj.iam.gserviceaccount.com',
  private_key: privateKey,
  project_id: 'proj',
});

const idParams = (name: string) => ({
  [name]: { type: 'string', location: 'path', required: true },
});
const valueRange = {
  type: 'object',
  properties: {
    range: { type: 'string' },
    majorDimension: { type: 'string' },
    values: { type: 'array', items: { type: 'array', items: { type: 'any' } } },
  },
};
const sheetsDoc: any = {
  name: 'sheets',
  version: 'v4',
  rootUrl: 'https://sheets.googleapis.com/',
  servicePath: '',
  parameters: { fields: { type: 'string', location: 'query' } },
  schemas: {
    ValueRange: valueRange,
    BatchUpdateRequest: {
      type: 'object',
      properties: { requests: { type: 'array', items: { type: 'object' } } },
    },
  },
  resources: {
    spreadsheets: {
      methods: {
        get: {
          id: 'sheets.spreadsheets.get',
          path: 'v4/spreadsheets/{spreadsheetId}',
          httpMethod: 'GET',
          parameters: {
            ...idParams('spreadsheetId'),
            fields: { type: 'string', location: 'query' },
          },
        },
        batchUpdate: {
          id: 'sheets.spreadsheets.batchUpdate',
          path: 'v4/spreadsheets/{spreadsheetId}:batchUpdate',
          httpMethod: 'POST',
          parameters: idParams('spreadsheetId'),
          request: { $ref: 'BatchUpdateRequest' },
        },
      },
      resources: {
        values: {
          methods: {
            get: {
              id: 'sheets.spreadsheets.values.get',
              path: 'v4/spreadsheets/{spreadsheetId}/values/{range}',
              httpMethod: 'GET',
              parameters: {
                ...idParams('spreadsheetId'),
                ...idParams('range'),
                majorDimension: { type: 'string', location: 'query' },
                valueRenderOption: { type: 'string', location: 'query' },
              },
            },
            batchGet: {
              id: 'sheets.spreadsheets.values.batchGet',
              path: 'v4/spreadsheets/{spreadsheetId}/values:batchGet',
              httpMethod: 'GET',
              parameters: {
                ...idParams('spreadsheetId'),
                ranges: { type: 'string', location: 'query', repeated: true },
                majorDimension: { type: 'string', location: 'query' },
                valueRenderOption: { type: 'string', location: 'query' },
              },
            },
            append: {
              id: 'sheets.spreadsheets.values.append',
              path: 'v4/spreadsheets/{spreadsheetId}/values/{range}:append',
              httpMethod: 'POST',
              parameters: {
                ...idParams('spreadsheetId'),
                ...idParams('range'),
                valueInputOption: { type: 'string', location: 'query' },
                insertDataOption: { type: 'string', location: 'query' },
              },
              request: { $ref: 'ValueRange' },
            },
            update: {
              id: 'sheets.spreadsheets.values.update',
              path: 'v4/spreadsheets/{spreadsheetId}/values/{range}',
              httpMethod: 'PUT',
              parameters: {
                ...idParams('spreadsheetId'),
                ...idParams('range'),
                valueInputOption: { type: 'string', location: 'query' },
              },
              request: { $ref: 'ValueRange' },
            },
          },
        },
      },
    },
  },
};
const docsDoc: any = {
  name: 'docs',
  version: 'v1',
  rootUrl: 'https://docs.googleapis.com/',
  servicePath: '',
  parameters: { fields: { type: 'string', location: 'query' } },
  schemas: {
    BatchUpdateDocumentRequest: {
      type: 'object',
      properties: { requests: { type: 'array', items: { type: 'object' } } },
    },
  },
  resources: {
    documents: {
      methods: {
        get: {
          id: 'docs.documents.get',
          path: 'v1/documents/{documentId}',
          httpMethod: 'GET',
          parameters: { ...idParams('documentId'), fields: { type: 'string', location: 'query' } },
        },
        batchUpdate: {
          id: 'docs.documents.batchUpdate',
          path: 'v1/documents/{documentId}:batchUpdate',
          httpMethod: 'POST',
          parameters: idParams('documentId'),
          request: { $ref: 'BatchUpdateDocumentRequest' },
        },
      },
    },
  },
};

let dir: string;
let fetchMock: jest.Mock<any>;
const realFetch = global.fetch;
let sheetTabs: string[];

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

function writePolicy(p: object) {
  fs.mkdirSync(process.env[AUTH_DIR_ENV] as string, { recursive: true });
  fs.writeFileSync(
    path.join(process.env[AUTH_DIR_ENV] as string, 'google-policy.json'),
    JSON.stringify(p),
  );
}

/** Routes discovery docs and the token endpoint; `api` handles Google API calls. */
function route(api: (url: string, init: any) => Response | Promise<Response>) {
  fetchMock = jest.fn(async (url: any, init: any) => {
    const u = String(url);
    if (u.includes('/discovery/v1/apis/sheets/v4/rest')) return json(sheetsDoc);
    if (u.includes('/discovery/v1/apis/docs/v1/rest')) return json(docsDoc);
    if (u === 'https://oauth2.googleapis.com/token')
      return json({ access_token: 'tok', expires_in: 3600 });
    return api(u, init);
  });
  (global as any).fetch = fetchMock;
}
const apiCalls = (): any[][] =>
  (fetchMock.mock.calls as any[][]).filter(
    (c) => !String(c[0]).includes('/discovery/') && !String(c[0]).includes('oauth2.googleapis.com'),
  );
const call = async (name: string, args: object): Promise<any> => {
  const r: any = await handleGoogleTool(name, args);
  return JSON.parse(r.content[0].text);
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-google-helpers-'));
  process.env[AUTH_DIR_ENV] = path.join(dir, 'agent');
  process.env[NO_KEYCHAIN_ENV] = '1';
  clearTokenCache();
  clearDiscoveryMemory();
  await saveServiceAccountKey(keyJson);
  sheetTabs = ['Sheet1'];
  route((u, init) => {
    if (u.includes('/spreadsheets/') && u.includes('fields=sheets.properties.title'))
      return json({ sheets: sheetTabs.map((title) => ({ properties: { title } })) });
    return json({ ok: true });
  });
});
afterEach(() => {
  (global as any).fetch = realFetch;
  delete process.env[AUTH_DIR_ENV];
  delete process.env[NO_KEYCHAIN_ENV];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('value validation and write mode', () => {
  test('counts formula and dangerous cells', () => {
    const { scan } = validateValues([['a', '=1+1', ' +5', '@x', '=IMPORTXML("u","//a")', 3, null]]);
    expect(scan).toEqual({ cells: 7, formulaCells: 4, dangerousCells: 1 });
  });
  test('rejects bad shapes and oversize writes', () => {
    expect(() => validateValues([])).toThrow(/non-empty/);
    expect(() => validateValues(['a'])).toThrow(/array/);
    expect(() => validateValues([[{ a: 1 }]])).toThrow(/string, number/);
    expect(() => validateValues([[Infinity]])).toThrow(/finite/);
    expect(() => validateValues([['x'.repeat(50_001)]])).toThrow(/characters/);
    expect(() => validateValues([new Array(MAX_CELLS + 1).fill('a')])).toThrow(/cells/);
  });
  test('RAW by default; USER_ENTERED needs both flags and policy', () => {
    const scan = { cells: 1, formulaCells: 1, dangerousCells: 0 };
    expect(chooseWriteMode({}, scan)).toMatchObject({ valueInputOption: 'RAW' });
    expect(chooseWriteMode({ userEntered: 'true' }, scan)).toMatchObject({
      valueInputOption: 'RAW',
    });
    expect(chooseWriteMode({ userEntered: true }, scan)).toHaveProperty('blocked');
    expect(chooseWriteMode({ userEntered: true, allowFormulas: 'yes' }, scan)).toHaveProperty(
      'blocked',
    );
    // caller flags set but policy.allowFormulas is false
    expect(chooseWriteMode({ userEntered: true, allowFormulas: true }, scan)).toHaveProperty(
      'blocked',
    );
    writePolicy({ allowFormulas: true });
    expect(chooseWriteMode({ userEntered: true, allowFormulas: true }, scan)).toEqual({
      valueInputOption: 'USER_ENTERED',
    });
    expect(
      chooseWriteMode({ userEntered: true, allowFormulas: true }, { ...scan, dangerousCells: 1 }),
    ).toHaveProperty('blocked');
    expect(
      chooseWriteMode({ userEntered: true }, { cells: 1, formulaCells: 0, dangerousCells: 0 }),
    ).toEqual({
      valueInputOption: 'USER_ENTERED',
    });
  });
});

describe('google_sheets_read', () => {
  test('single range uses values.get with a GET and wraps data as untrusted', async () => {
    route(() => json({ range: 'Tab!A1:B2', values: [['=evil()', 'x']] }));
    const r = await call('google_sheets_read', { spreadsheetId: SID, range: 'Tab!A1:B2' });
    expect(r).toMatchObject({ ok: true, helper: 'google_sheets_read', untrustedContent: true });
    const [u, init] = apiCalls()[0];
    expect(String(u)).toContain(`/v4/spreadsheets/${SID}/values/Tab!A1%3AB2`);
    expect(init.method).toBe('GET');
  });
  test('multiple ranges use batchGet', async () => {
    await call('google_sheets_read', { spreadsheetId: SID, ranges: ['A1:B2', 'C1:D2'] });
    const u = String(apiCalls()[0][0]);
    expect(u).toContain('values:batchGet');
    expect(u.match(/ranges=/g)).toHaveLength(2);
  });
  test('validates ids, ranges and enums before any request', async () => {
    const bad = async (a: object) =>
      expect((await handleGoogleTool('google_sheets_read', a)).isError).toBe(true);
    await bad({ spreadsheetId: '../x', range: 'A1' });
    await bad({ spreadsheetId: SID });
    await bad({ spreadsheetId: SID, range: 'A1\n' });
    await bad({ spreadsheetId: SID, range: 'A1', majorDimension: 'DIAG' });
    await bad({ spreadsheetId: SID, ranges: new Array(21).fill('A1') });
    expect(apiCalls()).toHaveLength(0);
  });
  test('respects allowedResourceIds', async () => {
    writePolicy({ allowedResourceIds: [OTHER] });
    const r = await call('google_sheets_read', { spreadsheetId: SID, range: 'A1' });
    expect(r).toMatchObject({ ok: false, blocked: true });
    expect(apiCalls()).toHaveLength(0);
    const ok = await call('google_sheets_read', { spreadsheetId: OTHER, range: 'A1' });
    expect(ok.ok).toBe(true);
  });
  test('respects allowedServices', async () => {
    writePolicy({ allowedServices: ['docs'] });
    expect(await call('google_sheets_read', { spreadsheetId: SID, range: 'A1' })).toMatchObject({
      blocked: true,
    });
  });
});

describe('google_sheets_append', () => {
  const args = { spreadsheetId: SID, range: 'Log!A:B', values: [['a', '=SUM(A1:A2)']] };
  test('dry-run by default, nothing sent', async () => {
    const r = await call('google_sheets_append', args);
    expect(r).toMatchObject({ ok: true, dryRun: true, helper: 'google_sheets_append' });
    expect(apiCalls()).toHaveLength(0);
  });
  test('executes as RAW by default and notes the literal formula text', async () => {
    const r = await call('google_sheets_append', { ...args, dryRun: false });
    expect(r.writeNote).toMatch(/literal text/);
    const [u, init] = apiCalls()[0];
    expect(String(u)).toContain('valueInputOption=RAW');
    expect(String(u)).toContain('insertDataOption=INSERT_ROWS');
    expect(String(u)).toContain(':append');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).values).toEqual(args.values);
  });
  test('userEntered with a formula is blocked without the second flag, even with dryRun:false', async () => {
    const r = await call('google_sheets_append', { ...args, dryRun: false, userEntered: true });
    expect(r).toMatchObject({
      ok: false,
      blocked: true,
      reason: expect.stringMatching(/allowFormulas/),
    });
    expect(apiCalls()).toHaveLength(0);
  });
  test('formula needs policy.allowFormulas too; then USER_ENTERED is used', async () => {
    const both = { ...args, dryRun: false, userEntered: true, allowFormulas: true };
    expect(await call('google_sheets_append', both)).toMatchObject({ blocked: true });
    writePolicy({ allowFormulas: true });
    expect((await call('google_sheets_append', both)).ok).toBe(true);
    expect(String(apiCalls()[0][0])).toContain('valueInputOption=USER_ENTERED');
  });
  test('IMPORT/IMAGE/HYPERLINK are refused even with every opt-in', async () => {
    writePolicy({ allowFormulas: true });
    for (const f of [
      '=IMPORTDATA("http://x")',
      '=image("http://x")',
      '=HYPERLINK("http://x","y")',
    ]) {
      const r = await call('google_sheets_append', {
        ...args,
        values: [[f]],
        dryRun: false,
        userEntered: true,
        allowFormulas: true,
      });
      expect(r).toMatchObject({ blocked: true, reason: expect.stringMatching(/IMPORT/) });
    }
    expect(apiCalls()).toHaveLength(0);
  });
  test('plain values may use userEntered without any formula flags', async () => {
    const r = await call('google_sheets_append', {
      ...args,
      values: [['2026-01-01', 5]],
      dryRun: false,
      userEntered: true,
    });
    expect(r.ok).toBe(true);
    expect(String(apiCalls()[0][0])).toContain('valueInputOption=USER_ENTERED');
  });
  test('readOnly and allowedResourceIds block execution', async () => {
    writePolicy({ readOnly: true });
    expect(await call('google_sheets_append', { ...args, dryRun: false })).toMatchObject({
      blocked: true,
    });
    writePolicy({ allowedResourceIds: [OTHER] });
    expect(await call('google_sheets_append', { ...args, dryRun: false })).toMatchObject({
      blocked: true,
    });
    expect(apiCalls()).toHaveLength(0);
  });
  test('an invalid policy fails closed', async () => {
    fs.mkdirSync(process.env[AUTH_DIR_ENV] as string, { recursive: true });
    fs.writeFileSync(path.join(process.env[AUTH_DIR_ENV] as string, 'google-policy.json'), '{oops');
    expect(await call('google_sheets_append', { ...args, dryRun: false })).toMatchObject({
      blocked: true,
    });
    expect(apiCalls()).toHaveLength(0);
  });
});

describe('google_sheets_update', () => {
  const args = { spreadsheetId: SID, range: 'Tab!A1:B1', values: [['a', 'b']] };
  test('dry-run flags that overwrite is required', async () => {
    const r = await call('google_sheets_update', args);
    expect(r).toMatchObject({ ok: true, dryRun: true, overwriteRequired: true });
    expect(apiCalls()).toHaveLength(0);
  });
  test('dryRun:false without overwrite:true is refused', async () => {
    const r = await call('google_sheets_update', { ...args, dryRun: false });
    expect(r).toMatchObject({
      ok: false,
      blocked: true,
      reason: expect.stringMatching(/overwrite/),
    });
    expect(
      await call('google_sheets_update', { ...args, dryRun: false, overwrite: 'true' }),
    ).toMatchObject({
      blocked: true,
    });
    expect(apiCalls()).toHaveLength(0);
  });
  test('executes a PUT with overwrite:true', async () => {
    const r = await call('google_sheets_update', { ...args, dryRun: false, overwrite: true });
    expect(r.ok).toBe(true);
    const [u, init] = apiCalls()[0];
    expect(init.method).toBe('PUT');
    expect(String(u)).toContain('valueInputOption=RAW');
    expect(JSON.parse(init.body).range).toBe('Tab!A1:B1');
  });
  test('readOnly blocks it', async () => {
    writePolicy({ readOnly: true });
    const r = await call('google_sheets_update', { ...args, dryRun: false, overwrite: true });
    expect(r).toMatchObject({ blocked: true, reason: expect.stringMatching(/readOnly/) });
  });
});

describe('formula gates (M1, M2, M3, M4, L5)', () => {
  const api = (method: string, params: object, body: unknown) =>
    call('google_api_call', { service: 'sheets', method, params, body, dryRun: false });
  const upd = (extra: object, values: unknown[][] = [['=SUM(A1:A2)']]) =>
    api('spreadsheets.values.update', { spreadsheetId: SID, range: 'A1', ...extra }, { values });

  test('google_api_call cannot write formulas with USER_ENTERED unless policy.allowFormulas', async () => {
    expect(await upd({ valueInputOption: 'USER_ENTERED' })).toMatchObject({
      blocked: true,
      reason: expect.stringMatching(/allowFormulas/),
    });
    expect(await upd({ valueInputOption: 'user_entered' })).toMatchObject({ blocked: true });
    expect(
      await api(
        'spreadsheets.values.append',
        { spreadsheetId: SID, range: 'A1', valueInputOption: 'USER_ENTERED' },
        { values: [['+1']] },
      ),
    ).toMatchObject({ blocked: true });
    expect(apiCalls()).toHaveLength(0);
    // RAW and plain USER_ENTERED text are unaffected
    expect((await upd({ valueInputOption: 'RAW' })).ok).toBe(true);
    expect((await upd({ valueInputOption: 'USER_ENTERED' }, [['2026-01-01', 5]])).ok).toBe(true);
  });
  test('formulaValue in batchUpdate (updateCells / repeatCell, snake_case too) is refused', async () => {
    const cell = { userEnteredValue: { formulaValue: '=A1' } };
    const bodies = [
      { requests: [{ updateCells: { rows: [{ values: [cell] }], fields: '*' } }] },
      { requests: [{ repeatCell: { cell, fields: '*' } }] },
      {
        requests: [
          {
            update_cells: {
              rows: [{ values: [{ user_entered_value: { formula_value: '=A1' } }] }],
            },
          },
        ],
      },
    ];
    for (const b of bodies)
      expect(await api('spreadsheets.batchUpdate', { spreadsheetId: SID }, b)).toMatchObject({
        blocked: true,
        reason: expect.stringMatching(/formulaValue/),
      });
    expect(apiCalls()).toHaveLength(0);
  });
  test('with allowFormulas the dangerous-function scan still applies to google_api_call', async () => {
    writePolicy({ allowFormulas: true });
    expect((await upd({ valueInputOption: 'USER_ENTERED' })).ok).toBe(true);
    expect(
      await upd({ valueInputOption: 'USER_ENTERED' }, [['=IMPORTXML("http://x","//a")']]),
    ).toMatchObject({ blocked: true, reason: expect.stringMatching(/blocked function/) });
    expect(
      await api(
        'spreadsheets.batchUpdate',
        { spreadsheetId: SID },
        {
          requests: [
            { repeatCell: { cell: { userEnteredValue: { formulaValue: '=IMAGE("u")' } } } },
          ],
        },
      ),
    ).toMatchObject({ blocked: true });
    expect(
      await api(
        'spreadsheets.batchUpdate',
        { spreadsheetId: SID },
        { requests: [{ repeatCell: { cell: { userEnteredValue: { formulaValue: '=A1+1' } } } }] },
      ),
    ).toMatchObject({ ok: true });
  });
  test('DANGEROUS_FUNCTION covers the extended list, whitespace, case and sheet prefixes', () => {
    const bad = [
      '=IMPORTRANGE("a","b")',
      '=ImportData ("u")',
      '=IMPORTFEED("u")',
      '=IMPORTHTML("u","t",1)',
      '=Sheet1!IMPORTXML("u","//a")',
      '=\'My Sheet\'!IMAGE("u")',
      '=HYPERLINK\n("u")',
      '=AI("prompt")',
      '=GOOGLEFINANCE("GOOG")',
      '=WEBSERVICE("u")',
      '=CUBEVALUE("c")',
      '=cubemember("c")',
      '=QUERY(A1:B2,"select *")&"http://evil"',
      '=QUERY("https://x/y.csv","select *")',
      '=IMPORT\u200b(1)',
      '=_xlfn.IMAGE("u")',
    ];
    for (const f of bad) expect(DANGEROUS_FUNCTION.test(f)).toBe(true);
    for (const f of ['=SUM(A1:A2)', '=MAIL(1)', '=QUERY(A1:B2,"select A")', '=A1+1', '=DAI(1)'])
      expect(DANGEROUS_FUNCTION.test(f)).toBe(false);
    const { scan } = validateValues([
      ['=AI("x")', 'the AI (assistant) said', '=QUERY("http://a","x")'],
    ]);
    expect(scan.dangerousCells).toBe(2); // plain text is not a formula, so it is not counted
  });
  test('FORMULA_TRIGGER ignores invisible/format/separator characters and quotes', () => {
    for (const lead of [
      '\u200b',
      '\u2060',
      '\u0085',
      '\ufeff',
      '\u180e',
      '\u00a0',
      '\u2028',
      "'",
      '"',
      '\t',
      ' \u200b\u2060',
    ])
      for (const c of ['=', '+', '-', '@']) expect(FORMULA_TRIGGER.test(`${lead}${c}1`)).toBe(true);
    expect(FORMULA_TRIGGER.test('a=1')).toBe(false);
    expect(validateValues([['\u200b=1+1']]).scan.formulaCells).toBe(1);
  });
  test('append with insertDataOption OVERWRITE needs overwrite:true to execute', async () => {
    const a = {
      spreadsheetId: SID,
      range: 'Log!A:B',
      values: [['a']],
      insertDataOption: 'OVERWRITE',
    };
    expect(await call('google_sheets_append', { ...a, dryRun: false })).toMatchObject({
      blocked: true,
      reason: expect.stringMatching(/overwrite:true/),
    });
    expect(apiCalls()).toHaveLength(0);
    expect((await call('google_sheets_append', a)).ok).toBe(true); // dry-run
    expect(apiCalls()).toHaveLength(0);
    const ok = await call('google_sheets_append', { ...a, dryRun: false, overwrite: true });
    expect(ok.ok).toBe(true);
    expect(String(apiCalls()[0][0])).toContain('insertDataOption=OVERWRITE');
    expect(
      await call('google_sheets_append', { ...a, dryRun: false, overwrite: 'true' }),
    ).toMatchObject({ blocked: true });
  });
  test('ensure_tab dry-run never contacts the spreadsheet or the token endpoint', async () => {
    const r = await call('google_sheets_ensure_tab', { spreadsheetId: SID, title: 'Anything' });
    expect(r).toMatchObject({ ok: true, dryRun: true, created: false, existenceChecked: false });
    expect(apiCalls()).toHaveLength(0);
    expect(
      (fetchMock.mock.calls as any[][]).some((c) => String(c[0]).includes('oauth2.googleapis.com')),
    ).toBe(false);
  });
  test('maxResponseBytes: NaN, junk, negative and huge values are clamped', () => {
    expect(responseCap(NaN)).toBe(DEFAULT_RESPONSE_BYTES);
    expect(responseCap('x')).toBe(DEFAULT_RESPONSE_BYTES);
    expect(responseCap(undefined)).toBe(DEFAULT_RESPONSE_BYTES);
    expect(responseCap(Infinity)).toBe(DEFAULT_RESPONSE_BYTES);
    expect(responseCap(-5)).toBe(1024);
    expect(responseCap(0)).toBe(1024);
    expect(responseCap(1e12)).toBe(MAX_RESPONSE_BYTES);
    expect(responseCap('4096')).toBe(4096);
  });
  test('a NaN maxResponseBytes does not disable the cap end to end', async () => {
    route(() => new Response('x'.repeat(DEFAULT_RESPONSE_BYTES + 5000), { status: 200 }));
    const r = await call('google_api_call', {
      service: 'sheets',
      method: 'spreadsheets.get',
      params: { spreadsheetId: SID },
      maxResponseBytes: 'NaN',
    });
    expect(r.truncated).toBe(true);
  });
});

describe('google_sheets_ensure_tab', () => {
  test('is a no-op when the tab exists (case-insensitive)', async () => {
    const r = await call('google_sheets_ensure_tab', {
      spreadsheetId: SID,
      title: 'sheet1',
      dryRun: false,
    });
    expect(r).toMatchObject({ ok: true, created: false, exists: true });
    expect(apiCalls().every((c) => (c[1] as any).method === 'GET')).toBe(true);
  });
  test('dry-run does not create; dryRun:false adds the sheet', async () => {
    const dry = await call('google_sheets_ensure_tab', { spreadsheetId: SID, title: 'Delistings' });
    expect(dry).toMatchObject({ ok: true, dryRun: true, created: false });
    expect(apiCalls().filter((c) => (c[1] as any).method === 'POST')).toHaveLength(0);
    const r = await call('google_sheets_ensure_tab', {
      spreadsheetId: SID,
      title: 'Delistings',
      dryRun: false,
    });
    expect(r).toMatchObject({ ok: true, created: true });
    const post = apiCalls().find((c) => (c[1] as any).method === 'POST')!;
    expect(JSON.parse((post[1] as any).body)).toEqual({
      requests: [{ addSheet: { properties: { title: 'Delistings' } } }],
    });
  });
  test('a racing "already exists" 400 is treated as success', async () => {
    route((u, init) =>
      init?.method === 'POST'
        ? json({ error: { message: 'A sheet with the name "New" already exists' } }, 400)
        : json({ sheets: [] }),
    );
    const r = await call('google_sheets_ensure_tab', {
      spreadsheetId: SID,
      title: 'New',
      dryRun: false,
    });
    expect(r).toMatchObject({ ok: true, created: false, exists: true });
  });
  test('rejects illegal titles; readOnly blocks creation but not the existence check', async () => {
    for (const title of ['a/b', '', "'x", 'x'.repeat(101), 'a\nb'])
      expect(
        (await handleGoogleTool('google_sheets_ensure_tab', { spreadsheetId: SID, title })).isError,
      ).toBe(true);
    writePolicy({ readOnly: true });
    const r = await call('google_sheets_ensure_tab', {
      spreadsheetId: SID,
      title: 'Nope',
      dryRun: false,
    });
    expect(r).toMatchObject({ ok: false, blocked: true });
    expect(apiCalls().filter((c) => (c[1] as any).method === 'POST')).toHaveLength(0);
  });
  test('allowedResourceIds blocks the existence check itself', async () => {
    writePolicy({ allowedResourceIds: [OTHER] });
    expect(
      await call('google_sheets_ensure_tab', { spreadsheetId: SID, title: 'X', dryRun: false }),
    ).toMatchObject({
      blocked: true,
    });
    expect(apiCalls()).toHaveLength(0);
  });
});

describe('google docs helpers', () => {
  const doc = {
    title: 'Plan',
    body: {
      content: [
        { sectionBreak: {} },
        {
          paragraph: {
            elements: [{ textRun: { content: 'Hello ' } }, { textRun: { content: 'world\n' } }],
          },
        },
        {
          table: {
            tableRows: [
              {
                tableCells: [
                  { content: [{ paragraph: { elements: [{ textRun: { content: 'a\n' } }] } }] },
                  { content: [{ paragraph: { elements: [{ textRun: { content: 'b\n' } }] } }] },
                ],
              },
            ],
          },
        },
      ],
    },
  };
  test('flattens paragraphs and tables', () => {
    expect(flattenDocContent(doc.body.content)).toBe('Hello world\na\tb\n');
    expect(flattenDocContent(undefined)).toBe('');
  });
  test('google_docs_read returns untrusted plain text', async () => {
    route(() => json(doc));
    const r = await call('google_docs_read', { documentId: DID });
    expect(r).toMatchObject({
      ok: true,
      title: 'Plan',
      text: 'Hello world\na\tb\n',
      untrustedContent: true,
    });
    expect(String(apiCalls()[0][0])).toContain('fields=title%2Cbody.content');
  });
  test('google_docs_read truncates to maxChars and honours the policy', async () => {
    route(() =>
      json({
        title: 't',
        body: {
          content: [{ paragraph: { elements: [{ textRun: { content: 'x'.repeat(5000) } }] } }],
        },
      }),
    );
    const r = await call('google_docs_read', { documentId: DID, maxChars: 1000 });
    expect(r).toMatchObject({ truncated: true, chars: 5000 });
    expect(r.text).toHaveLength(1000);
    writePolicy({ allowedResourceIds: [OTHER] });
    expect(await call('google_docs_read', { documentId: DID })).toMatchObject({ blocked: true });
  });
  test('google_docs_append_text is a dry-run by default and appends at the end of the body', async () => {
    const dry = await call('google_docs_append_text', { documentId: DID, text: 'hi' });
    expect(dry).toMatchObject({ ok: true, dryRun: true });
    expect(apiCalls()).toHaveLength(0);
    const r = await call('google_docs_append_text', { documentId: DID, text: 'hi', dryRun: false });
    expect(r.ok).toBe(true);
    const [u, init] = apiCalls()[0];
    expect(String(u)).toContain(`/v1/documents/${DID}:batchUpdate`);
    expect(JSON.parse(init.body).requests[0].insertText).toEqual({
      text: 'hi',
      endOfSegmentLocation: { segmentId: '' },
    });
  });
  test('append validates text and honours readOnly', async () => {
    for (const text of ['', 'x'.repeat(100_001), 5])
      expect(
        (await handleGoogleTool('google_docs_append_text', { documentId: DID, text })).isError,
      ).toBe(true);
    writePolicy({ readOnly: true });
    expect(
      await call('google_docs_append_text', { documentId: DID, text: 'hi', dryRun: false }),
    ).toMatchObject({
      blocked: true,
    });
  });
});

describe('tool schemas', () => {
  test('all six helpers are declared with required fields', () => {
    expect(sheetsDocsToolSchemas.map((t) => t.name)).toEqual([
      'google_sheets_read',
      'google_sheets_append',
      'google_sheets_update',
      'google_sheets_ensure_tab',
      'google_docs_read',
      'google_docs_append_text',
    ]);
    for (const t of sheetsDocsToolSchemas)
      expect((t.inputSchema as any).required.length).toBeGreaterThan(0);
  });
});
