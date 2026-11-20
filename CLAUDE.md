# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# SparkPOS (formerly TabletPOS) — Notes for Claude

Solution root. Components: `src/PosApi` (ASP.NET Core 8 backend), `web/` (React/Vite frontend),
`database/` (SQL Server schema + numbered migrations), `src/PrintAgent` (Windows-only local print
bridge, not used by the Android handheld terminal — see Printing below).

## Work log and tracker (keep them current)

@docs/CLAUDE_WORKLOG.md

- **`docs/CLAUDE_WORKLOG.md`** (loaded above) is the engineering record. It has:
  - one row per migration, with where it's installed;
  - client data changes and code changes, with where they're deployed;
  - "⏰ Reminders";
  - the next free migration number.
- **`docs/tracker/SparkPOS_Daily_Tracker.md`** is for the team, in plain language: "Pending now", "Decisions
  needed" (permanent numbers, Waiting / Decided / Dropped) and "Daily progress".
- Both copy the ERP side's layout (11-20). Update both whenever a change is written, installed or deployed,
  a decision is made, or a concern is raised or closed.
- **The team's copy** is the page https://claude.ai/artifact/PZf5BpR9vuAVQfVBsG4CYs (the Claude Docs connector
  wasn't available). It renders the published `tracker.md`, so after editing the repo file, republish only
  that file with the Artifact tool: `url` = the page, `files` =
  `{"tracker.md": "docs/tracker/SparkPOS_Daily_Tracker.md"}`. It's private until the user shares it.

## Commands

There is **no linter** and no app-level test project. The only automated tests are SQL scripts in
`database/tests/` (`acc_tests.sql` accounting, `bir_tests.sql` SI numbers/returns/guards,
`erp_sync_tests.sql` ERP master data + prices, `erp_users_tests.sql` ERP users, `branch_tests.sql`
who may open a shift where, and the later loyalty / e-invoice / zero-rated / other-discount /
price-level / discount-cap / wholesale / promo suites): every batch is
rolled back, and each result row must show `Pass = 1`. Otherwise, verification is `dotnet build` + `npm run build`, plus
direct `sqlcmd` execution of any new SQL (see the `LineNo` sections below for why a clean
compile proves nothing about raw SQL).

- **Build / publish / run scripts** (2026-11-06):
  - `./scripts/build.sh` builds the web app into `src/PosApi/wwwroot` (keeps `wwwroot/images`)
    and the API in Release.
  - `./scripts/publish.sh [site|printagent|all]` runs the build and writes zips to `publish/`
    (git-ignored). `site` is an IIS **update** package with no `appsettings*.json` and no
    `wwwroot/images`, plus a `README-UPDATE.txt`. `printagent` is a win-x64 single exe whose
    `appsettings.json` already points at the site. The defaults are `SITE_NAME=EnzoPOS` and
    `SITE_URL=https://enzopos.itcoresystems.com`; override both for another site.
  - `./scripts/publish_vross.sh [site|printagent|all]` is the same script with the VROSS
    site filled in: `SITE_NAME=VrossPOS`, `SITE_URL=https://vrosspos.itcoresystems.com`. That
    IIS site has been live since 2026-11-10 with its own server `appsettings.json`, and it is now
    the VROSS ERP poster. So `run-local.sh vross` runs with ERP posting, auto sync and invoice
    emails off (since 2026-11-15), like `enzo`.
  - **VROSS's ERP database is `VROSSMIG_STAGING`** (erp.itcoreapps.com,4283), not CORECSERP_003.
    That's where the live vrosspos site posts, per the ERP session on 2026-11-12. The older
    CORECSERP_003 restore has no SparkPOS sales from it. `run-local.sh vross` uses
    VROSSMIG_STAGING (override with `VROSS_ERP_DB`).
  - VROSS box→pieces ([284], AUTO_BREAK_PACK = 1) is on both. Only box 10825 → piece 41234 × 6
    (a sample row) is linked so far: SI 8 on SP-V02 opened that box on 2026-11-12. A product with
    no box link, e.g. 16292 MAGIC SARAP, can never break a box; it just goes short.
  - `./scripts/deploy.sh vross|enzo [--no-build] [--rollback]` (2026-11-19, not yet run against the
    server): builds the update package and installs it over **SSH** (OpenSSH Server on the IIS box,
    key login; host/user in git-ignored `scripts/deploy.env`). It copies
    `scripts/server/Deploy-SparkPOS.ps1` to `C:\deploy` and runs it: unzip to `C:\deploy\staging`,
    check it's a site package with no appsettings, back the site up to `C:\deploy\backups` (last 5),
    stop the pool, robocopy without `appsettings*.json` / `images` / `logs`, start the pool, check
    `/health`. Migrations stay separate (run first). The server's one-time setup is the user's.
  - `./scripts/run-local.sh enzo|vross|test [--build]` runs the API on 5092 / 5093 / 5090
    against the corex test DB.
    - It asks for the testserveruser password, or reads `SPARKPOS_DB_PASSWORD`, and never
      stores it.
    - The ERP connection comes from `appsettings.Enzo.json`; `vross` swaps the catalog to
      CORECSERP_003.
    - `enzo` runs with ERP posting, auto sync and invoice emails off, because the IIS site does
      those.
- **User guide screenshots and videos** (2026-11-10): the project skill
  `.claude/skills/sparkpos-user-guide`.
  - It drives the app in headless Chrome from scenario JSON files and makes PNGs plus captioned
    MP4s for the "SparkPOS User Guide" Claude Doc's Picture guide tab. Its tools live in
    `~/.cache/sparkpos-guide`.
  - It records only on a local copy (`run-local.sh enzo`), on the recording terminal 023/POS-DEMO
    (TerminalId 9 in TabletPOS_ENZO), or POS-DEMO2 / POS-DEMO3 (ids 10, 11) for more recordings on the same date.
    Both have ERP posting off, printer `console` and agent key `demo-capture`.
  - POS-DEMO is hidden from Cash Begin except while a recording runs (`demo-terminal.mjs on|off`).
  - A recorded day closes POS-DEMO for that date.
- **Hot-reload dev**: `./scripts/dev.sh` — API on `:5000` (`dotnet watch run`), Vite on `:5173`
  (proxies `/api` → `:5000`). Develop against `:5173`; `:5000` serves the last built bundle.
- **Local SQL Server** (Mac, via Docker): `./scripts/mac-setup.sh` first time (starts
  `tabletpos-sql`, creates + seeds DB, builds frontend into `wwwroot`). Reset:
  `docker compose down -v && ./scripts/mac-setup.sh`.
- **Run a SQL file against local Docker DB**:
  `docker exec -i tabletpos-sql /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P 'YourStrong!Pass1' -d TabletPOS < database/02_procedures.sql`
