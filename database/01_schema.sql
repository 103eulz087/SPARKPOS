/* =====================================================================
   TabletPOS v2 — Full Schema (SQL Server 2019+)
   Every transactional table carries BranchCode for centralized reporting.
   Run: sqlcmd -S <server> -U sa -P <pwd> -d TabletPOS -i 01_schema.sql
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

/* ============================ MASTER ============================ */

CREATE TABLE dbo.Branches (
    BranchCode      VARCHAR(10)   NOT NULL PRIMARY KEY,
    BranchName      NVARCHAR(120) NOT NULL,
    Tin             VARCHAR(30)   NULL,
    BirBranchCode   VARCHAR(10)   NULL,
    Address         NVARCHAR(250) NULL,
    ContactNo       NVARCHAR(50)  NULL,
    IsActive        BIT NOT NULL DEFAULT 1,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME()
);

CREATE TABLE dbo.Users (
    UserId          INT IDENTITY(1,1) PRIMARY KEY,
    Username        NVARCHAR(50)  NOT NULL UNIQUE,
    PasswordHash    NVARCHAR(200) NOT NULL,
    PasswordSalt    NVARCHAR(64)  NOT NULL,
    FullName        NVARCHAR(120) NOT NULL,
    Role            VARCHAR(20)   NOT NULL CHECK (Role IN ('Cashier','Supervisor','Admin')),
    IsActive        BIT NOT NULL DEFAULT 1,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME()
);

/* Which branches a user may sign in to. Admin with no rows = all branches. */
CREATE TABLE dbo.UserBranches (
    UserId          INT NOT NULL REFERENCES dbo.Users(UserId),
    BranchCode      VARCHAR(10) NOT NULL REFERENCES dbo.Branches(BranchCode),
    PRIMARY KEY (UserId, BranchCode)
);

CREATE TABLE dbo.Categories (
    CategoryId      INT IDENTITY(1,1) PRIMARY KEY,
    CategoryName    NVARCHAR(80) NOT NULL UNIQUE,
    IsActive        BIT NOT NULL DEFAULT 1
);

/* Kitchen/beverage-style print stations (Restaurant PosType). Each has its own network
   printer target, per branch — printers are physical hardware at one location. */
CREATE TABLE dbo.PrintAreas (
    AreaId          INT IDENTITY(1,1) PRIMARY KEY,
    BranchCode      VARCHAR(10) NOT NULL REFERENCES dbo.Branches(BranchCode),
    AreaName        NVARCHAR(50) NOT NULL,
    PrinterTarget   NVARCHAR(200) NOT NULL,
    PaperWidth      INT NOT NULL DEFAULT 58,   -- mm: 58 (32 columns) or 80 (48 columns)
    PrintAgentKey   NVARCHAR(100) NULL,   -- routes Send to Kitchen's server-side print to the
                                           -- right PrintAgent — see Terminals.PrintAgentKey.
    IsActive        BIT NOT NULL DEFAULT 1,
    CONSTRAINT UQ_PrintAreas_Branch_Name UNIQUE (BranchCode, AreaName)
);

/* Server-initiated prints (Test Print, X-Read, Z-Read, Blind Close, Send to Kitchen) are
   queued here instead of being pushed directly to a PrintAgent — each agent POLLS
   GET /api/print-jobs/poll?key=<its own PrintAgentKey> instead of exposing itself to be
   called into, so no router port-forwarding or public IP is ever needed for a terminal or
   print area, regardless of where it physically sits relative to the API server. Empty/blank
   AgentKey is the shared default bucket for a single-agent setup with nothing configured. */
CREATE TABLE dbo.PrintJobs (
    PrintJobId      BIGINT IDENTITY(1,1) PRIMARY KEY,
    AgentKey        NVARCHAR(100) NOT NULL DEFAULT '',
    PrinterTarget   NVARCHAR(200) NULL,
    JobText         NVARCHAR(MAX) NOT NULL,
    Status          VARCHAR(12) NOT NULL DEFAULT 'Pending' CHECK (Status IN ('Pending','Delivered')),
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    DeliveredAt     DATETIME2 NULL
);
CREATE INDEX IX_PrintJobs_Agent_Status ON dbo.PrintJobs(AgentKey, Status, PrintJobId);

