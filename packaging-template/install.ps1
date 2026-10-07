<#
  chrome-mcp - Windows installer
  Run from anywhere; paths are resolved relative to this script's own folder.
  Works in Windows PowerShell 5.1 and PowerShell 7+.
  Easiest: double-click install.cmd (it bypasses the execution-policy block).

  Options:
    -SkipNpmInstall   skip "npm install" (dependencies already present)
    -Yes              don't pause for the cloud-sync-folder warning
#>
param(
    [switch]$SkipNpmInstall,
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$ExtensionId = 'gnkfbbmfkabopdomoedaamfpgnakoici'

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host ""; Write-Host "INSTALL FAILED: $msg" -ForegroundColor Red; exit 1 }

$Root      = $PSScriptRoot
$Server    = Join-Path $Root 'native-server'
$Extension = Join-Path $Root 'chrome-extension'

# --- 1. Package layout ---------------------------------------------------------
Step "Checking package layout in $Root"
if (-not (Test-Path (Join-Path $Server 'package.json')) -or
    -not (Test-Path (Join-Path $Server 'dist\cli.js')) -or
    -not (Test-Path (Join-Path $Extension 'manifest.json'))) {
    Fail "native-server\ or chrome-extension\ not found next to install.ps1. Run this script from the unzipped package folder."
}
Ok "native-server and chrome-extension found"

