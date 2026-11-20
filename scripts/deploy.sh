#!/usr/bin/env bash
# Builds a site update package and installs it on the IIS server over SSH, with no remote desktop.
#   ./scripts/deploy.sh vross            VrossPOS  (https://vrosspos.itcoresystems.com)
#   ./scripts/deploy.sh enzo             EnzoPOS   (https://enzopos.itcoresystems.com)
#   ./scripts/deploy.sh vross --rollback put the site's newest backup back
#   ./scripts/deploy.sh vross --no-build install the newest package already in publish/
#
# Needs the server set up once for SSH (OpenSSH Server, your key) and scripts/deploy.env with:
#   DEPLOY_HOST=<server address>   DEPLOY_USER=<Windows admin user>   DEPLOY_PORT=22 (optional)
# deploy.env is git-ignored; it holds no password (SSH uses your key).
#
# On the server, scripts/server/Deploy-SparkPOS.ps1 does the install: backup, stop the pool,
# copy (never appsettings*.json or wwwroot/images), start the pool, check /health.
# Database migrations are NOT part of it: run new numbered .sql files separately, first.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET=${1:-}
shift || true
BUILD=1; ROLLBACK=0
for a in "$@"; do
  case "$a" in
    --no-build) BUILD=0 ;;
    --rollback) ROLLBACK=1 ;;
    *) echo "Unknown option $a"; exit 1 ;;
  esac
done

case "$TARGET" in
  vross) SITE=VrossPOS; URL=https://vrosspos.itcoresystems.com; PUBLISH=./scripts/publish_vross.sh ;;
  enzo)  SITE=EnzoPOS;  URL=https://enzopos.itcoresystems.com;  PUBLISH=./scripts/publish.sh ;;
  *) echo "Usage: $0 vross|enzo [--no-build] [--rollback]"; exit 1 ;;
esac

[ -f scripts/deploy.env ] || { echo "Missing scripts/deploy.env (DEPLOY_HOST, DEPLOY_USER). See the top of this file."; exit 1; }
# shellcheck disable=SC1091
. scripts/deploy.env
: "${DEPLOY_HOST:?set DEPLOY_HOST in scripts/deploy.env}" "${DEPLOY_USER:?set DEPLOY_USER in scripts/deploy.env}"
PORT=${DEPLOY_PORT:-22}
SSH="ssh -p $PORT -o ConnectTimeout=15 $DEPLOY_USER@$DEPLOY_HOST"
SCP="scp -P $PORT -o ConnectTimeout=15"

echo "== Checking the SSH connection to $DEPLOY_HOST"
$SSH "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force -Path C:\\deploy\\incoming | Out-Null; 'ok'\"" >/dev/null
# always send the current install script, so a change to it needs no remote desktop either
$SCP scripts/server/Deploy-SparkPOS.ps1 "$DEPLOY_USER@$DEPLOY_HOST:C:/deploy/Deploy-SparkPOS.ps1"

if [ "$ROLLBACK" = 1 ]; then
  read -r -p "Put the newest backup of $SITE back? [y/N] " ok
  [ "$ok" = y ] || [ "$ok" = Y ] || exit 1
  $SSH "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\deploy\\Deploy-SparkPOS.ps1 -Site $SITE -Rollback -HealthUrl $URL"
  exit 0
fi

if [ "$BUILD" = 1 ]; then $PUBLISH site; fi
ZIP=$(ls -t publish/"$SITE"-update-v*.zip 2>/dev/null | head -1 || true)
[ -n "$ZIP" ] || { echo "No $SITE package in publish/"; exit 1; }
NAME=$(basename "$ZIP")

echo
echo "About to install $NAME on $SITE ($URL)."
echo "Run any new database migrations (database/NN_*.sql) on its database BEFORE this."
read -r -p "Continue? [y/N] " ok
[ "$ok" = y ] || [ "$ok" = Y ] || exit 1

echo "== Uploading $NAME ($(du -h "$ZIP" | cut -f1))"
$SCP "$ZIP" "$DEPLOY_USER@$DEPLOY_HOST:C:/deploy/incoming/$NAME"
echo "== Installing on the server"
$SSH "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\deploy\\Deploy-SparkPOS.ps1 -Site $SITE -Zip C:\\deploy\\incoming\\$NAME -HealthUrl $URL"
echo "== From here: $(curl -s -m 15 "$URL/health" || echo 'no answer')"
echo "Tills get the new version from their \"new version\" bar."
