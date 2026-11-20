# TabletPOS — Addendum B: Basic Accounting Module

**Read after** `CLAUDE-CODE-BRIEF-multitenant-saas.md`.
**Build order:** this ships **before** `CLAUDE-CODE-ADDENDUM-A-bir-registration-upsell.md`.
See §12 for the one dependency that must be handled anyway.

**Audience:** Claude Code.
**Goal:** give SME owners their books, in the product, without an accountant —
QuickBooks/Xero simple on the surface, strict double-entry underneath.

---

## 1. Positioning and scope

**Settled with the user:**

| Question | Answer |
|---|---|
| Who keeps the books? | **The owner. No bookkeeper.** The UI must assume zero accounting knowledge. |
| Accounting basis | **Both accrual and cash.** Accrual is recorded; cash basis is a derived view. See §4. |
| CAS accreditation | **The user handles this separately.** Do not block on it, do not build official BIR book formats in this phase. |
| Ship order | **Before Addendum A.** |

Until CAS is in place, every report is labelled **"Management report — not an
official book of accounts."** Put it in the report header and in the PDF/Excel
export, not in a footnote. The engine is built to CAS standard so the label can
simply be removed later; nothing is rebuilt.

---

## 2. The design constraint that matters most

**The user is a shop owner, not an accountant.** They do not know what a debit
is and must never need to. This is not a nice-to-have — it is the difference
between a module they use and one they ignore.

Rules:

- **No account codes in any primary screen.** The owner sees "Electricity bill",
  not "6120 — Utilities Expense".
- **Nothing is entered as a journal.** The owner records *things that happened*:
  paid the electric bill, bought stock, took money for personal use. The posting
  engine turns each into a journal entry behind the scenes.
- **Manual journal entry exists but is hidden** under an "Advanced" area for the
  accountant they eventually hire, or for ITCORE support.
- **Plain-language report names.** "Profit & Loss" not "Statement of
  Comprehensive Income". "What I own and owe" as a subtitle on the balance sheet.
- **Guardrails over freedom.** Lock the system accounts the posting engine
  depends on. An owner who deletes "Sales" breaks every EOD posting.
- The trial balance and general ledger exist and are always correct — they are
  just not where the owner starts.

A useful test for any screen: *could a sari-sari store owner use this without
asking what a word means?* If not, rename it.

---

## 3. Schema

All tables carry `CompanyId`. Branch dimension goes on the **journal line**, not
on the account — never create `Sales-MAIN`, `Sales-MDU`, `Sales-LAP`.

```
acc.ChartOfAccounts
  AccountId, CompanyId, AccountCode, AccountName, PlainName,
  AccountType,          -- Asset | Liability | Equity | Income | Expense
  AccountSubType,       -- Cash | Bank | AR | Inventory | AP | VATOutput | ... 
  ParentAccountId NULL,
  IsSystem BIT,         -- posting engine depends on it; cannot be deleted
  SystemKey VARCHAR(40) NULL,   -- e.g. 'CASH_ON_HAND', 'SALES', 'VAT_OUTPUT'
  IsActive, SortOrder

acc.JournalEntries
  EntryUid UNIQUEIDENTIFIER, CompanyId, BranchId,
  EntryNo,              -- per company, sequential, gapless
  EntryDate DATE, EntryType,        -- Auto | Manual | Adjustment | Closing
  SourceType,           -- ZREAD | BILL | PAYMENT | RECEIPT | STOCK | MANUAL | ...
  SourceUid NULL,       -- points back to the originating record
  PermitId INT NULL,    -- see §12
  Memo, IsPosted BIT, PostedAt, PostedByUserId,
  ReversalOfUid NULL, ReversedByUid NULL

acc.JournalLines
  EntryUid, LineNo, AccountId, BranchId,
  Debit DECIMAL(18,2), Credit DECIMAL(18,2),
  Memo, ContactId NULL

acc.Contacts                  -- suppliers and charge customers in one table
  ContactId, CompanyId, ContactType,   -- Supplier | Customer | Both
  Name, Tin, Address, ContactNo, Email,
  IsWithholdingAgent BIT, DefaultEwtRate DECIMAL(5,4) NULL,
  CreditLimit, PaymentTermsDays, IsActive

acc.Bills                     -- payables
  BillId, CompanyId, BranchId, ContactId,
  BillNo, BillDate, DueDate,
  Subtotal, InputVat, EwtAmount, Total, AmountPaid, Status,
  SourceType NULL, SourceUid NULL,     -- e.g. a stock receipt
  EntryUid NULL

acc.BillLines
  BillId, LineNo, AccountId, Description, Amount, IsVatable, EwtRate

acc.Invoices                  -- receivables (charge/account customers)
  InvoiceId, CompanyId, BranchId, ContactId,
  InvoiceNo, InvoiceDate, DueDate,
  Subtotal, OutputVat, Total, AmountPaid, Status, EntryUid NULL

acc.Payments                  -- money out and money in
  PaymentId, CompanyId, BranchId, Direction,   -- Out | In
  PaymentDate, BankAccountId, Method, ReferenceNo,
  ContactId, Amount, EntryUid NULL

acc.PaymentAllocations        -- which payment settled which bill/invoice
  PaymentId, BillId NULL, InvoiceId NULL, Amount

acc.BankAccounts
  BankAccountId, CompanyId, AccountId,   -- links to ChartOfAccounts
  BankName, AccountName, AccountNoMasked, OpeningBalance, IsActive

acc.BankReconciliations
  ReconciliationId, CompanyId, BankAccountId, StatementDate,
  StatementBalance, ReconciledBalance, Status, CompletedAt

acc.BankReconciliationLines
  ReconciliationId, JournalLineRef, IsCleared, ClearedDate

acc.Periods
  CompanyId, PeriodYear, PeriodMonth, PeriodStart, PeriodEnd,
  Status,               -- Open | Closed | Locked
  ClosedAt, ClosedByUserId

acc.PostingRules          -- maps a source event to accounts, per company
  RuleId, CompanyId, SourceType, RuleKey, DebitAccountId, CreditAccountId
```