/* Categories are global (shared catalog across branches, see dbo.Categories above), but
   which printer a category routes to is a per-branch physical fact — the same "Beverages"
   category can point at a different printer at each branch. No row for a category at a
   branch = it isn't sent to any kitchen printer there (e.g. a retail add-on needing no prep). */
CREATE TABLE dbo.CategoryPrintAreas (
    BranchCode      VARCHAR(10) NOT NULL REFERENCES dbo.Branches(BranchCode),
    CategoryId      INT NOT NULL REFERENCES dbo.Categories(CategoryId),
    AreaId          INT NOT NULL REFERENCES dbo.PrintAreas(AreaId),
    CONSTRAINT PK_CategoryPrintAreas PRIMARY KEY (BranchCode, CategoryId)
);

/* ONE base price per product. Branch differences live in ProductPrices. */
CREATE TABLE dbo.Products (
    ProductId       INT IDENTITY(1,1) PRIMARY KEY,
    Barcode         NVARCHAR(50)  NOT NULL UNIQUE,
    ProductName     NVARCHAR(150) NOT NULL,
    CategoryId      INT NOT NULL REFERENCES dbo.Categories(CategoryId),
    Unit            NVARCHAR(20)  NOT NULL DEFAULT 'pc',
    BasePrice       DECIMAL(18,2) NOT NULL,
    Cost            DECIMAL(18,2) NOT NULL DEFAULT 0,
    IsVatable       BIT NOT NULL DEFAULT 1,
    IsDiscountable  BIT NOT NULL DEFAULT 1,   -- eligible for SC/PWD/NAAC/MOV/SOLO
    AllowPriceEdit  BIT NOT NULL DEFAULT 0,
    IsActive        BIT NOT NULL DEFAULT 1,
    ImageUrl        NVARCHAR(255) NULL,   -- thumbnail shown on the POS product grid
    RowVersionTs    DATETIME2 NOT NULL DEFAULT SYSDATETIME()
);
CREATE INDEX IX_Products_RowVersionTs ON dbo.Products(RowVersionTs);

/* Sparse override table — a row exists only where a branch differs from base. */
CREATE TABLE dbo.ProductPrices (
    ProductId       INT NOT NULL REFERENCES dbo.Products(ProductId),
    BranchCode      VARCHAR(10) NOT NULL REFERENCES dbo.Branches(BranchCode),
    Price           DECIMAL(18,2) NOT NULL,
    EffectiveDate   DATE NOT NULL DEFAULT CAST(SYSDATETIME() AS DATE),
    UpdatedBy       INT NULL,
    UpdatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    PRIMARY KEY (ProductId, BranchCode)
);

/* POS terminal + its BIR registration (one permit per physical machine) */
CREATE TABLE dbo.Terminals (
    TerminalId      INT IDENTITY(1,1) PRIMARY KEY,
    BranchCode      VARCHAR(10) NOT NULL REFERENCES dbo.Branches(BranchCode),
    TerminalCode    VARCHAR(20) NOT NULL,
    TerminalName    NVARCHAR(80) NOT NULL,
    PrinterTarget   NVARCHAR(200) NULL,        -- tcp://ip:9100 | file://COM3 | spool://XP-80C
    PaperWidth      INT NOT NULL DEFAULT 58,   -- mm: 58 (32 columns) or 80 (48 columns)
    PrintAgentKey   NVARCHAR(100) NULL,   -- routes server-initiated prints (Test Print, X-Read,
                                           -- Z-Read, Blind Close) to the right PrintAgent — it
                                           -- polls dbo.PrintJobs for this key instead of being
                                           -- called into, so no router/firewall config is ever
                                           -- needed. NULL/blank = the shared default agent.
    -- BIR registration
    Tin             VARCHAR(30)  NULL,
    AccreditationNo VARCHAR(60)  NULL,
    SerialNo        VARCHAR(60)  NULL,
    PermitNo        VARCHAR(60)  NULL,
    MinNo           VARCHAR(60)  NULL,
    PermitEffective DATE         NULL,
    -- running accumulators (BIR grand total)
    GrandTotalSales DECIMAL(18,2) NOT NULL DEFAULT 0,
    LastZCounter    INT NOT NULL DEFAULT 0,
    IsActive        BIT NOT NULL DEFAULT 1,
    CONSTRAINT UQ_Terminal UNIQUE (BranchCode, TerminalCode)
);

