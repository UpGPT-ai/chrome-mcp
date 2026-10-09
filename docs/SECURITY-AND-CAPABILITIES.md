# Chrome MCP from UpGPT — What It Can Do, and Why

Chrome MCP gives an AI agent hands inside **your real, logged-in Chrome**. That is the whole point,
and it is also the whole risk. This page lists every capability a security-minded developer would
flag, why it exists, what it enables, and what limits it. Nothing here is hidden; if you find
something that is not on this page, please open an issue.

Read this before installing. If you are not comfortable with an AI agent acting as you in your
browser, do not install it, or use a separate Chrome profile (recommended, see the end).

## Where your data goes

- Everything runs on your machine: the extension, the local bridge (`127.0.0.1`), and the MCP
  client you connect.
- The project has **no telemetry, analytics or crash reporting**, and no UpGPT server in the loop.
- Page content, screenshots, cookies and so on go **to whichever AI client you connect** (Claude,
  Codex, Cursor...). That client's own privacy terms apply. This is the largest data-flow decision
  you make, and it is yours.
- The only built-in outbound calls are the optional Google tools (`accounts.google.com`,
  `oauth2.googleapis.com`, `*.googleapis.com`), used only if you sign in to them.

## Extension permissions

| Permission                                                    | Why it is there                                                                                | What it enables                                                                      |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `<all_urls>` (host access)                                    | The agent must work on any site you point it at                                                | Read and act on every page, including logged-in ones                                 |
| `debugger`                                                    | Chrome DevTools Protocol: real clicks/hover/drag, JS evaluation, network capture, interception | Full control of a tab; Chrome shows a "debugging this browser" banner while attached |
| `scripting`                                                   | Inject helpers and run code in pages                                                           | Read the DOM, fill forms, run scripts in a page                                      |
| `webRequest`, `declarativeNetRequest`                         | Observe and capture network traffic for debugging and diffing actions                          | See request URLs, headers and statuses of tabs you target                            |
| `tabs`, `tabGroups`, `webNavigation`, `activeTab`             | Tab and window management                                                                      | List, move, close, group and navigate tabs                                           |
| `history`, `bookmarks`                                        | History and bookmark search/add/delete tools                                                   | Read and modify browsing history and bookmarks                                       |
| `downloads`                                                   | Handle and track downloads                                                                     | Start, list and manage downloads                                                     |
| `nativeMessaging`                                             | Talk to the local bridge                                                                       | The extension to bridge channel                                                      |
| `storage`, `alarms`, `offscreen`, `contextMenus`, `sidePanel` | Internal state, keepalive, UI                                                                  | Housekeeping                                                                         |
| `cookies` _(added with the storage/cookies tools)_            | `chrome_cookies`                                                                               | Read, set and delete cookies, **including session cookies**                          |

## Capabilities a developer should know about

### 1. Arbitrary JavaScript execution (`chrome_javascript`, `chrome_inject_script`, `chrome_userscript`)

- **Why:** many real tasks (extract data, work around a broken UI, test an app) need code run in the
  page. Without it the agent is limited to what we pre-built.
- **What it enables:** anything a script on that page could do: read the DOM, read page-visible
  storage, call that site's APIs **with your session**, and change what you see.
- **Limits:** runs only in tabs the agent targets; it is not a shell on your computer. `userscript`
  can inject into the page's own (MAIN) world; the default is the isolated world.

### 2. Reading cookies, storage and sessions (`chrome_cookies`, `chrome_storage`)

- **Why:** debugging auth, testing logged-in/out states, moving a session between tools.
- **What it enables:** access to session cookies and tokens, which is **account takeover material**.
  An agent that can read them can act as you without the page.
- **Mitigation:** the agent only sees what you let it call. Treat any connected AI client as
  trusted with those secrets.

### 3. Network capture and interception (`chrome_network_capture*`, `chrome_network_debugger*`, `chrome_network_request`, `chrome_intercept`)

- **Why:** seeing what an action actually did, and testing failure cases (block or mock a request).
- **What it enables:** viewing request/response data for targeted tabs, blocking or rewriting
  requests, and sending HTTP requests **from your browser context** (with your cookies).

### 4. Acting as you (`chrome_computer`, `chrome_click_element`, `chrome_fill_or_select`, `chrome_fill_form`, `chrome_keyboard`, `chrome_upload_file`, `chrome_handle_dialog`)

- **Why:** this is the product: clicking, typing, uploading and confirming dialogs.
- **What it enables:** anything you could do with the mouse and keyboard in a logged-in tab: send
  email, submit forms, move money, delete data. **A prompt-injected page can try to steer the
  agent into doing these.**

