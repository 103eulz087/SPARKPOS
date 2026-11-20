/* =====================================================================
   18 — BIR sworn-statement compliance (accreditation document)
   1. Sales Invoice number: 18 digits, non-resettable, starts at 000000000000000001.
      Stored in Sales.ORNumber (BIGINT; the column keeps its old name) and printed
      zero-padded. Each terminal (one MIN) runs its own gap-free sequence.
   2. Customer info on the invoice: name, address, TIN, business style.
   3. Reprint = an exact replica: the printed text is kept (Sales.ReceiptText) and a
      reprint is that text under a REPRINT label.
   4. Grand total: Terminals.GrandTotalSales DECIMAL(18,2) (max 9,999,999,999,999,999.99),
      guarded so it can never go down.
   5/6. Return transactions referencing the original SI No., numbered by a 6-digit
      non-resettable per-terminal counter (Terminals.LastReturnNo, starts at 000001).
   Idempotent. Run this, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

/* ---------- Sales: customer info + printed text + SI number range ---------- */
IF COL_LENGTH('dbo.Sales', 'CustomerName') IS NULL
    ALTER TABLE dbo.Sales ADD
        CustomerName          NVARCHAR(150) NULL,
        CustomerAddress       NVARCHAR(250) NULL,
        CustomerTin           VARCHAR(20)   NULL,
        CustomerBusinessStyle NVARCHAR(150) NULL;
GO
IF COL_LENGTH('dbo.Sales', 'ReceiptText') IS NULL
    ALTER TABLE dbo.Sales ADD ReceiptText NVARCHAR(MAX) NULL;
GO
IF OBJECT_ID('dbo.CK_Sales_SINo', 'C') IS NULL
    ALTER TABLE dbo.Sales ADD CONSTRAINT CK_Sales_SINo CHECK (ORNumber BETWEEN 1 AND 999999999999999999);
GO

/* ---------- SaleItems: per-line BIR breakdown (what computeTotals() worked out) ----------
   Needed so a partial return can refund exactly that line's share, and later for the ERP. */
IF COL_LENGTH('dbo.SaleItems', 'NetAmount') IS NULL
    ALTER TABLE dbo.SaleItems ADD
        NetAmount       DECIMAL(18,2) NOT NULL CONSTRAINT DF_SaleItems_NetAmount DEFAULT 0,
        VatableAmount   DECIMAL(18,2) NOT NULL CONSTRAINT DF_SaleItems_VatableAmount DEFAULT 0,
        VatAmount       DECIMAL(18,2) NOT NULL CONSTRAINT DF_SaleItems_VatAmount DEFAULT 0,
        VatExemptAmount DECIMAL(18,2) NOT NULL CONSTRAINT DF_SaleItems_VatExemptAmount DEFAULT 0,
        ZeroRatedAmount DECIMAL(18,2) NOT NULL CONSTRAINT DF_SaleItems_ZeroRatedAmount DEFAULT 0,
        VatAdjustment   DECIMAL(18,2) NOT NULL CONSTRAINT DF_SaleItems_VatAdjustment DEFAULT 0,
        ReturnedQty     DECIMAL(18,3) NOT NULL CONSTRAINT DF_SaleItems_ReturnedQty DEFAULT 0;
GO

/* TVP_SaleItem gains the breakdown. A table type can't be altered: drop its one user
   (sp_UpsertSale, recreated by 02_procedures.sql) and the type, then recreate. */
IF TYPE_ID('dbo.TVP_SaleItem') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.table_types tt JOIN sys.columns c ON c.object_id = tt.type_table_object_id
                   WHERE tt.name = 'TVP_SaleItem' AND c.name = 'NetAmount')
BEGIN
    IF OBJECT_ID('dbo.sp_UpsertSale', 'P') IS NOT NULL DROP PROCEDURE dbo.sp_UpsertSale;
    DROP TYPE dbo.TVP_SaleItem;
END
GO
IF TYPE_ID('dbo.TVP_SaleItem') IS NULL
    CREATE TYPE dbo.TVP_SaleItem AS TABLE (
        [LineNo] INT, ProductId INT, Barcode NVARCHAR(50), ProductName NVARCHAR(150),
        CategoryId INT, Quantity DECIMAL(18,3), UnitPrice DECIMAL(18,2),
        OrigUnitPrice DECIMAL(18,2), LineDiscount DECIMAL(18,2), LineTotal DECIMAL(18,2),
        IsVatable BIT, IsDiscountable BIT,
        NetAmount DECIMAL(18,2) DEFAULT 0, VatableAmount DECIMAL(18,2) DEFAULT 0,
        VatAmount DECIMAL(18,2) DEFAULT 0, VatExemptAmount DECIMAL(18,2) DEFAULT 0,
        ZeroRatedAmount DECIMAL(18,2) DEFAULT 0, VatAdjustment DECIMAL(18,2) DEFAULT 0
    );
