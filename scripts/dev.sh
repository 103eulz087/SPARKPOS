#!/usr/bin/env bash
# Hot-reload development: API on :5000, Vite on :5173 (proxies /api)
set -e
cd "$(dirname "$0")/.."
trap 'kill 0' EXIT
(cd src/PosApi && dotnet watch run) &
(cd web && npm run dev) &
echo "API  http://localhost:5000"
echo "Web  http://localhost:5173   <- develop against this one"
wait
