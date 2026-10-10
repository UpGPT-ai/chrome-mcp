# Install Chrome MCP

Chrome MCP has two parts that both have to be installed: a Chrome extension, and a native host
(a local Node.js program that Chrome launches and that serves MCP on `127.0.0.1`).

## Requirements

- Google Chrome or Chromium. Edge, Brave, Arc, Firefox and Safari are not supported.
- Node.js 20 or newer and npm (`node -v` to check).
- macOS or Windows. Linux uses the same installer but is untested.

## Get the release zip

The zip is built by `scripts/package.sh` and is named
`<YYYY-MM-DD>_chrome-mcp-package-universal.zip`. It contains a `chrome-mcp-package` folder with
`chrome-extension/`, `native-server/`, the installers and `show-config.js`.

Unzip it somewhere permanent. Chrome loads the extension straight from that folder, so do not leave
it in Downloads or in Dropbox, OneDrive, Google Drive or iCloud (sync clients lock the many small
files Chrome and the native server create). If extraction made a doubled `chrome-mcp-package/chrome-mcp-package`,
use the inner folder.

## macOS

```bash
cd /path/to/chrome-mcp-package
bash install.sh
```

The installer checks Node, registers the native messaging host with Chrome and
runs a self-check. It ends with `Native host installed and registered.` Options: `--yes` for no
prompts. No `npm install` is needed; the server is a self-contained bundle.

## Windows

Double-click `install.cmd` in the `chrome-mcp-package` folder. From a normal terminal you can run
`powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Yes`. Do not run the installer from
inside the Claude desktop app for Windows; it is sandboxed and the registry entry it writes is not
visible to Chrome.

## Load the extension

1. Open `chrome://extensions` and turn on Developer mode.
2. Choose Load unpacked and select the `chrome-extension` folder from the package.
3. Confirm the ID is `gnkfbbmfkabopdomoedaamfpgnakoici`. The native host only accepts that ID.
4. Pin the extension to the toolbar, open it, and click Connect.

## Connect your MCP client

The bridge listens on port 13366. The MCP URL is:

```
http://127.0.0.1:13366/mcp
```

Every request needs `Authorization: Bearer <token>`. The token is created on first use at:

- macOS / Linux: `~/.chrome-mcp-agent/auth-token`
- Windows: `%USERPROFILE%\.chrome-mcp-agent\auth-token`

Set `CHROME_MCP_PORT` to use another port. Set `CHROME_MCP_AGENT_DIR` to move the directory that
holds the token and audit log.

### Claude Code

```bash
claude mcp add --transport http chrome-mcp http://127.0.0.1:13366/mcp \
  --header "Authorization: Bearer $(cat ~/.chrome-mcp-agent/auth-token)"
```

### Claude Desktop

Claude Desktop reads stdio servers from its config file, so use the stdio proxy that ships in the
package. Run `node show-config.js` in the package folder to print the exact entry for your machine.
It has this shape:

```json
{
  "mcpServers": {
    "chrome-mcp": {
      "command": "node",
      "args": ["/path/to/chrome-mcp-package/native-server/dist/mcp/mcp-server-stdio.js"]
    }
  }
}
```

### Cursor

In `~/.cursor/mcp.json` (or the project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "chrome-mcp": {
      "url": "http://127.0.0.1:13366/mcp",
      "headers": { "Authorization": "Bearer <paste the token>" }
    }
  }
}
```

### Any other client

Use a Streamable HTTP server entry with the URL above and the `Authorization` header. For clients
that only support stdio, use the stdio proxy entry shown for Claude Desktop.

The HTTP route only works if Chrome is open and connected when the client starts. The stdio proxy
does not have that ordering problem.

## Verify

From the package folder run `node native-server/dist/cli.js doctor`. After clicking Connect,
`Connectivity` should show `[OK]`. Then ask your client to call `get_windows_and_tabs`.

## Migrating from upstream `mcp-chrome-bridge`

If you installed the upstream project (`mcp-chrome-bridge` from npm), remove it first. Its setup
script registers a different extension ID and will fight with this one.

1. Uninstall the global package: `npm uninstall -g mcp-chrome-bridge` (or
   `pnpm uninstall -g mcp-chrome-bridge`).
2. Remove the old native messaging manifest `com.chromemcp.nativehost.json`.
   - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
   - Windows: delete the registry key
     `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chromemcp.nativehost`
     (the manifest file lives under `%APPDATA%\Google\Chrome\NativeMessagingHosts`).
3. Remove the old extension from `chrome://extensions`.
4. Install this package as described above. The extension ID is different, so the native messaging
   manifest must be registered again; the installer does this.
5. Update your client config. The port changed from 12306 to 13366, and a bearer token is now
   required, so an old config that sends no `Authorization` header gets HTTP 401.
