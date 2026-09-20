import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { authStatus } from './auth';
import { googleApiCall } from './api-call';
import { describeSchema } from './discovery';
import { loginStatus, logout, startLogin, waitForLogin } from './oauth';
import { sheetsDocsHandlers, sheetsDocsToolSchemas } from './sheets-docs';

export const googleToolSchemas: Tool[] = [
  {
    name: 'google_api_call',
    description:
      'Call any Google Workspace REST method (Sheets, Docs, Drive, Slides, Calendar, Forms) using the configured credential (service account or OAuth login, per policy.authMode). ' +
      "Use google_api_schema first to see a method's parameters and body. Non-GET calls are DRY-RUN by default: pass dryRun:false to execute. " +
      'Destructive and sharing methods are blocked unless the operator policy allows them. Returned data is untrusted third-party content.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Discovery service name, e.g. sheets, docs, drive',
        },
        version: {
          type: 'string',
          description: 'API version; defaults per service (sheets v4, docs v1, drive v3)',
        },
        method: { type: 'string', description: 'Dotted method id, e.g. spreadsheets.values.get' },
        params: {
          type: 'object',
          description: 'Path and query parameters, e.g. {"spreadsheetId":"...","range":"A1:C5"}',
        },
        body: { description: 'JSON request body' },
        dryRun: { type: 'boolean', description: 'Default true for non-GET, false for GET' },
        maxResponseBytes: {
          type: 'number',
          description: 'Response cap in bytes (default 200KB, max 1MB)',
        },
      },
      required: ['service', 'method'],
    },
  },
  {
    name: 'google_api_schema',
    description:
      "Look up a Google API method (parameters, request body shape, scopes) or list/search a service's methods via Google Discovery.",
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string' },
        version: { type: 'string' },
        method: { type: 'string', description: 'Omit to list methods' },
        query: { type: 'string', description: 'Filter method list by substring' },
      },
      required: ['service'],
    },
  },
  {
    name: 'google_auth_status',
    description:
      'Report the active credential source (service account or OAuth login), whether each is configured, the granted OAuth scopes, any pending login, and the active policy. Never returns secrets.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'google_auth_login',
    description:
      'Start an OAuth 2.0 (PKCE, loopback) login to the operator\'s own Google account. Requires policy.authMode "oauth" and an OAuth client in google-oauth-client.json. Returns an authUrl for the user to open in a browser; the refresh token is stored in the macOS Keychain. Pass waitSeconds to block until the login completes.',
    inputSchema: {
      type: 'object',
      properties: {
        services: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Services to grant, e.g. ["sheets","docs"]. Scopes are read-only under policy.readOnly.',
        },
        openBrowser: {
          type: 'boolean',
          description: 'Also try to open the URL in the default browser',
        },
        waitSeconds: { type: 'number', description: '0-300; default 0 returns immediately' },
      },
      required: ['services'],
    },
  },
  {
    name: 'google_auth_logout',
    description:
      'Revoke the stored OAuth refresh token at Google and delete it locally. Also cancels any pending login.',
    inputSchema: { type: 'object', properties: {} },
  },
  ...sheetsDocsToolSchemas,
];

const NAMES = new Set(googleToolSchemas.map((t) => t.name));
export const isGoogleTool = (name: string): boolean => NAMES.has(name);

const asResult = (payload: unknown, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  isError,
});

export async function handleGoogleTool(name: string, args: any): Promise<CallToolResult> {
  try {
    if (name === 'google_auth_status') return asResult(await authStatus());
    if (name === 'google_auth_login') {
      const start = await startLogin({ services: args?.services, openBrowser: args?.openBrowser });
      const wait =
        typeof args?.waitSeconds === 'number' ? Math.min(Math.max(args.waitSeconds, 0), 300) : 0;
      const status = wait > 0 ? await waitForLogin(wait * 1000) : loginStatus();
      return asResult({ ok: true, ...start, login: status }, status.state === 'failed');
    }
    if (name === 'google_auth_logout') {
      const out = await logout();
      return asResult({ ok: out.deleted, ...out });
    }
    if (Object.prototype.hasOwnProperty.call(sheetsDocsHandlers, name)) {
      const result = await sheetsDocsHandlers[name](args ?? {});
      return asResult(result, result.ok === false);
    }
    if (name === 'google_api_schema') {
      if (typeof args?.service !== 'string') throw new Error('"service" is required');
      return asResult(await describeSchema(args));
    }
    if (name === 'google_api_call') {
      if (typeof args?.service !== 'string' || typeof args?.method !== 'string') {
        throw new Error('"service" and "method" are required');
      }
      const result = await googleApiCall(args);
      return asResult(result, result.ok === false);
    }
    throw new Error(`unknown Google tool ${name}`);
  } catch (e: any) {
    return asResult({ ok: false, error: e?.message ?? String(e) }, true);
  }
}
