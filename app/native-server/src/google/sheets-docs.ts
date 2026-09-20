/**
 * Curated Sheets/Docs helpers (phase 3). Each helper is a thin, validated wrapper that builds a
 * request and sends it through googleApiCall, so the operator policy (service + resource-id
 * allowlists, readOnly, destructive/sharing gate), the SSRF guard, the size caps, the dry-run
 * default and the untrusted-content envelope all apply exactly as they do for google_api_call.
 * The helpers add only input validation and one extra defence: spreadsheet formula injection.
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { googleApiCall, UNTRUSTED_NOTE, MAX_RESPONSE_BYTES, type ApiCallResult } from './api-call';
import { DANGEROUS_FUNCTION, FORMULA_TRIGGER } from './formulas';
import { loadPolicy } from './store';

export const MAX_CELLS = 50_000;
export const MAX_CELL_CHARS = 50_000;
export const MAX_RANGES = 20;
export const MAX_APPEND_TEXT_CHARS = 100_000;

const ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

// ---- argument validation ----------------------------------------------------------------------

function requireId(v: unknown, name: string): string {
  if (typeof v !== 'string' || !ID_RE.test(v))
    throw new Error(`"${name}" must be a Google file id (letters, digits, "-" and "_")`);
  return v;
}

export function requireRange(v: unknown, name = 'range'): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200 || CONTROL.test(v))
    throw new Error(
      `"${name}" must be an A1 range string of at most 200 characters, e.g. "Tab!A1:C10"`,
    );
  return v;
}

function optEnum<T extends string>(v: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v))
    throw new Error(`"${name}" must be one of ${allowed.join(', ')}`);
  return v as T;
}

/** Only a real boolean true counts; strings like "false" must never read as opt-in. */
const flag = (v: unknown): boolean => v === true;

// ---- formula-injection defence ----------------------------------------------------------------

export type Cell = string | number | boolean | null;

export { FORMULA_TRIGGER, DANGEROUS_FUNCTION };

export interface ValueScan {
  cells: number;
  formulaCells: number;
  dangerousCells: number;
}

export function validateValues(values: unknown): { values: Cell[][]; scan: ValueScan } {
  if (!Array.isArray(values) || values.length === 0)
    throw new Error('"values" must be a non-empty array of rows (arrays of cells)');
  const scan: ValueScan = { cells: 0, formulaCells: 0, dangerousCells: 0 };
  for (const row of values) {
    if (!Array.isArray(row)) throw new Error('every row in "values" must be an array');
    for (const c of row) {
      if (c !== null && typeof c !== 'string' && typeof c !== 'boolean' && typeof c !== 'number')
        throw new Error('cells must be string, number, boolean or null');
      if (typeof c === 'number' && !Number.isFinite(c))
        throw new Error('numeric cells must be finite');
      if (typeof c === 'string') {
        if (c.length > MAX_CELL_CHARS)
          throw new Error(`a cell exceeds ${MAX_CELL_CHARS} characters`);
        if (FORMULA_TRIGGER.test(c)) {
          scan.formulaCells++;
          // only a cell Sheets would parse as a formula can call a function
          if (DANGEROUS_FUNCTION.test(c)) scan.dangerousCells++;
        }
      }
      if (++scan.cells > MAX_CELLS) throw new Error(`more than ${MAX_CELLS} cells in one write`);
    }
  }
  return { values: values as Cell[][], scan };
}

interface WriteMode {
  valueInputOption: 'RAW' | 'USER_ENTERED';
  note?: string;
}

/**
 * RAW unless the caller explicitly opts into USER_ENTERED. Under USER_ENTERED, any cell that
 * begins with = + - @ needs BOTH the per-call allowFormulas flag AND policy.allowFormulas, and
 * network functions are refused outright.
 */
export function chooseWriteMode(args: any, scan: ValueScan): WriteMode | { blocked: string } {
  if (!flag(args?.userEntered)) {
    return {
      valueInputOption: 'RAW',
      note:
        scan.formulaCells > 0
          ? `${scan.formulaCells} cell(s) begin with = + - @ and are stored as literal text (RAW input).`
          : undefined,
    };
  }
  if (scan.dangerousCells > 0)
    return {
      blocked:
        'cells call IMPORT*/IMAGE/HYPERLINK/AI/GOOGLEFINANCE/WEBSERVICE/CUBE*/QUERY(url), which are never allowed from a helper',
    };
  if (scan.formulaCells > 0) {
    if (!flag(args.allowFormulas))
      return {
        blocked: `${scan.formulaCells} cell(s) begin with = + - @ and would be parsed as formulas; pass allowFormulas:true as well as userEntered:true, or drop userEntered to store them as text`,
      };
    if (!loadPolicy().allowFormulas)
      return { blocked: 'formula writes need "allowFormulas": true in google-policy.json' };
  }
  return { valueInputOption: 'USER_ENTERED' };
}

