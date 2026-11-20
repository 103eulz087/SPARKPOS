/* =====================================================================
   Accounting module (Addendum B), steps 1–4: acc schema, chart-of-accounts
   templates, journal, periods, posting rules.

   Strict double-entry underneath, plain language on top. The ledger's hard rules
   (balanced entries, no edits only reversals, period locks, gapless EntryNo) are
   enforced in stored procedures (acc.sp_PostJournalEntry, in 02_procedures.sql)
   plus the immutability triggers below as defense-in-depth.

   CompanyId is on every table (defaults to 1) so the schema is ready for the
   multi-tenant model, even though today each client is its own deployment + DB
   and the API always uses CompanyId 1. The branch dimension is BranchCode on the
   journal LINE (matching the rest of the app), never one account per branch.

   Nothing posts until an Admin turns accounting on (acc.sp_SetupCompany via
   Admin → Accounting). Until then End of Day behaves exactly as before.

   Safe to run more than once.
   Run: sqlcmd -S <server> -U sa -P <pwd> -d TabletPOS -i 16_accounting.sql
   THEN re-run 02_procedures.sql (the acc.* procedures and the updated
   dbo.sp_ProcessEndOfDay live there).
   ===================================================================== */
IF SCHEMA_ID('acc') IS NULL EXEC('CREATE SCHEMA acc');
GO

IF OBJECT_ID('acc.Settings', 'U') IS NULL
BEGIN
    CREATE TABLE acc.Settings (
        CompanyId       INT NOT NULL PRIMARY KEY,
        IsEnabled       BIT NOT NULL DEFAULT 0,
        TemplateCode    VARCHAR(20) NOT NULL,
        StartDate       DATE NOT NULL,          -- Z-Reads before this date are never posted
        EnabledAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        EnabledByUserId INT NULL
    );
END
GO

/* Industry chart-of-accounts templates. 'BASE' rows are shared by every template;
   the industry rows add to them. Populated by acc.sp_SeedCoaTemplates (idempotent),
   which acc.sp_SetupCompany calls itself — no separate seed step needed. */
IF OBJECT_ID('acc.CoaTemplateAccounts', 'U') IS NULL
BEGIN
    CREATE TABLE acc.CoaTemplateAccounts (
        TemplateCode    VARCHAR(20) NOT NULL,
        AccountCode     VARCHAR(20) NOT NULL,
        AccountName     NVARCHAR(120) NOT NULL,
        PlainName       NVARCHAR(120) NOT NULL,
        AccountType     VARCHAR(10) NOT NULL,
        AccountSubType  VARCHAR(30) NULL,
        SystemKey       VARCHAR(40) NULL,
        SortOrder       INT NOT NULL DEFAULT 0,
        CONSTRAINT PK_CoaTemplateAccounts PRIMARY KEY (TemplateCode, AccountCode)
    );
END
GO

IF OBJECT_ID('acc.ChartOfAccounts', 'U') IS NULL
BEGIN
    CREATE TABLE acc.ChartOfAccounts (
        AccountId       INT IDENTITY(1,1) PRIMARY KEY,
        CompanyId       INT NOT NULL DEFAULT 1,
        AccountCode     VARCHAR(20) NOT NULL,
        AccountName     NVARCHAR(120) NOT NULL,
        PlainName       NVARCHAR(120) NOT NULL,
        AccountType     VARCHAR(10) NOT NULL
                        CHECK (AccountType IN ('Asset','Liability','Equity','Income','Expense')),
        AccountSubType  VARCHAR(30) NULL,
        ParentAccountId INT NULL REFERENCES acc.ChartOfAccounts(AccountId),
        IsSystem        BIT NOT NULL DEFAULT 0,  -- the posting engine depends on it
        SystemKey       VARCHAR(40) NULL,        -- e.g. 'CASH_ON_HAND', 'SALES_VATABLE'
        IsActive        BIT NOT NULL DEFAULT 1,
        SortOrder       INT NOT NULL DEFAULT 0,
        CONSTRAINT UQ_Coa_Code UNIQUE (CompanyId, AccountCode)
    );
    CREATE UNIQUE INDEX UQ_Coa_SystemKey ON acc.ChartOfAccounts(CompanyId, SystemKey)
        WHERE SystemKey IS NOT NULL;
END
GO

