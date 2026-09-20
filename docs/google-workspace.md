# Google Workspace tools and bridge hardening

## Tools

| Tool                       | Purpose                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `google_api_call`          | Calls any method of a Google Discovery API (Sheets, Docs, Drive, Slides, Calendar, Forms). Non-GET calls default to **dry-run**.                |
| `google_api_schema`        | Lists methods of a service, or shows one method's parameters and request schema.                                                                |
| `google_auth_status`       | Shows the active credential source (`authMode`), service-account and OAuth state, the active policy, and cached tokens. Never returns a secret. |
| `google_auth_login`        | Starts an OAuth 2.0 loopback + PKCE login (needs `policy.authMode: "oauth"`). Returns the consent URL; optionally opens the browser and waits.  |
| `google_auth_logout`       | Revokes the stored OAuth refresh token at Google (best effort) and deletes it locally.                                                          |
| `google_sheets_read`       | Reads one range (`range`) or up to 20 (`ranges`). Read-only.                                                                                    |
| `google_sheets_append`     | Appends rows. Dry-run by default.                                                                                                               |
| `google_sheets_update`     | Overwrites a range. Dry-run by default and needs `overwrite: true` to execute.                                                                  |
| `google_sheets_ensure_tab` | Creates a tab if it does not exist (reads first, so it is idempotent). Dry-run by default.                                                      |
| `google_docs_read`         | Reads a document as plain text (`maxChars` caps it). Read-only.                                                                                 |
| `google_docs_append_text`  | Appends plain text to the end of a document (no markup, no formatting). Dry-run by default.                                                     |

Two credential sources exist and **exactly one is active**, chosen by `policy.authMode` (see below).
Service-account auth is a JWT (RS256) signed with `node:crypto`; OAuth uses the loopback flow with
PKCE. Both exchange tokens with global `fetch`. No npm dependency was added (a `google-auth-library`
dependency was considered and dropped).

## Curated Sheets and Docs helpers

The helpers are thin builders over `google_api_call`. They do not have their own HTTP path: every
request goes through the same policy gate, so `readOnly`, `allowedResourceIds`, `allowedServices`, the
invalid-policy lockout, the SSRF guard and the size caps apply identically. Each result carries a
`helper` field. Writes are dry-runs unless the caller passes `dryRun: false`.

Limits: 50,000 cells and 50,000 characters per cell per call, 20 ranges per read, 100,000 characters
per Docs append.

### Formula injection

A cell that starts with `=`, `+`, `-` or `@` is a formula to Sheets when parsed as user input. Values
therefore go in as `RAW` (stored literally) by default. To get parsing:

1. the caller passes `userEntered: true` (numbers and dates get parsed), and
2. if any cell starts with `= + - @`, the caller also passes `allowFormulas: true` **and** the policy
   has `"allowFormulas": true`. An agent cannot grant itself the policy half.

`IMPORT*`, `IMAGE` and `HYPERLINK` calls are refused whatever the flags say, because they can move data
out of the sheet. Only a real boolean `true` counts as a flag (strings like `"true"` do not).

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
  "allowedServices": ["sheets", "drive"],
  "authMode": "service-account",
  "allowFormulas": false,
  "allowAuthTools": true
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
- `authMode` is `"service-account"` (default) or `"oauth"`. It is the only switch between credential
  sources. There is **no automatic fallback**: in `oauth` mode a stored service-account key is never used,
  and in `service-account` mode a stored OAuth login is never used. Any other value makes the policy invalid.
- `allowFormulas` (default `false`) is the policy half of the formula opt-in described above.
- `allowAuthTools` (default `true`) lets the model call `google_auth_login` / `google_auth_logout`; `false` makes both
  refuse (the CLI still works).
- `dryRun` is advisory: it is a request from the caller, not a security boundary. The policy file is the boundary,
  and it is editable by any same-user process, including agent-engine tools.

## OAuth login (alternative to the service account)

Use this when the target sheets belong to your own Google account and sharing them with a service account is
not practical.