### Hard rules, enforced in stored procedures not C#

1. **Debits must equal credits per entry.** `sp_PostJournalEntry` validates and
   throws otherwise. No exceptions, no rounding slack — allocate any rounding
   difference to a designated rounding account.
2. **Posted entries are never edited or deleted, only reversed.** A reversal is a
   new entry with `ReversalOfUid` set. Same principle as `VOID_RETURN` in sales.
3. **No posting into a Closed or Locked period.** The procedure rejects it and
   tells the user which period is closed.
4. **`EntryNo` is gapless per company.** Allocate inside the posting transaction.
5. Every automatic entry carries `SourceType` + `SourceUid` so any figure in any
   report can be traced back to the transaction that caused it. Build the
   drill-through; the owner will not trust a number they cannot open.

---

## 4. Accrual and cash basis

**Accrual is the recorded truth. Cash basis is a derived reporting view.** Do
not maintain two sets of books.

How the cash-basis view is produced:

- Income and expense arising from an **immediate cash transaction** (a POS cash
  sale, a bill paid on the spot) appear in both views on the same date.
- Income and expense arising from a **credit transaction** (a charge invoice, an
  unpaid bill) appear in the accrual view on the document date, and in the cash
  view only on the date and to the extent cash actually moved —
  via `acc.PaymentAllocations`.
- Balance sheet items unaffected by basis (cash, inventory, equity) are
  identical in both.
- AR and AP do not exist in a cash-basis balance sheet. Suppress them in that
  view rather than showing zero.

Implement as `@Basis VARCHAR(10)` — `Accrual | Cash` — on every P&L, balance
sheet and cash-flow procedure. A single toggle in the report header, labelled in
plain language:

> **How should we count it?**
> ( ) When I get paid *(cash basis)* ( ) When I make the sale *(accrual)*

Default to **cash basis** in the UI. It matches how an SME owner thinks, and
the accrual view is there when their accountant or BIR needs it.

---

## 5. The posting engine

### 5.1 Source: End of Day (the main one)

**Post one summarized journal entry per terminal per business day, from
`ZReads`. Never per sale.** A busy terminal does 400 sales a day; per-sale
posting produces ~146,000 entries a year per terminal and a ledger no human can
read. EOD is already immutable and locked — it is the correct close point.

`sp_PostZReadToLedger(@CompanyId, @ZReadId)` produces:

```
Dr  Cash on Hand              (ZReads.CashSales)
Dr  Card Receivable           (ZReads.CardSales)
    Cr  Sales — Vatable           (ZReads.VatableAmount)
    Cr  Output VAT                (ZReads.VatAmount)
    Cr  Sales — VAT Exempt        (ZReads.VatExemptAmount)
    Cr  Sales — Zero Rated        (ZReads.ZeroRatedAmount)
Dr  SC/PWD Discount            (ZReads.TotalDiscounts)
```

Plus, from the same day's shift closings:

```
Dr/Cr  Cash Short/Over         (ShiftClosings.ShortOver)
```

