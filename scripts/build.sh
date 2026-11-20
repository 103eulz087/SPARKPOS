#!/usr/bin/env bash
# Builds SparkPOS: the web app (web/ -> src/PosApi/wwwroot) and the API (Release).
#   ./scripts/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
VERSION=$(node -p "require('./web/package.json').version")

echo "== Web app v$VERSION"
cd "$ROOT/web"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run build

# wwwroot is build output. Clear the old build's files, but keep wwwroot/images
# (product photos uploaded while running locally).
cd "$ROOT/src/PosApi"
mkdir -p wwwroot
rm -rf wwwroot/assets wwwroot/icons wwwroot/workbox-*.js wwwroot/sw.js
cp -R "$ROOT/web/dist/"* wwwroot/

echo "== API"
dotnet build -c Release --nologo -v q

echo
echo "Built SparkPOS v$VERSION"
