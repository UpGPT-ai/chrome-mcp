/** Loopback port for this build. Below the OS ephemeral range, not a well-known service. */
export const DEFAULT_SERVER_PORT = 13366;
/**
 * Upstream mcp-chrome port. A second install still binds it, so the popup probes it
 * and tells the user to point their MCP client at DEFAULT_SERVER_PORT by hand.
 */
export const LEGACY_SERVER_PORT = 12306;
export const HOST_NAME = 'com.chromemcp.nativehost';