- **Backend only**: `cd src/PosApi && dotnet run` (Swagger at `/swagger` in Development).
- **Frontend build into API**: `cd web && npm run build && cp -R dist/* ../src/PosApi/wwwroot/`
  (`wwwroot` is gitignored — it's a build output).
- **PrintAgent locally**: `cd src/PrintAgent && dotnet run`; set a terminal's printer target to
  `console` in Admin to see receipts in the agent window without hardware.
- Seeded logins: `admin/admin123`, `super/super123`, `cashier/cashier123` (seed rows store
  `SEEDPWD`; `DbBootstrap` replaces them with real hashes on API startup).

## Architecture overview

- **Backend** (`src/PosApi`): controllers inherit `ApiControllerBase` (JWT claims → `UserId`,
  `Branch`, `IsPrivileged`; `VerifyApproverAsync` for supervisor overrides; `AuditAsync` →
  `dbo.AuditLogs`). Data access is **raw SQL via Dapper** on `Db.Open()` — no EF, no repository
  layer. Heavier business logic (sale upsert, blind close, EOD, price list) lives in **stored
  procedures** in `database/02_procedures.sql`, not in C#. The API also serves the SPA from
  `wwwroot` with `MapFallbackToFile("index.html")`.
- **Frontend** (`web/src`): only a handful of files carry the logic — `lib/api.js` (fetch
  wrapper, Dexie/IndexedDB offline store, sync loops, printing via RawBT/PrintAgent),
  `lib/store.js` (Zustand cart + `computeTotals()` discount/VAT engine), `lib/receipt.js`
  (client receipt formatters). Pages map 1:1 to the cashier flow: `Login → CashBegin → Pos →
  BlindClose → EndOfDay`, plus `Admin.jsx` (one large file, all admin tabs).
- **Offline-first sales**: sales are written to IndexedDB first, then printed, then synced to
  `/api/sales/sync`. `SaleUid` (client UUID) is the idempotency key; OR numbers come from
  pre-allocated per-terminal blocks (`ORRanges`). Blind Close and EOD refuse while the queue is
  non-empty; `sp_UpsertSale` rejects sales for a terminal/date already closed by EOD.
- **Branch model**: every transactional table carries `BranchCode`. Pricing = `Products.BasePrice`
  plus sparse `ProductPrices` overrides, resolved by `sp_GetPriceList` and downloaded at Cash Begin.
- **Schema changes**: add a new numbered, idempotent migration in `database/` **and** mirror it in
  `01_schema.sql` (and `02_procedures.sql` for procs) so fresh installs match upgraded ones.
- **Accounting** lives in its own `acc` SQL schema (Addendum B, specced in the root-level
  `CLAUDE-CODE-ADDENDUM-B-accounting-module.md`). End of Day posts one summary journal entry per
  terminal per day. See "Accounting module (Addendum B)" near the end of this file.

## Deployment — read this before touching prod

- **Real server paths**: site root is `C:\inetpub\TabletPOS`, IIS app pool is `TabletPOS`.
  `C:\publish\tabletpos` is only ever the *local dev-machine* staging folder from
  `dotnet publish` — never the server. Confusing the two cost a long debugging detour once
  already; don't repeat it.
- **Full backend+frontend redeploy**:
  ```powershell
  Import-Module WebAdministration
  Stop-WebAppPool -Name "TabletPOS"
  Copy-Item "C:\inetpub\TabletPOS\appsettings.json" "C:\inetpub\TabletPOS\appsettings.server-backup.json" -Force
  robocopy "C:\publish\tabletpos" "C:\inetpub\TabletPOS" /E /XF appsettings.json
  Start-WebAppPool -Name "TabletPOS"
  ```
  **Never overwrite `appsettings.json`** on the server — its DB connection string and JWT key
  differ from dev's. `/XF appsettings.json` on robocopy is mandatory.
- **Frontend-only changes**: `npm run build` in `web/`, copy `dist\*` into
  `C:\inetpub\TabletPOS\wwwroot\`. No app pool stop needed.
- **Database migrations are separate, manual steps** — numbered files in `database/`
  (`04_`, `05_`, `06_`, `07_`...) must be run via `sqlcmd` against the server DB. Deploying
  code does **not** apply them.
- **PWA caching on the handheld terminal is aggressive** — after a redeploy, a hard refresh
  is sometimes *not* enough to load new code; clearing the site's cache/data (Chrome site
  settings, or reinstalling the home-screen shortcut) may be required. This caused at least
  one "the fix didn't work" false alarm — always confirm the device is actually running the
  new build before trusting a negative test result. **Since v2.1.0 (service worker, see below)**
  a device shows a "new version" bar and loads it when tapped. Don't clear site data any more:
  it also deletes sales still waiting to send.
- The original 405-on-PUT error was **not** WebDAV (not installed on this server) — it was
  IIS Request Filtering / Handler Mapping restricting verbs at the site level. Fixed via IIS
  Manager, not code.

## Status 2026-10-27: ENZO parked as a draft, VROSS next

The user parked ENZO (final touches pending: the open list sent to the ERP session that day) and
moved to VROSS. The ERP side of SparkPOS is installed on the VROSS restore
(`erp.itcoreapps.com,4283` / `CORECSERP_003`), identical to ENZO.
- **Not set up yet:**
  - `SPARKPOS_BRANCHES` is empty, so posting is off.
  - `SPARKPOS_KG_CATEGORIES` is empty.
  - No SQL login is mapped to `sparkpos_app` there. Own login vs the existing `sparkpos` is
    the user's call; a separate one is recommended.
- **Differences from ENZO:**
  - real ERP cashiers (398 with isCashier, 121 branch officers)
  - no combos
  - 29 desktop machines (5 per branch at 001/002/003/005/006)
  - no Xero
  - 4,437 product rows without a VAT flag
- **SparkPOS test setup for VROSS (built late 2026-10-27, setup decisions by the ERP session,
  approved by the user):**
  - Own DB `TabletPOS_VROSS` on the test server (01 → 02 → `03_seed_erp`; all 5 SQL suites pass).
  - The API runs with `ConnectionStrings__Erp` = the ENZO `sparkpos` string with the catalog set to
    `CORECSERP_003`, built from `appsettings.Enzo.json` in the shell, never written to a file.
    `Erp__AutoSyncMinutes=0`.
  - Branch 003: local `super`/`cashier`, scale prefix 25 (5/5/3), SC/PWD at the statutory default
    (no `DiscountCategoryRates`).
  - Terminals POS-01/02 = SP-V01/SP-V02 with test BIR values (`TEST-MIN-003-SPV1`, …), posting on.
  - **Size:** 12,545 products and 248,768 price rows. The first sync took 68 s; a no-change re-sync
    takes ~90 s. The local apply step (`sp_ErpSyncMasterData`) got its own 600 s timeout
    (`ApplyTimeoutSeconds`), since 60 s timed out. Make the price sync lighter (e.g. skip unchanged
    rows before the MERGE, or per branch) before turning auto sync on there.
  - **Users:** the ERP returns 88 Admins, no one at 003 (sent to the ERP session).
  - **Duplicate barcodes:** 7 barcodes shared by 2 products each, so all 14 products are not
    imported at all.
  - **Test day 2026-10-27 on SP-V01:** cash, card and split sales, a weighed sticker, a
    400-piece no-stock sale, a void, two shifts with a return, and the Z-Read. All posted, 15/15.
    The ERP verified it (Exception Center clean apart from the local-supervisor review flags;
    Z-Read net matches; the desktop copies are there). Every line came back short because the
    test items aren't stocked at VROSS, not because of a fault. For a retest with stock, use items
    003 sells: PASAYAN 12151 (kg), TANGLAD 12773, REPOLYO 12888, PATATAS 12912, LETTUCE 44660.
  - The 88 ERP Admins are VROSS's own flags (isAdmin is used widely there); head office corrects
    them before go-live. Until then, use local users at VROSS. The skipped price and barcode rows
    are on VROSS's cleanup list.

## ENZO test site: https://enzopos.itcoresystems.com (being set up, 2026-10-27)

The user's own IIS server (it also hosts https://corexrpt.itcoresystems.com) gets a separate site
`EnzoPOS` (folder `C:\inetpub\EnzoPOS`, app pool `EnzoPOS`) on the ENZO test DB
`TabletPOS_ENZO`, so the team can test the ENZO setup from their own devices (test manual by
the ERP session).
- **The package** is a framework-dependent `dotnet publish` plus the web build in `wwwroot`. It
  has a server-only `appsettings.json`: two `<SET_PASSWORD>` placeholders the user fills in, and
  its own new `Jwt:Key`. The dev / `Enzo` settings files are removed from the package. Full steps
  are in the package's `README-DEPLOY.txt`.
- **The app pool must not idle:** `AlwaysRunning`, idle time-out 0, site Preload. ERP posting,
  ERP auto sync and invoice emails are background workers and stop when the pool idles out.
- **Only one copy of the ENZO API may run against `TabletPOS_ENZO`.** Once the server site is
  live, stop the developer Mac's local one (port 5092), so two ERP posting workers don't work
  the same queue.
- Updates: same robocopy `/XF appsettings.json` procedure as TabletPOS (see Deployment above).
- **Terminals are Admin-only to save** (`TerminalsController` Create/Update/send-to-erp). A
  Supervisor saving one got a bare 403 on the live site (2026-11-06, user `super`); the
  Terminals tab is now read-only for Supervisors (Test print stays), and `api()` turns a bodyless
  403 into "Your account isn't allowed to do this".

## Provisioning a new client (multi-tenant by copy, not by code)

There is no multi-tenancy in the app itself — a new client (first one: "OneLovePOS") gets its
own fully separate deployment: copy the `TabletPOS` folder, rename it, point its
`appsettings.json` at that client's own database, and give it its own IIS app pool + site. Same
codebase, completely isolated runtime/DB/site per client. Steps, in order:

1. Copy the deployed folder (e.g. `C:\inetpub\TabletPOS` → `C:\inetpub\OneLovePOS`).
2. Create and run a **fresh** database for this client (see "Standalone install" pattern
   elsewhere in this file if one exists, or: `CREATE DATABASE`, then `01_schema.sql` →
   `02_procedures.sql` → `03_seed.sql`, in that order, nothing else needed for a brand-new DB).
3. Edit the copied `appsettings.json` — new `ConnectionStrings:Default` (new DB), a **freshly
   generated** `Jwt:Key` (never reuse another client's — the whole point of a per-client
   secret is that one client's tokens must never validate against another client's API).
4. IIS Manager: new Application Pool (e.g. `OneLovePOS`, matching TabletPOS's settings — No
   Managed Code, since ASP.NET Core doesn't use the classic CLR pipeline), new Site pointing at
   the copied folder, its own port/binding.
5. **Grant the new app pool's identity NTFS write access to its own `wwwroot` — this step is
   easy to miss because most of the app doesn't need it.** Confirmed on the OneLovePOS
   provisioning: Products/Categories CRUD worked immediately after steps 1-4 (that's pure SQL,
   no filesystem write), but product photo upload (`ProductsController.UploadImage`,
   `Path.Combine(AppContext.BaseDirectory, "wwwroot", "images", "products")`) returned 500 —
   because a brand-new app pool gets its own distinct identity (`IIS APPPOOL\<poolname>`,
   different from `IIS APPPOOL\TabletPOS`), and copying the folder does **not** copy whatever
   one-off permission grant originally made this work on the TabletPOS site. Any code path that
   touches disk (today: just image upload) needs this repeated per client:
   ```powershell
   # Run in an ELEVATED PowerShell (Run as Administrator) — icacls fails with a plain
   # "Access is denied" if the session isn't elevated, even for an admin account; this was
   # the actual failure on the first attempt during OneLovePOS's setup, not a wrong command.
   icacls "C:\inetpub\OneLovePOS\wwwroot" /grant "IIS APPPOOL\OneLovePOS:(OI)(CI)M" /T
   ```
   Swap the pool name/path per client. This assumes the app pool was left on the default
   `ApplicationPoolIdentity` — if a custom identity was set instead, grant that account.
6. If a photo upload still 500s after the permission grant, get the real exception instead of
   guessing further: flip `stdoutLogEnabled` to `true` in that site's `web.config`, create a
   `logs` folder next to the exe, reproduce once, read the exact .NET exception from
   `logs\stdout*.log` — could be IIS's own `maxAllowedContentLength` rejecting the upload before
   the app even runs, which looks similar from the browser but isn't the same fix.
7. This client also needs its own `PrintAgent` setup per terminal (see the Printing sections
   below) — nothing there is shared across clients either, each terminal polls its own client's
   `ApiServerUrl`.

## The Android handheld terminal (TC-TOUCH-T3, 5.5" portrait, 58mm embedded printer)

- Cashier-facing screens are phone-responsive (Login, Cash Begin, POS, Blind Close, End of
  Day). The Admin console's shell became responsive on request (2026-11-15, see "Admin console
  layout"); its forms and tables are still laid out for a desktop (tables scroll sideways).
- This device's Chrome/WebView has a **limited font** — confirmed the "⋮" (vertical
  ellipsis, U+22EE) glyph doesn't render (shows as a blank box). Use inline SVG icons for any
  new UI symbol on cashier screens, not Unicode characters, unless it's very common
  punctuation (em-dash, ellipsis, ×, checkmark have all rendered fine).
- PWA install (Add to Home Screen) is what removes the address bar — opening the site as a
  normal browser tab will always show it regardless of manifest config.

## Printing — the hard-won part (TC-TOUCH-T3, 5.5" portrait, 58mm embedded printer)

**No vendor SDK, no local HTTP API.** RawBT's listed "connection methods" (Bluetooth/WiFi/
Ethernet/USB/AIDL) are how RawBT talks to the **printer hardware**, not an inbound API for
other apps — AIDL specifically requires a native Android app, unusable from a web app. The
only viable integration is the `rawbt:` URL scheme via `window.location.href`, fired from the
browser running **on that device** — server-side code can never reach it directly.

- **Correct URL form**: `rawbt:base64,<data>` — opaque URI (single colon, no `//`). The
  hierarchical form `rawbt://base64,...` gets misparsed by RawBT (sees `//base64,...` as the
  payload, fails its prefix check, prints the literal string instead of decoding it).
- **Confirmed, fixed bug**: base64 payloads ending in **double `==` padding** reliably fail
  with RawBT's "Wrong data to printing" error; single `=` or no padding succeeds. Proven via
  controlled A/B testing (product names differing by exactly one character, which shifts the
  base64 mod-3 padding class, reliably flipped the result). Fix already applied: strip
  trailing `=` before sending (`web/src/lib/api.js`, `bytesToBase64()`).
- **RawBT device settings that matter** (its own Settings app, not our code):
  - **Print Coding Format must be UTF-8** — it defaulted to **GBK** (Chinese encoding) on
    this device, which caused 100% print failure until changed. Our code always sends UTF-8
    (`TextEncoder` has no other mode).
  - **Instruction setting must stay ESC-POS**, not TSPL (TSPL is for label printers).
  - **"Don't asking before opening url"** (Advanced settings) should stay checked to
    suppress an intermittent confirmation dialog.
  - **Paper cut** is RawBT's own setting, separate from our own `GS V B` cut command sent in
    the byte stream — currently set to "no — Do not cut" since we send our own cut command;
    don't let both fight if this changes.
- **Dead ends — do not retry without new evidence**:
  - Chunking the print into several smaller `rawbt:` calls "fixed" wrong-data errors but
    caused a visible pause in physical printing between chunks. Reverted.
  - Plain-text mode (`rawbt:<urlencoded text>`, no base64) was tried based on indirect
    evidence (RawBT's own document header/footer settings suggested a text-first design) but
    was **never confirmed against real RawBT documentation**, and it broke printing
    completely. Reverted. If revisited, verify the exact syntax first.
  - Theories that looked plausible but were disproven by controlled testing: receipt
    length/URL-length ceiling, and print order within a session (first-vs-second print).
    Neither held up. The padding theory is the one that's held.
- **No success/failure feedback** — `printText()`/RawBT calls always return optimistically;
  there's no channel to confirm paper actually printed, only that the handoff happened.
- Server-initiated prints (X-Read, End of Day) can't reach RawBT directly. Fixed by having
  the API return `receiptText` in its response, and the client (`Pos.jsx` for X-Read,
  `EndOfDay.jsx` for Z-Read) triggers the RawBT print itself when `PrinterTarget` starts with
  `rawbt`.
- **Blind Close intentionally never prints via RawBT** on this terminal — preserves the
  "cashier never sees drawer variance" guarantee, since RawBT printing requires the data to
  reach the browser, which would break that guarantee. Variance stays server-print-only
  (silently no-ops on a RawBT terminal, by design); a supervisor can view/reprint it from
  Admin on another device.

## Two independent receipt/report formatters — don't fix one and forget the other

- `web/src/lib/receipt.js` — client-side, builds **sale receipts** (and the offline X-Read
  fallback). Was hardcoded 32 characters wide (confirmed via a printed dash separator
  overflowing by exactly 8 chars: 40−8=32, the original bug was `W=40`) — now configurable
  per terminal, see "Configurable paper width" below; 32 stays the default.
- `src/PosApi/Services/ReceiptBuilder.cs` — server-side, builds **X-Read, Z-Read, Blind
  Close** printed text. Was also hardcoded 32-wide (same bug, fixed separately — this file
  was missed in the first pass and only found when Z-Read printing showed the same
  dash-overflow symptom weeks later) — now configurable the same way as `receipt.js`.
- `receipt.js`'s `lr(label, value)` had a bug where the common case silently dropped the
  `value` argument entirely (missing `+ r`) — every price/total on a sale receipt was blank
  whenever the line fit within width. `ReceiptBuilder.cs`'s equivalent `LR()` never had this
  bug (independently written). Found via the on-screen `<Paper>` receipt preview (wired into
  Reprint) showing labels with no values.
- Emailed reports (Blind Close report, EOD Z-Read) use a **third**, HTML-table set of
  methods in `ReceiptBuilder.cs` (`XReadEmailHtml`, `ZReadEmailHtml`, `ItemsTableHtml`,
  `HourlyTableHtml`) — these are not width-constrained and render as real `<table>`s with
  inline styles (email clients don't reliably support `<style>` blocks). The **printed**
  receipt stays plain 32-column text regardless; only the email got richer.

## Settings that are easy to confuse

- **`EmailOnBlindClose`** (Admin → POS Settings → Transaction controls) and **`SendOnEod`**
  (Admin → Email) are separate, independent controls. Checking one does not affect the
  other. Blind Close's report includes X-Read + item summary + hourly breakdown; EOD's
  includes Z-Read + item summary (no hourly — not part of the EOD spec).
- **`EodOverride`, `VoidOverride`, `PriceEditOverride`, `ReprintOverride`** all follow the
  same pattern: `needsOverride && !IsPrivileged` — an Admin/Supervisor performing the action
  themselves never needs a separate credential, regardless of the setting.
- The "test email" feature (Admin → Email → Send test email) deliberately does **not**
  check `SendOnEod` — it only confirms SMTP connectivity. Confirming test email works never
  proves `SendOnEod` is actually on.

## Branding: TabletPOS → SparkPOS (by ITCORE Solution Inc.)

Logo assets, PWA manifest, page titles, in-app headers updated. **Deliberately left as
"TabletPOS" internally** — these are infrastructure identifiers, not display text, and
renaming them has real operational risk:
- Dexie/IndexedDB database name (`web/src/lib/api.js`) — risk of losing offline-queued sales
  on devices that already have pending data.
- SQL Server database name (`appsettings.json`) — would require an actual DB rename.
- JWT issuer claim (`appsettings.json`) — would invalidate every active session.

## "Night counter" theme (2026-10-27)

The whole app (sign-in, cashier screens, Admin) is a dark theme, chosen by the user from three
mock-ups (design canvas: https://claude.ai/artifact/QAJNj3RnG5rgRRXfZtLR93).
- **Use the semantic colors in `web/tailwind.config.js`** (`ink`, `panel`, `raised`, `line`,
  `line2`, `fg`, `fg2`, `muted`, `accent`, `brand`, `danger`, `warn`), not raw `stone`/`emerald`
  shades. The action color is the SparkPOS green (`bg-accent text-ink`); white text on it fails
  contrast. Printed-paper previews (`Paper`) stay white.
- Fonts are **bundled** (`@fontsource/inter`, `@fontsource/montserrat` in `index.css`), not
  Google Fonts, so the handheld has them offline. `font-display` = Montserrat for headings and
  totals.
- `Ui.jsx` adds `Wordmark`, `StatusPill`, `Cube` (the logo's shape as decoration) and
  `ProductThumb`: a product with no photo (or one that fails to load offline) gets a tile tinted
  by its category, with its initials.
- **The product grid shows at most 60 tiles** (`GRID_LIMIT`, 2026-11-19): VROSS tills load ~11,400
  items, and the grid drew a tile for each and redrew all of them on every scan (Pos re-renders on
  each cart change). Timed in headless Chrome: 11,384 tiles 418 ms on a Mac, ~2.4 s at 6x CPU
  slowdown, vs 2 / 16 ms for 60. A note under the grid says "Showing 60 of N…"; search, scan and
  categories still cover every item. `ProductGrid` is `React.memo` with a stable `onTap`
  (`cart.addProduct`), so a cart change no longer redraws it.
- Pos.jsx icons are inline SVG paths in `ICONS` (the handheld font limitation). `ProductFinder`
  (search + category pills) is shared by takeout and dine-in.
- Two layout bugs were found while checking the screens at ENZO size:
  - With hundreds of products, the product grid squeezed its rows to zero height (tiles became
    thin lines). It's fixed with `auto-rows-max`.
  - The Dashboard's 7-day bars never showed (a % height with nothing to measure against).

## Grocery lane screen per terminal (built 2026-11-19)

The user: in a grocery, shoppers want to see each item punched, and the Touch screen's narrow cart
panel is too small for that. They picked mock-up B (classic lane) from
https://claude.ai/artifact/7pYee2neSgiD11TMHf4Ji1 (row 2, with the amount due box 132 px high and
the deductions large). Migration `database/37_terminal_screen_layout.sql` (mirrored in `01_schema.sql`;
no procedure changes) adds `Terminals.ScreenLayout` (NULL = Touch, `'Grocery'`).
- **Admin → Terminals**: a "Screen layout" field and a Screen column. The DTO's `ScreenLayout` is
  `'Touch'`/`'Grocery'`; **null = unchanged** (an older Admin sends none). Grocery is refused without 37.
- **Till** (`GroceryLane` in Pos.jsx): used when the terminal is Grocery **and the screen is at least
  1024 px wide** (the handheld and narrow windows keep Touch), and not in dine-in table screens.
  - **Scan box:** "6*code" = 6 of that item. Typing a name shows up to 8 matches (↑ ↓ Enter).
  - **"Last" strip:** shows the line just added or raised.
  - **Item table** (#, description, qty, unit price, Less, amount). Each line's discount, promo or
    wholesale is written under it, from `laneLineInfo()` and the same `totals.perLine` the sale saves:
    - 20% shows the discount, with "VAT removed −x";
    - 5% shows what came off the line;
    - wholesale shows WHS.
  - **Right side:** a sale card (discount holder and booklet/cap, customer, suki, price level, promo
    hints, wholesale savings), then the deductions as the invoice prints them, VATable/VAT/exempt,
    then AMOUNT DUE with "Saved ₱" (bill savings + wholesale).
  - **Function keys** (buttons and keyboard, only while no dialog is open):
    - F1 Find item: the old product grid in an overlay;
    - F2 Qty, F3 Price (or the line's price level), F4 Discount, F5 Customer;
    - F6 Remove: the selected line (click or ↑ ↓; it defaults to the last one);
    - F7 More: suki, zero-rated, price level, X-Read, Return, Cancel sale;
    - F8 Reprint, F9 Void, F10 Hold / Recall (see "Hold and Recall"), F12 PAY.
  - The scan box gets the focus back whenever a dialog closes.
- **Verified:**
  - In headless Chrome on the built app with a mocked API, a senior sale with promo, wholesale,
    5% and 20% lines gives amount due 6,172.39, matching the cart math. The F-keys work, F5 doesn't
    reload, and there's no sideways scroll at 1024 / 1280 / 1366 / 1920. Under 1024 px it falls back
    to Touch.
  - 37 is installed on TabletPOS, TabletPOS_ENZO and TabletPOS_VROSS. No terminal is set to Grocery.
  - The save SQL was tested in a rolled-back transaction.
- **Not verified:**
  - On a real till with a scanner.
  - Whether F12 opens Chrome's DevTools on the till PCs instead of PAY. The on-screen PAY always
    works. DevTools can be switched off by Chrome policy.
  - The Admin field, through a running API.

## Discounted sales print a customer and an accounting copy (2026-11-20)

The user: a sale with a discount, any type, prints twice: "CUSTOMER COPY" and "ACCOUNTING COPY". Web only.
- `discountCopies()` / `hasDiscountCopies()` (receipt.js): when the sale has a discount code (SC, PWD, NAAC, MOV,
  Solo parent, or regular / other) and a discount above 0, `completeSale` sends **one** print job: the label,
  the invoice, a feed and a paper cut (`GS V 1`, no NUL byte so the server's print queue keeps it), then the
  label and the same invoice. One job, so the drawer opens once and nothing prints between the copies.
- Not counted as a discount for this: promo-free items and wholesale prices alone (no discount type chosen).
- The stored invoice (`Sales.ReceiptText`) stays the single unlabelled text; a reprint prints one copy, marked
  REPRINT. The handheld (RawBT) gets the same single job.
- Verified in headless Chrome with a mocked PrintAgent: Senior and regular / other sales → one job, two
  labelled identical copies with a cut between; a sale with no discount → one plain copy. Not on a real printer.

## X-Read, Z-Read and Blind Close add up on paper (2026-11-20)

The user saw the three reports (rendered with the real `ReceiptBuilder` and a sample day) and asked to fix what
didn't add up. `ReceiptBuilder` (print and email), `sp_rpt_XRead` (+ `ChangeGiven`), `sp_ProcessEndOfDay`'s result
and the Z-Read reprint query (+ `ChangeGiven` from the day's Completed sales), `sp_GetShiftVariance` (+ `GcSales`).
No migration; re-run `02_procedures.sql` (done on all three test DBs 11-20).
- X-Read / Z-Read: GROSS SALES, LESS DISCOUNTS, **LESS VAT (SC/PWD)** (gross − discounts − net), NET SALES; the
  payment breakdown is CASH RECEIVED, **LESS CHANGE GIVEN**, CASH SALES, CARD, GIFT CERT, **TOTAL** (= net).
  `CashSales` in `ZReads` / the X-Read is still what was received (change included); only the print changed.
  "DRAWER OPENED, NO SALE" moved to the counts.
- Blind Close: CASH BEGIN, CASH RECEIVED, LESS CHANGE GIVEN, LESS CASH REFUNDS, EXPECTED CASH, then DECLARED and
  SHORT/(OVER), then "NOT IN THE DRAWER": card and gift certificates. The change line is worked out from the
  stored figures (begin + received − refunds − expected), so it always adds up to the stored expected cash.
- The three X-Read result-shape tests (promo, other_discount, drawer) got the `ChangeGiven` column. All suites
  pass (194 × 3). Checked on the real GC test day (TabletPOS 001 POS-02, 11-20): 100 − 60 + 860 = 900 net.

## Price level by time of day (built 2026-11-20)

The user: the default is the regular price (SellingPrice), and at e.g. 7 PM the till switches to Price 1 by
itself. Their calls: **per branch and per terminal** (the GRILLS tills have their own; one schedule can also
cover every branch), a **start and end time on chosen days**, a **sale being rung up keeps its prices** (the
next sale switches), and the **cashier can still put a sale back** to the regular price. Migration
`database/40_price_schedules.sql` (mirrored in `01_schema.sql`; no procedure changes).
- **`dbo.PriceLevelSchedules`**: BranchCode (NULL = every branch), TerminalId (set = that till only; its
  branch is taken from the terminal), PriceLevel 1-4, StartTime / EndTime (TIME, **end not included**; an end
  before the start runs past midnight, so 19:00-00:00 = until midnight), Days (7 × Y/N, Monday first),
  IsActive, Note. **A till follows its own schedules if it has any, else its branch's, else every branch's.**
- **API** `PriceSchedulesController`: `GET /api/price-schedules/terminal/{id}` (any user: the switched-on
  ones that till follows), `GET` list (Admin / Supervisor), POST / PUT / DELETE (Admin; audited
  `PRICE_SCHEDULE_SAVE` / `_DELETE`). Admin → Price Lists → "Price level by time of day".
- **Till**: the schedules load with the POS screen (`ctx.priceSchedules`, cached for offline).
  `scheduledLevel(schedules, now)` (store.js) gives the level in effect by **this device's clock** (when two
  overlap, the one that started last wins); it's checked every 30 s. The cart remembers who set the sale's
  level (`priceLevelBy`: 'schedule' / 'cashier'); the schedule applies only to an **empty** cart whose level
  the cashier didn't pick, so a sale in progress keeps its prices, and a cashier's choice (incl. back to the
  regular price) holds until that sale ends. A toast says "From the next sale: Price 1 (scheduled)". A
  dine-in bill (Generate Bill) takes the scheduled level. No approval for the scheduled level (the Price level
  approval still applies to a cashier picking one). The sale sends its level as before; the ERP takes
  SellingPrice or that level's PriceN. An item without that level sells at its regular price.
- **Verified:** `scheduledLevel` in Node (11: edges, weekdays, past midnight, overlaps); HTTP on a local API
  against TabletPOS (14: every-branch / branch / terminal fallback, switching off, validation, Admin only;
  test rows deleted, `zz.gc*` users off again); the till in headless Chrome (Price 1 on an empty cart, ₱180
  vs ₱200, an item without Price 1 unchanged; the cashier back to regular survives the 30 s check; a sale in
  progress at the start minute keeps its prices and the next sale switches). All suites pass (194 × 3).
  Installed 2026-11-20 (40) on TabletPOS, TabletPOS_ENZO and TabletPOS_VROSS; no schedules entered.
- VROSS has Price 1 on about 125 items per branch only; the rest stay at the regular price during a schedule.
  The till PCs' clocks must be right.

## Open drawer without a sale (built 2026-11-20)

The user: the cash drawer opens only when the printer prints (the printer / driver setting; SparkPOS
never sent a drawer command), so with no transaction the cashier couldn't open it. Migration
`database/39_open_drawer.sql` (mirrored in `01_schema.sql`), then re-run `02_procedures.sql`. Tests:
`database/tests/drawer_tests.sql` (5).
- **Till** (Pos.jsx `DrawerModal`, `doOpenDrawer`): "Drawer" in the header (both screens), "Open drawer
  (no sale)" in More (F7) and the phone menu. A reason (Change for a customer / Check the cash / Cash in /
  cash out / Other + what for), an optional note, and a supervisor when the till's **Open drawer**
  approval is on (works offline like Reprint; a Supervisor / Admin signed in is recorded as the approver).
- **How it opens** (`openDrawer()` in api.js): the ESC p pulse on pins 2 and 5 (`1B 70 00 19 FA`,
  `1B 70 01 19 FA`), no paper: through RawBT on the handheld, or **PrintAgent 2.1's new `POST /drawer`**
  (`Dispatch.KickAsync`; `/health` says `drawer: true`). An older PrintAgent answers 404, so the till
  prints a **NO SALE slip** instead (`buildNoSale()` in receipt.js: reason, cashier, approver; "NOT AN
  OFFICIAL RECEIPT"), which opens the drawer as any print does. No printer at all: an error, nothing logged.
  A drawer the printer setting opens on RAW (spool://) prints is assumed to also take the pulse.
- **Logged**: `POST /api/shifts/{shiftUid}/drawer-open` → `dbo.DrawerOpens` (the till's own id, so an
  offline one sent again counts once; shift, terminal, user, approver, reason, note, KICK / SLIP) and an
  audit row `DRAWER_OPEN`. Offline or failed, it waits in meta `drawer_log`; `flushDrawerLog()` sends it on
  opening the POS, every 5 minutes and when the connection returns.
- **Counted**: X-Read (the shift's) and Z-Read (`ZReads.DrawerOpens`, the day's) print "DRAWER OPENED, NO
  SALE n"; the emailed reports too. Both test suites that read the X-Read's shape got the new column.
- **Approval**: `OPEN_DRAWER` is the eighth action in POS Settings → Supervisor approvals
  (`PosSettings.OpenDrawerOverride`, **off**; a terminal can have its own answer).
- **Verified:** the SQL suites on all three test DBs (16 suites, 194 each); HTTP on a local API against
  TabletPOS (10: logging, a resent one counted once, no reason refused, audit, X-Read / Z-Read counts, the
  switch read by the till; a full day on 001 POS-01, closed; `zz.gc*` users off again); headless Chrome
  with mocked agents (new agent: pulse only; older agent: NO SALE slip; approval as cashier and as a
  signed-in supervisor; log kept offline when it can't be sent). **Not tried on a real drawer.**
- **Deploy**: the site (API + web), and **PrintAgent 2.1 on each till PC** (`publish_vross.sh printagent`)
  for the no-paper pulse; until then each opening prints a NO SALE slip. Installed 2026-11-20 (39 + 02)
  on TabletPOS, TabletPOS_ENZO and TabletPOS_VROSS.

## Gift certificates as a payment (built 2026-11-20)

The user asked for Gift Certificate as a payment type. Their calls: **SparkPOS keeps its own GC list**
(not the ERP's), **no change on a GC** (the excess is forfeited), the till **only accepts** GCs (they're
sold elsewhere), and **offline is allowed, checked at sync**. Migration `database/38_gift_certificates.sql`
(mirrored in `01_schema.sql`), then re-run `02_procedures.sql`. Tests: `database/tests/giftcert_tests.sql` (16).
- **`dbo.GiftCertificates`**: GcNo (unique, ≤ 30), FaceValue, BranchCode (NULL = every branch), IssuedDate,
  ExpiryDate (NULL = none), IssuedTo, Note, Status Active / Redeemed / Cancelled, the redeeming sale.
  One use each.
- **`SalePayments`**: PaymentType now `CASH` / `CARD` / `GC` (`CK_SalePayments_Type`; the old inline check
  is dropped by name lookup), plus GcNo, GcValue (face value; Amount = what it paid, the rest forfeited)
  and GcCheck. **`TVP_SalePayment` is unchanged** (the IIS build still sends it): the GC details go to
  `sp_UpsertSale @GiftCerts` as JSON [{seqNo, gcNo, faceValue}], sent only with a GC payment.
- **At sync** (first sync only): each GC is checked against the list → GcCheck `OK`, `UNKNOWN`, `USED`
  (used before, or twice on one sale), `EXPIRED`, `BRANCH`, `CANCELLED` or `VALUE` (face value differs),
  and an Active GC is marked Redeemed (even when expired / another branch's: the till took it in). The
  sale is never refused (the invoice is printed); a non-OK GC gets a `GC_REVIEW` audit row and shows in
  Reports → Gift Certificates. A sale voided before it synced redeems nothing.
- **Void gives the GC back**: `sp_GiftCertRelease` (Redeemed → Active, audit `GC_RELEASED`), from the
  void endpoint and from an offline void re-synced. A **return** still refunds in cash: the user (11-20)
  keeps it that way until management decides (tracker #15).
- **Till** (`PayModal`, only when the branch's `PosSettings.GiftCertOn`): "Gift cert" → scan/type the
  number → Check (`GET /api/giftcerts/lookup`, any user) → good: "face value ₱500, pays ₱424.00, ₱76.00
  forfeited" → Add; a used / cancelled / expired / other-branch / unknown GC is refused with the reason.
  No answer from the list (offline, signed in offline, server down): the cashier types the face value and
  it's added "not checked (offline)". A GC pays at most the balance, so change only ever comes from cash.
  Invoice: "GIFT CERT", its number, "Value 500.00, forfeited 76.00".
- **Totals**: X-Read and Z-Read print "GIFT CERT" in the payment breakdown (`sp_rpt_XRead.GcSales`,
  `ZReads.GcSales`); Blind Close's expected cash already counts CASH only. Sales Summary, Sales Details
  (+ GC forfeited), Branch Comparison, Payment Breakdown (GC txns, split = more than one kind) and Cashier
  Performance got a GC column, so cash + card + GC = net. **Ledger**: a "Gift Certificates Outstanding"
  liability (2120, `GIFT_CERT`) and the ZREAD rule `GC` (Dr what the GCs paid); 38 adds both to companies
  already set up (ENZO, VROSS), since an unmapped item fails End of Day. The forfeited part isn't booked
  (SparkPOS never booked the GCs' sale).
- **Admin**: People → **Gift Certificates** (`GiftCertsController`): add one number or a numbered batch
  (prefix + first number + count ≤ 1,000 + digits; all or none if one exists), face value, issue / expiry,
  branch, issued to; Cancel an unused one with a reason (Admin; audited `GC_CREATE` / `GC_CANCEL`). POS
  Settings → "Take gift certificates as payment" (`GiftCertOn`, off). Reports → Gift Certificates.
- **ERP: not yet.** SparkPOS sends only CASH / CARD to `spu_SparkPOS_PostSale`, and a GC row would fail
  there and hold up that till's queue. So the POS settings save **refuses `GiftCertOn` at a branch with an
  active posting till** (every VROSS branch today). Asked the ERP session (11-20) what the ERP / desktop
  POS has for GCs and what it needs (type code, GC no., CloseShift / Z-Read totals, desktop copy, GL);
  the poster is unchanged until it answers.
- **Verified:** the SQL suite on all three test DBs (all 15 suites 189 each); HTTP on a local API against
  TabletPOS (22: register / duplicate / branch / cancel / lookup, the switch, a full day on 001 POS-02 with
  a GC sale, the same GC again (USED), a void giving it back, the report, payment breakdown, X-Read, Blind
  Close, Z-Read; that day and an empty POS-03 day are closed, the `zz.gc*` users switched off); the pay
  dialog (good / used / offline GC, the queued sale and invoice text) and the Admin list in headless Chrome.
  Installed 2026-11-20 (38 + 02) on TabletPOS, TabletPOS_ENZO and TabletPOS_VROSS; no branch switched on.

## Hold and Recall a sale (built 2026-11-20)

The user: after everything is punched, a customer finds they're short of cash and goes out to withdraw;
instead of cancelling every item, hold the sale and recall it when they're back. No migration, no
server change.
- **Kept on the till only** (`getHeld` / `putHeld` in api.js: meta key `held_<terminalId>`, a list of
  `{ holdId, heldAt, note, heldBy, lineCount, net, sale }`). Works offline, survives a reload, and
  nothing reaches the server or uses an SI number until it's recalled and paid. Another till can't see it.
- **`cart.snapshot()` / `cart.restore()`** (store.js) carry what `clear()` empties: lines, discount
  (with its approver, booklet, cap, own-items quantities), pax, customer, suki card, zero-rated,
  price level and approver, cancelled lines. Restore reprices with the promos running now.
- **Till:** Hold asks for an optional note (the customer's name if one was entered); Recall lists them
  with note, items, time and who held it, and **Delete** drops one whose customer never came back (like
  Cancel sale, no approval). Recall needs an empty screen. Not for a dine-in tab or a dine-in bill.
  - Touch: a Hold / Recall (n) button beside Cancel, "Recall a held sale" on the empty cart, "Held (n)"
    in the header, and both in More and the phone menu.
  - Grocery lane: **F10** = Hold with items, Recall (n) when empty (11 keys now; F6 is "Remove").
- **Blind Close refuses** while the till has sales on hold (a note, Submit disabled, and a check on
  submit), so a held sale can't outlive its shift. An Admin force-close leaves them on the device.
- **Verified** in headless Chrome on the built app with a mocked API, Touch and grocery lane: a PWD
  sale held with a note, the page reloaded, the next customer paid, then recalled with the same amount
  due (₱376.40) and discount; Blind Close blocked; the 11 keys fit at 1024 px. Not on a real till.

## Admin console layout: side panel + glass (2026-11-15)

The user asked to move Admin's top tab row into a side panel that becomes a hamburger menu on a
phone, with a professional "glass" look. `components/AdminLayout.jsx` is the shell:
- **Side panel** with grouped sections (`NAV`: Overview, Sales, Catalog, People, Store setup,
  Finance) and inline-SVG icons (`ICON`). On a desktop (`lg`+) it is fixed and can shrink to an
  icon rail (remembered in `localStorage` `admin_rail`); below `lg` it is a drawer behind the
  hamburger (overlay, Esc or a pick closes it). The user, Open POS and Sign out sit at its foot.
- **Top bar**: the section's group and title, the branch picker, Open POS.
- **The section is in the URL hash** (`/admin#terminals`), so a reload or Back keeps it. A
  Supervisor given `#accounting` lands on Dashboard. The tab names (`TABS` in Admin.jsx) are
  unchanged; a new tab must also be added to a `NAV` group and get an `ICON`, or it won't show.
- **Glass**: a glow behind the page, and `.admin-glass .bg-panel` in `index.css` makes cards
  translucent with `backdrop-filter`. It's scoped to Admin; the cashier screens keep solid panels.
  Because a blurred card would trap a `fixed` overlay inside it, **`Modal` now renders through a
  portal into `<body>`** (z 60; Toast z 70).
- Checked in headless Chrome with mocked data at 1440, 900 and 390 px wide. Not yet clicked
  through against a live API.

## Service worker: the app opens offline (built 2026-10-28, v2.1.0)

Before this there was no service worker. Offline selling only worked if the window stayed open:
a refresh or a restart with no network showed Chrome's "No internet" page.
- **`vite-plugin-pwa` 0.21.1** (`web/vite.config.js`, `registerType: 'prompt'`) precaches the
  build: js, css, html, woff2, icons and manifest, about 1.9 MB. Navigations fall back to
  `index.html`, except `/api`, `/swagger`, `/health` and `/images`. Product photos are cached at
  runtime (`product-images`). **Data is never cached by the worker**: sales, prices and sign-ins
  stay in IndexedDB and go through the API.
- **Updates** (`web/src/lib/pwa.js`, `UpdateBar` in `App.jsx`): a new version installs in the
  background and waits. A "new version" bar offers it, hidden while the cart has lines (the cart
  is in memory, so a reload would drop the sale). "Later" hides it for an hour. Nothing reloads
  by itself. A till checks for a new version every 30 minutes and when the connection returns.
- **Server**: `Program.cs` sends `Cache-Control: no-cache` for `sw.js`, `index.html`,
  `manifest.webmanifest` and `workbox-*`, so a device always finds a new version. Deploying stays
  the same: copy the new `dist` into `wwwroot`.
- **Bug found and fixed while testing**: offline sign-in had never worked in a browser.
  `RequireAuth` needed a token, and an offline session has none, so the cashier landed back on
  the sign-in page. `/pos` now takes `allowOffline`, meaning signed in offline with a user but
  no token. Every other screen still needs a real sign-in.
- **Verified** in headless Chrome against the VROSS test API (003 / POS-02, 2026-10-28), with
  the API actually stopped for the offline steps (`scratchpad/shots/sw_test.mjs`):
  - Install. Restart with no server: SparkPOS opens, and the sign-in page opens.
  - A wrong password is refused offline. Offline sign-in resumes the own shift.
  - Two sales queue offline and survive a refresh.
  - Back online: "Sign in again", then both sales sync. They posted to the ERP without review
    flags.
  - The update bar shows, hides while the cart has lines, and "Update now" loads the new build.

## Suki / reward cards (v2.2.0, built 2026-11-12)

The user asked for suki cards and picked every recommended option: tap reader, earn and check
only (no redeeming yet), points kept in SparkPOS and shared by the client's branches, earned on
the amount paid. Migration `database/26_loyalty.sql` (mirrored in `01_schema.sql`), then re-run
`02_procedures.sql`. Tests: `database/tests/loyalty_tests.sql` (14).
- **Tables:**
  - `LoyaltySettings`: one row with on/off, `AmountPerPoint` (default ₱200) and `ProgramName`
    (default "Suki card"), shown on the till and the receipt.
  - `LoyaltyCards`: `CardNo` unique; `Mobile` kept as its last 10 digits, unique; `Points` is the
    balance and can't go below 0.
  - `LoyaltyLedger`: EARN / VOID / RETURN / ADJUST. One row per sale or return
    (`UQ_LoyaltyLedger_Ref`), and the rows can't be edited (`TR_LoyaltyLedger_Immutable`).
  - `Sales.LoyaltyCardId` records the card a sale was rung up with.
- **Earning happens server-side at sync.** `sp_UpsertSale @LoyaltyCardNo` resolves the card and
  calls `sp_LoyaltyEarn`, which gives FLOOR(NetAmount / rate), once per sale. The rate in effect
  is stored on the EARN row.
  - An unknown or switched-off card doesn't stop the sale: it earns nothing, and an audit row
    `LOYALTY_UNKNOWN` records it.
  - A sale voided before it ever synced earns nothing.
- **Taking points back:** `sp_LoyaltyTakeBack` handles both cases and never takes the card below 0.
  - **Void:** the void endpoint, or a re-sync with status Voided, takes back everything the sale
    still holds.
  - **Return:** `sp_ProcessReturn` keeps only what the amount left after all of the sale's
    returns would earn, at the sale's own rate.
  - **Manual adjustment:** `sp_LoyaltyAdjust` is Admin-only and needs a reason.
- **API** (`LoyaltyController`):
  - Any signed-in user: `GET settings` and `GET lookup?code=` (card number first, then mobile).
  - Admin and Supervisor: list, register and edit cards, and view a card's history.
  - Admin only: change the settings and adjust points.
- **Till:**
  - The cart shows a "<program>: tap the card or check points" button, only while earning is on.
    Its settings load with the POS context and are cached for offline.
  - `LoyaltyModal`: the reader types the number plus Enter. It shows the name and balance (a
    points inquiry needs no sale) and offers "Use for this sale".
  - Offline, the card can't be checked but can still go on the sale; the server checks it at sync.
  - The invoice gets a line block below CHANGE: the program name, the masked card number, points
    earned, and the balance when it was checked online. It's not a BIR figure.
- **Admin:** a new **Suki Cards** tab with the settings, card list and search, register/edit, and
  each card's history and adjustments.
- **Safe before the migration:** the sale sync sends `LoyaltyCardNo` only when a card is on the
  sale, so a DB without 26 still takes ordinary sales. The void endpoint calls the take-back proc
  only if it exists.
- **Installed 2026-11-12** (user's go-ahead) on TabletPOS_ENZO and TabletPOS_VROSS: 26 + 02. All
  six suites pass on both, 125/125.
  - On ENZO, earning is **on** (₱200, "Suki card").
  - ENZO has a demo card `0004817263` "Juan Dela Cruz (demo)", mobile 0999 000 0001, which ends at
    11 points after the till tests (earn, void, return).
  - Checked at the till on POS-DEMO..3. The IIS sites still run the older build until v2.2.0 is
    deployed.
- **Not done:**
  - Redeeming points: the BIR treatment, as a discount or a payment, is the accountant's call.
  - Expiry, a per-branch rate, and points reports.
  - The ERP gets nothing about points.

## VAT-exempt vs zero-rated (fixed 2026-11-13)

VROSS testers saw every non-VAT item (fresh pork, dried fish) printed under **Zero-Rated Sales**.
`discountLineAmount()` in `store.js` put any line with `isVatable = false` and no discount into
the zero-rated bucket. The user: those must not be zero-rated, and zero-rating must be an option.
- **Fix:** a non-VAT item is **VAT-exempt** (Tax Code sec. 109 basic goods). With a discount it was
  already exempt; now it is without one too. Everything downstream (Z-Read, ERP posting, the ledger)
  reads the sale's buckets, so nothing else changed. Sales made before the fix keep their zero-rated
  figures (immutable): on 2026-11-13 that's VROSS 006 POS-01 SI 1–4, POS-02 SI 1–2 (both posted to
  the ERP as zero-rated) and 001 POS-01 SI 4, 7.
- **Zero-rated sale** (the user's choices): a whole-sale option at the till ("Zero-rated sale
  (PEZA / ecozone / diplomat)" in the cart, `ZeroRatedModal`).
  - VAT-able items sell at their price **without the VAT** (`exVatPrice()`, per unit, so
    qty × price = the line total); VAT-exempt items keep their price. All of the VAT-able part is
    Zero-Rated Sales. No discount with it (the Discount button is disabled).
  - Needs the buyer's name, TIN and address (they go on the invoice as the customer), the buyer's
    **certificate / ID no.**, and a **supervisor** (verify-approver; offline, a cached supervisor of
    the branch) unless one is signed in.
  - The repriced lines carry the shelf price as `OrigUnitPrice` and the supervisor as
    `PriceApprovedBy` (so the ERP sees an approved price, and `sp_UpsertSale` writes its usual
    PRICE_EDIT rows); the invoice says ZERO-RATED SALE and Cert/ID No., without the * mark.
  - Migration `database/28_zero_rated_sales.sql` (`Sales.ZeroRatedCertNo`, `ZeroRatedApprovedBy`,
    mirrored in `01_schema.sql`), then re-run `02_procedures.sql` (`sp_UpsertSale` takes both and
    writes a `ZERO_RATED` audit row). The sync sends them only on a zero-rated sale.
    **Install 28 + 02 before deploying the build**, or a zero-rated sale can't sync.
  - Tests: `database/tests/zero_rated_tests.sql` (6); the till's math was checked in Node.
- **Not verified:** the zero-rated screens in a browser, and how the ERP treats a VAT-able line
  with zero VAT and a zero-rated bucket (it should pass its sum and VAT checks; ask the ERP side
  to confirm its desktop copy and GL).
- TabletPOS (test DB) got 26 + 28 + 02 on 2026-11-13; all suites pass there.
- **Installed 2026-11-13** (user's go-ahead) on TabletPOS_ENZO and TabletPOS_VROSS: 28 + 02. All seven
  suites pass on both (95/95). `loyalty_tests.sql` now uses test mobiles 9999990901/02: its old
  9990000001 clashed with ENZO's demo suki card.

## Each till device assigned to its terminal (built 2026-11-13)

Asked by the user after VROSS testing: V1 has 5 POS PCs, each named for its terminal (POS1…), and
a cashier must not be able to pick another PC's terminal at Cash Begin. The user chose
"assign once per device" over matching the Windows computer name via PrintAgent (that would need
a new agent on every PC and wouldn't cover the Android handheld). Migration
`database/27_terminal_devices.sql` (mirrored in `01_schema.sql`; no procedure changes).
- **`dbo.TerminalDevices`** (TerminalId PK, TokenHash unique, DeviceLabel, AssignedAt/By): one
  device per terminal and one terminal per device. The device keeps a random token in
  `localStorage` (`pos_deviceToken`); `api()` sends it as `X-Device-Token` on every request; the
  server stores only its SHA-256 (`Services/TerminalDevices.cs`).
- **Assigning:** Cash Begin → "Assign this device to a terminal" (`POST /api/terminals/{id}/assign-device`).
  A Supervisor of the branch or an Admin signed in does it directly; a Cashier needs a
  supervisor's user ID and password (`VerifyApproverAsync`). Assigning again moves the terminal
  to this device, and this device leaves its old terminal. Audited `DEVICE_ASSIGN`.
- **Effect:** `GET /api/terminals` adds `DeviceAssigned` / `DeviceIsThis` (+ label, date, by).
  Cash Begin shows only the device's own terminal, or else only unassigned ones. `ShiftsController.Open`
  refuses a shift on an assigned terminal from any other device. **Unassigned terminals behave
  as before**, so ENZO, the demo terminals and every existing till are unaffected until assigned.
- **Admin → Terminals:** a Device column; **Unassign** is Admin-only (`DELETE /api/terminals/{id}/device`,
  audited `DEVICE_UNASSIGN`), for a replaced or wiped PC. Clearing the site's data in Chrome loses
  the token; a supervisor assigns the device again (it moves the terminal over).
- **Safe before the migration:** without the table the API skips all of this (`InstalledAsync`).
- **Verified** on the TabletPOS test DB with the local API: 19/19 HTTP checks (approval rules,
  refusal from another device, move, reassign, Admin-only unassign, no hash in responses) and the
  Cash Begin screens in headless Chrome. Test rows removed afterwards. Migration 27 installed on
  TabletPOS_ENZO and TabletPOS_VROSS on 2026-11-13 (user's go-ahead); the IIS sites need the new
  build before it takes effect.

## Users kept to their own branch (built 2026-11-16)

The user: ERP cashiers have an AssignedBranch, and testers found one cashier account could sign
in at different branches. Sign-in already used only the user's own branch (an ERP user's
`UserBranches` row = AssignedBranch; checked on VROSS/ENZO data: no ERP cashier ever signed in or
opened a shift at another branch). The gap was physical: SparkPOS didn't know which branch a PC is
at, so a 002 cashier on a 001 PC signed in at 002 and got 002's terminals. VROSS had no till
assigned to its device yet. Now:
- **Sign-in on an assigned till** (`TerminalDevices.AssignedAsync`, `AuthController.Login`): only
  users of that terminal's branch get in; anyone else gets "This till is POS-03 of branch 001 …
  sign in at your own branch's till", audited `LOGIN_WRONG_BRANCH` (checked after the password,
  so a wrong password never reveals a branch). An Admin signs in there at that branch, no picker.
- **The sign-in page shows the till** ("This till: POS-03 · 001 …", `GET /api/auth/device`,
  public, answers only the device holding the token; remembered in `localStorage` `pos_till`).
  Offline sign-in refuses a remembered user of another branch on it.
- **Shift open** (`ShiftsController.Open`): the terminal must exist and be active, be at the
  branch signed in at (an Admin anywhere), and the branch sent must be the terminal's.
- **`sp_OpenShift`** checks the same in the database, before the day checks: 51014 the branch
  isn't the terminal's; 51015 the user isn't active and assigned to that branch (Admins pass).
  Tests: `database/tests/branch_tests.sql` (8; makes its own branches/terminals/users).
- **Still needs each till assigned** (Cash Begin → "Assign this device to a terminal"): an
  unassigned PC can't tell where it is, so a cashier there still gets their own branch's
  *unassigned* terminals. Once every terminal of a branch is assigned, a PC elsewhere can't open
  any of them. ERP Admins (91 at VROSS, from the ERP's isAdmin flag) can still sign in at any
  branch on an unassigned PC.
- Two existing bugs found while testing the sign-in page, both fixed:
  - `api()` showed "You signed in offline…" for a wrong password after sign-out (any 401 with no
    token); the sign-in's own 401 is now shown as is.
  - `ErrorBar`'s dismiss "×" had no `type`, so inside the sign-in form it was the default submit
    button: after any error, pressing Enter only cleared the message. Now `type="button"`.
- **Verified** on the TabletPOS test DB: all nine SQL suites pass (110), 15/15 HTTP checks with
  throwaway users and a test device (removed afterwards), and the sign-in page in headless Chrome
  at the handheld's size. Installed 2026-11-16 (02 re-run) on TabletPOS, TabletPOS_ENZO and
  TabletPOS_VROSS: all nine suites pass on each (146). The IIS sites need the new build.
- **Standing instruction (2026-11-16):** install SparkPOS DB changes on TabletPOS_ENZO and
  TabletPOS_VROSS directly, without asking; then tell the user whether it succeeded.
- **The suites no longer need a free terminal:** where a test picks a terminal with no unclosed
  day and finds none (VROSS on 11-15/16: testers' open days on all 14), it makes a throwaway
  `ZZ-TEST` terminal inside its rolled-back transaction. `SET @term = NULL` before each pick,
  because a `DECLARE` inside acc's `WHILE` loop keeps the previous (rolled-back) terminal.

## Supervisor approvals per branch and terminal; price level per item (built 2026-11-19)

The user: override control on cancel line, void, return, X-Read, reprint and discount, "dynamic";
and Price 1/2/3 per item during the sale (default SellingPrice). Their calls: **a switch per branch
that a terminal can override**; cancel line = **removing a line**; **one Discount switch** for every
SC/PWD/NAAC/MOV/Solo type; **per item, keeping the whole-sale picker**, no approval. Migration
`database/35_approvals.sql` (mirrored in `01_schema.sql`), then re-run `02_procedures.sql`. Tests:
`database/tests/approvals_tests.sql` (9).
- **Switches:** `PosSettings.CancelLineOverride`, `XReadOverride`, `DiscountOverride` (new, off) plus
  the existing `VoidOverride`, `ReturnOverride`, `ReprintOverride` (**Reprint is now enforced**; it
  never was, and no branch had it on). `dbo.TerminalOverrides (TerminalId, Func, Required)`: a
  terminal's own answer; no row = the branch's. `Services/Approvals.cs` resolves them (safe before
  35: new switches off, no terminal answers). A Supervisor / Admin signed in never needs one.
- **API:** `ApprovalsController`: `GET /api/approvals/terminal/{id}` (any user; the till caches it
  in `ctx_<terminalId>` as `approvals`), `GET /api/approvals/branch/{b}` (Admin/Supervisor),
  `PUT /api/approvals/branch/{b}/terminals` (Admin, replaces the branch's terminal answers, audited
  `APPROVALS_TERMINAL`). The branch switches save with the POS settings PUT (new fields nullable:
  an older Admin sends none and changes nothing).
- **Enforced:** Void (`SalesController.Void`, the sale's terminal) and Return (the returning
  shift's terminal) now read the resolved answer; **X-Read** takes optional `overrideUsername /
  overridePassword` and answers 403 `needsApproval` without them (server-verified; audit "approved
  by"); **Reprint** and **Cancel line** and **Discount** are checked at the till
  (`approveSupervisor`: online any supervisor of the branch or an admin, offline a cached supervisor),
  so they work offline; the reprint log takes `{ approvedBy }`.
- **Till (Pos.jsx):** `needs(func)`; `ApprovalModal` (user ID + password). Removing a line (×, − to
  none, quantity 0) with Cancel line on asks first; removed lines go in `cart.cancelled` and the sale
  sends `cancelledLines` → `sp_UpsertSale @CancelledLines` JSON → `LINE_CANCEL` audit rows (only on
  the first sync; bad JSON ignored). Lines removed and then the whole sale cancelled leave no trace
  (Cancel sale isn't covered, the user's choice). The Discount switch asks in `DiscountModal`
  (`typeNeedsApproval`; one approval also covers a weekly cap); the sale sends `discountApprovedBy`
  and `sp_UpsertSale` now keeps `DiscountApprovedBy` for any discount, with a `DISCOUNT_APPROVED`
  audit row. Dine-in order edits before Generate Bill aren't covered.
- **Admin → POS Settings → Supervisor approvals:** a table, one row per action: the branch's
  checkbox and a select per terminal (Branch (yes/no) / Required / Not needed). The old Void /
  Reprint / Return checkboxes moved there. Tills pick changes up when the POS screen next opens.
- **Price level per item:** each line has `priceLevel`. **In Edit price** (same day, the user's
  calls): the item's own prices are buttons with their values for reference: Regular and **all four
  levels**, switched on in Admin or not (`ctx.allPriceLevels`; a level with no price for the item
  shows "not set", disabled);
  picking one needs **no supervisor** and isn't a price change (`cart.setLinePriceLevel(lineNo, level,
  true)` also drops a supervisor's earlier typed price); a typed price that equals one of them counts as
  that level; any other typed price still follows `PriceEditOverride`. The line's link reads "Price 1 ·
  edit" when at a level. Only an item whose price can't be edited gets the separate "Price level" link
  (`PriceLevelModal` for the line). `atLevel()` in store.js.
- **Price level approval (36, same day, after the user tried it):** `database/36_price_level_approval.sql`
  adds `PosSettings.PriceLevelOverride` (off) and `PRICE_LEVEL` to `TerminalOverrides`' check, a
  seventh row in Supervisor approvals. When on, a cashier needs a supervisor to put an item (Edit
  price, or the line link) or the whole sale at Price 1-4 (`withLevelApproval` in Pos.jsx); back to
  the regular price needs none. The approver rides on the line (`levelApprovedBy`; the sale's on
  `priceLevelApprovedBy` for new lines) and is sent as the line's `priceApprovedBy` (stored in
  SaleItems.PriceApprovedBy; no PRICE_EDIT row since the price isn't a change). Installed 2026-11-19
  on all three (approvals suite 10). The whole-sale picker still sets every
  line; new lines take the sale's level; scanning an item again adds to its line at that line's
  level. The invoice prints the level under a line whose level differs from the sale's. **The ERP
  takes one level per sale** (`@PriceLevel`): the sale sends its own level, else the first line's.
  The ERP accepts SellingPrice or that level's PriceN, so a sale mixing two levels (Price 1 and
  Price 2) gets a review flag on the other lines. VROSS only has Price 1, so not yet an issue. The ERP
  agreed (11-19) a JSON `@LineLevels` ([{lineNo, priceLevel}], parsed like `@WholesaleLines`) on
  `spu_SparkPOS_PostSale` when per-line levels are wanted; not built on either side.
- **Verified:** all 14 SQL suites on TabletPOS, TabletPOS_ENZO and TabletPOS_VROSS (199 each;
  `other_discount` O1d and `discount_cap` C1d changed to the new rule: an approved SC discount keeps
  its approver); the cart in Node (11 checks, earlier cart / discount / promo checks still pass); 17
  HTTP checks on local VROSS (approvals read / save / refused for a Supervisor / other branch, X-Read
  refused without and with a wrong supervisor, allowed with one and for a signed-in Supervisor, old
  tills' bodyless X-Read and reprint log, the settings round trip incl. an older Admin); the Admin
  card in headless Chrome. **The till screens not clicked through in a browser.** Installed
  2026-11-19 (35 + 02) on all three; every switch off except Void / Return as before.

## SC/PWD on the senior's own items only (built 2026-11-19)

VROSS V1-GRILLS (001, Restaurant, takeout) SI 2: 3 dinuguan + 1 fried pork strips all got the senior
20%; the business wants only what the senior eats discounted (e.g. 1 of 3). The user's calls: a
quantity per line, **with supervisor approval**. No migration; re-run `02_procedures.sql`.
- **Discount screen:** "Only the senior's own items" lists the discountable lines with a quantity each
  (starts at the line's); lowering one keeps the discount on that many and charges the rest in full.
  A Cashier needs a supervisor (one approval also covers the Discount switch / weekly cap). Hidden on
  a pax-split bill (dine-in with diners entered: the headcount decides there).
- **Engine:** `discount.qtys` = { lineNo: qty } (only lowered lines). `computeTotals(…, discountQtys)`
  runs `discountedAmt()` = qty × price through `discountLineAmount()` with the rate and the rest without
  (two parts per line, like a pax split); the weekly cap (`capSplit`) measures only the discounted part.
  `perLine.discountQty` → cart "less SENIOR (1 of 3)", invoice the same. Removing a line drops its entry.
  Ignored with a pax split, OTHER or zero-rated. Each row shows the price, its rate ("20%, VAT removed"),
  Bought / For the senior columns and "Discount on 1 of 3; 2 at full price · less ₱6.80" (`cart.lineRate`,
  `discountFor(type, qtys).perLine`). The weekly cap field no longer says "(now ₱X)", which read as if
  the cap were X; nothing about the cap is stored between sales.
- **Dialogs no longer close on a drag that ends outside them** (`Modal` in Ui.jsx, every dialog): a
  tester selecting the right-aligned quantity and letting go past the edge fired a click on the backdrop,
  which closed the discount screen. Now only a press and release both on the backdrop close it.
  Reproduced and checked in headless Chrome with a mocked API (`scratchpad/dq/repro.mjs`), 1280 and 393 px. 3 dinuguan @34 + strips @38: whole 108.74; 1 of 3 +
  strips 122.34; 1 of 3 only 133.20.
- **Sale:** `discountApprovedBy` (signed-in supervisor when none asked), `discountLines`
  [{lineNo, productName, quantity, discountQty}] → `sp_UpsertSale @DiscountLines` JSON → one
  `DISCOUNT_QTY` audit row per line (first sync only). The line's stored figures carry the split; the
  ERP gets them as usual (its line checks are arithmetic only, like a pax-split line).
- A later partial return of such a line refunds a proportional share of its stored figures (as with a
  pax split), not the discounted unit first.
- **Verified:** Node (engine + cart actions), `approvals_tests.sql` A2f, all suites on the three test
  DBs (02 installed 2026-11-19). The screen not clicked through in a browser.

## Promos: Buy N Take M (built 2026-11-18)

The user: how to handle Buy 1 Take 1. Their calls: **every kind** (same item; a different free
item; mix and match; buy N take M), the free item at **full price less the promo**, applied
**automatically**, with **dates and branches**. Migration `database/34_promos.sql` (mirrored in
`01_schema.sql`), then re-run `02_procedures.sql`. Tests: `database/tests/promo_tests.sql` (11).
- **Tables:** `Promos` (name ≤ 40, printed; Kind `SAME` / `GROUP` / `GIFT`; BuyQty N, FreeQty M;
  FreeProductId for GIFT; optional MaxFreePerSale; StartDate–EndDate; IsActive), `PromoItems`
  (items or whole categories that qualify), `PromoBranches` (none = every branch),
  `SaleItemPromo` (each sale line with free units: promo, free qty, price, amount; immutable),
  `Sales.PromoAmount` (the sale's promo total, **part of `DiscountAmount`**), `ZReads.DiscPromo`.
- **X-Read / Z-Read / Sales Summary:** the per-type discount totals (Senior, PWD, …, Other) leave
  the promo out (`DiscountAmount − PromoAmount`) and a "PROMOS (BUY N TAKE M)" line / DiscPromo
  column shows it; total discounts still include it. The Discounts report shows "Of it promos".
- **Till:** `pullPriceList()` also fetches `/api/promos/branch/{b}` (`sp_GetPromos`: on, not ended,
  this branch; categories expanded to items) into meta `promos`; Pos.jsx `loadPromos()` →
  `cart.setPromos()`. **Also picked up during the shift** (11-18, after VROSS saved a promo at 10:53 PM to a
  shift opened at 9:03 AM and nothing applied): Pos.jsx `syncPromos()` → `refreshPromos()` (api.js)
  downloads them again on opening the POS, every 5 minutes, on reconnect and after each sale, and
  applies a new list only to an empty cart (else at the next check after the sale). It's a plain
  fetch, not `api()`, so an expired 12 h session never redirects to sign-in; offline or signed in
  offline it does nothing. Only for the catalog's own branch. Wholesale tiers and prices still
  change only at Cash Begin. `applyPromos()` (store.js) runs inside `reprice()` after wholesale, on lines
  sold by the piece (not weighed, whole qty, not at wholesale, not repriced by a supervisor),
  for promos running on the device's date: SAME per item (every N+M, M free), GROUP pooled (the M
  cheapest of every N+M), GIFT (every N bought, M of the gift in the cart free); the promo worth
  most takes its units first, so a unit never counts twice; MaxFreePerSale caps it. Lines get
  `promo: { promoId, promoName, freeQty }`; `cart.hints()` gives "…: add 1 more, free" / "gift not
  in the cart yet" rows. **The free item must be scanned** (stock leaves).
- **Pricing (`computeTotals`, `promoPart`):** the free units' price comes off the line (on the price
  charged, so zero-rated too), VAT on what's paid; it's the line's `LineDiscount`. `resolveDiscount`
  gives a promo line no SC/PWD discount; **with SC/PWD, `reprice()` keeps the promo or the discount,
  whichever leaves the sale cheaper** (per promo, like wholesale). In a senior sale, a promo line
  whose SC rule is the VAT-exempt 20% stays **VAT-exempt** at the promo price (RMC 38-2012 Q21,
  the handoff's PROMO_VATEX). A regular/other peso discount skips promo lines. Totals carry
  `promo` and `other`; `lessVat` subtracts them.
- **Invoice:** under the line "Promo: <name>" and "less N free −₱…"; totals "LESS PROMOS" (and "LESS
  OTHER DISCOUNT" from `discountBreakdown.other`). The 5% SC line shows discount + its VAT part,
  matching the "LESS … BNPC 5%" total. Cart totals show the same.
- **Sale sync:** `sp_UpsertSale @PromoLines` JSON (lineNo, promoId, promoName, freeQty,
  regularPrice, promoAmount = the line's discount) → `SaleItemPromo` + `Sales.PromoAmount`.
- **Admin → Promos item picker (fixed 11-19):** VROSS couldn't save a promo for one item: typing
  "555 BEEF" only showed a suggestion, Save then said "pick the items (or categories)", so they ticked
  Canned Foods (promo #11 = the item + all Canned Foods). Now each suggestion says "+ Add", Enter adds
  the first, "No items added yet / Items in this promo" shows what's picked, and Save with nothing
  picked explains it before calling the server. Item-only promos always worked server-side.
- **Admin → Promos** (Catalog group; `PromosController`, Admin edits, audited `PROMO_SAVE` /
  `PROMO_DELETE`; a promo used on sales can't be deleted, only switched off). **Reports → Promos**
  (`sp_rpt_Promos`). Status shown: Running / Starts later / Ended / Off.
- **ERP:** the poster gives promo lines no SC/PWD line code and sends `@PromoLines` (lineNo,
  promoName, freeQty, regularPrice, promoAmount) only when `spu_SparkPOS_PostSale` has the
  parameter. **Requested from the ERP session 2026-11-18 (queued, not built yet):** until then a
  promo line in a sale without an SC/PWD code is flagged "a discount with no code anywhere".
- **Verified:** all 14 SQL suites on TabletPOS, TabletPOS_ENZO and TabletPOS_VROSS (190 each); the
  engine in Node (13 promo checks: every kind, hints, max per sale, dates, senior 5% vs promo,
  senior 20% VAT-exempt promo, senior winning over a weak promo, other discount skipping promos;
  all earlier cart / discount / wholesale checks still pass); a sample invoice; the endpoints over
  HTTP (14, which caught a transaction opened on a closed connection, fixed); Admin → Promos in
  headless Chrome. **The till not clicked through in a browser.** Installed 2026-11-18 (34 + 02).
  No promos entered.

## Wholesale prices by quantity (built 2026-11-17)

The user: VROSS sells some meat "wholesale": from a set quantity of an item in one sale (e.g. 5 kg
of Pork Belly) every kg is ₱10 less; other items have their own (10 kg, ₱5). The settings change,
and wholesale sales go on a separate report for DTI. Their calls: a **lower price per kg** (not a
discount line); the **item's total in the sale** counts (several stickers add up); **wholesale or
SC/PWD, not both** (a supervisor can take wholesale off the sale so the discount applies); rules
for **every branch, overridable per branch**. Migration `database/33_wholesale.sql` (mirrored in
`01_schema.sql`), then re-run `02_procedures.sql`. Tests: `database/tests/wholesale_tests.sql` (10).
- **VROSS's memo** (Finance, 2024-08-16, `~/Downloads/Media.jpeg`): V1, V2, V3, V5 and V6 only;
  all pork SKUs 5 kg −₱5, 10 kg −₱10, 15 kg −₱15 (20 kg also ₱15); all beef 5 kg −₱5, 10 kg −₱10;
  all chicken 10 kg −₱5, 15 kg −₱10; Pork Belly 10 kg up −₱10 only (the user: 12100 PORK BELLY
  LOCAL, 40820 PORK BONELESS BELLY LOCAL, 45368 BELLY STRIPS; nothing at 5 kg, ₱10 at 15/20 kg);
  excluded: 12113 PORK CHOP, 12108 PORK PAA, 46306 PORK SEMI-PAA; kilos counted **per item**;
  wholesale or SC/PWD, not both (handwritten note). **Entered on TabletPOS_VROSS 2026-11-17** (user's
  go-ahead; script `scratchpad/lvl/vross_wholesale.sql`, audited WHOLESALE_RULE_SAVE): 7 category
  tiers, 3 belly rules, 3 exclusions; WholesaleOn only at 001/002/003/005/006. Branch 001's tills
  get tiers for 120 items (57 pork + 35 beef + 31 chicken − 3 excluded); whole chickens included
  (the memo says all chicken SKUs). Takes effect once the new build is deployed (next Cash Begin).
- **`dbo.WholesaleRules`**: an item (ProductId) **or** a category (CategoryId), BranchCode NULL =
  every branch, MinQty, AmountOff per unit, IsActive; unique per target + branch + minimum. Several
  minimums = tiers, the highest reached applies. `sp_GetWholesaleRules @BranchCode` resolves per
  item: the first set that has rows wins — **item at this branch, item at every branch, category at
  this branch, category at every branch** — and only its active rows count (an item rule switched
  off = the item is excluded). **`PosSettings.WholesaleOn`** switches a branch off altogether.
  Admin → **Wholesale** (Catalog group): the branch switches (branches with tills), rules for a
  whole category or one item, "Exclude this item" (Admin only; `WholesaleController`, audited
  `WHOLESALE_RULE_*` / `WHOLESALE_BRANCH`). The first copy of 33 had item rules only; 33 upgrades it.
- **Till:** `pullPriceList()` also fetches `/api/wholesale/branch/{branch}` and stores each item's
  tiers on the cached product (offline too; tills get changes at Cash Begin). `applyWholesale()`
  (store.js) runs after every cart change: the item's quantity across its lines picks the tier,
  and each of its lines goes to `basePrice` (SellingPrice or the price level) less the amount off.
  The wholesale price is also `OrigUnitPrice`, so it's not a price change (no `*`, no PRICE_EDIT);
  a line a supervisor repriced keeps its price. A tier that would take the price to 0 or below is
  ignored. `resolveDiscount()` gives a wholesale line no SC/PWD discount, and a regular/other peso
  discount is shared only over the non-wholesale items. **With an SC/PWD discount the customer gets
  whichever is worth more, never both** (RMC 38-2012 / JAO 24-02 via the handoff, 11-18; replaced
  the first "a supervisor takes wholesale off" step): `reprice()` (store.js) runs after every cart
  change and, item by item, waives an item's wholesale when the sale's net is lower without it
  (`applyWholesale(lines, waived)`; waived lines carry `wholesaleWaived` and show "SENIOR instead
  of wholesale"). E.g. 5.5 kg belly ₱380: 5% = ₱104.50 beats wholesale ₱55; 20 kg: 5% is capped at
  ₱125, wholesale saves ₱300, so wholesale stays. The cart shows a "wholesale · reg ₱…" badge and
  an information row; the invoice prints "Wholesale: reg … less …" under the line.
  `Sales.WholesaleRemovedBy` / audit `WHOLESALE_REMOVED` are no longer used by the till.
- **Sale:** the lines go to `sp_UpsertSale @WholesaleLines` as **JSON** (not a TVP_SaleItem column,
  so the build on the IIS sites still sends the TVP it knows) → `dbo.SaleItemWholesale` (regular
  price, amount off, wholesale price, minimum reached, item total; immutable, `TR_SaleItemWholesale_Immutable`).
  `Sales.WholesaleRemovedBy` + audit `WHOLESALE_REMOVED`. Bad JSON adds no lines, never refuses.
- **DTI report:** Admin → Reports → Wholesale (DTI) (`sp_rpt_Wholesale`, `/api/reports/wholesale`):
  each line with item code, qty, item total, minimum, regular / wholesale price, amounts and what
  the customer saved; Completed sales only, returned qty shown. Not checked against an actual DTI
  template (none given yet).
- **ERP [322]** (applied 2026-11-17 on JFC DEV, VROSSMIG and the ENZO test copy; ENZO PROD needs
  [321] then [322]): `spu_SparkPOS_PostSale @WholesaleLines` NVARCHAR(MAX), JSON array of exactly
  `lineNo`, `regularPrice`, `amountOff`, `minQty` (no nulls, plain decimals, ≤ 1000 entries), not
  in the re-send hash. A listed line passes (no "price differs" flag; terms stored on
  SparkPOS_SaleLine) when regularPrice = the ERP price (branch SellingPrice, else 888's; with
  @PriceLevel the branch's PriceN), UnitPrice = regularPrice − amountOff, 0 < amountOff <
  regularPrice, the product's total qty ≥ minQty, and the line has no discount or code. Anything
  else is a review note, never a refusal. The poster sends it only when the ERP's proc has the
  parameter, and **only lines still at the wholesale price** (a supervisor-repriced or zero-rated
  wholesale line posts as a price change with its approver). The ERP's regular-price check accepts
  SellingPrice (branch, else 888) always, OR the branch's PriceN at that level, so an item without
  PriceN at a price level passes too (ERP test W13b).
- **Verified:** all twelve SQL suites on TabletPOS, TabletPOS_ENZO and TabletPOS_VROSS (179 each;
  wholesale 13, set up like the memo); the cart in Node (14 wholesale checks, plus the price level
  and discount suites still passing); the endpoints over HTTP (24); the Admin screens (Wholesale
  with category / item / excluded rules and branch switches, Discounts by POS type, Price levels)
  in headless Chrome at 1440 px. **The till's wholesale and discount screens not clicked through
  in a browser.** Installed 2026-11-17 (33 + 02) on all three; no rules set yet.
- **Returns:** a partial return keeps the wholesale price on what's returned (stored line figures),
  even if what's left would no longer reach the minimum.

## SC/PWD rate per POS type, and the senior's weekly cap (built 2026-11-17)

VROSS testers: every senior discount was 20% VAT-exempt (VROSS has no category rates), changing
the POS type changed nothing, and a senior near the weekly cap (DTI-DA: ₱2,500 of basic
necessities a week) couldn't be given less. The user's calls: **a rate per POS type**, the
cashier types **the discount amount**, with **supervisor approval**. Migration
`database/32_discount_pos_type.sql` (mirrored in `01_schema.sql`), then re-run `02_procedures.sql`.
Tests: `database/tests/discount_cap_tests.sql` (9).
- **`dbo.DiscountPosTypeRates`** (DiscountCode, PosType, CategoryId NULL = every category, Rate,
  IsVatExempt; unique per code + type + category). A line's rate, first match wins:
  **POS type + category → category (`DiscountCategoryRates`, any POS type) → POS type → the
  type's default.** Same order in `resolveDiscount()` (store.js) and the ERP poster's line-code
  lookup (`ErpPostingService.PostSaleAsync`, OUTER APPLY). The till's POS type is
  `Terminals.PosType`, else the branch's `PosSettings.PosType`. **`DiscountCategoryRates` is
  untouched on purpose**, so the build already on the IIS sites reads it as before.
- Admin → Discounts: a POS type picker. "Every POS type" edits the category rules as before; a POS
  type shows its every-category rate (Set/Edit/Clear) and each category's rule with where it comes
  from; Override adds a POS type + category rule. Endpoints `GET/PUT/DELETE
  /api/settings/discount-pos-type-rates/{code}/{posType}[?categoryId=]` (GET any user, edit
  Admin/Supervisor, audited `DISCOUNT_POSTYPE_RATE_SET/CLEAR`). The discount screen at the till
  shows each type's rate for that till.
- **The till now keeps the discount rates offline** (types, category and POS-type rates go in the
  `ctx_<terminalId>` cache). Before, an offline restart fell back to the built-in 20% defaults.
- **Weekly cap** (reworked 11-18 after the handoff `handoff/TabletPOS Handoff — Senior Citizen PWD
  Discount Engine (Mixed Basket).md`): it limits only the **5% lines that keep the VAT** (basic
  necessities, BNPC); a VAT-exempt (20%) line is never capped (RMC 38-2012). **Every sale is
  limited to ₱125 off on those lines automatically** (`BNPC_WEEKLY_CAP`, JAO 24-02: ₱125 a week on
  ₱2,500); the cashier's "Weekly cap: basic necessities may take off at most ₱" lowers it to what
  the booklet still allows (supervisor). **"Purchase booklet shown"** (unticked by default when
  the cart has 5% lines): without it those lines get nothing and the 20% still applies
  (`discount.booklet`; printed "No booklet: no 5% on BNPC"; not stored on the server). The cap
  measures what comes off the bill (VAT included), the same figure as the handoff's ₱125.
  `capSplit()` discounts only part of each 5% group (like the pax split; the rest is charged in
  full), as much as fits, so the buckets stay exact. Not applied on a pax-split bill. A Cashier needs a supervisor (verify-approver; offline a cached supervisor of
  the branch). `Sales.DiscountCap` + `DiscountApprovedBy`, audit `DISCOUNT_CAP`, the invoice prints
  "Weekly cap applied", and the Sales Details and Discounts reports show it.
  E.g. Retail 5% on ₱2,000 VAT-able, cap ₱20: ₱448 discounted, net ₱1,980 (full: ₱1,900).
- **Verified:** all eleven SQL suites on TabletPOS, TabletPOS_ENZO and TabletPOS_VROSS (166 each);
  the engine in Node (the pax-split cases unchanged, the rule order, and the cap on 3,000 random
  carts: never over the cap, within ₱0.02 of it, lines adding up to the totals); the endpoints
  over HTTP (12); the poster's lookup in SQL. **Not clicked through in a browser.** Installed
  2026-11-17 (32 + 02) on all three. **VROSS rates set 2026-11-18** (user: "non restaurant items
  should be 5%, not 20%"): SENIOR and PWD at Retail = 5%, VAT kept (24 Retail tills); the 6 GRILLS
  tills (Restaurant) keep the 20% VAT-exempt default; NAAC/MOV/SOLO unchanged. Script
  `scratchpad/lvl/vross_rates.sql`, audited DISCOUNT_POSTYPE_RATE_SET. **11-19 (user):** SENIOR and PWD
  on **Prepared Foods** (category 69, cooked food like dinuguan) at Retail tills = 20% VAT-exempt, so
  they need no booklet and no weekly cap (`scratchpad/lvl/vross_prepared.sql`).
- **ERP (11-17):** PostSale accepts a capped line as is: its line checks are arithmetic only, it
  never compares a discount with its code's rate. Keep the ID no. and name on capped sales (a
  SENIOR/PWD header without them is flagged). The ERP has no column for the cap; it would add
  optional @DiscountCap / @DiscountCapBy only if accounting asks.
- **Invoice and cart (11-18):** an SC/PWD sale prints "LESS VAT (EXEMPT)", "LESS SENIOR DISC 20%"
  and "LESS SENIOR BNPC 5%" on their own lines (gross less these = amount due; RMC 38-2012
  Q24-26), from `computeTotals()`'s `lessVat`, `discExempt` (20%), `discKept` (5% incl. its VAT
  adjustment) and the rates when single; sent as `discountBreakdown` for the invoice only (stored
  figures unchanged: `Sales.DiscountAmount` is still the discount without the VAT adjustment). Old
  sales without it print the single "TOTAL … DISCOUNT" line. The cart totals show the same lines.
  **Fixed 11-18** (VROSS 002/POS-01 SI 3, all 5% lines, printed "LESS VAT (EXEMPT) -0.01"): the 5%
  total was discount + VAT adj, which can be a centavo short of what the line actually drops
  (separate roundings: 77.25 → 73.38 is 3.87 off, 3.45 + 0.41 = 3.86), and the leftover fell into
  LESS VAT. `discKept` is now line total − net per 5% line (`perLine.kept`; the invoice line prints
  the same, `bnpc`). Old invoices keep their printed text.
  Same day (user): **`VatAdjustment` on a 5% line = the VAT the customer no longer pays** (line total
  − net − discount), so discount + VAT adj = the 5% line (meat loaf 3 × 21.50: 2.88 + 0.34 = 3.22;
  it was 0.35 from 5% of the shelf price rounded). Set again per line after a cap / pax split shares
  the figures out. It's stored and sent to the ERP inside LineDiscount, so the ERP's desktop SC
  figure (discount − VAT adj) now equals the discount. Only lines under ₱1 can still be a centavo out.
  The total prints **"LESS SENIOR 5% (GROCERY/BASIC COMM)"** (two lines on 58 mm), the cart says
  "SENIOR 5% (grocery/basic comm.)"; "No booklet: no 5% on grocery/basic comm.", "Weekly cap applied".
- **Handoff check (11-18):** SparkPOS's engine gives the handoff's amounts due on all its worked
  examples (mixed basket ₱775.00 with VATable 513.40 / VAT 61.60 / exempt 250.00; shared
  platter ₱1,040; fresh pork ₱760; ₱3,000 BNPC → ₱2,875). Not adopted from it: its table design,
  per-ID weekly tracking (the cashier enters the booklet amount), non-VAT stores, BMBE. The user:
  price levels are normal prices, so SC/PWD on top of a price level stays. Open (accountant): the
  5% on VAT-inclusive price, the week's start day, cooked meat-shop items 20% or 5%, which
  discount types get the 5%, the ERP's discountable flags on snacks/beverages at VROSS, and an
  X-/Z-Read split of 20% vs 5% (offered, not built).

## Price levels Price1–Price4 (built 2026-11-17)

The user: use the ERP's Price1–4 so the cashier has a choice, with SellingPrice still the default.
Their calls: **one level per sale** (picked in the cart), **any cashier, no approval**, discounts on
top with the same rules. Migration `database/31_price_levels.sql` (mirrored in `01_schema.sql`), then
re-run `02_procedures.sql`. Tests: `database/tests/price_levels_tests.sql` (11).
- **Storage:** `Products.Price1..4` (head office's, next to BasePrice) and `ProductPrices.Price1..4`
  (a branch's, on its SellingPrice row). `sp_GetPriceList` returns the levels of the row the price
  comes from: the branch's own, else head office's. NULL = no such level.
- **Sync:** `ErpSyncService` reads Price1..4 from `sp_SparkPOS_GetPrices` and passes them in their
  **own TVP** (`TVP_ErpPriceLevel`, `@PriceLevels`, `@LevelsSent = 1`), only when the ERP's result
  set has the four columns (`sys.dm_exec_describe_first_result_set`) and this DB has 31. A level ≤ 0
  = none; a NULL clears one. **`TVP_ErpPrice` stays 3 columns on purpose:** the first copy of 31
  widened it, which would have broken the live sites' older build (a DataTable with fewer columns
  than the type fails); 31 now puts it back. Don't widen a TVP an older deployed build still sends.
- **Names:** `dbo.PriceLevels` (4 rows, `LevelName`, `IsActive`), all off until an Admin names and
  switches them on in Admin → Price Lists → Price levels (`GET/PUT /api/settings/price-levels`;
  GET any signed-in user, PUT Admin only, audited `PRICE_LEVELS`). The ERP has no names for them.
  Price Lists shows a column per level that's on.
- **Till:** a "Price level: …" row in the cart (only when a level is on), `PriceLevelModal`.
  `cart.setPriceLevel()` moves every line to `levelPrice()` (its PriceN when > 0, else SellingPrice);
  a line repriced by a supervisor keeps its price, measured against the new level. New lines take the
  sale's level. The level price is the line's `OrigUnitPrice`, so it's not a price change (no `*`, no
  PRICE_EDIT row). Dine-in: Generate Bill gets the levels from the cached price list. The invoice
  prints "Price level: <name>". Levels are cached with the price list and the POS context for offline.
- **Sale:** `Sales.PriceLevel` (`sp_UpsertSale @PriceLevel`, sent only when set; out of range = none),
  shown in Sales Details. The ERP poster sends `@PriceLevel` to `spu_SparkPOS_PostSale` only when the
  ERP's proc has that parameter (`sys.parameters`), so the level price isn't flagged "differs from
  the ERP price" (ERP [321], applied 2026-11-17 on JFC DEV, VROSSMIG and the ENZO test copy;
  ENZO PROD is the user's to run). With a level, a line at the branch's PriceN gets no price flag;
  an unknown level still posts with NeedsReview. The ERP stores it in `SparkPOS_Sale.PriceLevel`,
  and a re-send that differs only in the level returns DUPLICATE (the first level is kept). The
  ERP's level columns are MONEY (JFC / ENZO) or DECIMAL(12,2) (VROSS); SparkPOS rounds to 2 places.
- **ERP data (11-17):** only VROSS has a level: Price1 on 125 products per branch (122 differ from
  SellingPrice); Price2–4 are 0 everywhere. ENZO and JFC have none.
- **Verified:** all ten SQL suites on TabletPOS, TabletPOS_ENZO and TabletPOS_VROSS (157 each); the
  cart logic in Node (8 checks); the Admin endpoints over HTTP on the test DB (11); on VROSSMIG
  through the sparkpos login, GetPrices shows the four level columns and PostSale has @PriceLevel.
  **Not clicked through in a browser.** Installed 2026-11-17 (31 + 02) on all three; the levels stay
  off, so nothing changes until the new build is deployed, a sync runs and an Admin switches a level on.

## POS type per terminal (built 2026-11-14)

The user: changing the POS type (e.g. to Restaurant) in POS settings applied to every terminal of
the branch; it should apply only to the chosen terminal. Migration `database/29_terminal_pos_type.sql`
(mirrored in `01_schema.sql`; no procedure changes) adds `Terminals.PosType` (NULL = follow the
branch's `PosSettings.PosType`, so every existing terminal is unchanged).
- Admin → Terminals: a "POS type" field (Branch default / Retail / Restaurant / Pharmacy) and a
  column. POS settings' type is now described as the branch default.
- The till: `restaurantMode` in Pos.jsx = `(ctx.terminal.PosType || ctx.settings.PosType)`; the
  terminal row is in the offline-cached context, so it holds offline too.
- Safe before the migration: the API saves the field only when the column exists, and refuses a
  non-blank type without it.
- Tables and print areas are still per branch, so a Restaurant terminal sees all of the branch's
  tables (fits the "one terminal serves a branch's dine-in tables" assumption above).
- Installed 2026-11-14 on TabletPOS (test), and on TabletPOS_ENZO and TabletPOS_VROSS (user's
  go-ahead); every terminal there still on the branch default. Not clicked through in a browser.

## Sales Details report: the BIR breakdown (2026-11-14)

Admin → Reports → Sales Details now shows, per invoice, the customer's TIN, VATable sales, VAT,
VAT-exempt sales, zero-rated sales, VAT adj. and the zero-rated Cert/ID No., with a total row
under the money columns that leaves out voided sales (`total` / `note` on a `REPORTS` entry,
`totalRow()` in Admin.jsx; any report can use them). `sp_rpt_SalesDetails` (02_procedures.sql)
returns the new columns: deploy = re-run 02 (or just that proc). The figures are the stored
invoice buckets, so sales before the 2026-11-13 VAT-exempt fix still show their non-VAT items
as zero-rated. Installed 2026-11-14 (only that proc, user's go-ahead) on TabletPOS, TabletPOS_ENZO
and TabletPOS_VROSS; the Admin screen needs the new build.

## Reports: complete figures, totals and headline cards (2026-11-15)

The user found Admin → Reports too thin. Every report proc in `02_procedures.sql` now returns the
full set (the Reports controller is unchanged; the procs keep their names and parameters):
- **Sales Summary** (per date × terminal, like a Z-Read): first/last SI, invoices issued, sales,
  gross, the discount per type (SC, PWD, NAAC, MOV, Solo, Regular/other) and their total, **Less VAT**,
  net, the four BIR buckets, VAT adj., cash and card sales, card txns, voids (count, amount),
  returns (count, amount, on the day made), net after returns, average sale.
- **Sales Details** adds the customer's address and business style, lines and items, discount ID /
  name / approver, diners, Less VAT, tendered, change, cash and card sales, returned later, and
  who voided it, when and why.
- Branch Comparison, Payment Breakdown (cash received, change, cash sales, split payments, cash
  refunds, net cash), Card Transactions, Discounts, Group by Category / Item (gross, discount,
  Less VAT, net, VAT, returned qty and amount, share), Void / Return and Cashier Performance all
  got the matching columns.
- **Rules every report follows:** sales figures count Completed sales only; **cash sales = cash
  received − change**, so cash + card = net; **Less VAT = gross − discounts − net**, the 12% VAT
  taken off SC/PWD-exempt sales, so every row reconciles gross → net. Item figures use
  `SaleItems.NetAmount` (lines from before 18_ fall back to LineTotal − LineDiscount).
- Admin.jsx: column kinds (`1` money, `'n'` count, `'q'` qty, `'pct'`, `'d'`, `'si'`, `'rtn'`), a
  total row on every report but Audit Logs (Sales Details leaves out voided sales), headline
  cards per report (`cards`), and the CSV export carries the total row.
- Checked read-only on VROSS and ENZO data with temporary (#) copies of the procs: every total
  matches the Sales table (VROSS 64 sales ₱41,102.69, ENZO 122 sales ₱166,810.91, voids and
  returns included). Installed 2026-11-15 (re-run of `02_procedures.sql`, no schema change) on
  TabletPOS, TabletPOS_ENZO and TabletPOS_VROSS (user's go-ahead); the installed procs give the same
  totals on both. ENZO: all eight suites pass. VROSS's sale-ringing suites couldn't run then (no
terminal without an unclosed day); fixed 2026-11-16, see "Users kept to their own branch". The
Admin screen needs the new build.

## Restaurant pax split on the bill; regular / other discount (built 2026-11-15)

Checked against BIR RMC 38-2012 (group meals: total ÷ diners, less VAT, × 20%). The user's calls:
- **Shared meal stays the rule**: the restaurant assumes a shared meal and doesn't ask what the
  senior ordered, so every discountable item is split by headcount (no "senior's own dish" option).
- **One SC/PWD ID per sale** stays (one `DiscountCtrlNo` / `DiscountName`, however many seniors).
- **Service charge: parked.** SparkPOS has none (ENZO and VROSS don't use one); keep it for a
  later client. The Restaurant POS type's description in Admin still mentions it.
- **The pax split is worked out on the bill** (`paxSplit()` in store.js), not item by item: one
  group per treatment (VAT-able or not, rate, exempt or not); the senior share is
  total × seniors ÷ diners **in whole centavos** (a float fraction got 1,066.95 × 3/10 wrong),
  run once through `discountLineAmount()`, then each figure is shared out to the lines by
  largest remainder (`allocate()`). The amount due now equals the BIR formula exactly (50,000
  random bills); 2 × ₱100 with 4 pax / 1 SC gives 185.71 like 1 × ₱200 (it gave 185.72). Every
  line stays within the ERP's VAT = 12% × VATable ± 0.01. `cart.lineDiscount()` now reads
  `totals().perLine` (a line can't compute its own share any more); `lineDiscountOf` is gone.
- **Regular / other discount** (`OTHER_DISCOUNT = 'OTHER'`, not a DiscountTypes row): the user
  chose a **peso amount**, **supervisor approval** (verify-approver; offline a cached supervisor
  of the branch; a signed-in Supervisor/Admin gives it directly and is recorded), **never with
  SC/PWD** (one discount per sale), **whole sale**, every item included. A reason is required
  (`DiscountName`, printed as "Reason:"; no Ctrl#/signature lines). `computeTotals(…, otherAmount)`
  shares the amount out by line amount; it is **not VAT-exempt**: a VAT-able line's VAT is
  12/112 of what's left, a VAT-exempt item stays exempt at its discounted amount, so the four
  buckets add up to Net and VatAdjustment is 0. Pax is ignored with it.
  - Migration `database/30_other_discount.sql` (`Sales.DiscountApprovedBy`, `ZReads.DiscOther`,
    mirrored in `01_schema.sql`), then re-run `02_procedures.sql` (`sp_UpsertSale
    @DiscountApprovedBy` + audit `OTHER_DISCOUNT`; X-Read and Z-Read `DiscOther`, printed
    "REGULAR/OTHER"). The sync sends the approver only on an OTHER sale. Tests:
    `database/tests/other_discount_tests.sql` (7).
  - **ERP: not confirmed.** The poster sends header DiscountCode `OTHER`, DiscountName = the
    reason, no DiscountCtrlNo, and no per-line discount code (there's no rate for
    `<code><rate%><E|N>`). Expect a review flag (header code without control no.; discount on a
    non-discountable line); whether the ERP refuses an unknown code, and how its desktop copy
    and GL take it, is for the ERP session. Ask before turning it on at a posting branch.
  - Accounting: the Z-Read entry adds an OTHER discount back to Sales - Vatable even when it
    was on a VAT-exempt item (`NetAmount + DiscountAmount − buckets`); it still balances.
  - `PosSettings.MaxDiscountPerTxn` is still not enforced anywhere.
- Installed 2026-11-15 (30 + 02) on TabletPOS, and on TabletPOS_ENZO and TabletPOS_VROSS (user's
  go-ahead); all eight suites pass on each, 138/138. The screens are not clicked through in a browser.

## Days close in order (v2.1.1, 2026-11-10)

Found on the ENZO test site. At 023/POS-01, the 11-05 shift was blind-closed the next morning.
"Run End of Day" then closed **11-06**, which had no shifts, so the Z-Read was empty. 11-05
(26 sales) never got a Z-Read. Meanwhile 023/POS-02's 11-06 shift stayed open for days, and a
cashier signing in later only got "Terminal already has an open shift".
- **Root cause:** BlindClose.jsx and CashBegin.jsx opened `/end-of-day` without `businessDate`.
  EndOfDay.jsx then fell back to `localDate()` (today).
- **Fix: BlindClose** passes the shift's own business date.
- **Fix: `sp_OpenShift`** refuses a new day (51012) while an earlier day on that terminal has
  shifts but no Z-Read.
- **Fix: `sp_ProcessEndOfDay`** refuses a date with no shift (51005). It also refuses a later
  day while an earlier one is unclosed (51013).
- **Fix: `sp_GetTerminalDayState`** returns the earliest unclosed earlier day as `UnclosedDate`,
  plus that day's still-open shift. `terminal-state` exposes these as `unclosedDay`, and
  `canSell` is false while it's set.
- **Fix: Cash Begin** shows the unclosed day first:
  - "Blind-close my shift of …" when it's the cashier's own open shift;
  - who must close it (or a force-close in Admin) when it's someone else's;
  - "Run End of Day for …" once its shifts are blind-closed.
  Login itself is never blocked, because the day is closed by signing in.
- **Tests:** `bir_tests.sql` T17/T18. The suites' End of Day blocks (bir T9, acc ledger) now
  pick a terminal with no unclosed day, since the 51013 guard would otherwise trip on real
  data. Deploy = re-run `02_procedures.sql` (no schema change).
- **Still open (asked the user):**
  - Login on the same device still resumes the cashier's own open shift straight into the POS
    whatever its date, so sales keep that old business date.
  - The 11-05 Z-Read on POS-01 will carry a later Z counter than the empty 11-06 one.

## Void / Reprint by OR number

Both used to only operate on `lastSale` (in-memory React state, lost on reload, couldn't
reach any other transaction). Now both open a modal with an OR# field:
- **Void**: field starts empty (deliberately no default — voiding is destructive, shouldn't
  be one Enter-key-press from voiding whatever was last sold).
- **Reprint**: field defaults to the last OR number issued on this terminal, read from the
  persistent local counter (`or_next - 1` in IndexedDB meta), so the "just reprint the last
  one" one-tap flow still works even after a reload.
- Lookup (`findSaleByOr()` in `lib/api.js`) checks the local offline queue first (works
  without a connection), then falls back to `GET /api/sales/by-or/{terminalId}/{orNumber}`
  (new endpoint, reuses the existing `GET /api/sales/{saleUid}` action that already existed
  server-side but was never wired to the UI). OR numbers are only unique **per terminal**
  (`UQ_Sales_OR` = `(TerminalId, ORNumber)`), not globally — every lookup is terminal-scoped.

## Restaurant POS Type (dine-in / takeout)

`PosSettings.PosType` was a pre-existing column (`'Retail'|'Restaurant'|'Pharmacy'`), but only
Retail behavior was ever implemented before this feature. Takeout on a Restaurant-type branch
reuses the retail flow unchanged; dine-in is new.

- **Server-tracked pre-payment tab, not a client-side cart extension.** `dbo.Tables` (per-
  branch table list) → `dbo.OpenOrders` + `dbo.OpenOrderItems` (a dine-in tab; items get added
  over possibly several rounds) → **Generate Bill** loads the accumulated server items into the
  existing Zustand `useCart` store via `loadFromOrder()` (`web/src/lib/store.js`) and falls
  through to the **unmodified** discount/payment/receipt pipeline. Only a `checkoutOrderUid`
  breadcrumb (`Pos.jsx`) tracks that the order must also be closed after payment succeeds.
  This was a deliberate design choice to reuse ~90% of the retail checkout path instead of
  duplicating payment/discount/receipt logic for dine-in.
- **Dine-in went local-first (offline-capable) after initially shipping online-only.**
  Reopened deliberately, on the explicit assumption that **a single terminal serves a given
  branch's dine-in tables at a time** (no cross-device conflict handling exists — two offline
  devices editing the same table's tab independently is unhandled and would need a real
  conflict policy first). Mirrors the sales offline queue:
  - `web/src/lib/api.js` — `db.posTables` (cached at Cash Begin via `pullTables()`, same
    trigger as `pullPriceList()` — also refreshed live every time the table grid is opened,
    see below) and `db.openOrders` (one row per order, order header fields flat + an embedded
    `items` array, `syncStatus` like `pendingSales`). `openLocalOrder()` /
    `addLocalOrderItem()` / `setLocalOrderItemQty()` / `voidLocalOrder()` / `closeLocalOrder()`
    all mutate IndexedDB directly and return instantly — `Pos.jsx`'s dine-in handlers no
    longer call `api()` directly for any of these.
  - `syncPendingOrders()` pushes a **whole-snapshot replace** per dirty order to
    `POST /api/orders/sync` (`OrdersController.Sync`, mirrors `SalesController`'s
    `/api/sales/sync`) — deletes and reinserts that order's `OpenOrderItems` wholesale rather
    than replaying individual add/remove calls, which is simpler and idempotent by
    `OpenOrderUid`. `startSyncLoop()` (`App.jsx`) now runs both sales and orders sync on the
    same 20s/online-event cadence.
  - `openLocalOrder()` still prefers a **live** call to `OrdersController.Open()` when
    nothing's cached locally yet and the device is online — this is what lets it resume a
    genuinely existing server-side order (e.g. a fresh device, or local storage that was
    cleared) instead of racing a duplicate into `UQ_OpenOrders_OneOpenPerTable`. Offline with
    nothing cached, it creates a fresh client-GUID order outright.
  - The single-order live endpoints (`AddItem`, `SetItemQty`, `Close`) are still in
    `OrdersController` but the client no longer calls them — kept as a valid API surface, not
    dead code to be pruned reflexively, since removing working endpoints isn't this task's
    concern. `Open` and `Void` are still called directly in specific cases (see above).
  - Table occupancy in the grid (`loadLocalTables()`) merges the cached table list with any
    locally open order's current item count, so it's correct offline and doesn't wait on a
    round trip either way — same "0 items shows Available" rule as before, now computed
    client-side instead of server-side.
  - **This rule regressed once, silently, when dine-in went local-first** — the online-era
    fix lived in `TablesController.Get()`'s SQL; when table occupancy moved to
    `loadLocalTables()` (client-side merge against `db.openOrders`), that specific `> 0`
    check didn't get carried over, so a table opened-and-abandoned showed occupied again.
    Caught by the user re-testing the exact scenario the original fix targeted, not by any
    review pass. Same lesson as the receipt formatters above: a business rule implemented
    twice (server SQL, then client JS) needs both copies checked whenever either one changes,
    not just the one being actively edited.
  - **The table LIST itself deliberately does NOT follow products' "only refresh at Cash
    Begin" convention.** `Pos.jsx`'s `loadTables()` calls `pullTables()` (live refresh into
    `db.posTables`) every time the table grid is opened, before falling back to
    `loadLocalTables()`'s cached read — found necessary when a table added in Admin mid-shift
    didn't show up until the next Cash Begin, since `db.posTables` had only ever been
    populated once, at shift-open time. Tables are small in number and admin-edited on a
    timescale that matters (staff actively adding/renaming them during service), unlike the
    product catalog, so the extra round trip per grid-open is worth it. Still degrades
    gracefully offline — falls back to whatever's cached if `pullTables()` fails.
  - This fully replaced (not layered on top of) the earlier stopgap fix for the
    completeSale()/order-close race — `closeLocalOrder()` being local-first sidesteps that
    race entirely instead of needing to await sale sync first.
- **Flat discount only, not diner-count pro-rata split** was the original scope decision here —
  **superseded**: the diner-count pro-rata split (senior/PWD share only of a shared bill) was
  built later under "Discount configuration" below (`pax` / `PaxModal`, captured at Generate
  Bill). This section's own math no longer needs it re-explained; see that section instead.
- **Generate Bill prints an unofficial pre-payment bill AND sends to the kitchen.**
  `buildBill()` in `web/src/lib/receipt.js` — a formatter alongside `buildReceipt()` (see "Two
  independent receipt/report formatters" above): no OR number, no VAT breakdown, no discount
  line, because discount hasn't been chosen yet at this point in the flow (it's applied
  afterward, in the same `DiscountModal` retail uses). Clearly labeled
  `*** NOT AN OFFICIAL RECEIPT ***` so it can't be mistaken for one. The real BIR receipt still
  prints once, at actual payment, via the unchanged `buildReceipt()`. `generateBill()` also
  calls `sendToKitchen()` as a best-effort catch-up first (see "Kitchen/beverage print-area
  routing" below) in case staff forgot to tap Send to Kitchen for the last round.
- **One open order per table is enforced at the DB level**, not just app-level: a filtered
  unique index (`UQ_OpenOrders_OneOpenPerTable` on `OpenOrders(TableId) WHERE Status='Open'`)
  catches the case where two concurrent taps on the same table (or a double-fired request)
  both pass the app's own pre-check before either INSERT commits. `OrdersController.Open()`
  catches the resulting SQL Server duplicate-key error (2601/2627) and returns whichever order
  won, rather than erroring. `AddItem()`'s merge-on-tap logic has the same race (two adds both
  computing the same next `LineNo`) and is fixed the same way — retry loop against
  `UQ_OpenOrderItems`, up to 3 attempts.
- **`Close()` doesn't hard-require the SaleUid to already exist in `dbo.Sales`** — it logs
  `TABLE_ORDER_CLOSE` vs. `TABLE_ORDER_CLOSE_UNVERIFIED` depending on whether the sale is found,
  rather than rejecting. `completeSale()` in `Pos.jsx` calls `closeLocalOrder()` (local-first,
  see above) rather than the live endpoint, so this race mostly doesn't arise in practice
  anymore — the audit-vs-reject distinction remains as defense-in-depth for whenever the sync
  actually lands.
- **Migration**: `database/08_restaurant_tables.sql` (idempotent, `IF OBJECT_ID(...) IS NULL`
  pattern like `04`–`07`) — `01_schema.sql` also has the same tables for fresh installs.
- **Not yet fixed / flagged, not resolved**: a Supervisor-role branch-ownership check exists on
  `TablesController.Update` but **not** on `TablesController.Create`, nor on the older sibling
  endpoints `TerminalsController.Update` / `BranchesController.Update` — all have the same gap
  (a Supervisor can act on another branch's row via a guessable ID). Only `Tables.Update` was
  in scope when this was found; fixing the rest is a separate, broader task, not a quick
  follow-on.
- **Takeout/Dine-in toggle is hidden mid-checkout.** It used to stay visible and clickable
  after Generate Bill (`checkoutOrderUid` set), and tapping Takeout there would clear
  `activeOrder` while leaving `checkoutOrderUid` set — the resulting desync could strand
  `dineInStage` at `'ordering'` with no `activeOrder`, wedging the toggle. Fixed by hiding the
  toggle row entirely while `checkoutOrderUid` is set (`Pos.jsx`) — it was the only path that
  could reach `goToTakeout()` in that state, so removing it removes the whole class of bug.
- The new "Back to Tables" button uses an inline SVG chevron, not a Unicode arrow — matches
  the confirmed font-limitation rule for this device (see the handheld terminal section
  above).

## Multiple physical terminals: PrintAgent now polls, doesn't get pushed to (v2)

The original fix for multi-terminal deployments was `Terminals.PrintAgentUrl` /
`PrintAreas.PrintAgentUrl` — the API server dialing directly into each terminal's PrintAgent.
That required the agent to be reachable **from** the server, which meant router
port-forwarding (or a VPN) for any terminal not on the server's own network — a real security
exposure, and the thing that caused the very first real deployment's private-IP-routing
detour (see the diagnostic lesson below, still valid). **This was replaced wholesale** by a
poll-based job queue: PrintAgent now calls out to the server instead of the other way around,
which is a purely outbound connection and needs zero network configuration no matter where
the terminal physically sits. `PrintAgentUrl` is gone — dropped from both `Terminals` and
`PrintAreas`, and no longer read anywhere.

- **Schema**: `dbo.PrintJobs` (`AgentKey`, `PrinterTarget`, `JobText`, `Status`
  Pending/Delivered) — `database/15_print_jobs_queue.sql` (also drops `PrintAgentUrl` from both
  tables; safe to rerun, and safe even if `13_print_agent_url.sql` — the migration that
  originally added the column — was never run on a given DB). `01_schema.sql` updated for
  fresh installs so it never creates the column at all.
- **`PrintService`** is now just `EnqueueAsync(con, text, printerTarget, agentKey)` — an
  `INSERT INTO dbo.PrintJobs`, nothing else. The old `SendAsync(text, target, agentBaseUrl,
  agentApiKey)` HTTP-push method is gone. Every server-initiated call site
  (`ShiftsController` Blind Close/X-Read/force-close, `EndOfDayController` Z-Read/reprint,
  `TerminalsController` Test Print, `OrdersController.SendToKitchen`, and the browser-fallback
  `PrintController`) now calls `EnqueueAsync` instead, passing `PrintAgentKey` (kept — see
  below) instead of the old `PrintAgentUrl`.
- **New `PrintJobsController`**: `GET /api/print-jobs/poll?key=<PrintAgentKey>` — deliberately
  **not** `[Authorize]` (JWT), since a PrintAgent process has no cashier/admin session to log in
  with; the key itself *is* the credential, much lower blast-radius than a user JWT (it only
  exposes jobs already queued for that one agent). Atomically claims the oldest pending row via
  an `UPDATE ... OUTPUT` on a `TOP(1) ... ORDER BY PrintJobId` CTE (`TOP` alone has no defined
  order under `UPDATE`, so this is needed for "oldest" to actually mean oldest) and marks it
  `Delivered` the instant it's handed out — no separate ack round-trip, matching the existing
  "handoff, not a confirmation" honesty RawBT printing already has elsewhere in this app.
- **`PrintAgent` (`src/PrintAgent/Program.cs`) is now dual-mode**, both halves needed:
  1. Still hosts `http://localhost:5099/print` for same-machine browser prints (sale receipts,
     kitchen slips via `printText()`) — loopback-only, unchanged from before, no firewall rule
     needed since a browser and its own machine's loopback address never cross a network
     boundary.
  2. A background `PollLoopAsync` hits `{ApiServerUrl}/api/print-jobs/poll?key={ApiKey}` every
     3 seconds and dispatches whatever it gets through the same `Dispatch.PrintAsync` used by
     `/print` — one shared ESC/POS/target-scheme implementation regardless of which path a job
     arrived through. Configured via `ApiServerUrl`/`ApiKey` in `PrintAgent`'s own
     `appsettings.json` (or `PRINTAGENT_APISERVERURL`/`PRINTAGENT_APIKEY` env vars). Both blank
     = polling simply doesn't start (`if (!string.IsNullOrWhiteSpace(apiServerUrl))` — the agent
     still serves same-machine prints, just doesn't reach out). `ApiKey` blank with
     `ApiServerUrl` set = the shared default agent (matches leaving `PrintAgentKey` blank in
     Admin — see below).
  3. `/health` reports `polling: true/false` based on whether `ApiServerUrl` is set, so a quick
     `curl` against a deployed agent tells you which mode it's actually in.
- **`Terminals.PrintAgentKey` / `PrintAreas.PrintAgentKey` stay** (from the earlier push-model
  work, `database/14_print_agent_key.sql`) but changed role: previously an inbound-request
  credential (`X-Agent-Key` header on a server→agent push), now the agent's own outbound polling
  identity (`?key=` on its poll request) — same column, same value, opposite direction. Leave it
  blank on both the terminal/area row and the agent's `appsettings.json` for a single-PrintAgent
  deployment; the poll queries `WHERE AgentKey = ''` and everything queued under the shared
  default lands there.
- **Admin**: both the Terminals and Print Areas edit forms now show a "Print agent key
  (optional)" field (replacing the old "Print agent URL" field) with an inline note explaining
  the polling model and that blank means "the shared default agent."
- **Confirmed end-to-end on 2026-08-23** against the real MDU branch deployment
  (`http://itcoreapps.com:8080`) — Test Print from Admin against the MDU terminal
  (`spool://XP-80C`) actually reached the printer. Two things had to be fixed together before
  it worked, worth remembering if this regresses on another terminal:
  1. **The published `PrintAgent.exe` can silently predate the poll-loop code.** The exe in
     `publish-printagent/` had been built ~28 minutes *before* the poll loop was added to
     `Program.cs` that same session — running it looked fine (`/health` even responded), but it
     was the old single-mode agent and could never have picked up a queued job, no matter what
     `appsettings.json` said. A stale exe from an earlier publish is a real, easy-to-miss failure
     mode distinct from a config problem — if `/health` doesn't report `"polling": true` (or a
     Test Print never arrives even though `/health` looks fine), rebuild before troubleshooting
     config: `dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
     -p:IncludeNativeLibrariesForSelfExtract=true -o publish-printagent`. `dotnet publish`
     preserves an existing `appsettings.json` in the output folder rather than overwriting it
     (standard `CopyToOutputDirectory: PreserveNewest` behavior), so a config already tuned for a
     given machine survives a rebuild.
  2. **`ApiServerUrl` must be set to the site's actual base URL, not left blank** — obvious in
     hindsight, but the field had never been populated on this machine before (see "Deploying
     `PrintAgent`..." below — no dev-tools desktop starts with it set). It's `http://host:port`
     only, no `/admin` path — that's just the frontend route within the same site.
  3. **A `PrintAgentKey` mismatch fails silently and specifically fools this exact test
     sequence.** The MDU terminal row already had `PrintAgentKey = txIHV2OfVXfdn9Y7tlapxV8rj0Yrfx`
     set in the DB (a leftover from earlier testing, matching the stale `ApiKey` found in
     `publish-printagent/appsettings.json` before item 1 above), while the freshly-rebuilt agent
     was configured with a **blank** `ApiKey` on the reasoning that a blank field in Admin means
     "shared default" — reasonable in general, wrong for this specific already-configured
     terminal. Symptom was maximally confusing: `/health` reported `polling: true` (agent really
     was reaching the server), a Test Print click showed no error, and an *earlier* Test Print
     did print successfully — because that one job had been queued before the key was set on the
     terminal row, so it happened to match the agent's then-also-blank key. Once the key was set,
     every new Test Print queued under `txIHV2OfVXfdn9Y7tlapxV8rj0Yrfx` and the blank-keyed agent
     simply never saw it — while **cashier sale receipts kept printing fine the entire time**,
     since that path is the same-machine loopback `localhost:5099/print` call, which never checks
     `PrintAgentKey` at all. That gap (one working print path masking a broken one) is what made
     this look like it might be a real regression rather than a one-field mismatch. Fixed by
     setting the agent's `ApiKey` to the value already in the DB rather than the other way
     around, then restarting the agent. **Lesson**: `PrintAgentKey` must match exactly between a
     `Terminals`/`PrintAreas` row and the agent meant to serve it — check both sides, don't assume
     blank-means-blank once a terminal has been touched before. If Test Print silently does
     nothing while cashier receipts print fine, suspect a key mismatch before anything else; a
     direct `sqlcmd` check of `dbo.Terminals.PrintAgentKey` for that terminal is the fastest way
     to confirm.
  - **Still open**: `PrintAgent.exe` on the MDU cashier desktop was started manually as a
    foreground process for this test, same as before — it does not survive a reboot or a closed
    window yet. Converting it to a Task Scheduler "run at logon" entry (or a proper Windows
    Service) is deliberately deferred, not forgotten — do it before relying on this terminal
    unattended.
- **Historical lesson, still relevant** — the diagnosis that motivated moving off the push
  model in the first place: a remotely-hosted server and a printer terminal behind a
  home/office router are not on networks that can route to each other at all (confirmed via
  `ipconfig`/`Test-NetConnection` on both sides — the desktop's LAN IP was a private RFC 1918
  address, the server's were a public address and a *different* private network). No firewall
  rule or config value fixes that; only port-forwarding or a VPN could have, both of which the
  poll model now avoids needing entirely. **When a cross-machine health check fails, get both
  machines' real IP addresses and confirm they could even route to each other before chasing
  firewall rules or app config further** — this generalizes past printing.
- **Deploying `PrintAgent` to a plain desktop with no dev tools**: publish it self-contained so
  no .NET runtime install is needed there —
  `dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true`
  produces a single `PrintAgent.exe` (~90MB, bundles the whole runtime). Copy the output folder
  over and run the exe — **no inbound firewall rule needed anymore** (the old
  `New-NetFirewallRule ... LocalPort 5099` step was only ever for the server-push model reaching
  in from outside; polling is outbound-only). It's still a plain foreground process with nothing
  keeping it running after a reboot or a closed window — a Task Scheduler "run at logon" entry
  (or converting it to a proper Windows Service) is a real follow-up, not yet done. Rebuilding
  still requires killing whatever's holding the old exe open first, or the publish step fails
  with a file-lock error that looks unrelated but is just the old instance still running.

## `spool://` — printing to a USB printer with no virtual-COM-port mode

Confirmed on real hardware: an Xprinter XP-80C installed normally on Windows (just the
standard Xprinter driver, no virtual-COM-port option enabled) enumerates on a **virtual USB
port** (`USB004`, `USB008`, etc. — check via `Get-Printer | Select Name, PortName`, not
Device Manager's Ports list, since it's not a COM port at all). `file://COM<n>` doesn't apply
here — there's no COM port to point at, and `PrintAgent`'s `file://` handler is a literal
`File.WriteAllBytesAsync`, which can't write to a `USB00x` port the way it can a COM port.

- **`spool://<exact printer name>`** (e.g. `spool://XP-80C`) is the fix — `RawPrinter` in
  `src/PrintAgent/Program.cs` is a `winspool.drv` P/Invoke helper
  (`OpenPrinter`/`StartDocPrinter`/`StartPagePrinter`/`WritePrinter`/`EndPagePrinter`/
  `EndDocPrinter`, `DataType = "RAW"`) that sends ESC/POS bytes straight through the Windows
  print spooler, bypassing the driver's own text/graphics rendering entirely. This works for
  **any** Windows-installed printer regardless of port type (USB00x, LPT, a network share),
  not just this one model — verified by actually running `PrintAgent` and firing
  `POST /print` with `target: "spool://XP-80C"` against the real printer, not just compiling.
  The printer name must match exactly what `Get-Printer`/Windows' Printers & Scanners settings
  shows.
- If a printer *does* offer a genuine virtual-COM-port driver mode, `file://COM<n>` (found via
  Device Manager → Ports once that mode is enabled) still works exactly as documented under
  Printing above — `spool://` is the fallback for when that mode doesn't exist or isn't worth
  hunting for, not a replacement for it.
- Remember **PrintAgent must run on the machine the printer is physically attached to** — see
  "Multiple physical terminals: PrintAgent now polls, doesn't get pushed to (v2)" above. Getting
  the `PrinterTarget` scheme right doesn't help if no PrintAgent is running where the printer
  actually is.

## Configurable paper width (58mm/32-col vs 80mm/48-col)

Every printer target (`Terminals.PaperWidth`, `PrintAreas.PaperWidth`) now carries its own
paper width in mm — `58` (32 columns, the original handheld default) or `80` (48 columns,
the most common fixed thermal-printer size). Defaults to 58 for every existing row
(`database/11_paper_width.sql`), so nothing already deployed changes width until an Admin
explicitly sets a terminal or print area to 80mm.

- **`ReceiptBuilder.Columns(int paperWidthMm)`** (server) and **`columnsFor(paperWidthMm)`**
  (`web/src/lib/receipt.js`, client) are the single source of truth for the mm→columns
  mapping — `>= 80` → 48, everything else → 32. Don't hardcode either number elsewhere.
- **Every formatter takes the width as a parameter now**, not a module-level constant — each
  of `ReceiptBuilder`'s public methods (`BlindClose`, `XRead`, `ZRead`, `KitchenTicket`,
  `TestPrint`) takes `int paperWidthMm = 58` and shadows the private static `C`/`LR`/`Rule`
  helpers with width-bound local functions of the same name, so the method bodies themselves
  didn't need to change — only the signature and the two new lines at the top. `receipt.js`'s
  `ctr`/`lr`/`rule` take `w` as an explicit first argument instead.
  Each call site now fetches `PaperWidth` alongside `PrinterTarget` (same query, one extra
  column) and threads it through — `ShiftsController` (Blind Close, X-Read),
  `EndOfDayController` (Z-Read, Z-Read reprint), `TerminalsController` (test print),
  `OrdersController.SendToKitchen` (per print area). Client-side, width comes from
  `ctx.terminal.PaperWidth` (already flows through from `GET /api/terminals` once the column
  exists — no query change needed there since it's a `SELECT t.*`).
- **HTML email reports are unaffected** — they were never width-constrained (see "Two
  independent receipt/report formatters" above); only the plain-text printed paths changed.
- **Admin**: a "Paper width" dropdown (58mm/80mm) on both the Terminals and Print Areas edit
  forms, plus a Paper column on both list tables.
- **Setting up a real USB 80mm thermal printer**: see the two sections above
  ("`spool://`..." and "Multiple physical terminals: PrintAgent now polls...") — the
  printer-target scheme and the PrintAgent-machine-location problem are two separate things
  you can hit independently,
  and both were found via the same real-hardware/real-deployment testing pass.

## Kitchen/beverage print-area routing (Restaurant PosType, "Send to Kitchen")

Each print area (Kitchen, Beverage, etc.) has its own **network** printer, mapped per branch
from the shared/global category catalog — since `dbo.Categories` has no `BranchCode` (one
catalog, per-branch price overrides via `ProductPrices`), the same pattern applies here via a
new mapping table rather than a column directly on `Categories`.

- **Schema**: `dbo.PrintAreas` (`BranchCode`, `AreaName`, `PrinterTarget`, `PaperWidth`,
  `IsActive`) and `dbo.CategoryPrintAreas` (`BranchCode`, `CategoryId`, `AreaId` — composite
  PK, no row means that category isn't sent to any kitchen printer at that branch).
  `OpenOrderItems` gained `SentQuantity` to track how much of a line has already been sent to
  the kitchen. `database/10_print_areas.sql` (there is no `09_` file in the repo).
- **"Send to Kitchen" is inherently online-only**, unlike the rest of dine-in (which went
  local-first — see above): a browser cannot open a raw TCP socket to a LAN printer, so
  printing to an area's network target always has to go through the server
  (`OrdersController.SendToKitchen` → `PrintService` → the print agent, same mechanism as
  X-Read/Z-Read). RawBT is never used for area printers — it only bridges to the handheld's
  own paired printer. If offline, the button just fails with a clear error and nothing here is
  marked sent, so it's safe to retry once reconnected.
- **Delta-based, not whole-order.** The client always sends the order's current full item
  snapshot (same shape as `Sync()`); the server compares each line's `Quantity` against its
  stored `SentQuantity` to compute what's new, upserts via `MERGE`, prints only the delta
  grouped by area, then sets `SentQuantity = Quantity`. This is what makes repeated taps and
  multi-round ordering safe — no duplicate tickets for what a kitchen printer already got.
- **The consolidated ticket prints via the same terminal already handling the table** — not a
  separate cashier station (there isn't one in this app's model; one handheld runs the whole
  table from order to payment). `buildKitchenSlip()` in `web/src/lib/receipt.js` renders just
  the delta the server reported sending, via the terminal's existing `printText()` pipeline
  (RawBT or PrintAgent, whichever that terminal already uses) — same "no prices, not a bill"
  formatting as the per-area tickets, just a full-order copy for the terminal's own trail.
- **Admin**: new **Print Areas** tab (CRUD, mirrors Tables — branch-scoped, same
  branch-ownership check on `Update` as `TablesController`) and a **Print area** column added
  to the existing **Categories** tab (only shown once a single branch is selected in the
  header, since the mapping is per-branch but the category list itself is shared).

## Discount configuration (per-category rate/VAT overrides — RA 9994 etc.)

A discount **type** (SENIOR/PWD/NAAC/MOV/SOLO) is still picked once per transaction — the
cashier UX (`DiscountModal`) didn't change. What changed: the *effective rate and VAT
treatment now resolve per line item's category*, because RA 9994-style discounts aren't one
flat rate — e.g. Senior Citizen is 20% + fully VAT-exempt on medicine, but only 5% +
still-VATable (needing a VAT adjustment) on groceries/prime commodities, **within the same
transaction**. This was worked out from three hand-verified reference examples (Retail,
Restaurant, Pharmacy) — see the reconciliation below before touching this math again.

- **Schema**: `dbo.DiscountCategoryRates (DiscountCode, CategoryId, Rate, IsVatExempt)` —
  composite PK, no row for a category means "use `DiscountTypes`' own default Rate/
  IsVatExempt unchanged." Global, not branch-scoped (these rates are legally mandated, not a
  branch's business choice) — `database/12_discount_config.sql`. Also added to that
  migration: `dbo.Sales.VatAdjustment` (reporting-only figure, see below),
  `dbo.Sales.DinerCount`/`SeniorCount` (Restaurant pax split, captured at Generate Bill).
- **Core computation** lives in `web/src/lib/store.js`: `resolveDiscount()` looks up the
  category override (falling back to the discount type's default), `discountLineAmount()` is
  the pure per-amount math (reused for a whole line or for a pax-split fraction of one — see
  below), `computeTotals()` wires it all together. All discounts are computed off the
  **net-of-VAT base**, never the VAT-inclusive gross — for a non-VATable amount, net-of-VAT
  equals the amount itself, so this generalizes without a special case.
- **Two distinct behaviors depending on the resolved `vatExempt` flag**, both confirmed
  against the worked examples via a standalone Node script importing `computeTotals` directly
  (not just by hand):
  - `vatExempt: true` (the RA 9994 standard case) — the amount becomes **fully VAT-exempt**:
    no VAT is re-added, and there's **no VAT ADJ** (there's no VAT left to adjust). "VAT
    Exempt Sales" reports the line's *pre-discount* net-of-VAT base (the amount that
    qualified for exemption) — this matches standard BIR sales-invoice reporting and two of
    the three reference examples (Retail, Restaurant); the discount is deducted separately.
  - `vatExempt: false` on a VATable amount (e.g. the 5% prime-commodity rate) — VAT is
    **re-added on the post-discount net base** (the new taxable base), and "VAT ADJ" — the
    gap between a naive gross-based discount and the correct net-of-VAT-based one — is
    reported for transparency **only**. It is never subtracted a second time from what the
    customer pays; the actual cash amount already nets it out via the net-of-VAT-based
    discount, not the naive one.
- **Reconciling the reference examples — do not "fix" this back to the literal numbers
  without re-deriving them.** All three examples' final totals were re-derived by hand and
  cross-checked by actually running `computeTotals()`:
  - Restaurant's numbers matched **exactly** (net 185.71, regular sale 150, senior sale
    35.71, VAT-exempt 44.64, VATable 133.93, VAT 16.07) — this one was internally consistent
    as given.
  - Retail's and Pharmacy's *stated* "Amount Due" figures (255.86 and 155.72) don't hold up:
    reconstructing them item-by-item (net-of-discount + re-added VAT for the VATable/
    non-exempt line) gives 256.49 and 166.44 instead. The gap in both cases is caused by the
    reference material effectively subtracting the VAT ADJ twice — once implicitly (it's why
    the correct net-of-VAT-based discount is smaller than a naive gross-based one) and once
    again explicitly in the "Amount Due" formula. Confirmed with the user which resolution is
    correct: **VAT ADJ is reporting-only, never a further cash deduction** — `computeTotals()`
    implements that resolution, so its `net` deliberately does not reproduce 255.86/155.72.
  - The user re-shared the same examples as BIR material on 2026-10-27, plus a fourth
    (Fast food: 2 × ₱100 VATable, SC 20%, amount due 142.86 = SparkPOS's, but VAT-exempt sale
    stated as 142.86 post-discount; SparkPOS 178.58 pre-discount, and its discount is 35.72
    not 35.71 because it rounds per item). Of the four, two state the exempt figure
    pre-discount (Convenience/meatshop 150, Restaurant 44.64) and two post-discount (Pharmacy
    71.43, Fast food 142.86) — still an open decision for the user / accountant.
  - **ENZO rates (set 2026-10-27, user's instruction "meat and groceries 5%")**:
    `TabletPOS_ENZO` had no `DiscountCategoryRates`, so SC/PWD gave 20% VAT-exempt on every
    discountable item. Now **all five types** (SENIOR, PWD, NAAC, MOV, SOLO — the user: "naac
    and other discount will follow the same rule") = 5%, VAT not exempt, on all 21 meat/grocery
    categories (the 5 empty ones included), 105 rows. Not set: Consumables and Smart Products
    (empty). Consumables = plastic bags at ₱0 in the ERP (given free) — so they never get a
    discount, but they're also **hidden from the till** (an ERP item at 0 is always hidden), so
    SparkPOS can't ring them up the way the desktop POS does (open question to the user).
    Pending the accountant: a weekly purchase cap on the 5% discount (not enforced), and these
    settings must be redone on the production ENZO DB.
  - Pharmacy's own worked steps *do* match the code exactly except for one bucket: the
    reference states `VAT EXEMPT SALE: 71.43` (post-discount), while this code reports 89.29
    (pre-discount net-of-VAT), following the Retail/Restaurant convention instead. This is a
    deliberate, documented choice (2 of 3 examples + standard BIR practice agree on
    pre-discount) — if RA 9994 filing guidance says otherwise for this specific bucket, that's
    the one number to revisit, not the whole engine.
- **Restaurant pax split** (`pax: { dinerCount, seniorCount }`, `useCart.setPax()`): captured
  by a new `PaxModal` at Generate Bill (`Pos.jsx`), not at Open Table — only a Restaurant
  order asks for it (`generateBill()` branches on `restaurantMode`). Each discountable line is
  split by headcount fraction (`seniorCount / dinerCount`); only that fraction runs through
  the discount math, the rest is an ordinary undiscounted "regular sale" portion. `cart.clear()`
  and `loadFromOrder()` both reset `pax` to null — it must not leak into the next sale, and
  `finishGenerateBill()` sets it *after* `loadFromOrder()` for exactly that reason.
- **Admin**: new **Discounts** tab (global, not branch-scoped) — pick a discount type, see its
  default rate/VAT treatment, override per category or clear back to default.
- **Not done this pass**: `VatAdjustment`/`DinerCount`/`SeniorCount` are persisted on
  `dbo.Sales` (`sp_UpsertSale` updated to accept them) but are **not** threaded through the
  X-Read/Z-Read aggregation stored procedures or the emailed HTML reports — those still only
  see the pre-existing figures. Extending the reporting pipeline to surface these (e.g. a
  "VAT Adjustment" line on Z-Read) is a real follow-up, not an oversight to silently ignore.

## `LineNo` is a reserved word on this SQL Server instance — bracket-quote it

Discovered while smoke-testing Restaurant POS Type against the dev DB: `SELECT`/`WHERE`/
`ORDER BY`/`INSERT`-column-list references to the bare identifier `LineNo` all fail with
`Msg 156: Incorrect syntax near the keyword 'LineNo'` — reproduced directly via `sqlcmd`,
independent of the app, so it's the SQL Server engine (2022, compat level 160,
`itcore-apps.com,5281\SQLEXPRESS`), not a Dapper/driver quirk.

- **`[LineNo]` (bracket-quoted) works everywhere the bare form doesn't.** `@LineNo` as a
  T-SQL variable name is fine; it's specifically bare-identifier references (column, alias,
  qualified `t.LineNo`) that fail.
- **DDL is affected too, at least through SqlClient.** On the old dev instance bare `LineNo`
  in `CREATE TABLE` worked; building a fresh DB on the test server (2026-10-26) failed the whole
  first batch of `01_schema.sql` on it. `01_schema.sql` and `08_restaurant_tables.sql` now
  bracket it everywhere. Bracket it in any new DDL too.
- **This bit both new and pre-existing code.** `OrdersController.cs`'s new dine-in queries
  had it, but so did the already-shipped `SalesController.cs` `Get()` (`ORDER BY LineNo` on
  `dbo.SaleItems`) — which backs Reprint/Void-by-OR. That endpoint was very likely broken
  against this DB before this was ever caught; both are now fixed with `[LineNo]`.
- **Root cause not fully pinned down** (`LINENO` isn't a documented core T-SQL reserved word;
  best guess is Microsoft's ODBC/SQL-92 "future reserved keywords" list, which SQL Server
  enforces inconsistently by grammar production) — but the fix is unambiguous and safe
  regardless: bracket the identifier. If a future migration adds another column whose name
  happens to collide with an obscure reserved word, the symptom will look identical
  (a "syntax error" pointing at a column that's obviously spelled right) — try `[Name]` before
  assuming something else is wrong.
- **Also bites a `MERGE` statement's `USING (...)` subquery alias**, not just plain
  `SELECT`/`WHERE`/`ORDER BY`/`INSERT` — `SELECT @LineNo AS LineNo` in a `USING` clause (and
  the `src.LineNo` reference in the matching `ON`) needs the exact same `[LineNo]` treatment.
  Caught by direct `sqlcmd` testing before it shipped (`OrdersController.SendToKitchen`'s
  per-item upsert) — always smoke-test new raw-SQL statements against this DB directly, not
  just via `dotnet build`, since this class of bug is a clean compile every time.

## `LineNo` reserved-word bug, take three: found inside a stored procedure

While smoke-testing the discount-configuration feature end-to-end (calling `sp_UpsertSale`
directly with a throwaway sale before trusting it), `CREATE OR ALTER PROCEDURE
dbo.sp_UpsertSale` itself failed to compile on `INSERT INTO dbo.SaleItems (..., LineNo, ...)`
/ the matching `SELECT` — the exact same bare-`LineNo` issue documented above, just inside a
stored procedure body instead of Dapper-issued SQL. This was **pre-existing**, not introduced
by that session's changes — fixed with the same `[LineNo]` bracketing in
`database/02_procedures.sql`. The likely reason it had been silently fine in production:
however this procedure was originally deployed, that session's settings apparently didn't
trigger the parse error, and a successfully-compiled procedure doesn't get re-validated
against this quirk at execution time — it only resurfaces when the procedure itself gets
recreated (e.g. re-running `02_procedures.sql`) under a session where it does trigger.
**Lesson reinforced**: smoke-test actual execution (`EXEC`), not just that a script runs with
no visible error — a `CREATE OR ALTER` can fail entirely (leaving the *old* version intact and
untested) while a surrounding script full of other statements reports success.

## Dexie store names can't collide with Dexie's own instance properties

Named a dine-in table cache store `tables` (`web/src/lib/api.js`'s `PosDb`) — Dexie already
exposes `db.tables` **itself**, as a built-in array of every `Table` object registered on the
instance. The custom store silently lost that naming fight: `db.tables` resolved to Dexie's
own array, not the custom store, so every `db.tables.where(...)`/`.bulkPut(...)` call threw
`db.tables.where is not a function` — only caught when actually logging in as a cashier and
opening the table grid in a real browser (this is exactly the kind of bug static analysis and
`npm run build` can never catch, since it's a runtime property collision, not a type error).
Fixed by renaming the store to `posTables` in a new Dexie schema version (`tables: null` to
drop the broken v2 store, `posTables: 'TableId, BranchCode'` to replace it) — Dexie stores
that already exist client-side only migrate forward when the version number bumps, so a
same-version stores() edit would NOT have fixed anyone who'd already opened v2 once. Avoid
`tables`, `table`, `name`, `verno`, and other Dexie/Dexie-Table instance property names for
any future store.

## Accounting module (Addendum B) — steps 1–4 built, plus a read-only Admin tab

Full spec: **`CLAUDE-CODE-ADDENDUM-B-accounting-module.md`** (repo root). Read it before any
accounting work; it covers the owner-first UX rules, the out-of-scope list (payroll,
multi-currency, fixed assets, etc.) and the rest of the build order (steps 5–12: P&L/balance
sheet, cash-basis toggle, bills/AP, invoices/AR, bank reconciliation, PH tax layer, dashboard).

**What exists (built 2026-09-27):**
- `database/16_accounting.sql`: the `acc` schema (`Settings`, `CoaTemplateAccounts`,
  `ChartOfAccounts`, `Periods`, `EntryCounters`, `JournalEntries`, `JournalLines`,
  `PostingRules`, the `acc.TVP_JournalLine` type) plus guard triggers. Mirrored at the end of
  `01_schema.sql`. The procedures are at the end of `02_procedures.sql`. **To deploy: run 16,
  then re-run `02_procedures.sql`.**
- `acc.sp_PostJournalEntry` is the **only** way entries get written. It enforces exact
  balance, at least 2 lines each on one side, active same-company accounts, and an Open
  period (it auto-creates the month's row as Open). It allocates a gapless `EntryNo` from
  `acc.EntryCounters` inside its transaction. It is idempotent on `(SourceType, SourceUid)`:
  a retry returns the existing live entry. `acc.sp_ReverseJournalEntry` makes a mirror entry
  and stamps `ReversedByUid` on the original. Once reversed, the source can be posted again.
- Triggers block deleting or editing journal lines and entries (the only allowed update is
  stamping `ReversedByUid`), and block deleting, deactivating or retyping `IsSystem` accounts.
- **End of Day posting**: `dbo.sp_ProcessEndOfDay` calls `acc.sp_PostZReadToLedger` in its own
  transaction, guarded by `OBJECT_ID(...)` so EOD still works on a DB without the `acc`
  schema. The proc **silently does nothing unless accounting is turned on** (`acc.Settings`
  row, via Admin → Accounting) and skips business dates before `StartDate`. Once it's on, a
  posting failure (e.g. the month is closed) **fails EOD** with that message, per the spec.
- `acc.sp_SetupCompany` turns accounting on. It copies BASE + industry template accounts
  (RETAIL / RESTAURANT / PHARMACY / WATER; `acc.sp_SeedCoaTemplates` MERGEs the templates
  in, so there's no separate seed step), maps the 9 ZREAD posting rules by `SystemKey`, and
  creates the counter row.
- Reports: `acc.sp_rpt_TrialBalance`, `acc.sp_rpt_GeneralLedger` (opening + running balance),
  `acc.sp_rpt_Journal`. API: `AccountingController` (`/api/accounting/*`, **Admin role only**):
  status, setup, accounts, trial-balance, ledger, journal, periods, and period status.
- Admin → **Accounting** tab (hidden for Supervisors): setup screen, Account balances,
  Account history, All entries, and Months (close/reopen/lock). Every view shows the
  management-report label.
- **Tests**: `database/tests/acc_tests.sql`, 36 assertions (setup, posting, validation
  rejections, periods, reversal, triggers, and the full sale → blind close → EOD → ledger path).
  Every batch is rolled back, so it's safe on any DB. All pass against the dev DB. **Re-run it
  after any change to an `acc` proc or to `sp_ProcessEndOfDay`/`sp_UpsertSale`.**

**Decisions made while building (settled with the user, or forced by the real code):**
- **`CompanyId` is on every `acc` table (user's choice) but is always 1.** The API has a
  `const int CompanyId = 1` and EOD posts to company 1, because a deployment is still one
  client. The branch dimension is `BranchCode` on the journal line (there's no `BranchId`
  anywhere in the app).
- **`acc.PostingRules` has one `AccountId` per `RuleKey`**, not the spec's Debit/Credit pair.
  A Z-Read entry has 9 components, each landing on one account on whichever side its sign
  gives.
- **`SourceUid` is `VARCHAR(50)`**, not a GUID, because Z-Reads are keyed by an INT `ZReadId`.
- **Z-Read posting doesn't read `ZReads` verbatim. There are two corrections, both needed
  for the books to be right:**
  1. `ZReads.CashSales` is **tendered** cash, which includes the change handed back
     (`sp_ProcessBlindClose` subtracts `ChangeAmount` separately). So Cash on Hand is debited
     `CashSales − SUM(Sales.ChangeAmount)`. Posting `CashSales` directly would overstate cash
     every day.
  2. For a VAT-exempt discount (the SC/PWD standard case) the exempt bucket holds the
     *pre*-discount amount. For a non-exempt one (5% on prime commodities) the vatable bucket
     holds the *post*-discount amount (`computeTotals()` in `store.js`). The discount line
     always carries the full `TotalDiscounts`, so the second kind is added back to Sales -
     Vatable, computed per sale as `NetAmount + DiscountAmount − (the four buckets)`. That
     makes the entry balance exactly. Whatever gap remains between money received and
     `NetSales` goes to `ROUNDING` instead of failing EOD.
  **Business rule implemented twice, again:** this depends on how `computeTotals()` fills the
  buckets. If that function's bucket logic changes, re-check `acc.sp_PostZReadToLedger`
  and re-run test 7 in `acc_tests.sql`.
- Cash short/over comes from `ShiftClosings` joined through `dbo.Shifts` (it has no
  `TerminalId`/`BusinessDate` of its own). It's posted as a Short/Over line plus an
  offsetting Cash line.
- All discount types (SENIOR/PWD/NAAC/MOV/SOLO) post to the one `SCPWD_DISCOUNT` contra
  account (named "Sales Discounts (SC/PWD and others)"). Split it via posting rules if a
  per-type breakdown is needed.

**Accounting is ON on TabletPOS_ENZO and TabletPOS_VROSS** (user's request, 2026-11-16):
`acc.sp_SetupCompany` with the RETAIL template (32 accounts, 9 posting rules), StartDate
2026-11-16, enabled by `sparkpos-admin`. So every End of Day there for a business date from
11-16 on posts one journal entry per terminal per day (the live IIS sites too, since it's a DB
setting); earlier unclosed days are skipped. A closed month fails EOD. acc and bir suites pass on
both with it on (36, 35/36). **For the test only**: the 10-22 decision is that the ERP is the only GL poster; the user's call on 11-16 was "keep it on for the test", so ask about turning it off (`acc.Settings.IsEnabled = 0`) afterwards.

**Not done / still open:**
- **Accounting is ON in the dev DB** (`itcore-apps.com` TabletPOS; WATER template,
  StartDate 2026-09-27, turned on over HTTP on 2026-09-27). It's not on in production. So on
  dev, **every End of Day from now on posts to the ledger**, and it fails if the month is
  closed. There's a real test day on dev: MAIN/POS-02, business date 2026-09-27, 4 synced sales
  (ORs 101001–101004, discount name "Accounting Test"), a ₱5 short, Z-Read #7 → journal entry
  #1 (₱535.87; checked by hand line by line). It can't be deleted (the immutability
  triggers); if it has to go, reverse it with `acc.sp_ReverseJournalEntry`. The Blind Close
  and EOD for that day were run through the procs directly, not the API, so no email or print
  job went out (`SendOnEod` is on globally on dev and mails 3 real addresses).
- Every accounting endpoint has been exercised over HTTP against the dev DB (setup, all
  reports, period close/reopen, the rejection messages). **The Admin → Accounting screens
  themselves have still not been clicked through in a browser** (no browser tools in that
  session). Do this manually.
- The ledger has **no opening balances**: the ₱2,000 drawer float isn't in the books, so Cash
  in the drawer shows only the day's net cash. That's expected until the opening-balance
  wizard decision (spec §13) is made.
- `PermitId` column exists but nothing sets it (needs Addendum A's `ZReads.PermitId`).
- Not built: the `acc.Contacts`, Bills, Invoices, Payments, Bank and tax-rate tables (spec
  steps 7–10); the cash-basis toggle and P&L/balance sheet (steps 5–6); manual journal entry
  UI; reversal in the UI (the proc exists); CSV/PDF export on accounting reports; account
  add/rename.
- Subscription tiers / `PastDue` enforcement from the spec don't exist in this app. The tab is
  simply Admin-only.
- The Z-Read posting assumes the entries go to company 1 and that one deployment is one
  client. Revisit if multi-tenancy (the spec's `CLAUDE-CODE-BRIEF-multitenant-saas.md`, not
  in the repo) lands.
- The spec's open decisions (§13) are still undecided: an opening-balance wizard, year-end
  closing entries, card-settlement clearing, and the exact disclaimer wording (currently the
  spec's text, verbatim).
- Missing referenced docs: the multi-tenant SaaS brief, Addendum A and Addendum C aren't in
  the repo.

## CORECS ERP integration — step 1: master data (built 2026-10-22, not yet tested)

SparkPOS is being connected to the client's CORECS ERP (a separate SQL Server; DEV db
`COREX001` on `corex.itcoreapps.com`). The plan was agreed with the ERP-side Claude session and
then settled by the user. The steps run one at a time, each tested before the next: **1 master
data** → 2 prices (SparkPOS-only) → 3 discount types on the new categories → 4 sales posting
into the ERP's POS V2 procs (on hold).

- **Connection**: `ConnectionStrings:Erp` (blank = integration off) uses an ERP login that has
  EXECUTE rights **only** on `dbo.sp_SparkPOS_GetCategories`, `dbo.sp_SparkPOS_GetProducts
  @BranchCode` and `dbo.sp_SparkPOS_GetBranches`. It can't read any ERP table. `Erp:ProductBranch`
  (default `888`, head office) is the branch whose product list is the master copy.
  `Services/ErpDb.cs`, `Controllers/ErpController.cs` (`/api/erp/status`,
  `POST /api/erp/sync-master-data`, Admin only). Triggered by Admin → Products → **Sync from
  ERP**, never automatically.
- **Applying it**: `dbo.sp_ErpSyncMasterData` (`02_procedures.sql`) takes all three lists as
  TVPs and applies them in one transaction, under an applock. Migration
  `database/17_erp_master_data.sql` adds `Categories.ErpCategoryId`, `Products.ErpProductCode`
  (both filtered-unique) and the TVP types. Run 17, then re-run `02_procedures.sql`.
- **The ERP is master for** product identity, name, category, unit, VAT/discount flags, cost,
  active **and price** (changed 2026-10-26, see "ERP prices" below). Those fields are overwritten
  on every sync and locked in the Admin product form for linked products. Barcode,
  AllowPriceEdit (1 on import) and the photo stay ours.
- **A product with no price at a branch stays off that branch's till** (`sp_GetPriceList`). The
  only exception is a local (non-ERP) open-price item with `AllowPriceEdit = 1`; an ERP item at
  0 is always hidden. Admin shows "Needs price".
- **ERP has no product barcodes.** Its `Barcode` is the literal text `'NULL'` or blank, so it's
  treated as none and the ERP product code becomes our barcode.
- **Matching**: by ERP key first. An unlinked local row with the same category name / barcode
  is *adopted* (linked) rather than duplicated, so the seed `Others` becomes ERP `OTHERS`.
  A linked product missing from the ERP's list is deactivated, never deleted (SaleItems
  reference it). Local-only products are left alone and counted in the result. A category
  goes inactive once it's not in the ERP list and no active product uses it (the user's
  decision: the ERP's 5 categories replace the local set). Bad rows (too long, blank, missing
  category, duplicate barcode) are skipped and listed, never truncated. An empty product or
  category list aborts the sync, since it would otherwise deactivate everything.
- **Branches**: matching codes get name/address updated. New ERP branches are inserted along
  with their `PosSettings` row (same as `BranchesController.Create`). TIN/BIR fields and
  non-ERP branches (e.g. `MAIN`) are untouched. **The ERP's branch codes (`888`, ...) differ
  from the existing local ones** — reconciling them is a step-4 concern.
- **Not re-pointed automatically**: `CategoryPrintAreas` and `DiscountCategoryRates` rows on
  the old local categories. Re-enter them against the ERP categories in Admin (step 3 covers
  discount rates).

## ERP prices, supervisor price override, automatic sync, ERP branch codes (built 2026-10-26)

Decided by the user: the ERP's `Products.SellingPrice` (per branch row, set by head office) is
**the** price; `Price1`–`Price4` are unused. A special price for one sale is keyed at the till
with a branch supervisor's override. SparkPOS uses the ERP's branch codes (`888`, `001`–`014`).
Migration `database/19_erp_prices.sql` (mirrored in `01_schema.sql`), then re-run `02_procedures.sql`.

- **Sync** (`Services/ErpSyncService.cs`, shared by Admin → Sync from ERP and the `ErpAutoSync`
  timer, `Erp:AutoSyncMinutes`, default 30, 0 = off) reads `sp_SparkPOS_GetPrices` (all 2,355
  branch × product rows; ERP [225]) and passes them to `sp_ErpSyncMasterData @Prices`. Head
  office's (`Erp:ProductBranch`, 888) price → `Products.BasePrice`; every branch's own price →
  its `ProductPrices` row, mirrored exactly for ERP products. **A NULL price means "not set yet"
  (the ERP returns NULL while SellingPrice = 0) and never overwrites or removes ours.** A branch
  with no ERP row for a product loses its row and falls back to the base price (as the ERP's own
  GetProducts falls back to 888). An empty price list (ERP proc missing → fallback to GetProducts'
  888 `Price`) leaves prices alone. Terminals see new prices at their next Cash Begin.
- **Admin price editing is locked for ERP products**: `sp_SaveProductPrices` throws 53010, bulk
  price change and copy-prices skip them, `ProductsController.Update` keeps their BasePrice, and
  the UI disables the fields (branch prices shown read-only).
- **Price change at the till**: ERP items are price-editable (`AllowPriceEdit = 1` on import).
  When `PosSettings.PriceEditOverride` is on (default for branches the sync creates) a Cashier
  needs a supervisor, checked online by `POST /api/auth/verify-approver`; the approver goes on
  the line (`SaleItems.PriceApprovedBy`), and `sp_UpsertSale` writes a `PRICE_EDIT` audit row per
  changed line. Offline, a price change needing a supervisor is refused until users sync
  (next step). **`PriceEditOverride` was never enforced before this** (any AllowPriceEdit item
  could be repriced freely) — non-ERP deployments with the setting on now get the override too.
- **`database/03_seed_erp.sql`** replaces `03_seed.sql` for an ERP-run DB: starter logins,
  discount types, a placeholder `888` branch (so Admin can sign in before the first sync) and
  an inactive email config. No demo branches/products/terminals.
- **Test DB** (`TabletPOS` on `corex.itcoreapps.com`) was rebuilt with this seed on 2026-10-26:
  15 ERP branches, 157 ERP products (all still unpriced in the ERP, so none on any till), branch
  001 terminals POS-01/POS-02 (dummy BIR data), `super`/`cashier` assigned to 001, and two local
  test items `TEST-001`/`TEST-002` (₱250 / ₱180) so something can be sold. Tests:
  `bir_tests.sql` 28/28, `acc_tests.sql` 36/36, `erp_sync_tests.sql` 18/18; HTTP end-to-end
  27/27 on 001/POS-01 and again on POS-02 (both days are closed by those runs).
- **Barcodes**: a real ERP barcode (not just the product code) replaces ours on every sync; one
  another product already has is skipped and logged, never moved (the ERP doesn't enforce
  uniqueness). Longest real barcode measured: 13 (ENZO), 17 (VROSS) — `NVARCHAR(50)` is enough.

## ERP users: hybrid login, branch from the user, same-branch approvals, offline sign-in (built 2026-10-26)

Migration `database/20_erp_users.sql` (mirrored in `01_schema.sql`), then re-run `02_procedures.sql`.
Tests: `database/tests/erp_users_tests.sql` (11).

- **Sync**: `ErpSyncService` also reads `sp_SparkPOS_GetUsers` (ERP [226]: only users with a
  verifiable hash and a POS role; `Role` computed by the ERP — Admin > Supervisor > Cashier; use
  it, not the flags) into `dbo.sp_ErpSyncUsers`. Username = ERP UserID; the ERP's PBKDF2 hash,
  salt, iterations and version are copied into `Users.ErpPassword*`; branch = `AssignedBranch`
  (an Admin has none = every branch). **Never adopts a local user** with the same name (skipped +
  logged). **Deactivation only after a sane pull**: an empty list deactivates nobody; a user is
  deactivated only if the list still has someone for their branch (admins: some admin); a
  one-user refresh never deactivates.
- **Break-glass admin**: the starter Admin is local and named `sparkpos-admin` in
  `03_seed_erp.sql` (renamed on the test DB) so SparkPOS never loses its own admin to an ERP change.
- **Password check** (`Services/UserAuth.cs`, used by login AND every supervisor override):
  ERP users = PBKDF2-HMAC-**SHA1** over the UTF-8 password **as typed (not trimmed)**, salt and
  iterations from the row, hash-length bytes, `PasswordAlgoVersion` 1 only (verified against the
  ERP's test vector); local users = `PasswordHasher`. **SparkPOS's own lockout**: 5 wrong → 15
  min (`Users.FailedLogins/LockedUntil`; Admin → Users → Unlock; a new ERP hash clears it). The
  ERP counts failures but never locks. `MustChangePassword` = refused with a message.
- **Login** (`AuthController.Login`): no branch picker. ERP user → re-read from the ERP first
  (`RefreshUserAsync`, 6 s): not returned = refused; ERP unreachable = synced copy (audit says
  so). Branch = the user's own; someone with several (an Admin) gets `needsBranch` + the list and
  signs in again with one. `LoginRequest.BranchCode` is optional.
- **Approvals** (`VerifyApproverAsync(con, user, pw, branchCode)`): a Supervisor **of that
  branch** or an Admin, with the same lockout. **Non-admins act only at their own branch**
  (`CanActAt`): void, return, End of Day on another branch's sale/terminal are refused.
- **Who rang the sale up**: each queued sale carries `cashierUserId`; the sync accepts it if
  that user is active at the sale's branch, else the signed-in user (as before).
- **ERP users are read-only in Admin → Users** (API refuses edits); a Source column shows ERP/Local.
- **Offline sign-in** (`web/src/lib/offlineAuth.js`): no hash is ever sent to a terminal. At an
  online sign-in (or a supervisor's online price override) the browser derives its own check
  (PBKDF2-SHA256, 210k, random salt), encrypted with a non-extractable AES-GCM key in IndexedDB
  (Dexie v4 `credentials`). Admins are never cached; a copy expires 14 days after the last online
  sign-in; 5 wrong tries lock it 5 minutes. Offline, a cashier can only **resume their own open
  shift** (`pos_cashierUserId`). The session has no JWT, so sync waits and a banner asks them to
  sign in again once online (`api()` no longer redirects on 401 without a token). **Needs the
  POS on https://** (`crypto.subtle` doesn't exist on plain http; the login page says so).
- **Receipt header offline**: Pos.jsx caches the last loaded branch/terminal/settings per
  terminal (`meta ctx_<terminalId>`) so the BIR header still prints offline.
- **Verified 2026-10-26**: JFC DEV users sync (6 admins); HTTP tests with temporary ERP-hash
  users (`zz.*`, deactivated afterwards) for login/branch/lockout/approvals/not-in-ERP/ERP
  unreachable; offline crypto 9/9 in Node; end to end 29/29 on 001/POS-03. **Not yet clicked
  through in a browser.**
- **Open**: JFC's branch users have no role flag in the ERP (only 888 admins sync); ENZO has 35
  Supervisors + 17 Admins and no Cashiers; terminal registration (bind a device to one terminal)
  was built 2026-11-13 ("Each till device assigned to its terminal").
- **ENZO test setup**: separate DB `TabletPOS_ENZO` (same test server, ERP seed). The ENZO ERP
  connection goes in `src/PosApi/appsettings.Enzo.json` (git-ignored; the user enters the
  `sparkpos` login's password). Run the API with `ASPNETCORE_ENVIRONMENT=Enzo` and
  `ConnectionStrings__Default` pointing at `TabletPOS_ENZO`.

## Posting sales to the ERP — step 4.1 (built 2026-10-27)

User approved step 4 (via the ERP session). ERP side [228]: `spu_SparkPOS_PostSale`,
`spu_SparkPOS_VoidSale`, `sp_SparkPOS_GetPostingBranches`, `sp_SparkPOS_GetStockShortfalls`, types
`tt_SparkPOS_SaleLine` / `tt_SparkPOS_Payment`. **Never call them through INSERT…EXEC** (they roll
back inside; error 3915). Migration `database/22_erp_posting.sql`, then re-run `02_procedures.sql`.
- **Per terminal**, not per branch (the pilot replaces ONE desktop POS at a multi-POS branch):
  `Terminals.ErpTerminalCode` ('SP-' + up to 7, upper case, unique per branch — the ERP enforces
  'SP-%' and registers the terminal with its MIN on the first sale, after which the MIN can't
  change) and `PostToErp` (off = shadow/trial mode). Turning it on needs the code + MIN and the
  branch in the ERP's `SPARKPOS_BRANCHES` (checked live via `sp_SparkPOS_GetPostingBranches`).
- **Queue** `dbo.ErpOutbox` (SALE / VOID per SaleUid): `sp_UpsertSale` queues the sale (and its
  void if voided offline); the void endpoint queues online voids. `Services/ErpPostingService.cs`
  (`ErpPostingWorker`, every `Erp:PostIntervalSeconds`, default 15) posts in OutboxId order **per
  terminal**; an entry waiting for a retry holds back that terminal's later ones (a void never
  beats its sale). Retry with no limit: ERP 61100, 59800-59806, 1205, timeouts/connection
  errors (`Transient` set). Other unexpected SQL errors (8152, 515, 547…): 10 tries with backoff
  (~1 h), then Failed. Any other 50000+ ERP error = **Failed / needs attention** (Admin → Z-Read / EOD → Sales sent to the ERP,
  with Retry and "Send now"; shortfalls viewer there too).
- **Mapping to the ERP's exact-sum checks** (lines AND header must add up exactly to what was
  paid): line `VatExemptAmount` = Net − VATable − VAT − ZeroRated (after the discount — our
  printed BIR figure stays the pre-discount base); `LineDiscount` = LineTotal − Net; header
  Discount = Gross − Net; header buckets = line sums; per-line `DiscountCode` = `<code><rate%><E|N>`
  from the rate in effect (category override, else type default; a non-integer % fails).
  Cashier / PriceApprovedBy / VoidedBy = ERP UserID for ERP users, else the SparkPOS username
  (the ERP flags non-ERP approvers NeedsReview). WasOffline = synced > 10 min after the sale.
  The line discount codes are saved on the outbox row at first send (`LineDiscountCodes`) so a
  retry sends identical content — the ERP refuses a same-SaleUid resend with different content
  (61122). A VAT guard (`ErpVatSplit`) keeps each line within the ERP's VAT = 12% × VATable
  ± 0.01 check by moving a centavo between VATable and VAT in the payload only; an exhaustive
  check (every price ₱0.01–₱5,000) showed the till's rounding never needs it.
- **ERP contract [229]** (after its review): MIN ≤ 50 and one MIN per terminal ERP-wide (61112;
  head office corrects it), 61101 = retry, 61121 = void can't return stock (needs attention),
  per-line VAT check, card total ≤ net, review flags (price vs ERP SellingPrice without an ERP
  Supervisor/Admin approver, SC/PWD without ID/name, discount on a non-discountable line,
  IsVatable ≠ ERP flag, sale time far off). Stock is booked on a checked BookDate.
- **Times are now stored in Philippine time** (`Services/LocalTime.cs`, a global JSON converter):
  browsers send UTC, which had been stored as is — every sale/shift/return time was 8 hours early.
  The **business date** was the UTC date (before 8 AM = previous day); now `localDate()` in
  store.js. Old test data keeps UTC times.
- **Verified live on the ENZO restore** (ERP allows test posting at 000/006/023/030): branch 023,
  terminal SP-TEST01, MIN TEST-MIN-023-SP1 — sticker sale with SC discount and a local-supervisor
  price change posted (NeedsReview, 1 short line); sale + void posted in order; nothing sent twice;
  posting refused at 003; bad code / missing MIN refused. SI 1 there is a deliberate test leftover
  (refused 61116 — the script underpaid) in "needs attention".
- **Step 4.2 (built 2026-10-27, ERP [230])**, migration `database/23_erp_posting_shifts.sql`
  (outbox kinds OPEN/SALE/VOID/RETURN/CLOSE/ZREAD, `ZReads.ZReadUid`). Queued by the procs:
  `sp_OpenShift` → OPEN (the ERP refuses a sale until its shift is posted: 61102, retried);
  `sp_ProcessReturn` → RETURN (Failed at once if the original sale never went to the ERP — e.g.
  sold in trial mode); `sp_ProcessEndOfDay` → CLOSE for each of the terminal-day's shifts that
  were opened in the ERP, then ZREAD. CloseShift sends the shift's own figures (the ERP recomputes
  and refuses a mismatch, 61126 — e.g. a sale of the shift still in needs attention). The Z-Read's
  sales totals are sent on the ERP's basis (the same converted lines the sales went with); the
  printed BIR Z-Read is unchanged. Return lines: a centavo left over from the per-bucket shares
  goes back into VAT/zero-rated when the original line had no VAT-exempt part (`ErpBuckets`).
  Admin: `GET /api/erp/posting-log?terminalCode=` lists a terminal's queue in order.
  **Verified**: a full day on the ENZO restore (023 / SP-TEST04): OPEN, 2 sales, void, partial
  return of a weighed line, CLOSE (matched the ERP's recompute), Z-Read (no review flag).
- **ERP [231]** (after 4.2 review), verified 2026-10-27 (023 / SP-TEST05): VoidSale takes the
  voiding shift (`@ShiftUid`) and refuses one from another shift (61125), so **SparkPOS now allows
  a void only while the sale's own shift is open** (`SalesController.Void`) — before, a sale could
  be voided after its shift's Blind Close, which also made that shift's expected cash wrong. Card
  refunds (`@RefundCard`, `@CardRefunds`) stay 0 (SparkPOS refunds in cash). New permanent ERP
  codes 61144/61145 (return/sale whose sale/shift never arrived within 48 h), 61152 (shift on a
  Z-Read day). Sales carry their shift's business date even past midnight.
- **ERP [232]**: each posted Z-Read is copied by the ERP into the desktop POS tables
  (POSSalesSummary etc., MachineUsed = ErpTerminalCode) for head office's POS report and ENZO's
  Xero upload, which runs at **23:45** — a terminal's End of Day must reach the ERP before then or
  that day misses that night's upload; the next night's re-upload steps pick a late day up, but a
  correction to a day already in the Xero copy is never re-sent.
- **Several SparkPOS terminals per branch are fine for Xero**: its invoice no. comes from the
  day's SI range, which repeats across terminals (every terminal starts at 1), but Xero tells
  terminals apart by MachineUsed (= ErpTerminalCode). The user confirmed this via the ERP session
  after [233]. The SP-TEST01–06 terminals at 023 are test-only.
- **ERP [234]**: the desktop POS's nightly stock deduction now takes the same per-product lock as
  SparkPOS's posting. While a branch's deduction runs (supervisor before 10 pm, the 23:45 job, late
  uploads), a sale/void/return of a product in it can wait up to 15 s and then get 61101, which
  is in the `Transient` set (retried without limit; `CallTimeoutSeconds` = 60 covers the wait).
  Expect a few 61101 retries around those times; they're not a fault.
- **ERP confirmations, 2026-10-27**:
  - The 5% codes (SENIOR5N / PWD5N) post end to end. The desktop copy reads the rate from the
    code's digits.
  - A header discount code needs `DiscountCtrlNo` + `DiscountName`, or the ERP flags the sale
    for review.
  - A Z-Read with no returns must send `BegReturnNo`/`EndReturnNo` as NULL (the poster does:
    MIN/MAX over no rows).
  - ERP [237] settles a closed shift's stock shortages from later branch stock (23:45 job).
    `sp_SparkPOS_GetStockShortfalls` gained `QtySettled`/`QtyOpen` and status SETTLED, which
    Admin's shortfall viewer now shows.
  - The user: "head office will be the one to define all permits". A terminal's BIR permit
    data (MIN, serial, PTU, accreditation) is entered by head office in Admin → Terminals,
    never at the till.
- **Terminal BIR details → ERP (built 2026-10-27, ERP [238])**. Migration
  `database/25_terminal_bir_info.sql` (mirrored in `01_schema.sql`). Head office enters each
  terminal once, in Admin → Terminals. On every save, a terminal with an `ErpTerminalCode` is
  sent to `dbo.spu_SparkPOS_SaveTerminalInfo` (`TerminalsController.SendToErpAsync`). That fills
  the ERP's SparkPOS_Terminal and the desktop POS machine list (`POSInfoDetails`) behind its POS
  report machine picker and X/Z-read BIR header.
  - **What's sent:**
    - `@TerminalCode` = `ErpTerminalCode` (the same code posting uses)
    - `MinNo`, `SerialNo`, `PermitNo`, `PermitEffective` (start), `PermitValidUntil` (end)
    - `AccreditationNo`, `AccreditationDate`, `BirRegTransactionNo`, `BirApplicationDate`
    - BusinessName = `PosSettings.StoreHeader1`, address = `Branches.Address`, TIN =
      `Terminals.Tin` else `Branches.Tin`; NULL when blank, and the ERP then falls back to the
      branch's desktop machine row (61136 if there's none)
    - `@User` = the admin's ERP UserID, else their username
  - **Required by the ERP:** MIN (≤ 50), serial, PTU no. and date, accreditation no. and date.
    Saving a posting terminal without them is refused. A non-posting terminal with an ERP code
    saves but shows "not sent" with what's missing.
  - **The save never fails because of the ERP.** The outcome is kept on the terminal
    (`ErpInfoStatus` Sent/Failed, `ErpInfoResult` CREATED/UPDATED/UNCHANGED, `ErpInfoError`).
    The list shows it, with **Send again** (`POST /api/terminals/{id}/send-to-erp`, safe to
    repeat). ERP codes 61133–61138 are permanent; fix the data. 61101 = press Send again.
  - **One MIN, serial and PTU per machine:** Admin refuses a MIN, serial or PTU that another
    *active* terminal (any branch) already has (`DuplicateBirAsync`; blanks not compared). The
    shared test values on POS-06/07 were changed to TEST-SN/PTU-023-06 and -07 and re-sent.
    The ERP also refuses a serial or PTU that any machine in its list already has (61139),
    which covers desktop POS machines SparkPOS can't see. Pre-existing desktop duplicates in
    the ERP were left alone: 004 POS1/POS2 share a PTU; 001 and 888 POS2 share a serial and PTU.
  - **MIN change:** refused in SparkPOS while the terminal has an open shift or any
    `ErpOutbox` row not Posted, because the poster reads the MIN at send time. The ERP also
    refuses one while it has the shift open (61138).
  - **Verified on the ENZO restore:** SP-TEST01–07 re-saved (test accreditation date
    2026-10-01) → UPDATED; a repeat → UNCHANGED; a posting terminal without its accreditation
    date refused; a MIN change on POS-07 (open shift) refused. That also clears the ERP's SP31
    check for those terminals.
- **`VatAdjustment` sent to the ERP = the VAT part of the line's discount** (agreed with the ERP
  2026-10-27, verified 023 / SP-TEST06): `ErpVatAdjustment()` in the poster. On a line with a
  VAT-exempt discount (its stored buckets add up to more than was paid, since the exempt bucket
  holds the pre-discount base) it's LineTotal − the four stored buckets (₱112 SC → 12); otherwise
  the till's own `VatAdjustment` (the 5% case). It sits **inside** LineDiscount = gross − net, so
  no sum changes; the ERP's desktop copy shows SC = discount − VatAdjustment. Same rule on return
  lines (telescoped shares) and in the Z-Read total. Not frozen like `LineDiscountCodes`, because
  it's computed only from immutable SaleItems/SaleReturnItems figures. The till's own receipt and
  `Sales.VatAdjustment` are unchanged.
- **ERP [317] (2026-11-16): the ERP books one GL ticket per SparkPOS Z-Read.** `spu_SparkPOS_PostZRead`
  runs it after its own commit (no SparkPOS change; same parameters and results). Outcome per
  ZReadUid in the ERP's `dbo.SparkPOS_ZReadGL` (POSTED / OFF / NOTCONFIG / REVIEW / ERROR / EMPTY);
  a GL failure never fails the Z-Read. Accounts come from the ERP's JournalEntryMapping (Origin
  SPZ). VROSS: Dr 1010208 Cash on Hand - POS Sales, 10206 card, 501/502 COS; Cr 40101 exempt +
  zero-rated, 40102 VAT-able, 20202 output VAT, 10401/10402 inventory at FIFO lot cost; 407 over,
  408 short, 404 rounding (limit 1.00). Shortage cost is booked when SettleShortages settles it.
  Only Z-Reads posted after `SPARKPOS_GL_FROM` (VROSSMIG 2026-11-16 22:53) get one; a BACKFILL mode
  exists, not run. ENZO: no POS cash account (a cash day = NOTCONFIG) and ENZO PROD has GL_POSTING
  0 (Xero books its sales).
- **Still to do**: shortfalls on the Blind Close / EOD report + email; the pilot compare screen;
  a "damaged / expired — don't restock" choice on returns (asked the user).

## E-invoice copies by email (built 2026-10-27)

User's request: send the customer a copy of each invoice by email; when the customer has none,
send it to a common mailbox as the repository. Migration `database/24_invoice_email.sql`
(mirrored in `01_schema.sql`), then re-run `02_procedures.sql`. Tests:
`database/tests/einvoice_tests.sql` (10).
- **The till**: Add customer → "Email for the e-invoice copy" (`Sales.CustomerEmail`, not
  printed; the receipt is unchanged). Reprint → "Or email a copy" sends any synced invoice or
  return to any address (`POST /api/sales/{uid}/email`, `/api/returns/{uid}/email`, audited
  `INVOICE_EMAIL`).
- **Queue**: `dbo.sp_QueueInvoiceEmail`, called inside `sp_UpsertSale` (new Completed sales only:
  a sale voided before it synced gets none; a re-sync never queues twice) and `sp_ProcessReturn`
  (to the original sale's email). It goes to the customer's address when it looks like one,
  else to `EmailConfig.InvoiceRepository`. Only when that branch's config (branch row first,
  then global) has `IsActive` and `SendInvoices`. Manual copies are always queued.
- **Sending**: `Services/InvoiceEmailService.cs` + `InvoiceEmailWorker`
  (`Email:InvoiceIntervalSeconds`, default 30; at most 25 per round). The body is the stored
  invoice text (`ReceiptText`) in a monospace box, plus a plain-text version and the same text
  attached as `SI-<no>.txt` / `RETURN-<no>.txt`. Repository copies get a `[branch terminal]`
  subject prefix for searching. Retries with backoff (1 min … 8 h, 10 tries), then Failed. A
  refused address or nothing to send fails at once.
- **Admin → Email**: an on/off switch plus the repository address (both validated; it needs
  Active too), and an "E-invoice deliveries" list with counts and Retry failed
  (`GET /api/settings/invoice-emails`, `POST /api/settings/invoice-emails/retry`).
- **Verified**: SQL tests on both test DBs; all other suites still pass. A real send through
  the API and worker to a local mail catcher: the sale and return copies arrived, and the return
  went through on its automatic retry after the catcher dropped the first connection.
  **Not yet sent through a real mailbox** (no SMTP set up on the test DBs); the ENZO test DB's
  placeholder email row is still inactive.
- **Not done**: BIR's own EIS e-invoicing (RA 11976: structured invoice data transmitted to
  BIR) is a separate integration needing BIR's specs and accreditation. Copies of voided sales
  aren't sent. Watch the SMTP provider's daily limit (an ordinary Gmail account allows about 500
  a day; every sale sends one).

## Weighing-scale stickers; ENZO verified (2026-10-26)

ENZO sells mostly by weight using scale-printed EAN-13 stickers: prefix + product code + weight +
check digit — `2510015231232` = prefix `25`, product `10015`, weight `23.123`, check digit `2`
(not validated). Migration `database/21_scale_barcodes.sql` adds per-branch layout to
`PosSettings` (`ScaleBarcodePrefix` — blank = off, comma list allowed; `ScaleCodeLength` 5,
`ScaleQtyLength` 5, `ScaleQtyDecimals` 3), edited in Admin → POS Settings → Weighing-scale
stickers (the API validates the layout).
- `web/src/lib/scale.js` `parseScaleBarcode()`; Pos.jsx `onSearchKey` tries it first and matches
  the code to the product's **ERP product code** (`ErpProductCode`, now in the price list) or, for
  a local product, its barcode. Each sticker is **its own cart line** (`weighed: true`, quantity =
  weight, +/− hidden) — two stickers of one item weigh differently. Items sold by piece (oil,
  ingredients) are scanned/tapped as before.
- ENZO's ERP unit is 'pc' for everything (no unit per product); the sticker carries the quantity,
  so SparkPOS doesn't need a unit. A kg rule for the ERP's own inventory is the ERP session's call.
- **ENZO verified** in its own test DB `TabletPOS_ENZO` (API with `ASPNETCORE_ENVIRONMENT=Enzo`):
  sync via the EXECUTE-only `sparkpos` login (sysadmin removed 10-26) — 23 categories, 907 products
  (all 5-digit codes, 523 real barcodes, 2 inactive), 14 branches, 12,698 price rows, 52 users
  (17 Admin, 35 Supervisor, no Cashiers), 0 issues, ~3 s; a re-sync changes nothing. Branch 003
  (BUAYA) has test terminal POS-01, scale prefix 25, local `super`/`cashier`; end to end 29/29 with
  the sample sticker (BELLY BI 23.123 @ ₱438, supervisor price change, SC discount, partial return
  of 1.5 of the weighed line).
- **Step 4 discount GL rule**: the user delegated it; recommended and relayed YES (discounts
  reduce 401/402 as in the ERP's chart since 10-19; SparkPOS keeps the per-type discount detail
  for BIR).

## BIR sworn statement: SI numbers, customer info, reprint, grand total, returns (built 2026-10-26)

The accreditation sworn statement commits the POS to six things. Migration
`database/18_bir_invoice_returns.sql` (mirrored in `01_schema.sql`), then re-run
`02_procedures.sql`. Tests: `database/tests/bir_tests.sql` (rolled back, every row `Pass = 1`).

1. **Sales Invoice No.: 18 digits, non-resettable, starts at 000000000000000001.** Stored in
   `Sales.ORNumber` (BIGINT, name kept), `CK_Sales_SINo` limits it to 18 digits, printed zero-padded
   by `siNo()` (`receipt.js`) / `ReceiptBuilder.Si()`. Per terminal (one MIN), and **gap-free**:
   `sp_AllocateORRange` now starts every block right after the last SI the terminal actually used
   (`MAX(Sales.ORNumber)`), and Cash Begin re-reserves on every shift. The old behaviour (top up only
   below 50, branch-wide ranges from 100001) skipped up to 49 numbers per shift. `@From` (the device's
   own next number) is sent only while the device holds unsynced sales; it is capped at what was
   handed out before. Known edge: a force-blind-closed shift whose device still holds unsynced sales —
   the next shift reuses those numbers and the late sync hits `UQ_Sales_OR`.
2. **Customer name / address / TIN / business style** on `Sales`, entered from the cart ("Add customer
   name / TIN"), printed on every invoice (blank lines to write on when not given).
3. **Reprint = exact replica.** The invoice text is built once, stored in `Sales.ReceiptText` (sent
   with the sale sync) and a reprint prints that text under `*** REPRINT ***` (`reprintText()`).
   Older sales without text fall back to rebuilding. Every reprint of a synced sale/return is
   audit-logged (`REPRINT` / `RETURN_REPRINT`). The `ReprintOverride` setting is still **not
   enforced** anywhere (pre-existing gap).
4. **Grand total** `Terminals.GrandTotalSales DECIMAL(18,2)` = max 9,999,999,999,999,999.99. It only
   ever adds the day's Completed sales; returns are reported on their own Z-Read lines and do not
   lower it. `TR_Terminals_Counters` refuses any decrease of the grand total, Z counter or return
   counter.
5/6. **Return transactions** (`dbo.SaleReturns`/`SaleReturnItems`, `sp_ProcessReturn`,
   `ReturnsController`, Pos → Return). Receipt tagged RETURN TRANSACTION with `Ref SI No.`, numbered by
   `Terminals.LastReturnNo` (6 digits, per terminal, starts 000001, taken inside the proc's
   transaction so no gaps). **Online only**, like Void. Partial returns are allowed: each line refunds
   its share of that line's stored BIR breakdown (`SaleItems.NetAmount/VatableAmount/...`, new — sent
   by the terminal from `computeTotals().perLine`), with telescoping rounding so several partial
   returns add up to exactly the original line. Flow: preview (`@Commit=0`, writes nothing) → the
   terminal builds the receipt with `######` for the number → commit; the proc swaps in the number,
   stores the text, and refuses if the refund changed since the preview. Refund is cash out of the
   current shift's drawer (`ShiftClosings.CashRefunds`, subtracted from expected cash). Gated by
   `PosSettings.RefundEnabled`; `ReturnOverride` (new) works like `VoidOverride`. A sale with returns
   can't be voided. Only invoices from the same terminal can be looked up for a return.
- **Immutability triggers** (`TR_Sales_Immutable`, `TR_SaleItems_Immutable`, `TR_SaleReturns_*`):
  invoices and returns can't be deleted, and their number, date, amounts and printed text can't be
  changed (status/void fields and `ReturnedQty` still can). Cleaning test data out of a DB now needs
  the triggers disabled first — that's deliberate.
- **Z-Read / X-Read**: SI range now covers every SI issued (voided included), plus return count,
  amount and number range. **Accounting**: `acc.sp_PostZReadToLedger` reverses the day's returns
  (Dr sales/VAT, Cr discount, Cr cash) so the entry still balances.
- `TVP_SaleItem` gained the six breakdown columns; `acc_tests.sql` now inserts with column lists.
- **Verified 2026-10-26** on a fresh `TabletPOS` DB on the test server (`corex.itcoreapps.com`,
  1433 — same instance as the ERP's `COREX001`; login `testserveruser` is db_owner of TabletPOS only):
  01 → 02 → 03 clean, migrations 16/17/18 re-run as no-ops, and `bir_tests.sql` 28/28,
  `acc_tests.sql` 36/36, `erp_sync_tests.sql` 12/12. Then an HTTP end-to-end run (22/22) using the
  app's own `computeTotals()`/`receipt.js`: sale with SC discount + customer, sync, stored text,
  reprint, void (override), partial return (override, idempotent retry, number 000001), void refused
  after a return, X-Read, blind close (refund out of expected cash), EOD/Z-Read, grand total.
  **The screens themselves (Customer modal, Return modal, Reprint toggle) are not yet clicked
  through in a browser.**

## Open items

- Multi-terminal printing / `spool://` / poll queue: **confirmed working end-to-end on
  2026-08-23** — Test Print from Admin against the real MDU branch terminal
  (`http://itcoreapps.com:8080`, `spool://XP-80C`) was enqueued, polled, and physically printed.
  See "Multiple physical terminals: PrintAgent now polls..." above for the two issues that had
  to be fixed first (a stale pre-poll-loop exe, and an unset `ApiServerUrl`). Remaining gap:
  `PrintAgent.exe` on that terminal is still a manually-started foreground process, not yet a
  Task Scheduler entry or service — do that before relying on this terminal unattended.
- RawBT print fix (padding strip) confirmed working for the specific cases tested; broader
  multi-day/multi-item testing still recommended to build full confidence it's fully closed.
- Confirm `SendOnEod` is actually checked for branches that expect an automatic EOD email —
  this was flagged as possibly just unchecked, not a bug, but never explicitly confirmed
  fixed.
- Restaurant POS Type: applied and smoke-tested against the local dev DB (`itcore-apps.com`
  instance); still not deployed to the actual production server or tested end-to-end on real
  handheld hardware (RawBT printing, phone-width layout).
- Dine-in offline mode: the `/api/orders/sync` snapshot-replace SQL was verified directly
  against the dev DB (insert path, status-transition/update path, item snapshot-replace, and
  the `UQ_OpenOrders_OneOpenPerTable` conflict path all confirmed), but the actual offline
  *browser* path — killing the network mid-order on a real device, confirming `db.openOrders`
  queues correctly and `syncPendingOrders()` catches it back up — has not been tested yet.
  Do that before trusting this in production.
- Kitchen/beverage print-area routing: the `MERGE`/upsert and area-lookup-join SQL in
  `OrdersController.SendToKitchen` was verified directly against the dev DB with throwaway
  data (insert path, update/delta path, and the category→area join all confirmed correct,
  cleaned up afterward). Not yet tested end-to-end through the actual browser UI or against a
  real network printer — no real print area/printer target has been configured and fired at
  yet, only the SQL underneath it.
- Discount configuration: the computation engine (`computeTotals()`/`resolveDiscount()`/
  `discountLineAmount()`) was verified numerically against all three reference scenarios via
  a standalone script, and the new SQL (`DiscountCategoryRates` MERGE, `sp_UpsertSale`'s new
  params) was verified end-to-end against the dev DB with throwaway data. **Not yet tested
  through the actual UI** — the Admin Discounts tab, the `PaxModal` at Generate Bill, and the
  receipt's new "VAT Adjustment (info)" / diner-count lines have not been clicked through in
  a real browser. Do that, especially the Pharmacy-style mixed-rate case (two discountable
  categories with different overrides in one cart), before trusting this with real money.

## Working Agreement

- When starting work on a module, confirm which module/form/SP set is in scope before making changes.
- Flag any deviation from the patterns above rather than silently "fixing" them — some are deliberate (e.g. locked fields during edit) and were changed for a specific reason; check history before reversing a prior decision.
- Prefer surfacing a question over guessing when a screen's live file differs from what's expected (e.g. an extra control not in the original build) — add to it, don't guess at replacing it.