GO

/* ---------- Terminals: return counter ---------- */
IF COL_LENGTH('dbo.Terminals', 'LastReturnNo') IS NULL
    ALTER TABLE dbo.Terminals ADD LastReturnNo INT NOT NULL CONSTRAINT DF_Terminals_LastReturnNo DEFAULT 0;
GO
IF OBJECT_ID('dbo.CK_Terminals_LastReturnNo', 'C') IS NULL
    ALTER TABLE dbo.Terminals ADD CONSTRAINT CK_Terminals_LastReturnNo CHECK (LastReturnNo BETWEEN 0 AND 999999);
GO

/* ---------- PosSettings: supervisor override for returns ---------- */
IF COL_LENGTH('dbo.PosSettings', 'ReturnOverride') IS NULL
    ALTER TABLE dbo.PosSettings ADD ReturnOverride BIT NOT NULL CONSTRAINT DF_PosSettings_ReturnOverride DEFAULT 1;
GO

/* ---------- Return transactions ---------- */
IF OBJECT_ID('dbo.SaleReturns', 'U') IS NULL
CREATE TABLE dbo.SaleReturns (
    ReturnId         BIGINT IDENTITY(1,1) PRIMARY KEY,
    ReturnUid        UNIQUEIDENTIFIER NOT NULL UNIQUE,   -- idempotency key
    ReturnNo         INT NOT NULL CHECK (ReturnNo BETWEEN 1 AND 999999),
    BranchCode       VARCHAR(10) NOT NULL,
    TerminalId       INT NOT NULL REFERENCES dbo.Terminals(TerminalId),
    ShiftUid         UNIQUEIDENTIFIER NOT NULL,
    BusinessDate     DATE NOT NULL,
    ReturnDateTime   DATETIME2 NOT NULL,
    CashierUserId    INT NOT NULL,
    ApprovedByUserId INT NOT NULL,
    OrigSaleUid      UNIQUEIDENTIFIER NOT NULL,
    OrigTerminalId   INT NOT NULL,
    OrigORNumber     BIGINT NOT NULL,                    -- the Ref SI No.
    GrossAmount      DECIMAL(18,2) NOT NULL,
    DiscountAmount   DECIMAL(18,2) NOT NULL,
    VatableAmount    DECIMAL(18,2) NOT NULL,
    VatAmount        DECIMAL(18,2) NOT NULL,
    VatExemptAmount  DECIMAL(18,2) NOT NULL,
    ZeroRatedAmount  DECIMAL(18,2) NOT NULL,
    VatAdjustment    DECIMAL(18,2) NOT NULL DEFAULT 0,
    NetAmount        DECIMAL(18,2) NOT NULL,             -- refunded to the customer, in cash
    Reason           NVARCHAR(200) NOT NULL,
    ReceiptText      NVARCHAR(MAX) NULL,
    CreatedAt        DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT UQ_SaleReturns_No UNIQUE (TerminalId, ReturnNo)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SaleReturns_Shift' AND object_id = OBJECT_ID('dbo.SaleReturns'))
    CREATE INDEX IX_SaleReturns_Shift ON dbo.SaleReturns(ShiftUid);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SaleReturns_Day' AND object_id = OBJECT_ID('dbo.SaleReturns'))
    CREATE INDEX IX_SaleReturns_Day ON dbo.SaleReturns(TerminalId, BusinessDate);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SaleReturns_Orig' AND object_id = OBJECT_ID('dbo.SaleReturns'))
    CREATE INDEX IX_SaleReturns_Orig ON dbo.SaleReturns(OrigSaleUid);
GO

IF OBJECT_ID('dbo.SaleReturnItems', 'U') IS NULL
CREATE TABLE dbo.SaleReturnItems (
    ReturnItemId     BIGINT IDENTITY(1,1) PRIMARY KEY,
    ReturnUid        UNIQUEIDENTIFIER NOT NULL,
    [LineNo]         INT NOT NULL,                       -- the original invoice's line
    ProductId        INT NOT NULL,
    Barcode          NVARCHAR(50) NOT NULL,
    ProductName      NVARCHAR(150) NOT NULL,
    CategoryId       INT NOT NULL,
    Quantity         DECIMAL(18,3) NOT NULL,
    UnitPrice        DECIMAL(18,2) NOT NULL,
    LineTotal        DECIMAL(18,2) NOT NULL,
    LineDiscount     DECIMAL(18,2) NOT NULL,
    NetAmount        DECIMAL(18,2) NOT NULL,
    VatableAmount    DECIMAL(18,2) NOT NULL,
    VatAmount        DECIMAL(18,2) NOT NULL,
    VatExemptAmount  DECIMAL(18,2) NOT NULL,
    ZeroRatedAmount  DECIMAL(18,2) NOT NULL,
    VatAdjustment    DECIMAL(18,2) NOT NULL,
    IsVatable        BIT NOT NULL,
    IsDiscountable   BIT NOT NULL,
    CONSTRAINT UQ_SaleReturnItems UNIQUE (ReturnUid, [LineNo])
);
GO

IF TYPE_ID('dbo.TVP_ReturnItem') IS NULL
    CREATE TYPE dbo.TVP_ReturnItem AS TABLE ([LineNo] INT, Quantity DECIMAL(18,3));
GO

/* ---------- Blind close + Z-Read: returns ---------- */
IF COL_LENGTH('dbo.ShiftClosings', 'CashRefunds') IS NULL
    ALTER TABLE dbo.ShiftClosings ADD CashRefunds DECIMAL(18,2) NOT NULL CONSTRAINT DF_ShiftClosings_CashRefunds DEFAULT 0;
GO
IF COL_LENGTH('dbo.ZReads', 'ReturnCount') IS NULL
    ALTER TABLE dbo.ZReads ADD
        ReturnCount       INT NOT NULL CONSTRAINT DF_ZReads_ReturnCount DEFAULT 0,
        ReturnAmount      DECIMAL(18,2) NOT NULL CONSTRAINT DF_ZReads_ReturnAmount DEFAULT 0,
        BeginningReturnNo INT NULL,
        EndingReturnNo    INT NULL;
GO

/* ---------- Guards: numbers, totals and printed invoices can't be rewritten ---------- */
CREATE OR ALTER TRIGGER dbo.TR_Sales_Immutable ON dbo.Sales
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    IF NOT EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted)
        THROW 51100, 'A sales invoice cannot be deleted. Void it instead.', 1;
    IF EXISTS (SELECT 1 FROM inserted i JOIN deleted d ON d.SaleId = i.SaleId
               WHERE i.ORNumber <> d.ORNumber OR i.TerminalId <> d.TerminalId
                  OR i.SaleDateTime <> d.SaleDateTime OR i.GrossAmount <> d.GrossAmount
                  OR i.NetAmount <> d.NetAmount OR i.BusinessDate <> d.BusinessDate
                  OR (d.ReceiptText IS NOT NULL AND (i.ReceiptText IS NULL OR i.ReceiptText <> d.ReceiptText)))
        THROW 51101, 'A sales invoice''s number, date, amounts and printed text cannot be changed.', 1;