/* Dine-in tables — only meaningful for PosSettings.PosType = 'Restaurant'. */
CREATE TABLE dbo.Tables (
    TableId         INT IDENTITY(1,1) PRIMARY KEY,
    BranchCode      VARCHAR(10) NOT NULL REFERENCES dbo.Branches(BranchCode),
    TableNumber     NVARCHAR(20) NOT NULL,
    Capacity        INT NOT NULL DEFAULT 4,
    IsActive        BIT NOT NULL DEFAULT 1,
    CONSTRAINT UQ_Tables_Branch_Number UNIQUE (BranchCode, TableNumber)
);

/* Per-branch behaviour flags */
CREATE TABLE dbo.PosSettings (
    BranchCode          VARCHAR(10) NOT NULL PRIMARY KEY REFERENCES dbo.Branches(BranchCode),
    PosType             VARCHAR(20) NOT NULL DEFAULT 'Retail'
                        CHECK (PosType IN ('Retail','Restaurant','Pharmacy')),
    VoidOverride        BIT NOT NULL DEFAULT 1,
    PriceEditOverride   BIT NOT NULL DEFAULT 0,
    ReprintOverride     BIT NOT NULL DEFAULT 0,
    EodOverride         BIT NOT NULL DEFAULT 1,
    EmailOnBlindClose   BIT NOT NULL DEFAULT 0,   -- shift-close report emailed to admin recipients
    RefundEnabled       BIT NOT NULL DEFAULT 1,
    BlockLoginAfterEod  BIT NOT NULL DEFAULT 1,
    OrBlockSize         INT NOT NULL DEFAULT 500,
    OrLowWarning        INT NOT NULL DEFAULT 25,
    MaxDiscountPerTxn   DECIMAL(18,2) NOT NULL DEFAULT 0,   -- 0 = no cap
    StoreHeader1        NVARCHAR(60) NULL,
    StoreHeader2        NVARCHAR(60) NULL,
    ReceiptFooter       NVARCHAR(1000) NULL   -- multi-line: BIR accreditation block etc.
);

CREATE TABLE dbo.DiscountTypes (
    DiscountCode    VARCHAR(10) NOT NULL PRIMARY KEY,
    Description     NVARCHAR(80) NOT NULL,
    Rate            DECIMAL(5,4) NOT NULL,     -- 0.2000 = 20%  (default/fallback rate)
    IsVatExempt     BIT NOT NULL DEFAULT 1,    -- default/fallback: does this rate remove VAT entirely?
    LegalBasis      NVARCHAR(40) NULL,
    IsActive        BIT NOT NULL DEFAULT 1
);

/* Per-category override of a discount type's rate/VAT treatment — e.g. under RA 9994,
   Senior Citizen is 20% + fully VAT-exempt on medicine, but only 5% + still-VATable
   (with a VAT adjustment) on groceries/prime commodities. No row for a category means
   "use DiscountTypes' own default Rate/IsVatExempt" — most categories won't need one. */
CREATE TABLE dbo.DiscountCategoryRates (
    DiscountCode    VARCHAR(10) NOT NULL REFERENCES dbo.DiscountTypes(DiscountCode),
    CategoryId      INT NOT NULL REFERENCES dbo.Categories(CategoryId),
    Rate            DECIMAL(5,4) NOT NULL,
    IsVatExempt     BIT NOT NULL DEFAULT 1,
    CONSTRAINT PK_DiscountCategoryRates PRIMARY KEY (DiscountCode, CategoryId)
);

/* Pre-allocated OR blocks — lets a terminal keep selling offline */
CREATE TABLE dbo.ORRanges (
    ORRangeId       INT IDENTITY(1,1) PRIMARY KEY,
    BranchCode      VARCHAR(10) NOT NULL,
    TerminalId      INT NOT NULL REFERENCES dbo.Terminals(TerminalId),
    RangeStart      BIGINT NOT NULL,
    RangeEnd        BIGINT NOT NULL,
    AllocatedAt     DATETIME2 NOT NULL DEFAULT SYSDATETIME()
);

/* ============================ TRANSACTIONAL ============================ */

