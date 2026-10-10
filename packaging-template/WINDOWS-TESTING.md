# Windows testing guide

Thanks for testing. This takes about 10 minutes. You need Windows 10/11, Google Chrome and
Node.js 20 or newer (`node -v` in a terminal; if it is missing or older, install the LTS from
https://nodejs.org and open a NEW terminal). No `npm install`, no compiler, no internet needed.

## 1. Unzip somewhere permanent

Right-click the zip, Extract All, to a plain folder such as `C:\Tools\chrome-mcp`. Avoid Downloads,
Desktop, OneDrive and other synced folders: Chrome loads the extension from this folder, so it has
to stay put. If the zip extracts into a doubled folder, use the inner `chrome-mcp-package` folder
(the one containing `install.cmd`).

## 2. Load the extension

1. Chrome -> `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** -> pick the `chrome-extension` folder inside the package.
4. The card should show the ID `gnkfbbmfkabopdomoedaamfpgnakoici`. Pin it with the puzzle-piece icon.

## 3. Run the installer

Double-click **`install.cmd`**. It must be started by you in File Explorer, not from inside the
Claude desktop app. It should end with `Native host installed and registered.` Any failure prints
`INSTALL FAILED: <reason>`; send me that line.

## 4. Print the connection config

Open a terminal in the package folder and run:

    node show-config.js

Copy the command or JSON it prints into your AI client (Claude Code, Claude Desktop, Cursor, etc.).

## 5. Connect

Click the pinned extension icon -> **Connect**. It should read Connected. Check with:

    node native-server\dist\cli.js doctor

A Connectivity WARN is normal before you click Connect; there should be no `[ERROR]`.

## 6. What to try

- "List my open tabs."
- "Open https://example.com and tell me what is on the page."
- "Take a snapshot of this page, then click the first link."
- Fill in and submit a harmless form (a search box is fine).
- "Take a screenshot of the current tab."
- Close Chrome completely and reopen it, then repeat a request, to check the host restarts.

## What to expect for high-risk tools

Cookies, storage values, request interception, permission grants, clipboard and recording are OFF
by default. Asking for them returns an error that names the switch; this is correct, not a bug.
`chrome_javascript` and file upload are on by default. Switch any of them on in the extension popup
under Tools, only for the task that needs it. See `CAPABILITIES.md` for the full list.

## Reporting problems

Send, for each problem: what you asked the AI to do, the exact error text, the output of
`node native-server\dist\cli.js doctor`, your Windows version and `node -v`. Logs are in
`%LOCALAPPDATA%\mcp-chrome-bridge\logs`. Screenshots of the `chrome://extensions` card help too.
Do not paste cookie values or `~\.chrome-mcp-agent\auth-token`.
