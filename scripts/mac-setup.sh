#!/usr/bin/env bash
# =====================================================================
#  TabletPOS — one-command setup for macOS
#  Starts SQL Server in Docker, creates and seeds the database,
#  builds the front end, and launches the API.
# =====================================================================
set -e
cd "$(dirname "$0")/.."

echo "==> Checking prerequisites"
command -v docker >/dev/null || { echo "Docker Desktop is required: https://www.docker.com/products/docker-desktop/"; exit 1; }
command -v dotnet >/dev/null || { echo ".NET 8 SDK is required: brew install --cask dotnet-sdk"; exit 1; }
command -v node   >/dev/null || { echo "Node 20+ is required: brew install node"; exit 1; }

echo "==> Starting SQL Server (Rosetta emulation on Apple Silicon)"
docker compose up -d mssql

echo "==> Waiting for SQL Server to accept connections"
for i in $(seq 1 40); do
  if docker exec tabletpos-sql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa \
       -P 'YourStrong!Pass1' -Q 'SELECT 1' >/dev/null 2>&1; then
    echo "    ready after ${i}0s"; break
  fi
  sleep 10
  [ "$i" -eq 40 ] && { echo "SQL Server did not start. Try: docker compose logs mssql"; exit 1; }
done

echo "==> Creating and seeding the database"
docker compose run --rm db-init

echo "==> Building the front end"
cd web && npm install --silent && npm run build && cd ..

echo "==> Copying the built front end into the API's wwwroot"
rm -rf src/PosApi/wwwroot
mkdir -p src/PosApi/wwwroot
cp -R web/dist/* src/PosApi/wwwroot/

echo "==> Restoring and building the API"
dotnet build TabletPOS.sln -c Debug

cat <<'MSG'

  Setup complete.

  Start the API:            cd src/PosApi   && dotnet run
  Start the print agent:    cd src/PrintAgent && dotnet run     (optional)

  Then open http://localhost:5000

  Sign in with:   admin / admin123      (Admin)
                  super / super123      (Supervisor)
                  cashier / cashier123  (Cashier)

MSG
