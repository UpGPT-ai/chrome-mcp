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
echo "==> build native-server"; (cd "$ROOT/app/native-server" && npm run build >/dev/null)

cp "$ROOT"/packaging-template/* "$STAGE/"
chmod +x "$STAGE/install.sh"
cp -R "$ROOT/app/chrome-extension/.output/chrome-mv3" "$STAGE/chrome-extension"

NS="$STAGE/native-server"; mkdir -p "$NS"
rsync -a --exclude logs --exclude node_path.txt "$ROOT/app/native-server/dist" "$NS/"
SHARED_VER="$(node -p "require('$ROOT/packages/shared/package.json').version")"
node -e "
const p=require('$ROOT/app/native-server/package.json');
for (const k of ['dependencies','devDependencies']) for (const d in p[k]||{}) if (String(p[k][d]).startsWith('workspace:')) p[k][d]='^$SHARED_VER';
delete p.devDependencies;
require('fs').writeFileSync('$NS/package.json', JSON.stringify(p,null,2));"
[ -f "$ROOT/app/native-server/package-lock.json" ] && cp "$ROOT/app/native-server/package-lock.json" "$NS/" || true

ZIP="$OUT/${STAMP}_chrome-mcp-package-universal.zip"
rm -f "$ZIP"; (cd "$(dirname "$STAGE")" && zip -qr "$ZIP" chrome-mcp-package)
echo "==> $ZIP ($(du -h "$ZIP" | cut -f1))"
