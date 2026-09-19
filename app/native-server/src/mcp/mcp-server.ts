import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { setupTools } from './register-tools';

/**
 * Build a fresh MCP `Server` with all tools registered.
 *
 * IMPORTANT: a single SDK `Server` can be `.connect()`ed to exactly ONE transport
 * — a second `connect()` throws "Already connected to a transport". So every HTTP
 * session (each `/mcp` or `/sse` connection) MUST get its OWN `Server` instance,
 * or only the first client can ever connect and a stale/uncleanly-closed session
 * poisons the slot for everyone until the host restarts. Callers create one of
 * these per transport and close it when the transport closes.
 */
export const createMcpServer = (): Server => {
  const server = new Server(
    {
      name: 'ChromeMcpServer',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  setupTools(server);
  return server;
};

export let mcpServer: Server | null = null;

/**
 * Singleton accessor — retained for back-compat. Do NOT use this to back multiple
 * concurrent transports (see createMcpServer). Prefer createMcpServer() per session.
 */
export const getMcpServer = () => {
  if (mcpServer) {
    return mcpServer;
  }
  mcpServer = createMcpServer();
  return mcpServer;
};