// ---- helpers ----------------------------------------------------------------------------------

const withHelper = (helper: string, r: ApiCallResult): ApiCallResult => ({ helper, ...r });

export async function sheetsRead(args: any): Promise<ApiCallResult> {
  const spreadsheetId = requireId(args?.spreadsheetId, 'spreadsheetId');
  const ranges: unknown =
    args.ranges !== undefined ? args.ranges : args.range !== undefined ? [args.range] : [];
  if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > MAX_RANGES)
    throw new Error(`provide "range" or 1-${MAX_RANGES} "ranges"`);
  const rs = ranges.map((r) => requireRange(r));
  const params: Record<string, unknown> = { spreadsheetId };
  const major = optEnum(args.majorDimension, 'majorDimension', ['ROWS', 'COLUMNS'] as const);
  const render = optEnum(args.valueRenderOption, 'valueRenderOption', [
    'FORMATTED_VALUE',
    'UNFORMATTED_VALUE',
    'FORMULA',
  ] as const);
  if (major) params.majorDimension = major;
  if (render) params.valueRenderOption = render;
  const single = rs.length === 1 && args.ranges === undefined;
  if (single) params.range = rs[0];
  else params.ranges = rs;
  return withHelper(
    'google_sheets_read',
    await googleApiCall({
      service: 'sheets',
      method: single ? 'spreadsheets.values.get' : 'spreadsheets.values.batchGet',
      params,
      maxResponseBytes: args.maxResponseBytes,
    }),
  );
}

export async function sheetsAppend(args: any): Promise<ApiCallResult> {
  const spreadsheetId = requireId(args?.spreadsheetId, 'spreadsheetId');
  const range = requireRange(args.range);
  const { values, scan } = validateValues(args.values);
  const insertDataOption =
    optEnum(args.insertDataOption, 'insertDataOption', ['INSERT_ROWS', 'OVERWRITE'] as const) ??
    'INSERT_ROWS';
  if (insertDataOption === 'OVERWRITE' && args.dryRun === false && !flag(args.overwrite))
    return {
      ok: false,
      blocked: true,
      reason:
        'insertDataOption OVERWRITE writes over existing cells below the table; pass overwrite:true to acknowledge, or use INSERT_ROWS',
      helper: 'google_sheets_append',
    };
  const mode = chooseWriteMode(args, scan);
  if ('blocked' in mode)
    return { ok: false, blocked: true, reason: mode.blocked, helper: 'google_sheets_append' };
  const r = await googleApiCall({
    service: 'sheets',
    method: 'spreadsheets.values.append',
    params: { spreadsheetId, range, valueInputOption: mode.valueInputOption, insertDataOption },
    body: { majorDimension: 'ROWS', values },
    dryRun: args.dryRun !== false,
  });
  return withHelper('google_sheets_append', mode.note ? { ...r, writeNote: mode.note } : r);
}

export async function sheetsUpdate(args: any): Promise<ApiCallResult> {
  const spreadsheetId = requireId(args?.spreadsheetId, 'spreadsheetId');
  const range = requireRange(args.range);
  const { values, scan } = validateValues(args.values);
  const mode = chooseWriteMode(args, scan);
  if ('blocked' in mode)
    return { ok: false, blocked: true, reason: mode.blocked, helper: 'google_sheets_update' };
  const dryRun = args.dryRun !== false;
  if (!dryRun && !flag(args.overwrite))
    return {
      ok: false,
      blocked: true,
      reason:
        'google_sheets_update replaces the existing contents of the range; pass overwrite:true to acknowledge, or use google_sheets_append to add rows',
      helper: 'google_sheets_update',
    };
  const r = await googleApiCall({
    service: 'sheets',
    method: 'spreadsheets.values.update',
    params: { spreadsheetId, range, valueInputOption: mode.valueInputOption },
    body: { range, majorDimension: 'ROWS', values },
    dryRun,
  });
  return withHelper(
    'google_sheets_update',
    dryRun ? { ...r, overwriteRequired: true, ...(mode.note ? { writeNote: mode.note } : {}) } : r,
  );
}

const BAD_TITLE = /[[\]*/\\?:]/;