And, once the inventory module exists (Addendum C), the COGS side:

```
Dr  Cost of Goods Sold
    Cr  Inventory
```

**Call it from inside `sp_ProcessEndOfDay`, in the same transaction.** If the
posting fails, EOD fails. A locked business day with no journal entry is a
reconciliation problem that surfaces months later.

Make it **idempotent** — keyed on `SourceType='ZREAD'` + `SourceUid=ZReadId`, so
a retry cannot double-post. Same discipline as `sp_UpsertSale`.

### 5.2 Other sources

| Event | Entry |
|---|---|
| Stock receipt (cash) | Dr Inventory, Dr Input VAT / Cr Cash |
| Stock receipt (credit) | Dr Inventory, Dr Input VAT / Cr Accounts Payable |
| Bill payment | Dr Accounts Payable / Cr Bank or Cash, Cr EWT Payable |
| Expense paid directly | Dr Expense, Dr Input VAT / Cr Cash or Bank |
| Charge sale invoice | Dr Accounts Receivable / Cr Sales, Cr Output VAT |
| Customer payment | Dr Cash or Bank / Cr Accounts Receivable |
| Card settlement received | Dr Bank / Cr Card Receivable |
| Owner withdrawal | Dr Owner's Drawings / Cr Cash |
| Owner capital injection | Dr Cash / Cr Owner's Capital |
| Stock adjustment or spoilage | Dr Inventory Loss / Cr Inventory |
| Branch transfer | Dr Inventory (to-branch) / Cr Inventory (from-branch) |
| **Container deposit collected** | Dr Cash / **Cr Container Deposit Liability** |
| **Container deposit refunded** | Dr Container Deposit Liability / Cr Cash |

The last two matter for the water-refilling clients: a deposit is a liability,
not revenue. Generic accounting bolt-ons get this wrong and overstate income.

**Card Receivable is deliberate.** Card sales are not cash until the acquirer
settles, usually a few days later. Posting them straight to Bank makes the
owner's cash position wrong every single day and destroys trust in the module.

### 5.3 Posting rules are data

Account mappings live in `acc.PostingRules`, seeded per company from the
industry template. Never hardcode an `AccountId` in a stored procedure. A client
who wants sales split differently should be a configuration change, not a
deployment.

---

## 6. Chart of accounts templates

Ship per-industry templates, pre-mapped to the posting rules, so a new company
is productive on day one:

- **Water refilling** — includes Container Deposit Liability, Container
  Inventory, Delivery Expense, Refilling Supplies
- **Retail**
- **Restaurant** — includes Food Cost, Beverage Cost, Service Charge Payable
- **Pharmacy**

Each template ships the required `SystemKey` accounts:
`CASH_ON_HAND`, `CASH_IN_BANK`, `CARD_RECEIVABLE`, `AR`, `INVENTORY`,
`AP`, `VAT_OUTPUT`, `VAT_INPUT`, `EWT_PAYABLE`, `SALES_VATABLE`,
`SALES_EXEMPT`, `SALES_ZERORATED`, `SCPWD_DISCOUNT`, `COGS`,
`CASH_SHORT_OVER`, `INVENTORY_LOSS`, `OWNER_CAPITAL`, `OWNER_DRAWINGS`,
`RETAINED_EARNINGS`, `ROUNDING`.

The owner may add, rename and deactivate accounts. `IsSystem = 1` accounts
cannot be deleted, and their `SystemKey` cannot be reassigned.

---

## 7. Reports

Owner-facing, in this order of prominence:

1. **Dashboard** — cash on hand and in bank, this month's sales vs last, top
   expenses, money owed to me, money I owe, and a simple profit figure
2. **Profit & Loss** — month, quarter, year, custom; comparison column;
   branch filter; basis toggle
3. **Balance Sheet** — "What I own and owe"
4. **Cash Flow** — where the money came from and went
5. **Expenses by category** — with drill-through to the actual bill
6. **AR aging / AP aging** — "who owes me" and "who I owe", bucketed
7. **Sales by branch / by product** — reads existing POS reports, no new work

Accountant-facing, under "Advanced":

8. Trial Balance
9. General Ledger, per account, with running balance
10. General Journal
11. Account transaction drill-through

Every report: branch filter, basis toggle, CSV and PDF export, and the
management-report label until CAS is granted.

---

## 8. Philippine tax layer

This is the differentiator over "just connect to Xero" — Xero does not know PH
tax. Build it properly.

