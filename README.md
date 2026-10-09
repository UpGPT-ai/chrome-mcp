# Chrome MCP from UpGPT.ai

Open source, MIT License.

Chrome MCP lets an MCP client (Claude Code, Claude Desktop, Cursor and others) drive the Chrome you
already use: your tabs, your logins, your extensions. It is a Chrome extension plus a small local
bridge that speaks the Model Context Protocol over HTTP on your own machine.

Home page: https://upgpt.ai/chrome-mcp

## Why use it

- It works in your real browser profile, so the agent sees pages the way you do, signed in.
- Nothing leaves your machine except what the AI client you choose sends to its own model.
- The agent can read and act on pages, and the risky capabilities are off until you turn them on.
- Page text reaches the model wrapped as untrusted content, which makes prompt injection from web
  pages harder to pull off (it does not make it impossible).

## Quick start (about 60 seconds)

1. Download the release zip, unzip it somewhere permanent (not Downloads, not a cloud-synced folder).
2. Run the installer from the unzipped `chrome-mcp-package` folder:
   - macOS / Linux: `bash install.sh`
   - Windows: double-click `install.cmd`
3. In Chrome open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and select the
   `chrome-extension` folder. The extension ID should be `gnkfbbmfkabopdomoedaamfpgnakoici`.
4. Pin the extension and click Connect in its popup.
5. Point your MCP client at `http://127.0.0.1:13366/mcp` with the header
   `Authorization: Bearer <contents of ~/.chrome-mcp-agent/auth-token>`.

Claude Code:

```bash
claude mcp add --transport http chrome-mcp http://127.0.0.1:13366/mcp \
  --header "Authorization: Bearer $(cat ~/.chrome-mcp-agent/auth-token)"
```

Full steps, Windows paths and other clients are in
[docs/INSTALL.md](https://github.com/UpGPT-ai/chrome-mcp/blob/main/docs/INSTALL.md). If something
fails, see
[docs/TROUBLESHOOTING.md](https://github.com/UpGPT-ai/chrome-mcp/blob/main/docs/TROUBLESHOOTING.md).

## What it can do

The server exposes tools for tabs and windows, reading pages (`chrome_read_page`, `chrome_snapshot`,
`chrome_get_web_content`), clicking and typing, forms, screenshots, network capture and requests,
console, history, bookmarks, downloads, tab groups, file upload, print to PDF, and recorded flows
that can be replayed. Some tools are high-risk and are off by default: cookies, storage values,
request interception, permission grants, clipboard, and recording.

The complete list, with a one-line purpose for each tool, is in
[docs/TOOLS.md](https://github.com/UpGPT-ai/chrome-mcp/blob/main/docs/TOOLS.md).

## Security posture

- The bridge listens on loopback (`127.0.0.1`) only. Requests must carry a loopback `Host` header,
  and a browser `Origin` is accepted only from an extension or a loopback origin.
- Every MCP request needs a bearer token. It is generated on first use and stored at
  `~/.chrome-mcp-agent/auth-token` with owner-only permissions.
- High-risk tools are off by default and each is a separate switch.
- A site policy denies Chrome internal pages, extension pages, the Chrome Web Store, and password
  manager and OS settings pages by default. You can switch to allowlist mode.
- Every tool call is written to a local audit log at `~/.chrome-mcp-agent/audit.log`. Typed values,
  cookie values and URL query strings are redacted.

This is a single-user, local trust model. Read
[docs/SECURITY-AND-CAPABILITIES.md](https://github.com/UpGPT-ai/chrome-mcp/blob/main/docs/SECURITY-AND-CAPABILITIES.md)
for the details and the known limits before using it on sensitive accounts.

## What's different from upstream

This project started from [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) (MIT) and has
diverged. Main differences:

- Authentication: a bearer token is required, plus Host and Origin checks. Upstream had none.
- Default port is 13366 (upstream used 12306). `CHROME_MCP_PORT` overrides it, and a busy port
  stops the bridge with a message naming the process instead of silently picking another.
- Page content is wrapped as untrusted, hidden text is dropped by default, and cross-origin
  navigation and exfiltration of values read earlier are gated.
- High-risk tools default to off; a per-site policy and an audit log were added.
- New tools: `chrome_snapshot`, `chrome_wait_for`, `chrome_fill_form`, cookies, storage, intercept,
  file chooser, print to PDF, permission grants, clipboard, human handoff, audit log reload, and
  recorded flows. The injection and userscript tools are not exposed.
- Optional Google Workspace tools and app-style panel windows.
- A packaged release with a fixed extension ID, installer scripts and an ID check.

## Documentation

- [Install](https://github.com/UpGPT-ai/chrome-mcp/blob/main/docs/INSTALL.md)
- [Tools](https://github.com/UpGPT-ai/chrome-mcp/blob/main/docs/TOOLS.md)
- [Security and capabilities](https://github.com/UpGPT-ai/chrome-mcp/blob/main/docs/SECURITY-AND-CAPABILITIES.md)
- [Troubleshooting](https://github.com/UpGPT-ai/chrome-mcp/blob/main/docs/TROUBLESHOOTING.md)
- [Architecture](https://github.com/UpGPT-ai/chrome-mcp/blob/main/docs/ARCHITECTURE.md)
- [Contributing](https://github.com/UpGPT-ai/chrome-mcp/blob/main/docs/CONTRIBUTING.md)

## License and attribution

MIT License. Copyright (c) 2024 hangye and (c) 2025-2026 UpGPT.ai. See `LICENSE`. Original work by
hangye at https://github.com/hangwin/mcp-chrome, used under the MIT License.
