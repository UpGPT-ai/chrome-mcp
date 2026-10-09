# Troubleshooting

First check: from the package folder run `node native-server/dist/cli.js doctor`. Every line should
be `[OK]` once the extension is connected.

## "Already connected" or "port in use"

The bridge listens on 127.0.0.1:13366 and does not move to another port. If that port is taken, it
stops and prints the name of the process holding it. Either quit that process, or set
`CHROME_MCP_PORT` to a free port and update your client URL. An old client config that still points
at port 12306 must be edited by hand.

Two Chrome profiles, or two copies of the extension, both trying to start a host will also collide.
Keep one connected extension.

## Dynamic Client Registration rejected, HTTP 401

An error such as `Dynamic Client Registration rejected (HTTP 401): Unauthorized: missing or invalid
bearer token` means the client sent no bearer token, or the wrong one. Add the header
`Authorization: Bearer <contents of ~/.chrome-mcp-agent/auth-token>` to the client's HTTP server
config. On Windows the file is `%USERPROFILE%\.chrome-mcp-agent\auth-token`. If the file did not
exist, start the bridge (click Connect) so it creates one, then copy it.

## Native host not found

Chrome says "Specified native messaging host not found" or the popup shows "Connected, Service Not
Started".

- Re-run the installer from the package folder so the manifest is written again.
- Windows: the registration must be done outside the Claude desktop app's sandbox. Use
  `install.cmd`, or a normal PowerShell or Windows Terminal.
- macOS: make sure you use Google Chrome or Chromium, not another browser.
- If Node comes from nvm, volta or fnm, set `CHROME_MCP_NODE_PATH` to the absolute path of `node`.
- If the wrapper script is not executable, run `node native-server/dist/cli.js fix-permissions`.

## Extension ID mismatch

"Access to the specified native messaging host is forbidden" means the extension ID Chrome shows is
not the one the manifest allows. The ID must be `gnkfbbmfkabopdomoedaamfpgnakoici`. Load the
`chrome-extension` folder from this package (not a build from another source) and re-run the
installer. If a global `mcp-chrome-bridge` was installed, uninstall it first; it overwrites the
registration with a different ID.

## A tool was refused

- High-risk tool off. The error says which tool is off. Cookies, storage values, intercept, permission
  grants, clipboard and recording are off until you turn them on in the extension popup under Tools
  (they are stored under `highRiskTools` in `chrome.storage.local`).
- Site policy denied. The target origin matched the denylist (Chrome internal pages, extension
  pages, the Chrome Web Store, password managers, OS settings) or, in allowlist mode, was not on the
  allowlist. The relevant keys are `sitePolicyMode`, `sitePolicyDenyOrigins` and
  `sitePolicyAllowOrigins`. The default denylist always wins.
- `needs_confirmation`. A cross-origin navigation or a value read earlier would be sent to another
  site. Repeat the call with `confirmCrossOrigin: true` only if that is what you intend.

## Audit log

Every tool call is appended as one JSON line to `~/.chrome-mcp-agent/audit.log` (Windows:
`%USERPROFILE%\.chrome-mcp-agent\audit.log`). At about 5,000,000 bytes it is rotated to
`audit.log.1`. The `chrome_audit_log` tool returns the last entries (50 by default, 200 at most).

## Other log locations

- macOS: `~/Library/Logs/mcp-chrome-bridge/`
- Windows: `%LOCALAPPDATA%\mcp-chrome-bridge\logs\`
- Linux: `~/.local/state/mcp-chrome-bridge/logs/`

## Tools still work after closing Chrome

Chrome may still be running in the background (installed web apps, "continue running background
apps"). Quit it from the system tray or menu bar and check with `pgrep -l -i chrome` (macOS) or
`Get-Process chrome` (Windows).