1. Create an OAuth client of type **Desktop app** in Google Cloud Console and enable the Sheets/Docs/Drive
   APIs you need. Save its JSON as `~/.chrome-mcp-agent/google-oauth-client.json` (either the downloaded
   `{"installed": {...}}` shape or plain `{"client_id": "...", "client_secret": "..."}`). This file is
   configuration, not a login; keep it 0600 all the same, since Desktop-app client secrets are not truly secret
   but should not be spread around.
2. Set `"authMode": "oauth"` in the policy file.
3. Run `google_auth_login` with `services: ["sheets", "docs"]` (or `chrome-mcp-google login --services sheets,docs --open`).
   Open the URL it returns and approve.
4. `google_auth_status` now shows `authMode: "oauth"`, `oauth.loggedIn: true`, the granted scopes and where the
   refresh token is stored.

How it works: a listener binds `127.0.0.1` on a random port; the redirect URI is
`http://127.0.0.1:<port>/callback`; PKCE uses S256; the `state` value is 32 random bytes compared in constant
time. A callback with a wrong or missing `state` or a wrong `Host` header gets HTTP 400 and the login keeps waiting
for the real one. The code is single use, the login expires after 5 minutes, and starting a new login cancels a
pending one. The requested scopes come from the requested services and are `.readonly` when `policy.readOnly`
is set; `allowedServices` restricts which services may be requested.