END
GO

CREATE OR ALTER TRIGGER dbo.TR_SaleItems_Immutable ON dbo.SaleItems
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    IF NOT EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted)
        THROW 51102, 'Sales invoice lines cannot be deleted.', 1;
    -- Only ReturnedQty may move, and only up to the quantity sold.
    IF EXISTS (SELECT 1 FROM inserted i JOIN deleted d ON d.SaleItemId = i.SaleItemId
               WHERE i.Quantity <> d.Quantity OR i.UnitPrice <> d.UnitPrice OR i.LineTotal <> d.LineTotal
                  OR i.LineDiscount <> d.LineDiscount OR i.NetAmount <> d.NetAmount
                  OR i.ReturnedQty < d.ReturnedQty OR i.ReturnedQty > i.Quantity)
        THROW 51103, 'Sales invoice lines cannot be changed.', 1;
END
GO

CREATE OR ALTER TRIGGER dbo.TR_SaleReturns_Immutable ON dbo.SaleReturns
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    IF NOT EXISTS (SELECT 1 FROM inserted) AND EXISTS (SELECT 1 FROM deleted)
        THROW 51104, 'A return transaction cannot be deleted.', 1;
    IF EXISTS (SELECT 1 FROM inserted i JOIN deleted d ON d.ReturnId = i.ReturnId
               WHERE i.ReturnNo <> d.ReturnNo OR i.TerminalId <> d.TerminalId OR i.NetAmount <> d.NetAmount
                  OR i.OrigSaleUid <> d.OrigSaleUid OR i.ReturnDateTime <> d.ReturnDateTime
                  OR (d.ReceiptText IS NOT NULL AND (i.ReceiptText IS NULL OR i.ReceiptText <> d.ReceiptText)))
        THROW 51105, 'A return transaction cannot be changed.', 1;
END
GO

CREATE OR ALTER TRIGGER dbo.TR_SaleReturnItems_Immutable ON dbo.SaleReturnItems
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    THROW 51106, 'Return transaction lines cannot be changed or deleted.', 1;
END
GO

/* Non-resettable counters: the grand total, Z counter and return counter only ever go up. */
CREATE OR ALTER TRIGGER dbo.TR_Terminals_Counters ON dbo.Terminals
AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM inserted i JOIN deleted d ON d.TerminalId = i.TerminalId
               WHERE i.GrandTotalSales < d.GrandTotalSales OR i.LastZCounter < d.LastZCounter
                  OR i.LastReturnNo < d.LastReturnNo)
        THROW 51107, 'The grand total, Z counter and return counter are non-resettable.', 1;
END
GO
