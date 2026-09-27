# SparkPOS (formerly TabletPOS) — Notes for Claude

Solution root. Components: `src/PosApi` (ASP.NET Core 8 backend), `web/` (React/Vite frontend),
`database/` (SQL Server schema + numbered migrations), `src/PrintAgent` (Windows-only local print
bridge, not used by the Android handheld terminal — see Printing below).

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
  new build before trusting a negative test result.
- The original 405-on-PUT error was **not** WebDAV (not installed on this server) — it was
  IIS Request Filtering / Handler Mapping restricting verbs at the site level. Fixed via IIS
  Manager, not code.

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

- Cashier-facing screens only need to be phone-responsive (Login, Cash Begin, POS, Blind
  Close, End of Day). **Admin console is intentionally desktop/tablet-only** — do not try to
  make it mobile-responsive unless explicitly asked.
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
  the kitchen. `database/09_print_areas.sql` / `10_print_areas.sql`.
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
- **DDL is unaffected** — `CREATE TABLE ... LineNo INT NOT NULL` and
  `CONSTRAINT ... UNIQUE (OpenOrderUid, LineNo)` both worked with the bare name; only DML
  (`SELECT`/`WHERE`/`ORDER BY`/`INSERT` column lists) rejects it. So existing schema files
  didn't need changing, only the queries that reference the column.
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