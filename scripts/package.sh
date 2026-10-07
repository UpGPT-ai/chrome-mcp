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
echo "==> build native-server"; (cd "$ROOT/app/native-server" && pnpm run build >/dev/null)

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
