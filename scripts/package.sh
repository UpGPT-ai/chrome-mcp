#!/usr/bin/env bash
# Build one cross-platform (macOS + Windows + Linux) chrome-mcp-package zip from the current tree.
# Usage: scripts/package.sh [output-dir]   (default: ~/Desktop)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$HOME/Desktop}"
STAMP="$(date +%F)"
STAGE="$(mktemp -d)/chrome-mcp-package"
mkdir -p "$STAGE"

echo "==> build shared";        (cd "$ROOT/packages/shared" && npx tsup src/index.ts --format cjs,esm --dts --clean >/dev/null)
echo "==> build extension";     (cd "$ROOT/app/chrome-extension" && npx wxt build >/dev/null)
echo "==> verify extension id"
node -e "
const c=require('crypto'),fs=require('fs');
const m=JSON.parse(fs.readFileSync('$ROOT/app/chrome-extension/.output/chrome-mv3/manifest.json','utf8'));
if(!m.key){console.error('manifest has no key: set CHROME_EXTENSION_KEY and rebuild');process.exit(1);}
const h=c.createHash('sha256').update(Buffer.from(m.key,'base64')).digest('hex').slice(0,32);
const id=[...h].map(x=>String.fromCharCode(97+parseInt(x,16))).join('');
const want=(fs.readFileSync('$ROOT/app/native-server/src/scripts/constant.ts','utf8').match(/EXTENSION_ID = '([a-p]{32})'/)||[])[1];
if(id!==want){console.error('extension id '+id+' does not match EXTENSION_ID '+want);process.exit(1);}
console.log('extension id ok: '+id);"
echo "==> bundle native-server (self-contained, no node_modules)"
NS="$STAGE/native-server"; mkdir -p "$NS"
node "$ROOT/scripts/bundle-native-server.cjs" "$NS/dist" >/dev/null
SRC="$ROOT/app/native-server/src"
mkdir -p "$NS/dist/mcp" "$NS/dist/logs"
cp "$SRC/mcp/stdio-config.json" "$NS/dist/mcp/stdio-config.json"
cp "$SRC/scripts/run_host.sh" "$SRC/scripts/run_host.bat" "$NS/dist/"
chmod +x "$NS/dist/run_host.sh" "$NS/dist/cli.js" "$NS/dist/index.js"
rmdir "$NS/dist/logs" 2>/dev/null || true

# Minimal manifest: identity and version only. No dependencies, so nothing can ask for npm install.
node -e "
const p=require('$ROOT/app/native-server/package.json');
const m={name:p.name,version:p.version,description:p.description,license:p.license,private:true,
  bin:p.bin,engines:{node:'>=20'}};
require('fs').writeFileSync('$NS/package.json', JSON.stringify(m,null,2)+'\\n');"

cp "$ROOT"/packaging-template/* "$STAGE/"
chmod +x "$STAGE/install.sh"
cp -R "$ROOT/app/chrome-extension/.output/chrome-mv3" "$STAGE/chrome-extension"

echo "==> verify: no native binaries, no node_modules"
if find "$STAGE" \( -name '*.node' -o -name node_modules \) | grep -q .; then
  find "$STAGE" \( -name '*.node' -o -name node_modules \) >&2
  echo "native binary or node_modules found in package" >&2; exit 1
fi

ZIP="$OUT/${STAMP}_chrome-mcp-package-universal.zip"
mkdir -p "$OUT"; rm -f "$ZIP"; (cd "$(dirname "$STAGE")" && zip -qr "$ZIP" chrome-mcp-package)
echo "==> $ZIP ($(du -h "$ZIP" | cut -f1))"
