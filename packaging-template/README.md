# chrome-mcp: setup for Windows, macOS and Linux

Gives Claude (or any MCP client) live control of your real Chrome browser: reading tabs, clicking,
filling forms, navigating. This is a patched build that fixes the bug where the connection silently
died and needed everything restarted.

**One package, one set of instructions, every OS.** This file is the only setup guide; it is written
for both people and AI assistants. Everything below works the same on Windows, Mac and Linux except
where a table says otherwise.

Two pieces, both required, both talking only on your own machine (`127.0.0.1`):

1. **`chrome-extension/`**: loaded into Chrome.
2. **`native-server/`**: a small local Node.js program the extension launches.

> **Never run `npm install -g mcp-chrome-bridge`.** That installs the _public_ build, whose setup
> script overwrites Chrome's registration with a different extension ID. Everything keeps working
> until Chrome next restarts, then silently stops connecting, which looks exactly like the bug this
> build fixes. If it was already run: `npm uninstall -g mcp-chrome-bridge`, then re-run the installer.

---

## For AI assistants: read this first

You are helping a user install this. Follow this protocol; the rest of the file is the detail.

1. **Find the package folder.** It is the folder that directly contains `README.md`, `install.cmd`,
   `install.sh`, `show-config.js`, `native-server/` and `chrome-extension/`. If the zip extracted into a
   doubled folder (`chrome-mcp-package/chrome-mcp-package/`), use the inner one. Use its absolute path
   everywhere below. Ask the user to move it somewhere permanent and not cloud-synced first if it is in
   Downloads, Dropbox, OneDrive, Google Drive or iCloud (see Step 0).
2. **Check prerequisites:** `node -v` must print v20 or newer. If not, tell the user to install the LTS
   from https://nodejs.org and open a new terminal. Chrome (or Chromium) must be installed.
   Edge, Brave, Arc, Firefox and Safari are **not** supported.
3. **Run the installer.**
   - **macOS / Linux:** `bash install.sh --yes` from the package folder.
   - **Windows:** ask the user to double-click `install.cmd`. **If you are running inside the Claude
     desktop app for Windows, do not run it yourself.** That app is a sandboxed (MSIX) app, and the
     Chrome registry entry you would write is invisible to Chrome. The installer detects this and stops
     with instructions. In any other Windows shell (Windows Terminal, plain PowerShell, Claude Code in a
     terminal) you may run
     `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Yes`.
   - **Success** is a final line reading `Native host installed and registered.` Failure prints
     `INSTALL FAILED: <reason>` and exits non-zero. Read the reason; the fix is in the Troubleshooting table.
