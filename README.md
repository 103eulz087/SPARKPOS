# TabletPOS v2 — Browser-Based Multi-Branch POS

Touch-first point of sale for tablets and desktops. Built on ASP.NET Core 8 +
SQL Server + React, with an offline-first sales queue, per-branch pricing,
BIR-registered terminals, five discount types, split payment, blind close, and a
controlled End of Day.

---

## What's in the box

```
TabletPOS/
├── TabletPOS.sln              Open this in Visual Studio / Rider
├── database/
│   ├── 01_schema.sql          Tables, TVPs — BranchCode on every transactional table
│   ├── 02_procedures.sql      All stored procedures (business logic lives here)
│   └── 03_seed.sql            3 branches, 3 users, 14 products, 3 terminals
├── src/PosApi/                ASP.NET Core 8 Web API (Dapper + JWT), also serves the SPA
├── src/PrintAgent/            .NET 8 agent on localhost:5099 → ESC/POS thermal printer
├── web/                       React 18 + Vite + Tailwind + Dexie (IndexedDB)
├── scripts/
│   ├── mac-setup.sh           One command to get running on a Mac
│   ├── windows-setup.ps1      One command to deploy on Windows Server
│   └── dev.sh                 Hot-reload development
├── docker-compose.yml         SQL Server + API in containers
└── Dockerfile
```

**Seeded logins — change these immediately:**
`admin / admin123` · `super / super123` · `cashier / cashier123`

---

## Part 1 — Running it on your Mac

Visual Studio for Mac was retired in August 2024, so on macOS use **VS Code**
(free) or **JetBrains Rider**. The solution file still opens in either. You'll
run the actual Visual Studio on the Windows server later if you want.

### Step 1 — Install the prerequisites

```bash
# Homebrew, if you don't have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install --cask dotnet-sdk        # .NET 8 SDK
brew install node                     # Node 20+
brew install --cask docker            # Docker Desktop (for SQL Server)
brew install --cask visual-studio-code
```

Verify: `dotnet --version` (8.x), `node --version` (20+), `docker --version`.

### Step 2 — Turn on Rosetta in Docker (Apple Silicon only)

SQL Server has no ARM build, so it runs emulated. Open **Docker Desktop →
Settings → General** and tick **"Use Rosetta for x86_64/amd64 emulation on
Apple Silicon"**, then **Apply & Restart**. Skip this on an Intel Mac.

### Step 3 — Run the setup script

```bash
cd TabletPOS
chmod +x scripts/*.sh
./scripts/mac-setup.sh
```

It starts SQL Server, waits for it, creates and seeds `TabletPOS`, builds the
front end, copies it into the API's `wwwroot`, and compiles the solution.
First run takes 5–10 minutes, mostly pulling the SQL Server image.

### Step 4 — Start the API

```bash
cd src/PosApi
dotnet run
```

Open **http://localhost:5000** and sign in as `admin / admin123`.

### Step 5 — Start the print agent (optional but recommended)

In a second terminal:

```bash
cd src/PrintAgent
dotnet run
```

You almost certainly have no thermal printer on your Mac, so set the terminal's
printer target to `console` in **Admin → Terminals → Edit → Printer target**.
Receipts then print into the agent's terminal window, which is perfect for
checking the layout.

### Step 6 — Walk the full cycle

Do this once end to end; it exercises nearly every code path.

1. **Admin** → Branches: confirm MAIN, MDU, LAP.
2. **Products**: open Pork Belly → *Branch prices…* — MDU 385, LAP 395 while the
   base is 380. One base price, overrides only where they differ.
3. **Price Lists**: switch between branches and watch the effective column change.
4. **Terminals**: edit MAIN/POS-01, set printer target to `console`, save,
   then hit **Test print** — the agent window should show a test slip.