# --- 1b. Not inside the Claude desktop app's MSIX sandbox ----------------------
# The Claude desktop app for Windows is MSIX-packaged. Shells it spawns inherit the
# package's registry virtualization: the HKCU NativeMessagingHosts key that
# "register" writes lands in a private hive only Claude can see. register and doctor
# both report success (they read the same merged view), but Chrome says "Specified
# native messaging host not found". Found on GAKI-LEGION, 2026-09-19.
# Match Claude's package specifically: Windows Terminal also lives under WindowsApps
# but does NOT virtualize its children, and running from it is the fix.
Step "Checking this is not running inside the Claude desktop app"
$claudePkg = $null
$procId = $PID
for ($i = 0; $i -lt 15 -and $procId; $i++) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    if (-not $proc) { break }
    if ($proc.ExecutablePath -match '\\WindowsApps\\Claude_') { $claudePkg = $proc.ExecutablePath; break }
    $procId = $proc.ParentProcessId
}
if ($claudePkg) {
    Write-Host ""
    Write-Host "This installer was started from inside the Claude desktop app:" -ForegroundColor Red
    Write-Host "    $claudePkg"
    Write-Host "Claude's sandbox hides the Chrome registry entry from Chrome, so the install would"
    Write-Host "look successful but Chrome could never start the native host."
    Write-Host ""
    Write-Host "Run it yourself instead - either double-click in File Explorer:" -ForegroundColor White
    Write-Host "    $(Join-Path $Root 'install.cmd')" -ForegroundColor White
    Write-Host "or from Windows Terminal opened from the Start menu:" -ForegroundColor White
    Write-Host "    powershell -ExecutionPolicy Bypass -File `"$(Join-Path $Root 'install.ps1')`"" -ForegroundColor White
    Write-Host ""
    Write-Host "(Claude: tell the user to run one of the above; you can verify afterwards with doctor.)" -ForegroundColor DarkGray
    Fail "started from inside the Claude desktop app's MSIX sandbox"
}
Ok "not inside the Claude desktop app"

# --- 2. Node.js ----------------------------------------------------------------
Step "Checking Node.js"
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js not found on PATH. Install the LTS version from https://nodejs.org, then open a NEW terminal and re-run." }
$ver = (& node.exe -v).Trim()
$major = [int]($ver.TrimStart('v').Split('.')[0])
if ($major -lt 20) { Fail "Node.js $ver is too old; version 20 or newer is required." }
Ok "Node.js $ver at $($node.Source)"

# Always call npm.cmd: plain "npm" resolves to npm.ps1, which Windows PowerShell
# blocks under the default execution policy ("running scripts is disabled").
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { Fail "npm.cmd not found. Reinstall Node.js from https://nodejs.org." }

# --- 3. Conflicting global install --------------------------------------------
Step "Checking for a conflicting global mcp-chrome-bridge"
$globalRoot = (& npm.cmd root -g 2>$null | Out-String).Trim()
if ($globalRoot -and (Test-Path (Join-Path $globalRoot 'mcp-chrome-bridge'))) {
    Write-Host ""
    Write-Host "The public npm package 'mcp-chrome-bridge' is installed globally." -ForegroundColor Red
    Write-Host "Its setup script overwrites Chrome's registration with the PUBLIC extension ID,"
    Write-Host "which silently breaks this build after the next Chrome restart."
    Write-Host "Remove it, then re-run this installer:"
    Write-Host ""
    Write-Host "    npm.cmd uninstall -g mcp-chrome-bridge" -ForegroundColor White
    Fail "conflicting global package present"
}
Ok "none found"

# --- 4. Cloud-synced folder warning -------------------------------------------
if ($Root -match '\\(Dropbox|OneDrive|Google Drive|iCloud ?Drive)[^\\]*\\') {
    Step "Location warning"
    Warn "This package is inside a cloud-synced folder:"
    Warn "  $Root"
    Warn "npm install writes ~20,000 small files; sync clients can lock them (EBUSY/EPERM)"
    Warn "and will upload all of them. Recommended: move the whole folder to e.g."
    Warn "  C:\Tools\chrome-mcp   and run install.cmd from there."
    Warn "(Chrome loads the extension from wherever it sits, so pick a permanent spot.)"
    if (-not $Yes) {
        $ans = Read-Host "    Continue here anyway? [y/N]"
        if ($ans -notmatch '^(y|yes)$') { Fail "cancelled - move the folder and re-run" }
    }
}

# --- 5. npm install ------------------------------------------------------------
Push-Location $Server
try {
    if ($SkipNpmInstall) {
        Step "Skipping npm install (-SkipNpmInstall)"
    } else {
        Step "Installing dependencies (npm install - takes a few minutes)"
        Write-Host "    Warnings about 'deprecated' packages and 'allow-scripts' are expected and harmless." -ForegroundColor DarkGray
        & npm.cmd install --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { Fail "npm install exited with code $LASTEXITCODE (see output above)" }
        Ok "dependencies installed"
    }

    # better-sqlite3 is a native module; make sure a compiled binary exists.
    $sqlite = Join-Path $Server 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
    if (-not (Test-Path $sqlite)) {
        Warn "better-sqlite3 native binary missing - attempting rebuild"
        & npm.cmd rebuild better-sqlite3
        if (-not (Test-Path $sqlite)) {
            Fail "better-sqlite3 could not be built. Install Visual Studio Build Tools with the 'Desktop development with C++' workload, then re-run."
        }
    }
    Ok "better-sqlite3 native module present"

    # --- 6. Register with Chrome ----------------------------------------------
    Step "Registering native messaging host with Chrome"
    & node.exe dist\cli.js register
    if ($LASTEXITCODE -ne 0) { Fail "registration failed (exit $LASTEXITCODE)" }

    # Double-check the manifest actually matches this build's extension ID.
    $manifest = Join-Path $env:APPDATA 'Google\Chrome\NativeMessagingHosts\com.chromemcp.nativehost.json'
    if (Test-Path $manifest) {
        $m = Get-Content $manifest -Raw | ConvertFrom-Json
        if ($m.allowed_origins -notcontains "chrome-extension://$ExtensionId/") {
            Fail "Chrome manifest does not allow extension $ExtensionId - something else overwrote it"
        }
        Ok "manifest allows extension $ExtensionId"
    }

    # --- 7. Self-check ---------------------------------------------------------
    Step "Running doctor self-check"
    $doc = & node.exe dist\cli.js doctor 2>&1 | Out-String
    Write-Host $doc
    if ($doc -match '\[ERROR\]') { Fail "doctor reported errors (above)" }
}
finally {
    Pop-Location
}

# --- 8. Next steps -------------------------------------------------------------
Write-Host ""
Write-Host "Native host installed and registered." -ForegroundColor Green
Write-Host "(A 'Connectivity' WARN above is normal until the extension is loaded.)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  1. Chrome -> chrome://extensions -> enable Developer mode -> Load unpacked -> select:"
Write-Host "       $Extension" -ForegroundColor White
Write-Host "     (extension ID should read $ExtensionId)"
Write-Host "     PIN IT: click the puzzle-piece icon in Chrome's toolbar -> click the pin next to chrome-mcp." -ForegroundColor Yellow
Write-Host "     The pinned icon shows connection status and has the Connect button."
Write-Host "  2. Click the extension icon -> Connect. Then verify with:"
Write-Host "       node `"$Server\dist\cli.js`" doctor" -ForegroundColor White
Write-Host "  3. Add it to Claude Code (stdio proxy - works even if Claude starts before Chrome):"
Write-Host "       claude mcp add chrome-mcp -s user -- node `"$Server\dist\mcp\mcp-server-stdio.js`"" -ForegroundColor White
Write-Host "     (If you previously added the HTTP version: claude mcp remove chrome-mcp -s user)"
Write-Host ""
