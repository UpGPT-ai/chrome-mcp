import { DEFAULT_SERVER_PORT } from 'chrome-mcp-shared';

export enum NATIVE_MESSAGE_TYPE {
  START = 'start',
  STARTED = 'started',
  STOP = 'stop',
  STOPPED = 'stopped',
  PING = 'ping',
  PONG = 'pong',
  ERROR = 'error',
}

export const NATIVE_SERVER_PORT = DEFAULT_SERVER_PORT;

// Timeout constants (in milliseconds)
export const TIMEOUTS = {
  DEFAULT_REQUEST_TIMEOUT: 15000,
  EXTENSION_REQUEST_TIMEOUT: 20000,
  PROCESS_DATA_TIMEOUT: 20000,
} as const;

// Server configuration
export const SERVER_CONFIG = {
  HOST: '127.0.0.1',
  /**
   * CORS origin whitelist - only allow Chrome/Firefox extensions and local debugging.
   * Use RegExp patterns for extension origins, string for exact match.
   */
  CORS_ORIGIN: [/^chrome-extension:\/\//, /^moz-extension:\/\//, 'http://127.0.0.1'] as const,
  LOGGER_ENABLED: false,
} as const;

// HTTP Status codes
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500,
  GATEWAY_TIMEOUT: 504,
} as const;

// Error messages
export const ERROR_MESSAGES = {
  NATIVE_HOST_NOT_AVAILABLE: 'Native host connection not established.',
  SERVER_NOT_RUNNING: 'Server is not actively running.',
  REQUEST_TIMEOUT: 'Request to extension timed out.',
  INVALID_MCP_REQUEST: 'Invalid MCP request or session.',
  INVALID_SESSION_ID: 'Invalid or missing MCP session ID.',
  INTERNAL_SERVER_ERROR: 'Internal Server Error',
  MCP_SESSION_DELETION_ERROR: 'Internal server error during MCP session deletion.',
  MCP_REQUEST_PROCESSING_ERROR: 'Internal server error during MCP request processing.',
  INVALID_SSE_SESSION: 'Invalid or missing MCP session ID for SSE.',
  /**
   * Returned (as HTTP 404) when a request carries an `mcp-session-id` this
   * process does not know. The bridge is respawned by Chrome on every native-port
   * reconnect and keeps sessions only in memory, so this is routine after a
   * restart. Per the MCP Streamable HTTP spec a 404 tells a long-lived client
   * (e.g. Claude Code) to drop its session and re-initialize; anything else is
   * treated as a hard error and every subsequent call fails identically.
   */
  SESSION_NOT_FOUND: 'Session not found',
} as const;

/** JSON-RPC error code the MCP SDK uses for an unknown session. */
export const JSONRPC_SESSION_NOT_FOUND_CODE = -32001;

// ============================================================
// Chrome MCP Server Configuration
// ============================================================

/**
 * Environment variables for dynamically resolving the local MCP HTTP endpoint.
 * CHROME_MCP_PORT is the preferred source; MCP_HTTP_PORT is kept for backward compatibility.
 */
export const CHROME_MCP_PORT_ENV = 'CHROME_MCP_PORT';
export const MCP_HTTP_PORT_ENV = 'MCP_HTTP_PORT';

/**
 * Read the port override. CHROME_MCP_PORT wins over MCP_HTTP_PORT.
 * An empty value means "use the built-in default". A set but invalid value is an error.
 */
export function parseChromeMcpPortEnv(env: NodeJS.ProcessEnv = process.env): {
  port: number | null;
  error?: string;
} {
  const chrome = env[CHROME_MCP_PORT_ENV];
  const fallback = env[MCP_HTTP_PORT_ENV];
  const usingChrome = chrome !== undefined && String(chrome).trim() !== '';
  const raw = usingChrome ? chrome : fallback;
  const source = usingChrome ? CHROME_MCP_PORT_ENV : MCP_HTTP_PORT_ENV;
  if (raw === undefined || String(raw).trim() === '') return { port: null };
  const text = String(raw).trim();
  if (!/^[0-9]+$/.test(text)) {
    return { port: null, error: `${source} must be an integer from 1 to 65535 (got ${text})` };
  }
  const port = Number(text);
  if (port < 1 || port > 65535) {
    return { port: null, error: `${source} must be an integer from 1 to 65535 (got ${text})` };
  }
  return { port };
}

/**
 * Get the actual port the Chrome MCP server is listening on.
 * Priority: CHROME_MCP_PORT env > MCP_HTTP_PORT env > NATIVE_SERVER_PORT default.
 * Invalid overrides fall back here; the bridge rejects them before it listens.
 */
export function getChromeMcpPort(): number {
  const parsed = parseChromeMcpPortEnv();
  return parsed.port ?? NATIVE_SERVER_PORT;
}

/**
 * Get the full URL to the local Chrome MCP HTTP endpoint.
 * This URL is used by Claude/Codex agents to connect to the MCP server.
 */
export function getChromeMcpUrl(): string {
  return `http://${SERVER_CONFIG.HOST}:${getChromeMcpPort()}/mcp`;
}