5. **POS Settings**: leave Retail; note the void-override toggle.
6. Sign out, sign in as `cashier / cashier123` on branch MAIN.
7. **Cash Begin** → POS-01 → 5000 → Open shift.
8. Punch items — type `4800001` and press Enter to simulate a barcode scan. Add
   a Hotdog Jumbo too (it's flagged non-discountable).
9. Tap **Discount** → SENIOR, enter a control number and a name. Only the pork
   line drops; the hotdog stays at full price. That's the per-item rule.
10. **PAY** → add ₱500 cash, then **Add card** for the balance. Complete the sale
    and check the receipt in the agent window: per-item discount lines, control
    number, name, signature line, split tender, VAT breakdown.
11. **Kill your Wi-Fi.** Punch two more sales. The header flips to OFFLINE and
    shows the queued count; OR numbers keep incrementing from the reserved block.
12. Turn Wi-Fi back on and watch the queue drain within about 20 seconds.
13. **Close shift** → enter denominations → Submit. Note that you see no totals —
    only "submitted".
14. Choose **Sign out (EOD later)** to test the recovery path.
15. Sign back in as `cashier`. Cash Begin now shows *"End of Day is still
    pending"* with an EOD button instead of a change-fund field.
16. Click it, enter `super / super123` as the approver, and close the day. The
    Z-Read prints with the discount breakdown, cash-vs-card split, and old/new
    grand totals.
17. Sign in as `admin` → **Z-Read / EOD** to see the completed Z-Read, and
    **Closings** to see the short/over that was hidden from the cashier.

### Step 7 — Verify the data in SQL

```bash
docker exec -it tabletpos-sql /opt/mssql-tools18/bin/sqlcmd -C \
  -S localhost -U sa -P 'YourStrong!Pass1' -d TabletPOS \
  -Q "SELECT BranchCode, ORNumber, NetAmount, DiscountCode, Status FROM dbo.Sales ORDER BY SaleId"
```

Or connect **Azure Data Studio** (`brew install --cask azure-data-studio`) to
`localhost,1433`, user `sa`.

### Day-to-day development

```bash
./scripts/dev.sh     # API on :5000 with hot reload, Vite on :5173
```

Develop against **http://localhost:5173** — it proxies `/api` to the backend and
hot-reloads React edits instantly. Port 5000 serves the last built bundle.

### Handy commands

| Task | Command |
|---|---|
| Stop SQL Server | `docker compose stop mssql` |
| Reset the database completely | `docker compose down -v && ./scripts/mac-setup.sh` |
| Reapply just the procedures | `docker exec -i tabletpos-sql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P 'YourStrong!Pass1' -d TabletPOS < database/02_procedures.sql` |
| Rebuild the front end into wwwroot | `cd web && npm run build && cp -R dist/* ../src/PosApi/wwwroot/` |
| API docs | http://localhost:5000/swagger |

### Alternative: run everything in Docker

```bash
docker compose up -d --build
```

Serves the whole stack at http://localhost:5000 with no local .NET or Node
needed. Slower to rebuild, so it's better for a final check than for daily work.

---

## Part 2 — Deploying to the Windows server

### Step 1 — Prepare the server

Install on the Windows Server box:

- **SQL Server 2019+** (Express is fine) with SQL Server Authentication enabled
- **SQL Server Command Line Utilities** (gives you `sqlcmd`)
- **.NET 8 Hosting Bundle** — <https://dotnet.microsoft.com/download/dotnet/8.0>
- **Node.js 20+** — only needed if you build on the server
- **Visual Studio 2022** — optional; only if you want to edit there

### Step 2 — Copy the solution across

Copy the whole folder to e.g. `C:\Source\TabletPOS`, or clone it from your repo.

### Step 3 — Run the deployment script

Open **PowerShell as Administrator**:

```powershell
cd C:\Source\TabletPOS
.\scripts\windows-setup.ps1 -SqlServer "localhost" -SqlUser "sa" -SqlPassword "YourRealPassword"
```

It creates the database, applies all three SQL files, builds the front end,
publishes the API and print agent to `C:\TabletPOS`, generates a random JWT key,
registers both Windows services, and opens port 5000 in the firewall.

If PowerShell blocks the script:
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`

### Step 4 — Verify

- On the server: <http://localhost:5000>
- From a tablet on the same network: `http://SERVER-IP:5000`
  (find it with `ipconfig`)

Check the services are running:

```powershell
Get-Service TabletPosApi, TabletPosPrintAgent
```

### Step 5 — Harden before going live

1. **Change all three seeded passwords** in Admin → Users.
2. **Create a dedicated SQL login** instead of using `sa`:
   ```sql
   CREATE LOGIN tabletpos WITH PASSWORD = 'a-strong-password';
   USE TabletPOS;
   CREATE USER tabletpos FOR LOGIN tabletpos;
   ALTER ROLE db_datareader ADD MEMBER tabletpos;
   ALTER ROLE db_datawriter ADD MEMBER tabletpos;
   GRANT EXECUTE TO tabletpos;
   ```
   Then update the connection string in
   `C:\TabletPOS\api\appsettings.Production.json` and restart the service.
3. **Add HTTPS.** Tablets on Wi-Fi should not send JWTs in the clear. Put IIS in
   front as a reverse proxy to `http://localhost:5000` with a certificate, or
   use Caddy for automatic certificates.
4. **Back up the database** — a nightly SQL Agent job, or `sqlcmd -Q "BACKUP
   DATABASE..."` in Task Scheduler on Express.
5. **Configure Z-Read email** in the `dbo.EmailConfig` table: set the SMTP
   details, `SendOnEod = 1`, and `IsActive = 1`.

### Step 6 — Set up each till

On every machine with a receipt printer, install the print agent
(`C:\TabletPOS\printagent` and the `TabletPosPrintAgent` service — the script
already does this on the server; copy the folder and repeat `sc.exe create` on
the other tills). Then in **Admin → Terminals**, set that terminal's printer
target:

| Printer type | Target |
|---|---|
| Network thermal printer | `tcp://192.168.1.50:9100` |
| Windows USB/serial (shared to a port) | `file://COM3` |
| Linux USB | `file:///dev/usb/lp0` |
| Testing without hardware | `console` |

Use **Test print** to confirm before the store opens.

### Updating later

```powershell
cd C:\Source\TabletPOS
git pull
Stop-Service TabletPosApi
.\scripts\windows-setup.ps1 -SqlPassword "YourRealPassword"
Start-Service TabletPosApi
```

The SQL scripts are safe to re-run: `01_schema.sql` fails on existing tables
(expected — comment it out on upgrades), `02_procedures.sql` uses
`CREATE OR ALTER`, and `03_seed.sql` is guarded by `IF NOT EXISTS`.

---

## How the important parts work

### Branches and pricing

Every transactional table carries `BranchCode`, so each branch runs
independently — its own OR series, its own End of Day, its own BIR permits —
while head office queries one consolidated database.

Pricing uses a **base price plus sparse overrides**. `Products.BasePrice` is the
single default; `ProductPrices` gets a row *only* where a branch charges
something different. Thirty branches does not mean thirty fields on the product
form. `sp_GetPriceList` resolves `COALESCE(override, base)` and is what a tablet
downloads at shift open.

### Per-item discounts

Five types are seeded: SENIOR, PWD, NAAC, MOV (20%, VAT-exempt) and SOLO (10%).
A discount only touches lines where `IsDiscountable = 1`. Eligible lines have
VAT removed first (`amount / 1.12`), then the rate is deducted; everything else
stays VATable. The receipt prints a `less <TYPE>` line under each discounted
item plus the control number, name, and a signature line.

### Split payment

`SalePayments` holds one row per tender, so a sale can be part cash, part card.
Card rows store bank, reference number, cardholder name and **only the last four
digits** of the card. Card tenders are excluded from expected cash at blind
close, because they never enter the drawer.

### Blind close

`POST /api/shifts/blind-close` accepts denominations only and returns
`{status:"submitted"}` — nothing else. Short/over is computed inside
`sp_ProcessBlindClose` and stored in `ShiftClosings`. The variance report is
rendered server-side and pushed straight to the print agent, so the figures
never touch the cashier's browser or network tab. Reading it back requires
`Admin` or `Supervisor`.

### End of Day

Three paths, one endpoint, one rule — **an approver credential is always
required**, even for an Admin:

1. Cashier runs it at the terminal right after blind close.
2. Cashier forgot and signed out: signing back in, Cash Begin detects the
   `eodPending` state and offers an End of Day button instead of a change-fund
   field. No selling is possible.
3. Admin closes it remotely from **Admin → Z-Read / EOD**, which lists every
   terminal with a blind-closed but unclosed day.

`sp_ProcessEndOfDay` refuses if any shift is still open, locks all shifts for
that date, writes the Z-Read with the discount and payment breakdowns, and rolls
the terminal's grand-total accumulator (old → new) for BIR. After that,
`sp_UpsertSale` rejects any sale for that terminal and date, so a late offline
sync can't silently reopen a closed day.

### Offline behaviour

Sales are written to IndexedDB **first**, then printed, then synced. `SaleUid` is
a client-generated UUID used as the idempotency key, so replaying a batch is
harmless. OR numbers come from pre-allocated per-terminal blocks (`ORRanges`), so
numbering stays sequential and collision-free while offline. Blind close and End
of Day both refuse to proceed while the queue is non-empty — otherwise the
expected cash would be computed against incomplete data.

---

## Still open

The receipt layout lives entirely in two files —
`src/PosApi/Services/ReceiptBuilder.cs` (server: blind close, X-Read, Z-Read) and
`web/src/lib/receipt.js` (client: the sales invoice). When your final BIR receipt
format arrives, those are the only files that change.

Also worth confirming before go-live: whether Solo Parent should be restricted to
specific product categories rather than everything flagged discountable.