- **Output VAT in three buckets.** Vatable, VAT-exempt (this is where the
  SC/PWD discounts land) and zero-rated must post to separate accounts, because
  that is how 2550M/2550Q is structured. The POS already computes all three per
  sale and rolls them into `ZReads` — use those columns directly.
- **Input VAT** on purchases, tracked per supplier and per document.
- **VAT summary report** laid out to match the 2550M/2550Q line items.
- **Summary List of Sales and Purchases (SLSP)** export.
- **Expanded withholding tax** — a field on bills, with common rates
  (rent 5%, professional fees 5%/10%, contractors 2%). Generates the data
  needed for BIR 2307. Do not treat EWT as an afterthought; SMEs paying rent
  withhold every month.
- **SC/PWD discount** already reported by the POS; the ledger side records it as
  a deduction account so the P&L shows it explicitly.

Tax rates and EWT rates are **data in a table with effective dates**, never
constants. Rates change, and historical documents must keep the rate that
applied when they were issued.

---

## 9. Integration points with what exists

| Existing | Change |
|---|---|
| `sp_ProcessEndOfDay` | Calls `sp_PostZReadToLedger` in the same transaction |
| `ZReads` | Read-only source for the daily sales entry; no schema change |
| `ShiftClosings` | Source for the Cash Short/Over line |
| Admin console | New "Accounting" top-level section |
| Subscription | Accounting is a **paid add-on tier**, not bundled in the ₱1,999 |
| Enforcement middleware | Accounting screens are admin-tier: they degrade with `PastDue` per the main brief's §6 ladder. **The POS still sells regardless.** |

---

## 10. Explicitly out of scope for v1

Refuse these; each one turns "basic accounting" into a two-year ERP project:

- Multi-currency
- Cost centres and project accounting
- Fixed-asset register and depreciation schedules
- Budgeting and variance analysis
- Multi-company consolidation
- **Payroll** — clients will ask constantly. It is a separate product with its
  own compliance surface (SSS, PhilHealth, Pag-IBIG, 1601-C, alphalist). Say
  "later, priced separately."
- Purchase orders and approval workflows (these belong with the inventory
  module, Addendum C)

---

## 11. Build order

1. `acc` schema, chart of accounts, industry templates, `SystemKey` seeding
2. `sp_PostJournalEntry` with the balance check, reversal, period lock, gapless
   numbering — plus a test suite. **This is the foundation; get it right before
   anything posts to it.**
3. Trial balance and general ledger (proves the engine before any UI polish)
4. `sp_PostZReadToLedger` wired into `sp_ProcessEndOfDay`, idempotent
5. P&L and balance sheet, accrual basis
6. Cash basis derivation and the basis toggle
7. Contacts, bills, expenses, AP aging
8. Payments, allocations, AR invoices and aging
9. Bank accounts and reconciliation
10. PH tax layer — VAT summary, SLSP, EWT/2307
11. Owner dashboard and plain-language polish
12. Exports — CSV for the accountant; Xero/QBO connectors only if demand
    justifies them

Steps 1–4 are the critical path. Do not build UI ahead of a posting engine that
provably balances.

**Mockup first**, as with every previous phase — the owner-facing screens
especially, because §2 is the whole risk.

---

## 12. Sequencing note: the one dependency on Addendum A

The user has chosen to ship accounting **before** the BIR registration upsell.
That is fine, with one precaution.

Addendum A introduces `TerminalPermits` and puts `PermitId` on `Sales` and
`ZReads`, so that official sales under a given PTU can be reported separately.
Journal entries posted from Z-Reads will need the same dimension.

**Therefore: include `PermitId INT NULL` on `acc.JournalEntries` now**, even
though nothing populates it yet. `sp_PostZReadToLedger` copies it from the
Z-Read when the column exists. Adding a nullable column now costs nothing;
backfilling a dimension across a year of journal entries later is painful.

Everything else in Addendum A is independent of this module.

---

## 13. Open items

- **Opening balances.** A client switching from manual books has existing cash,
  stock, receivables and payables. Build an opening-balance entry wizard —
  otherwise their first balance sheet is wrong and they stop using the module in
  week one. **DECIDE WITH USER:** part of v1, or a guided ITCORE-assisted
  onboarding task?
- **Year-end closing.** Closing entries to Retained Earnings — v1, or manual
  journal for now?
- **Card settlement timing.** Does the owner reconcile Card Receivable manually
  when the acquirer deposits, or should the system auto-clear after N days?
  Manual is more accurate; auto is less work. Recommend manual with a "settle
  card batch" action.
- **Reporting label.** Confirm the exact wording of the management-report
  disclaimer with the user before it goes on every export.
