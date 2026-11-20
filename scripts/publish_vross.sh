#!/usr/bin/env bash
# Packages for the VROSS test site https://vrosspos.itcoresystems.com (database TabletPOS_VROSS).
# Same as publish.sh, with the VROSS site filled in. Output: publish/ (git-ignored).
#   ./scripts/publish_vross.sh              site update package (the default)
#   ./scripts/publish_vross.sh printagent   PrintAgent for a VROSS store PC
#   ./scripts/publish_vross.sh all          both
# SITE_NAME is the IIS site / app pool name used in the README's commands; override it if the
# server uses another, e.g. SITE_NAME=VROSSPOS ./scripts/publish_vross.sh
set -euo pipefail
export SITE_NAME=${SITE_NAME:-VrossPOS}
export SITE_URL=${SITE_URL:-https://vrosspos.itcoresystems.com}
exec "$(dirname "$0")/publish.sh" "$@"