### 5. Seeing everything in the browser (`get_windows_and_tabs`, `chrome_read_page`, `chrome_snapshot`, `chrome_get_web_content`, `chrome_screenshot`, `chrome_gif_recorder`, `chrome_console`, `chrome_history`, bookmarks)

- **Why:** the agent has to see the page, and often needs to find a tab.
- **What it enables:** it can read every open tab's URL, title and content, your history, and take
  screenshots. That includes tabs unrelated to the task.

### 6. Local panel server (`chrome_panel_*`)

- **Why:** lets the agent show you a small app-style window (rank images, collect input) without
  building a website.
- **What it is:** a short-lived HTTP server bound to `127.0.0.1` on a random port with an
  unguessable path, which checks the `Origin` header.

### 7. Google API tools (`google_*`)

- **Why:** read/append Docs and Sheets directly.
- **What it is:** standard Google OAuth through a loopback listener (`127.0.0.1`, random port,
  short-lived). Requests go only to an allow-list of Google hosts. Sign out with
  `google_auth_logout`.

### 8. Agent engines in the native server (`app/native-server/src/agent/`)

- **What it is:** the bridge can launch local AI CLIs (for example `codex`) as child processes for
  its built-in chat UI. This **spawns processes on your machine** and is separate from the MCP tools.
- **Mitigation:** only used if you use that UI; it does not run for MCP-only use.

### 9. Record-and-replay automation (RPA) (`flow.<name>` tools, the flow builder, the side panel)

- **Why:** repeat a task without an agent in the loop: record it once, edit it in the visual
  builder, and run it on demand or on a trigger.
- **What it enables:** saved flows can click, fill, navigate, extract data, run `script` steps
  (arbitrary JavaScript), and make `http` requests from your browser context **with your cookies**.
  Triggers (cron, interval, one-off, URL match, keyboard shortcut, context menu, element appearance)
  can start a flow **without you or an AI client present**. Flows you publish appear to the connected
  AI client as `flow.<name>` tools.
- **Limits:** flows are stored locally in the extension (IndexedDB) and run only while Chrome is
  open and the extension is enabled. Only flows you explicitly publish are exposed over MCP. Review a
  flow's steps before enabling a trigger, and delete flows you no longer use. The planned site policy
  and audit log (see the hardening roadmap) are intended to cover flow runs as well.

## The local bridge (security model)

The bridge listens on **`127.0.0.1:13366`** by default (loopback only, not reachable from the network).
`CHROME_MCP_PORT` overrides that port (`MCP_HTTP_PORT` is the older name, used only when
`CHROME_MCP_PORT` is unset). If the port is busy, the bridge stops and names the process that holds
it. Client configs that still point at the previous default, port 12306, must be edited by hand.

Three layers:

1. The `Host` header must be a loopback name, which defeats DNS rebinding from web pages.
2. If an `Origin` header is present, it must be an exact extension or loopback origin.
3. The MCP endpoints require a **bearer token** stored in a `0600` file at
   `~/.chrome-mcp-agent/auth-token`. This blocks other local processes that lack the token.

**Known residual risk (stated in the code):** `/ping`, `/ask-extension` and `/agent/*` are exempt
from the token because the extension UI cannot hold one. They are protected only by the Host and
Origin checks. **Any process running as your OS user can read the token file**, so this is not a
defense against malware that is already running as you.

## Honest limits of this tool

- **Prompt injection is real.** A web page can contain text that tries to instruct your agent.
  Content the agent reads is untrusted; if the agent also has click/cookie/JS powers, that is the
  dangerous combination. No tool setting removes this; your client's confirmations and your
  vigilance do.
- **It runs with your logins.** There is no sandbox between the agent and your sessions.
- **It is a developer tool, not a hardened enterprise product.** There is no audit log yet, and
  there are no per-site permissions.

## Recommended safe setup

1. **Use a dedicated Chrome profile** for agent work, signed in only to accounts you are willing to
   let an agent act in. This is the single best mitigation.
2. Keep your AI client's tool-approval prompts on for click, JS, cookies and upload tools.
3. Disconnect the extension (popup) when you are not using it. The bridge only works while
   connected.
4. Review the code. It is MIT licensed, and all of the above lives in `app/chrome-extension/` and
   `app/native-server/`.

## Credit

Built on the open-source [mcp-chrome](https://github.com/hangwin/mcp-chrome) by hangye (MIT).

## Hardening roadmap (not yet shipped; will be marked shipped per release)

Planned defenses against prompt injection from web pages, tracked as work item 8 in
`docs/CONTRACT-dom-agent-tools.md`: an untrusted-content envelope around page-derived output,
filtering of hidden text, per-site allow/deny policy, high-risk tools (cookies, storage values,
interception) off by default, a cross-origin action confirmation, an exfiltration guard, and a local
audit log. These reduce risk; they do not remove it.