CREATE TABLE dbo.Shifts (
    ShiftId         INT IDENTITY(1,1) PRIMARY KEY,
    ShiftUid        UNIQUEIDENTIFIER NOT NULL UNIQUE,
    BranchCode      VARCHAR(10) NOT NULL,
    TerminalId      INT NOT NULL REFERENCES dbo.Terminals(TerminalId),
    CashierUserId   INT NOT NULL REFERENCES dbo.Users(UserId),
    BusinessDate    DATE NOT NULL,
    CashBegin       DECIMAL(18,2) NOT NULL,
    OpenedAt        DATETIME2 NOT NULL,
    ClosedAt        DATETIME2 NULL,
    Status          VARCHAR(15) NOT NULL DEFAULT 'Open'
                    CHECK (Status IN ('Open','BlindClosed','Locked'))
);
CREATE INDEX IX_Shifts_Term_Date ON dbo.Shifts(TerminalId, BusinessDate, Status);

CREATE TABLE dbo.Sales (
    SaleId          BIGINT IDENTITY(1,1) PRIMARY KEY,
    SaleUid         UNIQUEIDENTIFIER NOT NULL UNIQUE,   -- idempotency key
    ShiftUid        UNIQUEIDENTIFIER NOT NULL,
    BranchCode      VARCHAR(10) NOT NULL,
    TerminalId      INT NOT NULL,
    CashierUserId   INT NOT NULL,
    ORNumber        BIGINT NOT NULL,
    BusinessDate    DATE NOT NULL,
    SaleDateTime    DATETIME2 NOT NULL,
    GrossAmount     DECIMAL(18,2) NOT NULL,
    DiscountAmount  DECIMAL(18,2) NOT NULL DEFAULT 0,
    VatExemptAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
    VatableAmount   DECIMAL(18,2) NOT NULL DEFAULT 0,
    VatAmount       DECIMAL(18,2) NOT NULL DEFAULT 0,
    ZeroRatedAmount DECIMAL(18,2) NOT NULL DEFAULT 0,
    NetAmount       DECIMAL(18,2) NOT NULL,
    TenderedAmount  DECIMAL(18,2) NOT NULL,
    ChangeAmount    DECIMAL(18,2) NOT NULL,
    DiscountCode    VARCHAR(10)  NULL,
    DiscountCtrlNo  NVARCHAR(60) NULL,
    DiscountName    NVARCHAR(120) NULL,
    VatAdjustment   DECIMAL(18,2) NOT NULL DEFAULT 0,  -- reporting-only: VAT forgone on lines
                                                        -- discounted but still VATable (not
                                                        -- a further cash deduction — see CLAUDE.md)
    DinerCount      INT NULL,   -- Restaurant PosType only: pax count entered at Generate Bill
    SeniorCount     INT NULL,   -- Restaurant PosType only: how many of DinerCount are SC/PWD
    Status          VARCHAR(12) NOT NULL DEFAULT 'Completed'
                    CHECK (Status IN ('Completed','Voided','Returned')),
    VoidedBy        INT NULL,
    VoidedAt        DATETIME2 NULL,
    VoidReason      NVARCHAR(200) NULL,
    SyncedAt        DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT UQ_Sales_OR UNIQUE (TerminalId, ORNumber)
);
CREATE INDEX IX_Sales_Shift  ON dbo.Sales(ShiftUid);
CREATE INDEX IX_Sales_Report ON dbo.Sales(BranchCode, BusinessDate, Status);

CREATE TABLE dbo.SaleItems (
    SaleItemId      BIGINT IDENTITY(1,1) PRIMARY KEY,
    SaleUid         UNIQUEIDENTIFIER NOT NULL,
    BranchCode      VARCHAR(10) NOT NULL,
    LineNo          INT NOT NULL,
    ProductId       INT NOT NULL,
    Barcode         NVARCHAR(50) NOT NULL,
    ProductName     NVARCHAR(150) NOT NULL,
    CategoryId      INT NOT NULL,
    Quantity        DECIMAL(18,3) NOT NULL,
    UnitPrice       DECIMAL(18,2) NOT NULL,
    OrigUnitPrice   DECIMAL(18,2) NOT NULL,
    LineDiscount    DECIMAL(18,2) NOT NULL DEFAULT 0,   -- per-item discount
    LineTotal       DECIMAL(18,2) NOT NULL,
    IsVatable       BIT NOT NULL DEFAULT 1,
    IsDiscountable  BIT NOT NULL DEFAULT 1,
    CONSTRAINT UQ_SaleItems UNIQUE (SaleUid, LineNo)
);
CREATE INDEX IX_SaleItems_Sale ON dbo.SaleItems(SaleUid);