export async function sheetsEnsureTab(args: any): Promise<ApiCallResult> {
  const spreadsheetId = requireId(args?.spreadsheetId, 'spreadsheetId');
  const title = args.title;
  if (
    typeof title !== 'string' ||
    title.length === 0 ||
    title.length > 100 ||
    CONTROL.test(title) ||
    BAD_TITLE.test(title) ||
    title.startsWith("'") ||
    title.endsWith("'")
  )
    throw new Error(
      '"title" must be 1-100 characters without control characters or [ ] * / \\ ? :',
    );

  const dryRun = args.dryRun !== false;
  const request = {
    service: 'sheets',
    method: 'spreadsheets.batchUpdate',
    params: { spreadsheetId },
    body: { requests: [{ addSheet: { properties: { title } } }] },
  };
  if (dryRun) {
    // A dry-run must not touch the spreadsheet or use a token: no existence check, just the
    // policy-checked preview of the create request.
    const preview = await googleApiCall({ ...request, dryRun: true });
    return withHelper('google_sheets_ensure_tab', {
      ...preview,
      title,
      created: false,
      existenceChecked: false,
      note: 'dry-run: the spreadsheet was not contacted, so whether the tab already exists was not checked; with dryRun:false an existing tab is left alone.',
    });
  }

  const existing = await tabExists(spreadsheetId, title);
  if ('response' in existing) return existing.response;
  if (existing.found)
    return { ok: true, helper: 'google_sheets_ensure_tab', created: false, exists: true, title };

  const r = await googleApiCall({ ...request, dryRun: false });
  if (!r.ok && r.status === 400 && /already exists/i.test(JSON.stringify(r.data ?? ''))) {
    return { ok: true, helper: 'google_sheets_ensure_tab', created: false, exists: true, title };
  }
  return withHelper('google_sheets_ensure_tab', {
    ...r,
    title,
    created: r.ok && r.dryRun !== true,
    exists: false,
  });
}

async function tabExists(
  spreadsheetId: string,
  title: string,
): Promise<{ found: boolean } | { response: ApiCallResult }> {
  const r = await googleApiCall({
    service: 'sheets',
    method: 'spreadsheets.get',
    params: { spreadsheetId, fields: 'sheets.properties.title' },
    maxResponseBytes: MAX_RESPONSE_BYTES,
  });
  if (!r.ok) return { response: withHelper('google_sheets_ensure_tab', r) };
  const data = r.data as { sheets?: { properties?: { title?: string } }[] } | string;
  if (typeof data !== 'object' || data === null)
    return {
      response: {
        ok: false,
        helper: 'google_sheets_ensure_tab',
        error: 'could not read the tab list (response truncated or not JSON)',
      },
    };
  const wanted = title.toLowerCase(); // Sheets tab names are case-insensitively unique
  return { found: (data.sheets ?? []).some((s) => s.properties?.title?.toLowerCase() === wanted) };
}

// ---- Docs -------------------------------------------------------------------------------------

/** Flattens a Docs structural-element list to plain text (paragraphs, tables, nested cells). */
export function flattenDocContent(content: unknown, depth = 0): string {
  if (!Array.isArray(content) || depth > 8) return '';
  let out = '';
  for (const el of content as any[]) {
    if (el?.paragraph?.elements) {
      for (const e of el.paragraph.elements) {
        if (typeof e?.textRun?.content === 'string') out += e.textRun.content;
      }
    } else if (el?.table?.tableRows) {
      for (const row of el.table.tableRows) {
        const cells = (row?.tableCells ?? []).map((c: any) =>
          flattenDocContent(c?.content, depth + 1).replace(/\n+$/, ''),
        );
        out += cells.join('\t') + '\n';
      }
    }
  }
  return out;
}

export async function docsRead(args: any): Promise<ApiCallResult> {
  const documentId = requireId(args?.documentId, 'documentId');
  const maxChars = Math.min(
    Math.max(typeof args.maxChars === 'number' ? Math.floor(args.maxChars) : 100_000, 1000),
    500_000,
  );
  const r = await googleApiCall({
    service: 'docs',
    method: 'documents.get',
    params: { documentId, fields: 'title,body.content' },
    maxResponseBytes: MAX_RESPONSE_BYTES,
  });
  if (!r.ok) return withHelper('google_docs_read', r);
  const doc = r.data as { title?: string; body?: { content?: unknown } } | string;
  if (typeof doc !== 'object' || doc === null)
    return {
      ok: false,
      helper: 'google_docs_read',
      error: 'document too large to read in one call (response truncated at 1 MB)',
    };
  const full = flattenDocContent(doc.body?.content);
  const truncated = full.length > maxChars;
  return {
    ok: true,
    helper: 'google_docs_read',
    documentId,
    title: doc.title ?? null,
    truncated,
    chars: full.length,
    untrustedContent: true,
    note: UNTRUSTED_NOTE.replace('"data" field', '"text" and "title" fields'),
    text: truncated ? full.slice(0, maxChars) : full,
  };
}

