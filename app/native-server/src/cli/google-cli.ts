#!/usr/bin/env node
/**
 * chrome-mcp-google: run the Google Workspace tools from a terminal, without the Chrome extension
 * or the bridge. Every command calls the same handleGoogleTool the MCP server uses, so it reads the
 * same policy file (~/.chrome-mcp-agent/google-policy.json) and passes through the same guards:
 * service/resource allowlists, readOnly, destructive gate, SSRF guard, size caps, dry-run default.
 *
 * Output is the tool's JSON on stdout (untrusted Google content included; treat it as data).
 * Diagnostics and the login URL go to stderr. Exit status: 0 ok, 1 tool error or blocked, 2 usage.
 */
import fs from 'node:fs';
import { handleGoogleTool } from '../google';
import { loginStatus, startLogin, waitForLogin } from '../google/oauth';

export const USAGE = `usage: chrome-mcp-google <command> [options]

  status                                       credential source, login state, active policy
  schema <service> [method] [--query TEXT]     look up a Discovery method
  call <service> <method> [--version V] [--params JSON] [--body JSON] [--max-bytes N] [--execute]
  sheets-read <spreadsheetId> <range>... [--dimension ROWS|COLUMNS] [--render FORMATTED_VALUE|UNFORMATTED_VALUE|FORMULA]
  sheets-append <spreadsheetId> <range> (--values JSON | --values-file FILE) [--user-entered] [--allow-formulas] [--execute]
  sheets-update <spreadsheetId> <range> (--values JSON | --values-file FILE) [--overwrite] [--user-entered] [--allow-formulas] [--execute]
  sheets-ensure-tab <spreadsheetId> <title> [--execute]
  docs-read <documentId> [--max-chars N]
  docs-append <documentId> (--text TEXT | --text-file FILE) [--execute]
  login --services sheets,docs [--open] [--wait SECONDS]   OAuth login (policy.authMode must be "oauth")
  logout                                       revoke and delete the stored OAuth refresh token

Writes are dry-runs unless --execute is given.`;

const BOOLEAN_FLAGS = new Set([
  'execute',
  'overwrite',
  'user-entered',
  'allow-formulas',
  'open',
  'help',
]);

class UsageError extends Error {}

interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (!name) throw new UsageError('unexpected "--"');
      if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else {
        const v = argv[++i];
        if (v === undefined) throw new UsageError(`--${name} needs a value`);
        flags[name] = v;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

const str = (f: Record<string, string | true>, k: string): string | undefined =>
  typeof f[k] === 'string' ? (f[k] as string) : undefined;

function json(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${what} is not valid JSON`);
  }
}

function jsonFlag(f: Record<string, string | true>, inline: string, file: string, what: string) {
  const a = str(f, inline);
  const b = str(f, file);
  if (a !== undefined && b !== undefined)
    throw new UsageError(`use only one of --${inline}, --${file}`);
  if (a !== undefined) return json(a, `--${inline}`);
  if (b !== undefined) return json(fs.readFileSync(b, 'utf8'), `--${file}`);
  throw new UsageError(`--${inline} or --${file} is required`);
}

const need = (p: string[], n: number, usage: string): void => {
  if (p.length < n) throw new UsageError(usage);
};

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
};

async function runTool(name: string, args: Record<string, unknown>, io: Io): Promise<number> {
  const r = await handleGoogleTool(name, args);
  const text = r.content?.[0] && 'text' in r.content[0] ? (r.content[0] as any).text : '';
  io.out(text);
  return r.isError ? 1 : 0;
}

export async function runCli(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    const { positional: p, flags: f } = parseArgs(argv);
    const cmd = p.shift();
    if (!cmd || f.help || cmd === 'help') {
      io.err(USAGE);
      return cmd || f.help ? 0 : 2;
    }
    const dryRun = f.execute === true ? false : true;
    switch (cmd) {
      case 'status':
        return await runTool('google_auth_status', {}, io);
      case 'schema':
        need(p, 1, 'schema <service> [method]');
        return await runTool(
          'google_api_schema',
          { service: p[0], method: p[1], query: str(f, 'query'), version: str(f, 'version') },
          io,
        );
      case 'call': {
        need(p, 2, 'call <service> <method>');
        const params = str(f, 'params');
        const body = str(f, 'body');
        const cap = str(f, 'max-bytes');
        return await runTool(
          'google_api_call',
          {
            service: p[0],
            method: p[1],
            version: str(f, 'version'),
            ...(params !== undefined ? { params: json(params, '--params') } : {}),
            ...(body !== undefined ? { body: json(body, '--body') } : {}),
            ...(cap !== undefined ? { maxResponseBytes: Number(cap) } : {}),
            dryRun: f.execute === true ? false : undefined,
          },
          io,
        );
      }
      case 'sheets-read':
        need(p, 2, 'sheets-read <spreadsheetId> <range>...');
        return await runTool(
          'google_sheets_read',
          {
            spreadsheetId: p[0],
            ...(p.length === 2 ? { range: p[1] } : { ranges: p.slice(1) }),
            majorDimension: str(f, 'dimension'),
            valueRenderOption: str(f, 'render'),
          },
          io,
        );
      case 'sheets-append':
      case 'sheets-update': {
        need(p, 2, `${cmd} <spreadsheetId> <range> --values JSON`);
        return await runTool(
          cmd === 'sheets-append' ? 'google_sheets_append' : 'google_sheets_update',
          {
            spreadsheetId: p[0],
            range: p[1],
            values: jsonFlag(f, 'values', 'values-file', 'values'),
            userEntered: f['user-entered'] === true,
            allowFormulas: f['allow-formulas'] === true,
            ...(cmd === 'sheets-update' ? { overwrite: f.overwrite === true } : {}),
            dryRun,
          },
          io,
        );
      }
      case 'sheets-ensure-tab':
        need(p, 2, 'sheets-ensure-tab <spreadsheetId> <title>');
        return await runTool(
          'google_sheets_ensure_tab',
          { spreadsheetId: p[0], title: p.slice(1).join(' '), dryRun },
          io,
        );
      case 'docs-read': {
        need(p, 1, 'docs-read <documentId>');
        const n = str(f, 'max-chars');
        return await runTool(
          'google_docs_read',
          { documentId: p[0], ...(n !== undefined ? { maxChars: Number(n) } : {}) },
          io,
        );
      }
      case 'docs-append': {
        need(p, 1, 'docs-append <documentId> --text TEXT');
        const text =
          str(f, 'text') ??
          (str(f, 'text-file') ? fs.readFileSync(str(f, 'text-file')!, 'utf8') : undefined);
        if (text === undefined) throw new UsageError('--text or --text-file is required');
        return await runTool('google_docs_append_text', { documentId: p[0], text, dryRun }, io);
      }
      case 'login': {
        const services = (str(f, 'services') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const wait = Number(str(f, 'wait') ?? 300);
        const start = await startLogin({ services, openBrowser: f.open === true });
        io.err(`Open this URL in your browser to sign in (valid until ${start.expiresAt}):`);
        io.err(start.authUrl);
        const status = await waitForLogin(Math.min(Math.max(wait, 0), 300) * 1000);
        io.out(
          JSON.stringify(
            { ok: status.state === 'complete', scopes: start.scopes, login: status },
            null,
            2,
          ),
        );
        return status.state === 'complete' ? 0 : 1;
      }
      case 'logout':
        return await runTool('google_auth_logout', {}, io);
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}

// loginStatus is re-exported for tests that want to assert nothing is left pending.
export { loginStatus };
