#!/usr/bin/env bash
# Runs SparkPOS (API + the built web app) on this Mac against a test database on corex.
#   ./scripts/run-local.sh enzo      TabletPOS_ENZO   -> http://localhost:5092
#   ./scripts/run-local.sh vross     TabletPOS_VROSS  -> http://localhost:5093 (ERP: VROSSMIG_STAGING)
#   ./scripts/run-local.sh test      TabletPOS        -> http://localhost:5090
#   add --build to rebuild first (./scripts/build.sh). Stop with Ctrl+C.
#
# Passwords are never saved by this script:
#   - the test server login (testserveruser) is asked for, or read from SPARKPOS_DB_PASSWORD;
#   - the ERP connection comes from src/PosApi/appsettings.Enzo.json (git-ignored).
#
# ENZO / VROSS: the server sites (enzopos / vrosspos.itcoresystems.com) send their sales to
# the ERP, so a local run has ERP posting, ERP auto sync and invoice emails switched OFF.
# What you ring up locally still lands in the queue, and the server site sends it.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

TARGET=${1:-}
BUILD=0
for a in "$@"; do [ "$a" = --build ] && BUILD=1; done

ENZO_FILE="$ROOT/src/PosApi/appsettings.Enzo.json"
erp_from_enzo_file() {
  [ -f "$ENZO_FILE" ] || { echo "Missing $ENZO_FILE (the ENZO ERP connection)"; exit 1; }
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ConnectionStrings"]["Erp"])' "$ENZO_FILE"
}

case "$TARGET" in
  enzo)
    DB=TabletPOS_ENZO; PORT=5092; export ASPNETCORE_ENVIRONMENT=Enzo   # loads appsettings.Enzo.json
    export Erp__PostIntervalSeconds=0 Erp__AutoSyncMinutes=0 Email__InvoiceIntervalSeconds=0 ;;
  vross)
    DB=TabletPOS_VROSS; PORT=5093; export ASPNETCORE_ENVIRONMENT=Vross
    ERP=$(erp_from_enzo_file)
    [[ "$ERP" == *CORECSERP_001* ]] || { echo "appsettings.Enzo.json's Erp connection doesn't name CORECSERP_001"; exit 1; }
    # the same ERP database as the live site https://vrosspos.itcoresystems.com (VROSSMIG_STAGING,
    # found 2026-11-12), not the older CORECSERP_003 restore: one VROSS test, one ERP database
    export ConnectionStrings__Erp="${ERP/CORECSERP_001/${VROSS_ERP_DB:-VROSSMIG_STAGING}}"
    # the live site https://vrosspos.itcoresystems.com posts VROSS sales: off here, like enzo
    export Erp__PostIntervalSeconds=0 Email__InvoiceIntervalSeconds=0
    export Erp__AutoSyncMinutes=0 ;;   # the VROSS sync is slow (~90 s); run it from Admin when needed
  test)
    DB=TabletPOS; PORT=5090; export ASPNETCORE_ENVIRONMENT=Development
    export ConnectionStrings__Erp="${SPARKPOS_ERP_CS:-}" ;;   # blank = ERP link off
  *)
    sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use (another copy running?):"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2
  exit 1
fi

if [ "$BUILD" = 1 ] || [ ! -f src/PosApi/wwwroot/index.html ]; then "$ROOT/scripts/build.sh"; fi

PW=${SPARKPOS_DB_PASSWORD:-}
if [ -z "$PW" ]; then read -rsp "Password for testserveruser on corex.itcoreapps.com: " PW; echo; fi
export ConnectionStrings__Default="Server=corex.itcoreapps.com,1433;Database=$DB;User Id=testserveruser;Password=$PW;TrustServerCertificate=True;Encrypt=False;"
unset PW
export ASPNETCORE_URLS="http://localhost:$PORT"

echo "SparkPOS ($TARGET, $DB) on http://localhost:$PORT   - Ctrl+C to stop"
[ "$TARGET" != test ] && echo "ERP posting, auto sync and invoice emails are OFF here (the server site does them)."
cd src/PosApi
exec dotnet run -c Release --no-launch-profile