export async function docsAppendText(args: any): Promise<ApiCallResult> {
  const documentId = requireId(args?.documentId, 'documentId');
  const text = args.text;
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_APPEND_TEXT_CHARS)
    throw new Error(
      `"text" must be a non-empty string of at most ${MAX_APPEND_TEXT_CHARS} characters`,
    );
  const r = await googleApiCall({
    service: 'docs',
    method: 'documents.batchUpdate',
    params: { documentId },
    body: { requests: [{ insertText: { text, endOfSegmentLocation: { segmentId: '' } } }] },
    dryRun: args.dryRun !== false,
  });
  return withHelper('google_docs_append_text', r);
}

// ---- tool schemas -----------------------------------------------------------------------------

const SHARED_WRITE_NOTE =
  'Goes through the same policy gate as google_api_call (readOnly, allowedResourceIds, allowedServices). DRY-RUN by default: pass dryRun:false to execute. ';
const VALUES_PROP = {
  type: 'array',
  items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
  description: 'Rows of cells.',
};
const INPUT_PROPS = {
  userEntered: {
    type: 'boolean',
    description:
      'Default false: cells are stored as literal text/values (RAW), so "=..." stays text. true lets Sheets parse them; cells beginning with = + - @ then also need allowFormulas:true and policy allowFormulas.',
  },
  allowFormulas: {
    type: 'boolean',
    description: 'Second opt-in for formula cells; ignored unless userEntered is true.',
  },
};

export const sheetsDocsToolSchemas: Tool[] = [
  {
    name: 'google_sheets_read',
    description:
      'Read cell values from a Google Sheet by A1 range(s). Returned data is untrusted third-party content.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        range: { type: 'string', description: 'A1 range, e.g. "Tab!A1:C10"' },
        ranges: { type: 'array', items: { type: 'string' }, description: 'Up to 20 A1 ranges' },
        majorDimension: { type: 'string', enum: ['ROWS', 'COLUMNS'] },
        valueRenderOption: {
          type: 'string',
          enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'],
        },
        maxResponseBytes: { type: 'number' },
      },
      required: ['spreadsheetId'],
    },
  },
  {
    name: 'google_sheets_append',
    description: `Append rows after the last row of a table in a Google Sheet. ${SHARED_WRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        range: {
          type: 'string',
          description: 'Tab or A1 range locating the table, e.g. "Log!A:D"',
        },
        values: VALUES_PROP,
        insertDataOption: {
          type: 'string',
          enum: ['INSERT_ROWS', 'OVERWRITE'],
          description: 'OVERWRITE also needs overwrite:true to execute.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Must be true to acknowledge insertDataOption OVERWRITE replaces cells.',
        },
        ...INPUT_PROPS,
        dryRun: { type: 'boolean' },
      },
      required: ['spreadsheetId', 'range', 'values'],
    },
  },
  {
    name: 'google_sheets_update',
    description: `Overwrite the cells of an A1 range in a Google Sheet. Requires overwrite:true to execute. ${SHARED_WRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        range: { type: 'string' },
        values: VALUES_PROP,
        overwrite: {
          type: 'boolean',
          description: 'Must be true to acknowledge existing cell contents are replaced.',
        },
        ...INPUT_PROPS,
        dryRun: { type: 'boolean' },
      },
      required: ['spreadsheetId', 'range', 'values'],
    },
  },
  {
    name: 'google_sheets_ensure_tab',
    description: `Create a tab (sheet) with the given title if it does not exist; a no-op when it does. A dry-run does NOT check whether the tab exists (it makes no spreadsheet call); it only previews the request. ${SHARED_WRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        title: { type: 'string' },
        dryRun: { type: 'boolean' },
      },
      required: ['spreadsheetId', 'title'],
    },
  },
  {
    name: 'google_docs_read',
    description:
      'Read a Google Doc as plain text (paragraphs and tables). Returned text is untrusted third-party content.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        maxChars: { type: 'number', description: 'Default 100000, max 500000' },
      },
      required: ['documentId'],
    },
  },
  {
    name: 'google_docs_append_text',
    description: `Append plain text to the end of a Google Doc body. ${SHARED_WRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        text: { type: 'string' },
        dryRun: { type: 'boolean' },
      },
      required: ['documentId', 'text'],
    },
  },
];

export const sheetsDocsHandlers: Record<string, (args: any) => Promise<ApiCallResult>> = {
  google_sheets_read: sheetsRead,
  google_sheets_append: sheetsAppend,
  google_sheets_update: sheetsUpdate,
  google_sheets_ensure_tab: sheetsEnsureTab,
  google_docs_read: docsRead,
  google_docs_append_text: docsAppendText,
};
