/* =====================================================================
   38 — Gift certificates as a payment (2026-11-20)
   The user: add Gift Certificate as a payment type. Their calls: SparkPOS keeps its own list of
   GCs (head office registers them in Admin), the till only ACCEPTS them (they're sold elsewhere),
   no change on a GC (the excess is forfeited), and a GC can be taken offline: it's checked and
   redeemed when the sale syncs, and a problem (unknown, already used, expired...) is flagged
   for review, never refused (the invoice is already printed).
   - dbo.GiftCertificates: the register. One use per GC (Active → Redeemed; a void puts it back).
   - SalePayments: PaymentType 'GC', GcNo, GcValue (face value; Amount = what it paid of the
     bill, GcValue − Amount = forfeited), GcCheck (what the check at sync found).
   - PosSettings.GiftCertOn: a branch takes GCs only when switched on (off).
   - ZReads.GcSales: GC payments of the day, on the Z-Read like card sales.
   - acc: a "Gift Certificates Outstanding" account and the ZREAD 'GC' rule for every company
     already set up (its End of Day would otherwise fail on an unmapped item).
   TVP_SalePayment is unchanged on purpose (the build on the IIS sites still sends it): the GC
   details go to sp_UpsertSale as JSON (@GiftCerts).
   Idempotent. Run, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.GiftCertificates', 'U') IS NULL
    CREATE TABLE dbo.GiftCertificates (
        GcId            INT IDENTITY(1,1) PRIMARY KEY,
        GcNo            NVARCHAR(30) NOT NULL CONSTRAINT UQ_GiftCertificates_No UNIQUE,
        FaceValue       DECIMAL(18,2) NOT NULL CONSTRAINT CK_GiftCertificates_Value CHECK (FaceValue > 0),
        BranchCode      VARCHAR(10) NULL,           -- NULL = good at every branch
        IssuedDate      DATE NOT NULL,
        ExpiryDate      DATE NULL,                  -- NULL = no expiry; good through this date
        IssuedTo        NVARCHAR(120) NULL,
        Note            NVARCHAR(200) NULL,
        Status          VARCHAR(10) NOT NULL CONSTRAINT DF_GiftCertificates_Status DEFAULT 'Active'
                        CONSTRAINT CK_GiftCertificates_Status CHECK (Status IN ('Active', 'Redeemed', 'Cancelled')),
        RedeemedSaleUid UNIQUEIDENTIFIER NULL,
        RedeemedAt      DATETIME2 NULL,
        RedeemedBranch  VARCHAR(10) NULL,
        CreatedAt       DATETIME2 NOT NULL CONSTRAINT DF_GiftCertificates_CreatedAt DEFAULT SYSDATETIME(),
        CreatedBy       INT NULL,
        CancelledAt     DATETIME2 NULL,
        CancelledBy     INT NULL,
        CancelReason    NVARCHAR(200) NULL
    );
GO

/* PaymentType's CHECK was declared inline (system-named): replace it, whatever its name. */
DECLARE @ck SYSNAME = (SELECT TOP 1 cc.name FROM sys.check_constraints cc
    WHERE cc.parent_object_id = OBJECT_ID('dbo.SalePayments') AND cc.definition LIKE '%PaymentType%');
IF @ck IS NOT NULL AND OBJECT_DEFINITION(OBJECT_ID(@ck)) NOT LIKE '%''GC''%'
BEGIN
    EXEC (N'ALTER TABLE dbo.SalePayments DROP CONSTRAINT ' + @ck);
    SET @ck = NULL;
END
IF @ck IS NULL AND NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_SalePayments_Type')
    ALTER TABLE dbo.SalePayments ADD CONSTRAINT CK_SalePayments_Type CHECK (PaymentType IN ('CASH', 'CARD', 'GC'));
GO

IF COL_LENGTH('dbo.SalePayments', 'GcNo') IS NULL
    ALTER TABLE dbo.SalePayments ADD
        GcNo    NVARCHAR(30) NULL,     -- the GC's number as keyed / scanned
        GcValue DECIMAL(18,2) NULL,    -- its face value; Amount is what it paid of the bill
        GcCheck VARCHAR(10) NULL;      -- at sync: OK / UNKNOWN / USED / EXPIRED / CANCELLED / BRANCH / VALUE
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SalePayments_GcNo')
    CREATE INDEX IX_SalePayments_GcNo ON dbo.SalePayments(GcNo) WHERE GcNo IS NOT NULL;
GO

IF COL_LENGTH('dbo.PosSettings', 'GiftCertOn') IS NULL
    ALTER TABLE dbo.PosSettings ADD GiftCertOn BIT NOT NULL CONSTRAINT DF_PosSettings_GiftCertOn DEFAULT 0;
GO

IF COL_LENGTH('dbo.ZReads', 'GcSales') IS NULL
    ALTER TABLE dbo.ZReads ADD GcSales DECIMAL(18,2) NOT NULL CONSTRAINT DF_ZReads_GcSales DEFAULT 0;
GO

/* Accounting already set up: the GC account and its Z-Read rule (new companies get them from
   the template, see acc.sp_SeedCoaTemplates / acc.sp_SetupCompany in 02_procedures.sql). */
IF OBJECT_ID('acc.Settings', 'U') IS NOT NULL
BEGIN
    INSERT INTO acc.ChartOfAccounts (CompanyId, AccountCode, AccountName, PlainName, AccountType,
        AccountSubType, IsSystem, SystemKey, SortOrder)
    SELECT s.CompanyId, '2120', 'Gift Certificates Outstanding', N'Gift certificates sold, not yet used',
           'Liability', 'GiftCert', 1, 'GIFT_CERT', 115
    FROM acc.Settings s
    WHERE NOT EXISTS (SELECT 1 FROM acc.ChartOfAccounts a WHERE a.CompanyId = s.CompanyId AND a.SystemKey = 'GIFT_CERT')
      AND NOT EXISTS (SELECT 1 FROM acc.ChartOfAccounts a WHERE a.CompanyId = s.CompanyId AND a.AccountCode = '2120');

    INSERT INTO acc.PostingRules (CompanyId, SourceType, RuleKey, AccountId)
    SELECT a.CompanyId, 'ZREAD', 'GC', a.AccountId
    FROM acc.ChartOfAccounts a
    WHERE a.SystemKey = 'GIFT_CERT'
      AND NOT EXISTS (SELECT 1 FROM acc.PostingRules r WHERE r.CompanyId = a.CompanyId AND r.SourceType = 'ZREAD' AND r.RuleKey = 'GC');
END
GO