4. **Steps only the user can do (Chrome's UI).** Walk them through Steps 2 and 3 below: Load unpacked,
   **pin the extension**, click **Connect**. Before saying "click Connect", ask whether they can see the
   extension's icon in the toolbar; if not, help them pin it first.
5. **Register with the MCP client.** Run `node show-config.js` (add `--json` for machine-readable output).
   It prints the exact command and JSON for this machine with correct quoting. For Claude Code, run the
   printed `claude mcp add chrome-mcp -s user -- node "<path>"`; for other clients, add the printed
   `mcpServers` entry to their config. The user then needs a **new session / restart of the client**.
6. **Verify.** `node native-server/dist/cli.js doctor` (run from the package folder) must show no
   `[ERROR]`; after the user clicks Connect, `Connectivity` must be `[OK]`. Then call the
   `get_windows_and_tabs` tool: it should return the user's real tabs.
   `Error calling tool: Failed to connect to MCP server` means Chrome is not running or the extension is
   not connected. It is not a broken install.
7. **Never:** run `npm install -g mcp-chrome-bridge`; edit the extension's `manifest.json` or its `key`
   (the ID `gnkfbbmfkabopdomoedaamfpgnakoici` is hard-wired into the registration); move the folder
   after installing without re-running the installer and reloading the extension; use the direct HTTP
   config unless the user asks (see Step 4); trust "I closed Chrome" without checking (see Troubleshooting).

---

## Requirements

- **Google Chrome** or Chromium (installed normally; Snap/Flatpak builds on Linux are sandboxed and unsupported).
- **Node.js 20 or newer.** `node -v` to check. Install the LTS from https://nodejs.org, then open a _new_ terminal.
- Windows, macOS, or Linux. Tested on Windows 11 and macOS (Apple silicon). Linux uses the same
  installer and registration paths but has not been tested.

## Where things differ by OS

|                              | Windows                                 | macOS / Linux                                                                         |
| ---------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| Good permanent folder        | `C:\Tools\chrome-mcp-package`           | `~/Applications/chrome-mcp-package`                                                   |
| Run the installer            | double-click `install.cmd`              | `bash install.sh` in Terminal                                                         |
| Verify (from package folder) | `node native-server/dist/cli.js doctor` | `node native-server/dist/cli.js doctor`                                               |
| Logs                         | `%LOCALAPPDATA%\mcp-chrome-bridge\logs` | Mac `~/Library/Logs/mcp-chrome-bridge`; Linux `~/.local/state/mcp-chrome-bridge/logs` |
| Is Chrome really closed?     | `Get-Process chrome`                    | `pgrep -l -i chrome`                                                                  |

Forward slashes work in Node commands on every OS, so the `node native-server/dist/...` commands in this
file are identical everywhere.

---

## Step 0: Put the folder somewhere permanent

Chrome loads the extension straight from this folder, so don't leave it in Downloads or a temp folder.
**Avoid Dropbox / OneDrive / Google Drive / iCloud folders**: sync clients can lock or rewrite files
while Chrome is using them (EBUSY/EPERM errors).

Windows "Extract All" often creates a doubled folder (`chrome-mcp-package\chrome-mcp-package\`). Use the
**inner** one, the one that contains `install.cmd`, `native-server` and `chrome-extension`.

## Step 1: Install the native server

**Windows:** double-click **`install.cmd`**.
**macOS / Linux:** open Terminal and run:

```bash
bash /path/to/chrome-mcp-package/install.sh
```

Either installer works from wherever the folder is. It checks Node.js, refuses to continue if the
conflicting public package is installed, registers with Chrome, confirms the registration allows this build's extension ID, and runs a
self-check. It ends with **`Native host installed and registered.`** and prints the folder to use in
Step 2.

**No `npm install` and no compiler are needed.** The native server ships as a self-contained bundle, so
Node.js 20+ is the only prerequisite and the install works offline. Two features are unavailable in
this build: persistent agent-chat storage (it needs a native SQLite module) and offline performance-trace
analysis. Neither affects the browser tools.

> **Windows, if Claude is doing the install for you:** double-click `install.cmd` yourself instead.
> The Claude desktop app for Windows is a packaged (MSIX) app; commands Claude runs write the Chrome
> registry entry into a private copy only Claude can see. The installer and `doctor` then report
> success, but Chrome says _"Specified native messaging host not found"_ and the extension shows
> **"Connected, Service Not Started"**. `install.ps1` detects this and stops. Claude can still read the
> docs, check results and walk you through every other step. (Not an issue on Mac.)

## Step 2: Load the Chrome extension

1. Open Chrome → `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. **Load unpacked** → select the **`chrome-extension`** folder inside the package
4. Check that the extension ID shown is **`gnkfbbmfkabopdomoedaamfpgnakoici`**
5. **Pin it to the toolbar. Don't skip this.** Chrome hides new extensions behind the puzzle-piece
   icon. Click the **puzzle piece** (top-right) → click the **pin** next to chrome-mcp. The pinned icon
   shows whether it's connected and has the **Connect** button.

If you ever move the package folder: remove the extension, **Load unpacked** again from the new
location, and re-run the installer.

## Step 3: Connect and verify

Click the extension icon → **Connect**. Then, from the package folder:

```
node native-server/dist/cli.js doctor
```

Every line should be `[OK]`. (`Connectivity` shows `[WARN]` until the extension has connected.)

## Step 4: Connect your AI client

From the package folder:

```
node show-config.js
```

It prints the exact, correctly quoted command and JSON for **this** machine. Use the **stdio proxy**
it gives you. It works no matter whether the AI client or Chrome starts first. For Claude Code the
command has the form:

```
claude mcp add chrome-mcp -s user -- node "<package folder>/native-server/dist/mcp/mcp-server-stdio.js"
```

For Claude Desktop and most other clients (Cursor, Cline, Windsurf, …), add the printed entry to
`mcpServers` in their config (Claude Desktop: **Settings → Developer → Edit Config** opens the right
file). Then restart the client or start a new session.

If a tool says Chrome isn't connected: open Chrome, click the extension icon → **Connect**, retry.
No client restart is needed.

**Advanced: direct HTTP** (`http://127.0.0.1:13366/mcp`). Configs that still say port 12306 must be
edited by hand. Set `CHROME_MCP_PORT` to use another port. If that port is busy, the bridge stops
and names the process that holds it. Direct HTTP only works if **Chrome is already open
and connected when the AI client starts**. If the client starts first it marks the server failed, and you
must reconnect (`/mcp` in Claude Code) or start a new session. Prefer stdio.

---

## Troubleshooting

| Symptom                                                                                         | Fix                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd` says path not found / `node` can't find `cli.js`                                           | Wrong folder. Use the installer, which finds its own folder, and use the inner folder if extraction doubled it.                                                                                                                                                                                                                             |
| Installer stops: _conflicting global package_                                                   | `npm uninstall -g mcp-chrome-bridge`, then re-run the installer.                                                                                                                                                                                                                                                                            |
| `doctor`: _allowed_origins missing chrome-extension://gnkfbb…_                                  | Something (usually a global `mcp-chrome-bridge`) overwrote the registration. Uninstall it, re-run the installer, restart Chrome.                                                                                                                                                                                                            |
| AI client shows `chrome-mcp` failed / no Chrome tools                                           | It started before Chrome on the HTTP config. Switch to the stdio config (Step 4), or reconnect (`/mcp` in Claude Code).                                                                                                                                                                                                                     |
| Client error `spawn node ENOENT` (common on Mac with nvm/Homebrew when the client is a GUI app) | The app doesn't see your shell's PATH. Use the second, absolute-Node-path config that `node show-config.js` prints.                                                                                                                                                                                                                         |
| Extension shows disconnected                                                                    | Click the icon → Connect, then re-run `doctor`.                                                                                                                                                                                                                                                                                             |
| Popup says **"Connected, Service Not Started"**; port 13366 not listening                       | Chrome couldn't launch the native host. To see why: `chrome://extensions` → chrome-mcp → **service worker** → Console, run `chrome.runtime.connectNative('com.chromemcp.nativehost').onDisconnect.addListener(()=>console.log('NATIVE ERR:', chrome.runtime.lastError?.message))`.                                                          |
| `NATIVE ERR: Specified native messaging host not found` but `doctor` is all `[OK]`              | **Windows:** registration was run from inside Claude Desktop's sandbox (see Step 1). From Windows Terminal opened via the Start menu: `node "<package folder>\native-server\dist\cli.js" register`, then Disconnect → Connect in the popup. **Mac/Linux:** you use a browser other than Chrome/Chromium, or Chrome is a Snap/Flatpak build. |
| `NATIVE ERR: Access to the specified native messaging host is forbidden`                        | Extension ID mismatch. The card on `chrome://extensions` must show `gnkfbbmfkabopdomoedaamfpgnakoici`; re-run the installer.                                                                                                                                                                                                                |
| Mac: `permission denied` running `run_host.sh` or `cli.js`                                      | Executable bits lost (some unzip tools drop them). `node native-server/dist/cli.js fix-permissions`, or just re-run `install.sh`.                                                                                                                                                                                                           |
| Can't find the extension icon / "Connect" button                                                | It isn't pinned. Puzzle-piece icon → pin chrome-mcp (Step 2, item 5).                                                                                                                                                                                                                                                                       |
| Tools still work after "closing" Chrome                                                         | Chrome is still running: an installed web app (e.g. Google Messages) or "Continue running background apps" keeps it alive. Close app windows too, then quit Chrome from the system tray / menu bar (Mac: ⌘Q). Check with the "Is Chrome really closed?" command above.                                                                      |
| EBUSY / EPERM during install                                                                    | The folder is in a synced location. See Step 0.                                                                                                                                                                                                                                                                                             |

Anything else: send a screenshot of the error plus the output of `node native-server/dist/cli.js doctor`
to Greg.

## What's in the package

| Path                         | Purpose                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- |
| `README.md`                  | This guide.                                                                 |
| `install.cmd`, `install.ps1` | Windows installer.                                                          |
| `install.sh`                 | macOS / Linux installer.                                                    |
| `show-config.js`             | Prints the MCP client config for this machine (any OS). `--json` for tools. |
| `chrome-extension/`          | The extension to Load unpacked.                                             |
| `native-server/`             | The native host + stdio proxy (`dist/`), fully bundled; no `node_modules/`. |
| `WINDOWS-TESTING.md`         | Short test script for Windows testers.                                      |
| `CAPABILITIES.md`            | Every tool and feature, and which are off by default.                       |