IF OBJECT_ID('acc.Periods', 'U') IS NULL
BEGIN
    CREATE TABLE acc.Periods (
        CompanyId       INT NOT NULL DEFAULT 1,
        PeriodYear      INT NOT NULL,
        PeriodMonth     INT NOT NULL CHECK (PeriodMonth BETWEEN 1 AND 12),
        PeriodStart     DATE NOT NULL,
        PeriodEnd       DATE NOT NULL,
        Status          VARCHAR(10) NOT NULL DEFAULT 'Open' CHECK (Status IN ('Open','Closed','Locked')),
        ClosedAt        DATETIME2 NULL,
        ClosedByUserId  INT NULL,
        CONSTRAINT PK_Periods PRIMARY KEY (CompanyId, PeriodYear, PeriodMonth)
    );
END
GO

/* One row per company; bumped inside the posting transaction so EntryNo is gapless
   (a rolled-back post rolls the counter back with it). */
IF OBJECT_ID('acc.EntryCounters', 'U') IS NULL
BEGIN
    CREATE TABLE acc.EntryCounters (
        CompanyId       INT NOT NULL PRIMARY KEY,
        LastEntryNo     BIGINT NOT NULL DEFAULT 0
    );
END
GO

IF OBJECT_ID('acc.JournalEntries', 'U') IS NULL
BEGIN
    CREATE TABLE acc.JournalEntries (
        EntryUid        UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        CompanyId       INT NOT NULL DEFAULT 1,
        BranchCode      VARCHAR(10) NULL,
        EntryNo         BIGINT NOT NULL,
        EntryDate       DATE NOT NULL,
        EntryType       VARCHAR(12) NOT NULL CHECK (EntryType IN ('Auto','Manual','Adjustment','Closing')),
        SourceType      VARCHAR(20) NOT NULL,    -- ZREAD | REVERSAL | MANUAL | (later) BILL, PAYMENT, ...
        SourceUid       VARCHAR(50) NULL,        -- VARCHAR, not GUID: Z-Reads are keyed by an INT id
        PermitId        INT NULL,                -- for Addendum A (BIR permits); nothing sets it yet
        Memo            NVARCHAR(300) NULL,
        TotalAmount     DECIMAL(18,2) NOT NULL,  -- sum of debits (= sum of credits)
        IsPosted        BIT NOT NULL DEFAULT 1,
        PostedAt        DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        PostedByUserId  INT NULL,
        ReversalOfUid   UNIQUEIDENTIFIER NULL REFERENCES acc.JournalEntries(EntryUid),
        ReversedByUid   UNIQUEIDENTIFIER NULL,
        CONSTRAINT UQ_JournalEntries_No UNIQUE (CompanyId, EntryNo)
    );
    /* Idempotency: one live (un-reversed) entry per source record. Reversing an entry
       takes it out of this index, so the source can be posted again afterward. */
    CREATE UNIQUE INDEX UQ_JournalEntries_Source ON acc.JournalEntries(CompanyId, SourceType, SourceUid)
        WHERE SourceUid IS NOT NULL AND ReversedByUid IS NULL;
    CREATE INDEX IX_JournalEntries_Date ON acc.JournalEntries(CompanyId, EntryDate);
END
GO

IF OBJECT_ID('acc.JournalLines', 'U') IS NULL
BEGIN
    CREATE TABLE acc.JournalLines (
        EntryUid        UNIQUEIDENTIFIER NOT NULL REFERENCES acc.JournalEntries(EntryUid),
        [LineNo]        INT NOT NULL,            -- reserved word on this server: always bracket it
        AccountId       INT NOT NULL REFERENCES acc.ChartOfAccounts(AccountId),
        BranchCode      VARCHAR(10) NULL,
        Debit           DECIMAL(18,2) NOT NULL DEFAULT 0,
        Credit          DECIMAL(18,2) NOT NULL DEFAULT 0,
        Memo            NVARCHAR(200) NULL,
        ContactId       INT NULL,                -- acc.Contacts arrives with bills/invoices (step 7)
        CONSTRAINT PK_JournalLines PRIMARY KEY (EntryUid, [LineNo]),
        CONSTRAINT CK_JournalLines_OneSide CHECK (Debit >= 0 AND Credit >= 0
            AND (Debit = 0 OR Credit = 0) AND (Debit + Credit) > 0)
    );
    CREATE INDEX IX_JournalLines_Account ON acc.JournalLines(AccountId) INCLUDE (Debit, Credit, BranchCode);