/* A dine-in tab — items get added over possibly several rounds before Generate
   Bill hands the accumulated items to the normal checkout flow, which creates the
   actual Sales row. Only one 'Open' row per table is enforced by the filtered
   unique index below — OrdersController.Open() also pre-checks, but that check
   alone races under concurrent taps on the same table. */
CREATE TABLE dbo.OpenOrders (
    OpenOrderUid    UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    TableId         INT NOT NULL REFERENCES dbo.Tables(TableId),
    BranchCode      VARCHAR(10) NOT NULL,
    TerminalId      INT NOT NULL,
    ShiftUid        UNIQUEIDENTIFIER NOT NULL,
    OpenedByUserId  INT NOT NULL,
    OpenedAt        DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    Status          VARCHAR(12) NOT NULL DEFAULT 'Open' CHECK (Status IN ('Open','Billed','Voided')),
    ClosedAt        DATETIME2 NULL,
    SaleUid         UNIQUEIDENTIFIER NULL   -- set once billed — links to the resulting Sales row
);
CREATE INDEX IX_OpenOrders_Table ON dbo.OpenOrders(TableId, Status);
CREATE UNIQUE INDEX UQ_OpenOrders_OneOpenPerTable ON dbo.OpenOrders(TableId) WHERE Status = 'Open';

CREATE TABLE dbo.OpenOrderItems (
    OpenOrderItemId BIGINT IDENTITY(1,1) PRIMARY KEY,
    OpenOrderUid    UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.OpenOrders(OpenOrderUid),
    LineNo          INT NOT NULL,
    ProductId       INT NOT NULL,
    Barcode         NVARCHAR(50) NOT NULL,
    ProductName     NVARCHAR(150) NOT NULL,
    CategoryId      INT NOT NULL,
    Quantity        DECIMAL(18,3) NOT NULL,
    UnitPrice       DECIMAL(18,2) NOT NULL,
    IsVatable       BIT NOT NULL DEFAULT 1,
    IsDiscountable  BIT NOT NULL DEFAULT 1,
    SentQuantity    DECIMAL(18,3) NOT NULL DEFAULT 0,   -- how much of Quantity Send to Kitchen has already printed
    AddedAt         DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT UQ_OpenOrderItems UNIQUE (OpenOrderUid, LineNo)
);
CREATE INDEX IX_OpenOrderItems_Order ON dbo.OpenOrderItems(OpenOrderUid);

/* Split tender: one row per payment on a sale */
CREATE TABLE dbo.SalePayments (
    PaymentId       BIGINT IDENTITY(1,1) PRIMARY KEY,
    SaleUid         UNIQUEIDENTIFIER NOT NULL,
    BranchCode      VARCHAR(10) NOT NULL,
    SeqNo           INT NOT NULL,
    PaymentType     VARCHAR(10) NOT NULL CHECK (PaymentType IN ('CASH','CARD')),
    Amount          DECIMAL(18,2) NOT NULL,
    CardNo          NVARCHAR(30)  NULL,     -- store masked only
    CardBank        NVARCHAR(60)  NULL,
    CardRefNo       NVARCHAR(60)  NULL,
    CardName        NVARCHAR(120) NULL,
    CONSTRAINT UQ_SalePayments UNIQUE (SaleUid, SeqNo)
);
CREATE INDEX IX_SalePayments_Sale ON dbo.SalePayments(SaleUid);

CREATE TABLE dbo.ShiftClosings (
    ClosingId       INT IDENTITY(1,1) PRIMARY KEY,
    ShiftUid        UNIQUEIDENTIFIER NOT NULL UNIQUE,
    BranchCode      VARCHAR(10) NOT NULL,
    DeclaredCash    DECIMAL(18,2) NOT NULL,
    ExpectedCash    DECIMAL(18,2) NOT NULL,
    CashSales       DECIMAL(18,2) NOT NULL DEFAULT 0,
    CardSales       DECIMAL(18,2) NOT NULL DEFAULT 0,
    ShortOver       DECIMAL(18,2) NOT NULL,
    DenominationsJson NVARCHAR(MAX) NOT NULL,
    ClosedAt        DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    VerifiedBy      INT NULL,
    VerifiedAt      DATETIME2 NULL
);

