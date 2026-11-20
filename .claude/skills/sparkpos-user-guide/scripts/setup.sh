#!/usr/bin/env bash
# One-time install of the capture tools into ~/.cache/sparkpos-guide (outside the repo, and not a
# temp folder, so it survives reboots): puppeteer-core, a headless Chrome and a standalone ffmpeg.
# Safe to re-run; it only fetches what's missing.
set -euo pipefail
TOOLS="${SPARKPOS_GUIDE_TOOLS:-$HOME/.cache/sparkpos-guide}"
CHROME_BUILD=131.0.6778.204   # the Chrome that puppeteer-core 23.11.1 is made for
mkdir -p "$TOOLS"
cd "$TOOLS"
[ -f package.json ] || echo '{ "name": "sparkpos-guide-tools", "private": true, "type": "module" }' > package.json
if [ ! -d node_modules/puppeteer-core ] || [ ! -d node_modules/ffmpeg-static ]; then
  npm install --no-audit --no-fund --save-exact puppeteer-core@23.11.1 @puppeteer/browsers@2.6.1 ffmpeg-static@5.2.0
fi
if ! ls browser/chrome-headless-shell/*/chrome-headless-shell-*/chrome-headless-shell >/dev/null 2>&1; then
  npx --no-install @puppeteer/browsers install "chrome-headless-shell@$CHROME_BUILD" --path "$TOOLS/browser"
fi
node -e "import('ffmpeg-static').then(m => { if (!m.default) throw new Error('ffmpeg-static has no binary for this machine'); console.log('ffmpeg:', m.default) })"
ls browser/chrome-headless-shell/*/chrome-headless-shell-*/chrome-headless-shell | sed 's/^/chrome: /'
echo "Capture tools ready in $TOOLS"
