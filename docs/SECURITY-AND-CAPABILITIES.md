# Security and capabilities

Chrome MCP gives an AI client control of your real, signed-in Chrome. That is powerful and it
carries risk. This page says what the software does, what it protects against, and what it does not.

## Where your data goes

The extension and the bridge run on your machine. The bridge listens on `127.0.0.1` only. Page
content is returned to the MCP client you connected, and that client sends it to whatever model it
uses. Chrome MCP itself does not send page data to UpGPT.ai. The optional Google tools call Google's
APIs directly from your machine.

## Extension permissions

The extension asks for broad Chrome permissions because the tools need them: `nativeMessaging`,
`tabs`, `tabGroups`, `activeTab`, `scripting`, `contextMenus`, `downloads`, `webRequest`,
`webNavigation`, `debugger`, `history`, `bookmarks`, `offscreen`, `storage`, `cookies`,
`declarativeNetRequest`, `alarms`, `sidePanel`, and host access to all URLs. The `debugger`
permission backs CDP features such as screenshots, network capture, interception, file chooser and
printing; Chrome shows a "debugging this browser" banner while it is attached. The authoritative list
is `app/chrome-extension/wxt.config.ts`.

## The local bridge

Three checks apply to requests on the bridge:

1. The `Host` header must be a loopback name.
2. If an `Origin` header is present, it must be an extension origin or an exact loopback origin.
3. The request must carry `Authorization: Bearer <token>`. The token is stored at
   `~/.chrome-mcp-agent/auth-token` (directory mode 0700, file mode 0600), created on first use.
   `CHROME_MCP_AGENT_DIR` overrides the directory.

Three paths are exempt from the token check and rely on checks 1 and 2 only: `/ping`,
`/ask-extension` and `/agent/*`. The extension UI cannot hold the token.

## High-risk tools

Each high-risk capability is a separate switch stored under `highRiskTools` in the extension's
`chrome.storage.local`. There is no settings screen for these switches yet; the storage keys are the switches.

| Capability        | Default | What it controls                                                            |
| ----------------- | ------- | --------------------------------------------------------------------------- |
| `cookies`         | off     | `chrome_cookies`                                                            |
| `storageValues`   | off     | values returned by `chrome_storage` (key and database names stay available) |
| `intercept`       | off     | `chrome_intercept`                                                          |
| `grantPermission` | off     | `chrome_grant_permission`                                                   |
| `clipboard`       | off     | `chrome_clipboard`                                                          |
| `recording`       | off     | `chrome_recording`                                                          |
| `userscript`      | off     | flag exists; the userscript tool itself is not exposed                      |
| `javascript`      | on      | `chrome_javascript` (off only if set to exactly `false`)                    |
| `upload`          | on      | `chrome_upload_file` (off only if set to exactly `false`)                   |

A tool that is switched off returns an error that names the switch.

## What the main tools do with sensitive data

- Cookies: with the switch on, `list` returns metadata only (name, domain, flags, value length; the
  value is marked redacted). `get` returns the value inside the untrusted-content envelope. `set`
  and `delete` need an http(s) URL, and `set` returns redacted metadata.
- Storage: `list` returns key names (or IndexedDB database and object-store names). `get` returns
  the raw string inside the envelope and needs the `storageValues` switch.
- Network request and capture use your browser's cookies and context, so they can reach anything you
  are signed in to.
- `chrome_javascript` runs code in the page and can read anything the page can.

## Site policy

Every tool that acts on a page is checked against a site policy. The default denylist covers
`chrome://` pages, extension pages, the Chrome Web Store, password-manager pages and OS-settings
pages. Settings are in `chrome.storage.local`: `sitePolicyMode`, `sitePolicyDenyOrigins` and
`sitePolicyAllowOrigins`. In allowlist mode an origin must match an allow pattern. The default
denylist always wins over the allowlist. If the settings cannot be read, access is denied.
`chrome_grant_permission` additionally requires the origin to be in `sitePolicyAllowOrigins`.
`chrome_flow_list` and `chrome_flow_export` do not check site policy.

## Prompt-injection defences

- Untrusted envelope: page text is returned between
  `<<UNTRUSTED_PAGE_CONTENT origin=... >>` and `<<END_UNTRUSTED_PAGE_CONTENT>>` so the model can tell
  page content from instructions.
- Hidden text is dropped unless a call sets `includeHidden: true`.
- Cross-origin confirmation: an action that would move to a different origin than the last page
  content the agent read returns `needs_confirmation` within a 60 second window; the call proceeds
  only with `confirmCrossOrigin: true`.
- Exfiltration guard: a secret of eight or more characters that was returned earlier (for example a
  cookie value) is refused if it later appears in a navigation URL query, unless
  `confirmCrossOrigin` is true.

These raise the cost of an attack. They are heuristics and do not make prompt injection impossible.

## Audit log

Each tool call is appended as one JSON line to `~/.chrome-mcp-agent/audit.log`. Typed field values,
cookie values and URL query strings are redacted. The file rotates to `audit.log.1` at 5,000,000
bytes. `chrome_audit_log` reads the last N entries (default 50, maximum 200).

## Shipped hardening

These items were previously on the roadmap and are now in the code:

- Untrusted-content envelope for page text
- Hidden-text filtering
- Per-site policy (denylist, allowlist mode)
- High-risk tools off by default
- Cross-origin confirmation
- Exfiltration guard
- Local audit log with rotation
- Bearer token, Host and Origin checks on the bridge
- Human handoff (`chrome_request_human`) for CAPTCHA, passkey and hardware prompts

## Known limits

- Extension pages and `chrome://` pages are denied by site policy. The tools cannot act on them.
- The trust model is a single user on one machine. Any local process running as your user can read
  the token file and call the bridge.
- The audit log rotates at 5,000,000 bytes and keeps one previous file; older entries are lost.
- Inputs whose label is a wrapping `<label>` element can appear unnamed in `chrome_snapshot`.
- There is no settings screen for the high-risk switches or site policy yet; they are edited in extension storage.
- The injection defences are heuristic. Do not point an agent at untrusted pages while signed in to
  accounts you cannot afford to lose.

## Recommended safe setup

- Use a separate Chrome profile for agent work, signed in only to what the task needs.
- Leave high-risk switches off and enable one only for the task that needs it.
- Use allowlist mode for site policy when the task is limited to a few sites.
- Review `~/.chrome-mcp-agent/audit.log` after sessions.
- Keep the token file private and replace it by deleting the file and restarting the bridge (not verified that a running bridge picks up a change).

## Credit

Based on [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) (MIT).
