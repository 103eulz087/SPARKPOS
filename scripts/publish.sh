#!/usr/bin/env bash
# Makes the packages to copy to the server or a store PC. Output: publish/ (git-ignored).
#   ./scripts/publish.sh              site update package (the default)
#   ./scripts/publish.sh printagent   PrintAgent for a Windows store PC, already pointed at the site
#   ./scripts/publish.sh all          both
# Another site: SITE_NAME=TabletPOS SITE_URL=http://itcoreapps.com:8080 ./scripts/publish.sh
#
# The site package has NO appsettings.json: the server keeps its own (passwords, Jwt key).
# Database migrations are not part of it; run new numbered .sql files by hand.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

WHAT=${1:-site}
SITE_NAME=${SITE_NAME:-EnzoPOS}
SITE_URL=${SITE_URL:-https://enzopos.itcoresystems.com}
SITE_URL=${SITE_URL%/}
VERSION=$(node -p "require('./web/package.json').version")
STAMP=$(date +%Y%m%d-%H%M)
OUT="$ROOT/publish"
mkdir -p "$OUT"

case "$WHAT" in site|printagent|all) ;; *) echo "Usage: $0 [site|printagent|all]"; exit 1 ;; esac

zip_dir() {   # zip_dir <folder> <zip file>
  rm -f "$2"
  (cd "$1" && zip -qrX "$2" . -x '.DS_Store' '*/.DS_Store')
  echo "  -> $2 ($(du -h "$2" | cut -f1))"
}

publish_site() {
  "$ROOT/scripts/build.sh"
  local dir="$OUT/$SITE_NAME-update"
  echo "== Site package: $SITE_NAME ($SITE_URL)"
  rm -rf "$dir"
  dotnet publish src/PosApi -c Release --nologo -v q -o "$dir"
  # Never ship settings files: the server's appsettings.json must not be replaced, and the
  # Development / Enzo files hold this Mac's passwords.
  rm -f "$dir"/appsettings*.json "$dir"/*.pdb
  rm -rf "$dir/wwwroot/images"
  [ -f "$dir/wwwroot/sw.js" ] || { echo "wwwroot/sw.js missing: the web build didn't make it in"; exit 1; }
  cat > "$dir/README-UPDATE.txt" <<EOF
SparkPOS v$VERSION update for $SITE_URL   (built $(date '+%Y-%m-%d %H:%M'))
=====================================================================
An UPDATE package for the existing $SITE_NAME site. It has NO appsettings.json:
the server's own file (passwords, Jwt key) stays exactly as it is.
Database changes are not included: run any new numbered .sql file from the repo's
database\\ folder against the site's database by hand, before starting the pool.

Install (admin PowerShell on the server):
  1. Unzip this into  C:\\publish\\$(echo "$SITE_NAME" | tr '[:upper:]' '[:lower:]')
  2. Import-Module WebAdministration
     Stop-WebAppPool -Name "$SITE_NAME"
     Copy-Item "C:\\inetpub\\$SITE_NAME\\appsettings.json" "C:\\inetpub\\$SITE_NAME\\appsettings.server-backup.json" -Force
     robocopy "C:\\publish\\$(echo "$SITE_NAME" | tr '[:upper:]' '[:lower:]')" "C:\\inetpub\\$SITE_NAME" /E /XF appsettings.json
     Start-WebAppPool -Name "$SITE_NAME"
  3. Check: $SITE_URL/health says ok, and $SITE_URL/sw.js opens.

Devices pick up the new version from the "new version" bar (or a reload).
Don't clear site data on a device: that also deletes sales still waiting to send.
EOF
  zip_dir "$dir" "$OUT/$SITE_NAME-update-v$VERSION-$STAMP.zip"
}

publish_printagent() {
  local dir="$OUT/PrintAgent-$SITE_NAME"
  echo "== PrintAgent for $SITE_URL (Windows x64, single exe)"
  rm -rf "$dir"
  dotnet publish src/PrintAgent -c Release --nologo -v q -r win-x64 --self-contained true \
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o "$dir"
  rm -f "$dir"/*.pdb "$dir/web.config"
  # Pointed at this site, shared default key (one PrintAgent per store, or set ApiKey per PC).
  cat > "$dir/appsettings.json" <<EOF
{
  "ApiServerUrl": "$SITE_URL",
  "ApiKey": "",
  "Logging": { "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" } }
}
EOF
  cat > "$dir/README-PRINTAGENT.txt" <<EOF
PrintAgent for $SITE_URL   (built $(date '+%Y-%m-%d %H:%M'))
=====================================================================
1. Copy this folder to the store PC as  C:\\SparkPOS\\PrintAgent
2. appsettings.json already points at $SITE_URL.
   ApiKey "" is right when this is the store's only PrintAgent. With more than one PC,
   give each its own key here AND the same value in Admin -> Terminals -> Print agent key.
3. Run PrintAgent.exe and keep the window open. Check in Chrome on that PC:
   http://localhost:5099/health  must show  "polling":true
4. Admin (sign in as an Admin) -> Terminals -> Edit this PC's terminal:
   Printer target = spool://<the printer's exact name from: Get-Printer | Select Name>
   Paper width = 80mm (or 58mm). Save, then press Test print.
5. Start it with Windows: Task Scheduler -> Create Basic Task -> When I log on ->
   Start a program -> C:\\SparkPOS\\PrintAgent\\PrintAgent.exe, Start in C:\\SparkPOS\\PrintAgent
After changing appsettings.json, close PrintAgent and start it again.
EOF
  zip_dir "$dir" "$OUT/PrintAgent-$SITE_NAME-$STAMP.zip"
}

[ "$WHAT" = printagent ] || publish_site
[ "$WHAT" = site ] || publish_printagent
echo
echo "Done. Packages are in $OUT"