END
GO

/* Maps a source event's components to accounts, per company. Deviation from the
   spec's DebitAccountId/CreditAccountId pair: a Z-Read entry has 8+ components, each
   landing on one account on whichever side its sign dictates, so one AccountId per
   RuleKey is the simpler, complete mapping. */
IF OBJECT_ID('acc.PostingRules', 'U') IS NULL
BEGIN
    CREATE TABLE acc.PostingRules (
        RuleId          INT IDENTITY(1,1) PRIMARY KEY,
        CompanyId       INT NOT NULL DEFAULT 1,
        SourceType      VARCHAR(20) NOT NULL,
        RuleKey         VARCHAR(40) NOT NULL,
        AccountId       INT NOT NULL REFERENCES acc.ChartOfAccounts(AccountId),
        CONSTRAINT UQ_PostingRules UNIQUE (CompanyId, SourceType, RuleKey)
    );
END
GO

IF TYPE_ID('acc.TVP_JournalLine') IS NULL
    CREATE TYPE acc.TVP_JournalLine AS TABLE (
        Seq INT NOT NULL, AccountId INT NOT NULL, BranchCode VARCHAR(10) NULL,
        Debit DECIMAL(18,2) NOT NULL DEFAULT 0, Credit DECIMAL(18,2) NOT NULL DEFAULT 0,
        Memo NVARCHAR(200) NULL
    );
GO

/* ---------- Guardrails (defense-in-depth; the procedures already follow these) ---------- */

/* System accounts: can't be deleted, and their SystemKey/type can't change —
   an owner who deletes "Sales" would break every End of Day posting. */
CREATE OR ALTER TRIGGER acc.trg_ChartOfAccounts_Guard ON acc.ChartOfAccounts
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM deleted d LEFT JOIN inserted i ON i.AccountId = d.AccountId
               WHERE d.IsSystem = 1 AND i.AccountId IS NULL)
        THROW 52101, 'System accounts cannot be deleted.', 1;
    IF EXISTS (SELECT 1 FROM deleted d JOIN inserted i ON i.AccountId = d.AccountId
               WHERE d.IsSystem = 1 AND (i.IsSystem = 0 OR ISNULL(i.SystemKey,'') <> ISNULL(d.SystemKey,'')
                                         OR i.AccountType <> d.AccountType OR i.IsActive = 0))
        THROW 52102, 'System accounts cannot be deactivated, retyped, or have their system key changed.', 1;
END
GO

/* Posted lines are never edited or deleted — reverse the entry instead. */
CREATE OR ALTER TRIGGER acc.trg_JournalLines_Immutable ON acc.JournalLines
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM deleted)
        THROW 52103, 'Posted journal lines cannot be changed or deleted. Reverse the entry instead.', 1;
END
GO

/* Entries: no deletes; the only permitted update is stamping ReversedByUid (once). */
CREATE OR ALTER TRIGGER acc.trg_JournalEntries_Immutable ON acc.JournalEntries
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM deleted d LEFT JOIN inserted i ON i.EntryUid = d.EntryUid WHERE i.EntryUid IS NULL)
        THROW 52104, 'Posted journal entries cannot be deleted. Reverse the entry instead.', 1;
    IF EXISTS (SELECT 1 FROM deleted d JOIN inserted i ON i.EntryUid = d.EntryUid
               WHERE d.ReversedByUid IS NOT NULL
                  OR i.CompanyId <> d.CompanyId OR i.EntryNo <> d.EntryNo OR i.EntryDate <> d.EntryDate
                  OR i.EntryType <> d.EntryType OR i.SourceType <> d.SourceType
                  OR ISNULL(i.SourceUid,'') <> ISNULL(d.SourceUid,'') OR i.TotalAmount <> d.TotalAmount
                  OR ISNULL(i.BranchCode,'') <> ISNULL(d.BranchCode,'') OR ISNULL(i.Memo,N'') <> ISNULL(d.Memo,N'')
                  OR i.IsPosted <> d.IsPosted
                  OR ISNULL(CONVERT(VARCHAR(36), i.ReversalOfUid),'') <> ISNULL(CONVERT(VARCHAR(36), d.ReversalOfUid),''))
        THROW 52105, 'Posted journal entries cannot be edited. Reverse the entry instead.', 1;
END
GO
