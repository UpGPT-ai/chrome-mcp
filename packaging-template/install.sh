#!/usr/bin/env bash
#
# chrome-mcp - macOS / Linux installer (Windows: use install.cmd).
# Run from anywhere:   bash /path/to/chrome-mcp-package/install.sh
# Paths are resolved from this script's own location.
#
# Options:
#   --yes, -y           don't pause for the cloud-synced-folder warning
#   --skip-npm-install  skip "npm install" (dependencies already present)
#
# Works with the macOS default bash 3.2. Safe to re-run.

set -u

EXTENSION_ID='gnkfbbmfkabopdomoedaamfpgnakoici'
YES=0
SKIP_NPM=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --skip-npm-install) SKIP_NPM=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)"; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''; C_OFF=''
fi
step() { printf '\n%s==> %s%s\n' "$C_CYAN" "$1" "$C_OFF"; }
ok()   { printf '    %sOK%s  %s\n' "$C_GREEN" "$C_OFF" "$1"; }
warn() { printf '    %s!!%s  %s\n' "$C_YELLOW" "$C_OFF" "$1"; }
fail() { printf '\n%sINSTALL FAILED: %s%s\n' "$C_RED" "$1" "$C_OFF"; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SERVER="$ROOT/native-server"
EXTENSION="$ROOT/chrome-extension"

# --- 1. Package layout ---------------------------------------------------------
step "Checking package layout in $ROOT"
if [ ! -f "$SERVER/package.json" ] || [ ! -f "$SERVER/dist/cli.js" ] || [ ! -f "$EXTENSION/manifest.json" ]; then
  fail "native-server/ or chrome-extension/ not found next to install.sh. Run this from the unzipped package folder (the inner one, if the zip extracted into a doubled folder)."
fi
ok "native-server and chrome-extension found"

# --- 2. Node.js / npm ----------------------------------------------------------
step "Checking Node.js"
command -v node >/dev/null 2>&1 || fail "Node.js not found on PATH. Install the LTS version from https://nodejs.org (or 'brew install node'), then open a NEW terminal and re-run."
NODE_VER="$(node -v)"
NODE_MAJOR="${NODE_VER#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || fail "Node.js $NODE_VER is too old; version 20 or newer is required."
ok "Node.js $NODE_VER at $(command -v node)"
command -v npm >/dev/null 2>&1 || fail "npm not found. Reinstall Node.js from https://nodejs.org."

# --- 3. Conflicting global install --------------------------------------------
step "Checking for a conflicting global mcp-chrome-bridge"
GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
if [ -n "$GLOBAL_ROOT" ] && [ -d "$GLOBAL_ROOT/mcp-chrome-bridge" ]; then
  printf '\n%sThe public npm package "mcp-chrome-bridge" is installed globally.%s\n' "$C_RED" "$C_OFF"
  echo "Its setup script overwrites Chrome's registration with the PUBLIC extension ID,"
  echo "which silently breaks this build after the next Chrome restart."
  echo "Remove it, then re-run this installer:"
  echo
  echo "    npm uninstall -g mcp-chrome-bridge"
  fail "conflicting global package present"
fi
ok "none found"

# --- 4. Location warnings ------------------------------------------------------
case "$ROOT" in
  *"/Dropbox"*|*"/OneDrive"*|*"/Google Drive"*|*"/GoogleDrive"*|*"/iCloud"*|*"/Mobile Documents/"*|*"/Library/CloudStorage/"*)
    step "Location warning"
    warn "This package is inside a cloud-synced folder: $ROOT"
    warn "npm install writes ~20,000 small files; sync clients lock and upload them."
    warn "Recommended: move the whole folder to e.g. ~/Applications/chrome-mcp-package and re-run."
    warn "(Chrome loads the extension from wherever it sits, so pick a permanent spot.)"
    if [ "$YES" -ne 1 ] && [ -t 0 ]; then
      printf '    Continue here anyway? [y/N] '
      read -r ans
      case "$ans" in y|Y|yes|YES) ;; *) fail "cancelled - move the folder and re-run" ;; esac
    fi
    ;;
  "$HOME/Downloads"/*|/tmp/*|/private/tmp/*|/private/var/*)
    step "Location warning"
    warn "This package is in a temporary-looking location: $ROOT"
    warn "Chrome loads the extension straight from this folder, so it must stay put."
    warn "Consider moving it somewhere permanent (e.g. ~/Applications/chrome-mcp-package) and re-running."
    ;;
esac

# --- 5. Mac: clear the download quarantine flag, restore executable bits -------
if [ "$(uname -s)" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null || true
fi
chmod +x "$ROOT/install.sh" 2>/dev/null || true

# --- 6. npm install ------------------------------------------------------------
cd "$SERVER" || fail "cannot cd to $SERVER"
if [ "$SKIP_NPM" -eq 1 ]; then
  step "Skipping npm install (--skip-npm-install)"
else
  step "Installing dependencies (npm install - takes a minute or two)"
  printf '    %sWarnings about "deprecated" packages and "allow-scripts" are expected and harmless.%s\n' "$C_DIM" "$C_OFF"
  npm install --no-fund --no-audit || fail "npm install failed (see output above)"
  ok "dependencies installed"
fi

SQLITE="$SERVER/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [ ! -f "$SQLITE" ]; then
  warn "better-sqlite3 native binary missing - attempting rebuild"
  npm rebuild better-sqlite3
  [ -f "$SQLITE" ] || fail "better-sqlite3 could not be built. macOS: run 'xcode-select --install'. Linux: install build-essential and python3. Then re-run."
fi
ok "better-sqlite3 native module present"

# --- 7. Register with Chrome ---------------------------------------------------
step "Registering native messaging host with Chrome"
node dist/cli.js register || fail "registration failed (see output above)"

# Double-check that the manifest Chrome will read matches this build's extension ID.
FOUND=0
for m in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json" \
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts/com.chromemcp.nativehost.json" \
  "$HOME/.config/google-chrome/NativeMessagingHosts/com.chromemcp.nativehost.json" \
  "$HOME/.config/chromium/NativeMessagingHosts/com.chromemcp.nativehost.json"; do
  if [ -f "$m" ]; then
    FOUND=1
    grep -q "chrome-extension://$EXTENSION_ID/" "$m" \
      || fail "manifest $m does not allow extension $EXTENSION_ID - something else overwrote it"
    ok "manifest allows extension $EXTENSION_ID ($m)"
  fi
done
[ "$FOUND" -eq 1 ] || warn "could not find the registered manifest in the usual Chrome/Chromium locations; 'doctor' below will say more"

# --- 8. Self-check -------------------------------------------------------------
step "Running doctor self-check"
DOC="$(node dist/cli.js doctor 2>&1)"
echo "$DOC"
case "$DOC" in *"[ERROR]"*) fail "doctor reported errors (above)" ;; esac

# --- 9. Next steps -------------------------------------------------------------
cd "$ROOT" || exit 0
printf '\n%sNative host installed and registered.%s\n' "$C_GREEN" "$C_OFF"
printf '%s(A "Connectivity" WARN above is normal until the extension is loaded.)%s\n' "$C_DIM" "$C_OFF"
printf '\n%sNext:%s\n' "$C_CYAN" "$C_OFF"
echo "  1. Chrome -> chrome://extensions -> enable Developer mode -> Load unpacked -> select:"
echo "       $EXTENSION"
echo "     (extension ID should read $EXTENSION_ID)"
printf '     %sPIN IT: click the puzzle-piece icon in Chrome'"'"'s toolbar -> click the pin next to chrome-mcp.%s\n' "$C_YELLOW" "$C_OFF"
echo "     The pinned icon shows connection status and has the Connect button."
echo "  2. Click the extension icon -> Connect. Then verify with:"
echo "       node \"$SERVER/dist/cli.js\" doctor"
echo "  3. Connect your AI client (stdio proxy - works even if the client starts before Chrome):"
echo "       node \"$ROOT/show-config.js\"     # prints the exact command / JSON for this machine"
echo