/* End of Day / Z-Read — one row per terminal per business date */
CREATE TABLE dbo.ZReads (
    ZReadId         INT IDENTITY(1,1) PRIMARY KEY,
    BranchCode      VARCHAR(10) NOT NULL,
    TerminalId      INT NOT NULL,
    BusinessDate    DATE NOT NULL,
    ZCounter        INT NOT NULL,
    GrossSales      DECIMAL(18,2) NOT NULL,
    TotalDiscounts  DECIMAL(18,2) NOT NULL,
    NetSales        DECIMAL(18,2) NOT NULL,
    VatableAmount   DECIMAL(18,2) NOT NULL,
    VatAmount       DECIMAL(18,2) NOT NULL,
    VatExemptAmount DECIMAL(18,2) NOT NULL,
    ZeroRatedAmount DECIMAL(18,2) NOT NULL,
    CashSales       DECIMAL(18,2) NOT NULL,
    CardSales       DECIMAL(18,2) NOT NULL,
    DiscSenior      DECIMAL(18,2) NOT NULL DEFAULT 0,
    DiscPwd         DECIMAL(18,2) NOT NULL DEFAULT 0,
    DiscNaac        DECIMAL(18,2) NOT NULL DEFAULT 0,
    DiscMov         DECIMAL(18,2) NOT NULL DEFAULT 0,
    DiscSolo        DECIMAL(18,2) NOT NULL DEFAULT 0,
    TxnCount        INT NOT NULL,
    VoidCount       INT NOT NULL,
    VoidAmount      DECIMAL(18,2) NOT NULL DEFAULT 0,
    BeginningOR     BIGINT NULL,
    EndingOR        BIGINT NULL,
    OldGrandTotal   DECIMAL(18,2) NOT NULL DEFAULT 0,
    NewGrandTotal   DECIMAL(18,2) NOT NULL DEFAULT 0,
    ClosedByUserId  INT NOT NULL,
    ApprovedByUserId INT NOT NULL,
    Remarks         NVARCHAR(200) NULL,
    GeneratedAt     DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT UQ_ZRead UNIQUE (TerminalId, BusinessDate)
);

CREATE TABLE dbo.AuditLogs (
    AuditId         BIGINT IDENTITY(1,1) PRIMARY KEY,
    BranchCode      VARCHAR(10) NULL,
    UserId          INT NULL,
    TerminalId      INT NULL,
    Action          VARCHAR(40) NOT NULL,
    Detail          NVARCHAR(MAX) NULL,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME()
);
CREATE INDEX IX_Audit_Date ON dbo.AuditLogs(CreatedAt);

CREATE TABLE dbo.EmailConfig (
    ConfigId        INT IDENTITY(1,1) PRIMARY KEY,
    BranchCode      VARCHAR(10) NULL,       -- NULL = global default
    SmtpHost        NVARCHAR(120) NOT NULL,
    SmtpPort        INT NOT NULL DEFAULT 587,
    SmtpUser        NVARCHAR(120) NOT NULL,
    SmtpPassword    NVARCHAR(200) NOT NULL,
    FromAddress     NVARCHAR(120) NOT NULL,
    ToAddresses     NVARCHAR(500) NOT NULL,
    EnableSsl       BIT NOT NULL DEFAULT 1,
    SendOnEod       BIT NOT NULL DEFAULT 1,
    IsActive        BIT NOT NULL DEFAULT 1
);
GO

/* ============================ TVPs ============================ */
CREATE TYPE dbo.TVP_SaleItem AS TABLE (
    LineNo INT, ProductId INT, Barcode NVARCHAR(50), ProductName NVARCHAR(150),
    CategoryId INT, Quantity DECIMAL(18,3), UnitPrice DECIMAL(18,2),
    OrigUnitPrice DECIMAL(18,2), LineDiscount DECIMAL(18,2), LineTotal DECIMAL(18,2),
    IsVatable BIT, IsDiscountable BIT
);
GO

CREATE TYPE dbo.TVP_SalePayment AS TABLE (
    SeqNo INT, PaymentType VARCHAR(10), Amount DECIMAL(18,2),
    CardNo NVARCHAR(30), CardBank NVARCHAR(60), CardRefNo NVARCHAR(60), CardName NVARCHAR(120)
);
GO

CREATE TYPE dbo.TVP_BranchPrice AS TABLE (
    BranchCode VARCHAR(10), Price DECIMAL(18,2)
);
GO