Token storage: the **refresh token** lives in the macOS Keychain (service `chrome-mcp-google`, account
`oauth-refresh`) with a 0600 file fallback at `~/.chrome-mcp-agent/google-oauth.json`. **Access tokens are
cached in memory only.** Each API call refreshes with a `scope` parameter narrowed to what that call needs, and a
login that lacks a scope is refused instead of silently widened. A stored login from a different OAuth client is
refused. Tool output, status output and errors never contain the refresh token, access token, code or PKCE verifier.
The `authUrl` returned by `google_auth_login` (and printed by the CLI) does contain `state` and the
`code_challenge`; that is what the user opens in a browser, so treat the URL as low-sensitivity but not public:
anyone who holds it can end that login early with `GET /callback?state=<state>&error=x` on the loopback port (a
denial of service only; without the browser's code and the verifier no token can be obtained). Cached access tokens
are keyed to the current OAuth client id and secret and are dropped on logout or when the client file changes.
`google_auth_status` reports `oauth.clientFileInvalid` when `google-oauth-client.json` is malformed. Google errors are reduced to their `error` and `error_description` fields.

`google_auth_logout` revokes the refresh token at `oauth2.googleapis.com/revoke` and deletes it locally even if the
revoke request fails (the result says which). To remove access completely also remove the app at
myaccount.google.com/permissions.

## CLI: `chrome-mcp-google`

The same tools from a terminal, without the Chrome extension or the bridge. The commands call the same
`handleGoogleTool`, so they read the same policy file and pass through the same guards. `package.json` exposes a
`chrome-mcp-google` bin (`dist/cli/google-cli.js`); before building, run it with
`npx ts-node src/cli/google-cli.ts <command>` from `app/native-server`.

```bash
chrome-mcp-google status
chrome-mcp-google schema sheets spreadsheets.values.get
chrome-mcp-google sheets-read <spreadsheetId> 'Tab!A1:D20'
chrome-mcp-google sheets-append <spreadsheetId> 'Tab!A1' --values '[["a","b"]]'            # dry-run
chrome-mcp-google sheets-append <spreadsheetId> 'Tab!A1' --values-file rows.json --execute
chrome-mcp-google sheets-update <spreadsheetId> 'Tab!A1:B2' --values '[[1,2]]' --overwrite --execute
chrome-mcp-google sheets-ensure-tab <spreadsheetId> 'New Tab' --execute
chrome-mcp-google docs-read <documentId>
chrome-mcp-google docs-append <documentId> --text 'hello' --execute
chrome-mcp-google call drive files.list --params '{"pageSize":5}'
chrome-mcp-google login --services sheets,docs --open
chrome-mcp-google logout
```

Options accept `--flag value` or `--flag=value`. Unknown options, values on switches (`--execute=yes`) and
non-decimal numbers (`--max-bytes 0x10`, `1e3`) are usage errors (exit 2). Writes are dry-runs unless `--execute` is given. Formula flags are explicit (`--user-entered`,
`--allow-formulas`) and still need the policy's `allowFormulas`. Output is the tool JSON on stdout; the login URL
and diagnostics go to stderr. Exit codes: 0 ok, 1 tool error or blocked, 2 usage error.

## Other safeguards

https-only, `*.googleapis.com`-only URLs (including the token URI), `..` path segments rejected, 2 MB request cap,
200 KB default (1 MB max) response cap, 30 s timeout on API, discovery and token calls, results wrapped in an
untrusted-content envelope. Discovery documents are cached for 7 days under `~/.chrome-mcp-agent/discovery/`; a cached
file that fails structural validation is discarded and refetched.

## Known limits (read before granting access)

- **The policy gate is a guard rail, not a sandbox.** Destructive detection matches method names and body keys
  (camelCase and snake_case). Several overwriting requests are not classed as destructive: Sheets `cutPaste`,
  `findReplace`, `values.update`, Docs `replaceAllText`, and `drive.files.watch`. Use `readOnly` or a resource
  allowlist when overwrites matter.
- **Formula channels.** A cell value such as `=IMPORTRANGE(...)` or `=IMAGE(...)` can move data to another
  spreadsheet or a remote URL. On `google_api_call` (Sheets writes) the gate now refuses, unless
  `policy.allowFormulas` is true: `valueInputOption=USER_ENTERED` (query or body) with formula-like cells, any
  `formulaValue` (`updateCells`, `repeatCell`, ... camelCase or snake_case), and formula-like `pasteData` /
  `findReplace` text. Plain `USER_ENTERED` values with no formula-like string are still allowed. Even with
  `allowFormulas` true, cells calling a blocked function are refused. `google_sheets_*` helpers apply the same scan.
- **Helper formula scan is a heuristic.** A string is formula-like when, after stripping whitespace, control,
  format and separator characters (U+200B, U+2060, U+0085, BOM, ...) and leading quotes, it starts with `= + - @`.
  Blocked functions: `IMPORT*`, `IMAGE`, `HYPERLINK`, `AI`, `GOOGLEFINANCE`, `WEBSERVICE`, `CUBE*` and `QUERY` with
  an `http(s):` / `//` URL, matched case-insensitively, tolerating whitespace before `(` and a sheet prefix.
  It does not evaluate formulas. **Residual limit:** a spreadsheet's own Apps Script custom function
  (`=MYFUNC(...)`) or a named function that wraps a blocked one cannot be recognised, and a parsed (`userEntered`)
  numeric-looking or date-looking string is still interpreted by Sheets. Keep `allowFormulas` off, or use
  `readOnly` / `allowedResourceIds`, when this matters.
- **`insertDataOption: OVERWRITE`** on `google_sheets_append` replaces existing cells and needs `overwrite:true`
  to execute (dry-run is unaffected).
- **`google_sheets_ensure_tab` dry-run makes no spreadsheet call**, so it cannot say whether the tab exists
  (`existenceChecked:false`). It may still fetch the public Discovery document.
- **Model-callable auth tools.** `google_auth_login` and `google_auth_logout` are callable by the model with no
  confirmation. Login still needs a human to approve consent in a browser, but a model can start (and thereby
  cancel a pending) login or end the operator's session. Set `policy.allowAuthTools:false` to make both refuse;
  the `chrome-mcp-google login|logout` CLI is unaffected.
- **OAuth is broader than a service account.** The login acts as you, so it can reach everything your account can
  reach within the granted scopes, not only what was shared with a bot. Narrow it with `allowedResourceIds`,
  `allowedServices` and `readOnly`. Those are enforced by this code, not by Google.
- **OAuth consent screens in Testing mode** issue refresh tokens that expire after 7 days; publish the app (or
  use an Internal Workspace app) if you need longer-lived logins.
- **`dryRun` is advisory.** It builds and policy-checks the request but is not a server-side simulation.
- **Responses are buffered in memory** before the size cap truncates them, so a very large response still costs
  memory up to the fetch's own limits.
- Bodies nested deeper than 12 levels are refused (destructive check) and fail any scoped allowlist.
- The service-account key in the Keychain and the policy file are readable and editable by any process running as
  the same user.

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
