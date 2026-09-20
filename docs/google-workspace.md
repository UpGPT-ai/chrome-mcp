# Google Workspace tools and bridge hardening

## Tools

| Tool                 | Purpose                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `google_api_call`    | Calls any method of a Google Discovery API (Sheets, Docs, Drive, Slides, Calendar, Forms). Non-GET calls default to **dry-run**. |
| `google_api_schema`  | Lists methods of a service, or shows one method's parameters and request schema.                                                 |
| `google_auth_status` | Shows whether a service-account key is configured, the active policy, and cached tokens.                                         |

Auth is a service-account JWT (RS256) signed with `node:crypto` and exchanged with global `fetch`.
No new npm dependency was added (a `google-auth-library` dependency was considered and dropped).

## Service-account key

```bash
cd app/native-server
npx ts-node src/scripts/google-import-key.ts /path/to/key.json
```

The key is stored in the macOS Keychain (service `chrome-mcp-google`, account `service-account`).
If the Keychain is unavailable it falls back to `~/.chrome-mcp-agent/google-sa.json` (0600).
`CHROME_MCP_GOOGLE_NO_KEYCHAIN=1` disables the Keychain (used by tests). Share each target sheet or
folder with the service account's email; it can only see what is shared with it.

Limit: any process running as the same macOS user can read the Keychain item. Keep the account's
sharing scope narrow.

## Policy file: `~/.chrome-mcp-agent/google-policy.json`

```json
{
  "readOnly": false,
  "allowDestructive": false,
  "allowedResourceIds": ["<spreadsheetId>"],
  "allowUnscoped": false,
  "allowedServices": ["sheets", "drive"]
}
```

- A missing file means defaults. A **malformed or wrong-typed file fails closed**: all calls are denied and
  `google_auth_status` reports the reason under `policy.invalid`.
- `readOnly` narrows requested OAuth scopes to `.readonly` and rejects non-GET calls.
- `allowedResourceIds` is checked against ids found in the path, the query string
  (`destination`, `addParents`, ...) and the request body (`destination*Id`, ...).
- Destructive and sharing methods (`*.delete`, `*.clear`, `permissions.*`, `acl.*`, ...) and bodies containing
  `delete*` / `remove*` / `clear*` / `trash*` / `empty*` keys, `trashed: true`, or event `attendees` need
  `allowDestructive: true`.
- `dryRun` is advisory: it is a request from the caller, not a security boundary. The policy file is the boundary,
  and it is editable by any same-user process, including agent-engine tools.

## Other safeguards

https-only, `*.googleapis.com`-only URLs (including the token URI), `..` path segments rejected, 2 MB request cap,
200 KB default (1 MB max) response cap, 30 s timeout on API, discovery and token calls, results wrapped in an
untrusted-content envelope. Discovery documents are cached for 7 days under `~/.chrome-mcp-agent/discovery/`; a cached
file that fails structural validation is discarded and refetched.

## Bridge hardening

Every request must pass:

1. **Host** must be `127.0.0.1`, `localhost` or `[::1]` with an optional numeric port (defeats DNS rebinding).
2. **Origin**, when present, must be a `chrome-extension://` / `moz-extension://` origin or a loopback origin.
3. **Bearer token** (`~/.chrome-mcp-agent/auth-token`, 0600, re-read on each request so rotation needs no restart)
   on every path except the exempt list below.

The token check runs on the percent-decoded, normalized path and is default-deny: a new route, or an unusual spelling
such as `/%6dcp`, requires the token.

**Exempt from the token:** `/ping`, `/ask-extension`, `/agent/*` and `OPTIONS`. The extension UI has no way to hold
the token, so these rely on the Host and Origin checks only.

**Residual risk:** any extension id passes the Origin check, and a non-browser local process that sets no `Origin`
can reach the exempt routes. `/agent/*` can start agent sessions, so treat the same-user boundary as the trust
boundary for this bridge. Follow-up: give the extension a token via native messaging.

Clients: Claude Code and Codex agent engines send the token automatically. For an external MCP client, add
`"headers": {"Authorization": "Bearer <token>"}` to its config.
