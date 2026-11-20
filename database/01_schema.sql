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
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    -- ERP users (20_erp_users.sql): synced from the CORECS ERP; NULL ErpUserId = local user
    ErpUserId             VARCHAR(50)   NULL,
    ErpPasswordHash       VARBINARY(64) NULL,
    ErpPasswordSalt       VARBINARY(64) NULL,
    ErpPasswordIterations INT           NULL,
    ErpPasswordAlgo       TINYINT       NULL,
    MustChangePassword    BIT NOT NULL CONSTRAINT DF_Users_MustChangePassword DEFAULT 0,
    ErpSyncedAt           DATETIME2     NULL,
    FailedLogins          INT NOT NULL CONSTRAINT DF_Users_FailedLogins DEFAULT 0,
    LockedUntil           DATETIME2     NULL
);
CREATE UNIQUE INDEX UQ_Users_ErpUserId ON dbo.Users(ErpUserId) WHERE ErpUserId IS NOT NULL;

/* Which branches a user may sign in to. Admin with no rows = all branches. */
CREATE TABLE dbo.UserBranches (
    UserId          INT NOT NULL REFERENCES dbo.Users(UserId),
    BranchCode      VARCHAR(10) NOT NULL REFERENCES dbo.Branches(BranchCode),
    PRIMARY KEY (UserId, BranchCode)
);

CREATE TABLE dbo.Categories (
    CategoryId      INT IDENTITY(1,1) PRIMARY KEY,
    CategoryName    NVARCHAR(80) NOT NULL UNIQUE,
    IsActive        BIT NOT NULL DEFAULT 1,
    ErpCategoryId   INT NULL   -- CORECS ERP ProductCategoryID; NULL = local-only (17_erp_master_data.sql)
);
CREATE UNIQUE INDEX UQ_Categories_ErpCategoryId ON dbo.Categories(ErpCategoryId) WHERE ErpCategoryId IS NOT NULL;

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
    RowVersionTs    DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    ErpProductCode  VARCHAR(50) NULL   -- CORECS ERP ProductCode; NULL = local-only (17_erp_master_data.sql),
    Price1 DECIMAL(18,2) NULL, Price2 DECIMAL(18,2) NULL,   -- head office's ERP price levels (31_price_levels.sql)
    Price3 DECIMAL(18,2) NULL, Price4 DECIMAL(18,2) NULL
);
CREATE INDEX IX_Products_RowVersionTs ON dbo.Products(RowVersionTs);
CREATE UNIQUE INDEX UQ_Products_ErpProductCode ON dbo.Products(ErpProductCode) WHERE ErpProductCode IS NOT NULL;

/* Sparse override table — a row exists only where a branch differs from base. */
CREATE TABLE dbo.ProductPrices (
    ProductId       INT NOT NULL REFERENCES dbo.Products(ProductId),
    BranchCode      VARCHAR(10) NOT NULL REFERENCES dbo.Branches(BranchCode),
    Price           DECIMAL(18,2) NOT NULL,
    EffectiveDate   DATE NOT NULL DEFAULT CAST(SYSDATETIME() AS DATE),
    UpdatedBy       INT NULL,
    UpdatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    Price1 DECIMAL(18,2) NULL, Price2 DECIMAL(18,2) NULL,   -- the branch's ERP price levels (31_price_levels.sql)
    Price3 DECIMAL(18,2) NULL, Price4 DECIMAL(18,2) NULL,
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
    AccreditationDate   DATE NULL,             -- 25: required when sent to the ERP
    PermitValidUntil    DATE NULL,             -- PTU end (optional)
    BirRegTransactionNo VARCHAR(60) NULL,
    BirApplicationDate  DATE NULL,
    ErpInfoStatus       VARCHAR(10) NULL,      -- last send to the ERP: Sent / Failed
    ErpInfoResult       VARCHAR(20) NULL,      -- CREATED / UPDATED / UNCHANGED
    ErpInfoError        NVARCHAR(400) NULL,
    ErpInfoSentAt       DATETIME2 NULL,
    -- running accumulators: non-resettable (TR_Terminals_Counters). GrandTotalSales
    -- DECIMAL(18,2) tops out at 9,999,999,999,999,999.99 (BIR: 18 digits incl. 2 decimals).
    GrandTotalSales DECIMAL(18,2) NOT NULL DEFAULT 0,
    LastZCounter    INT NOT NULL DEFAULT 0,
    LastReturnNo    INT NOT NULL CONSTRAINT DF_Terminals_LastReturnNo DEFAULT 0,  -- 6-digit return counter
    IsActive        BIT NOT NULL DEFAULT 1,
    -- posting to the CORECS ERP (22_erp_posting.sql); PostToErp = 0 = shadow mode
    ErpTerminalCode VARCHAR(10) NULL,
    PostToErp       BIT NOT NULL CONSTRAINT DF_Terminals_PostToErp DEFAULT 0,
    -- 29: this terminal's own POS type; NULL = the branch's PosSettings.PosType
    PosType         VARCHAR(20) NULL
                    CONSTRAINT CK_Terminals_PosType CHECK (PosType IS NULL OR PosType IN ('Retail','Restaurant','Pharmacy')),
    -- 37: the till's screen; NULL = Touch (product grid), 'Grocery' = the grocery lane (list + F-keys)
    ScreenLayout    VARCHAR(10) NULL
                    CONSTRAINT CK_Terminals_ScreenLayout CHECK (ScreenLayout IS NULL OR ScreenLayout IN ('Grocery')),
    CONSTRAINT UQ_Terminal UNIQUE (BranchCode, TerminalCode),
    CONSTRAINT CK_Terminals_LastReturnNo CHECK (LastReturnNo BETWEEN 0 AND 999999),
    CONSTRAINT CK_Terminals_ErpTerminalCode
        CHECK (ErpTerminalCode IS NULL OR (ErpTerminalCode LIKE 'SP-_%' AND ErpTerminalCode = UPPER(ErpTerminalCode))),
    CONSTRAINT CK_Terminals_PostToErp CHECK (PostToErp = 0 OR (ErpTerminalCode IS NOT NULL AND MinNo IS NOT NULL))
);
CREATE UNIQUE INDEX UQ_Terminals_ErpTerminalCode ON dbo.Terminals(BranchCode, ErpTerminalCode) WHERE ErpTerminalCode IS NOT NULL;

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
    WholesaleOn         BIT NOT NULL CONSTRAINT DF_PosSettings_WholesaleOn DEFAULT 1,   -- 33: wholesale prices at this branch
    VoidOverride        BIT NOT NULL DEFAULT 1,
    PriceEditOverride   BIT NOT NULL DEFAULT 0,
    ReprintOverride     BIT NOT NULL DEFAULT 0,
    EodOverride         BIT NOT NULL DEFAULT 1,
    CancelLineOverride  BIT NOT NULL CONSTRAINT DF_PosSettings_CancelLineOverride DEFAULT 0,   -- 35: removing a cart line
    XReadOverride       BIT NOT NULL CONSTRAINT DF_PosSettings_XReadOverride DEFAULT 0,        -- 35
    DiscountOverride    BIT NOT NULL CONSTRAINT DF_PosSettings_DiscountOverride DEFAULT 0,     -- 35: SC/PWD/NAAC/MOV/Solo
    PriceLevelOverride  BIT NOT NULL CONSTRAINT DF_PosSettings_PriceLevelOverride DEFAULT 0,   -- 36: Price 1..4 at the till
    GiftCertOn      BIT NOT NULL CONSTRAINT DF_PosSettings_GiftCertOn DEFAULT 0,   -- 38: the branch takes gift certificates
    OpenDrawerOverride BIT NOT NULL CONSTRAINT DF_PosSettings_OpenDrawerOverride DEFAULT 0,   -- 39: opening the drawer with no sale
    EmailOnBlindClose   BIT NOT NULL DEFAULT 0,   -- shift-close report emailed to admin recipients
    RefundEnabled       BIT NOT NULL DEFAULT 1,   -- return transactions allowed at all
    ReturnOverride      BIT NOT NULL CONSTRAINT DF_PosSettings_ReturnOverride DEFAULT 1,
    BlockLoginAfterEod  BIT NOT NULL DEFAULT 1,
    OrBlockSize         INT NOT NULL DEFAULT 500,
    OrLowWarning        INT NOT NULL DEFAULT 25,
    MaxDiscountPerTxn   DECIMAL(18,2) NOT NULL DEFAULT 0,   -- 0 = no cap
    -- weighing-scale stickers (21_scale_barcodes.sql): prefix + code + weight + check digit
    ScaleBarcodePrefix  VARCHAR(20) NULL,      -- e.g. '25' or '20,25'; NULL/blank = off
    ScaleCodeLength     INT NOT NULL CONSTRAINT DF_PosSettings_ScaleCodeLength DEFAULT 5,
    ScaleQtyLength      INT NOT NULL CONSTRAINT DF_PosSettings_ScaleQtyLength DEFAULT 5,
    ScaleQtyDecimals    INT NOT NULL CONSTRAINT DF_PosSettings_ScaleQtyDecimals DEFAULT 3,
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

/* A discount type's rate per POS type, and if needed per POS type + category
   (32_discount_pos_type.sql). First match wins for a line: POS type + category, then
   DiscountCategoryRates (any POS type), then POS type (CategoryId NULL), then DiscountTypes. */
CREATE TABLE dbo.DiscountPosTypeRates (
    RateId       INT IDENTITY(1,1) CONSTRAINT PK_DiscountPosTypeRates PRIMARY KEY,
    DiscountCode VARCHAR(10) NOT NULL REFERENCES dbo.DiscountTypes(DiscountCode),
    PosType      VARCHAR(20) NOT NULL CONSTRAINT CK_DiscountPosTypeRates_PosType CHECK (PosType IN ('Retail', 'Restaurant', 'Pharmacy')),
    CategoryId   INT NULL REFERENCES dbo.Categories(CategoryId),   -- NULL = every category at this POS type
    Rate         DECIMAL(5,4) NOT NULL CONSTRAINT CK_DiscountPosTypeRates_Rate CHECK (Rate BETWEEN 0 AND 1),
    IsVatExempt  BIT NOT NULL,
    UpdatedAt    DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    UpdatedBy    INT NULL
);
CREATE UNIQUE INDEX UQ_DiscountPosTypeRates ON dbo.DiscountPosTypeRates (DiscountCode, PosType, CategoryId);

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
    ORNumber        BIGINT NOT NULL,   -- the BIR Sales Invoice No.: 18 digits, per terminal, gap-free
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
    CustomerName          NVARCHAR(150) NULL,   -- printed on the invoice (BIR)
    CustomerAddress       NVARCHAR(250) NULL,
    CustomerTin           VARCHAR(20)   NULL,
    CustomerBusinessStyle NVARCHAR(150) NULL,
    CustomerEmail         NVARCHAR(254) NULL,   -- where the e-invoice copy goes (not printed)
    LoyaltyCardId   INT NULL,                   -- the suki card the sale was rung up with (26_loyalty.sql)
    ZeroRatedCertNo NVARCHAR(50) NULL,          -- a zero-rated buyer's PEZA/BOI cert or diplomatic ID (28_zero_rated_sales.sql)
    ZeroRatedApprovedBy INT NULL,               -- the supervisor who approved the zero-rating
    DiscountApprovedBy  INT NULL,               -- the supervisor who approved a regular/other discount (30_other_discount.sql)
    PriceLevel      TINYINT NULL CONSTRAINT CK_Sales_PriceLevel CHECK (PriceLevel BETWEEN 1 AND 4),  -- 31: Price1..4 used; NULL = SellingPrice
    DiscountCap     DECIMAL(18,2) NULL,         -- 32: the SC/PWD discount limited to the booklet's weekly cap (approver in DiscountApprovedBy)
    WholesaleRemovedBy INT NULL,                -- 33: the supervisor who took the wholesale price off this sale
    PromoAmount     DECIMAL(18,2) NOT NULL CONSTRAINT DF_Sales_PromoAmount DEFAULT 0,   -- 34: promo total, part of DiscountAmount
    ReceiptText     NVARCHAR(MAX) NULL,         -- the invoice exactly as printed; reprints use it
    SyncedAt        DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT UQ_Sales_OR UNIQUE (TerminalId, ORNumber),
    CONSTRAINT CK_Sales_SINo CHECK (ORNumber BETWEEN 1 AND 999999999999999999)
);
CREATE INDEX IX_Sales_Shift  ON dbo.Sales(ShiftUid);
CREATE INDEX IX_Sales_Report ON dbo.Sales(BranchCode, BusinessDate, Status);

CREATE TABLE dbo.SaleItems (
    SaleItemId      BIGINT IDENTITY(1,1) PRIMARY KEY,
    SaleUid         UNIQUEIDENTIFIER NOT NULL,
    BranchCode      VARCHAR(10) NOT NULL,
    [LineNo]        INT NOT NULL,
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
    -- per-line BIR breakdown from computeTotals() (store.js); returns refund from these
    NetAmount       DECIMAL(18,2) NOT NULL CONSTRAINT DF_SaleItems_NetAmount DEFAULT 0,
    VatableAmount   DECIMAL(18,2) NOT NULL CONSTRAINT DF_SaleItems_VatableAmount DEFAULT 0,
    VatAmount       DECIMAL(18,2) NOT NULL CONSTRAINT DF_SaleItems_VatAmount DEFAULT 0,
    VatExemptAmount DECIMAL(18,2) NOT NULL CONSTRAINT DF_SaleItems_VatExemptAmount DEFAULT 0,
    ZeroRatedAmount DECIMAL(18,2) NOT NULL CONSTRAINT DF_SaleItems_ZeroRatedAmount DEFAULT 0,
    VatAdjustment   DECIMAL(18,2) NOT NULL CONSTRAINT DF_SaleItems_VatAdjustment DEFAULT 0,
    ReturnedQty     DECIMAL(18,3) NOT NULL CONSTRAINT DF_SaleItems_ReturnedQty DEFAULT 0,
    PriceApprovedBy INT NULL,   -- who OK'd a price change on this line (19_erp_prices.sql)
    CONSTRAINT UQ_SaleItems UNIQUE (SaleUid, [LineNo])
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
    [LineNo]        INT NOT NULL,
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
    CONSTRAINT UQ_OpenOrderItems UNIQUE (OpenOrderUid, [LineNo])
);
CREATE INDEX IX_OpenOrderItems_Order ON dbo.OpenOrderItems(OpenOrderUid);

/* Split tender: one row per payment on a sale */
CREATE TABLE dbo.SalePayments (
    PaymentId       BIGINT IDENTITY(1,1) PRIMARY KEY,
    SaleUid         UNIQUEIDENTIFIER NOT NULL,
    BranchCode      VARCHAR(10) NOT NULL,
    SeqNo           INT NOT NULL,
    PaymentType     VARCHAR(10) NOT NULL CONSTRAINT CK_SalePayments_Type CHECK (PaymentType IN ('CASH','CARD','GC')),
    Amount          DECIMAL(18,2) NOT NULL,
    CardNo          NVARCHAR(30)  NULL,     -- store masked only
    CardBank        NVARCHAR(60)  NULL,
    CardRefNo       NVARCHAR(60)  NULL,
    CardName        NVARCHAR(120) NULL,
    GcNo            NVARCHAR(30)  NULL,     -- 38: a gift certificate's number
    GcValue         DECIMAL(18,2) NULL,     -- 38: its face value (Amount = what it paid; the rest is forfeited)
    GcCheck         VARCHAR(10)   NULL,     -- 38: OK / UNKNOWN / USED / EXPIRED / CANCELLED / BRANCH / VALUE at sync
    CONSTRAINT UQ_SalePayments UNIQUE (SaleUid, SeqNo)
);
CREATE INDEX IX_SalePayments_Sale ON dbo.SalePayments(SaleUid);
CREATE INDEX IX_SalePayments_GcNo ON dbo.SalePayments(GcNo) WHERE GcNo IS NOT NULL;

/* 38: gift certificates SparkPOS accepts as payment, registered by head office in Admin. One use
   each (Active → Redeemed at the sale's sync; a void puts it back). */
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

CREATE TABLE dbo.ShiftClosings (
    ClosingId       INT IDENTITY(1,1) PRIMARY KEY,
    ShiftUid        UNIQUEIDENTIFIER NOT NULL UNIQUE,
    BranchCode      VARCHAR(10) NOT NULL,
    DeclaredCash    DECIMAL(18,2) NOT NULL,
    ExpectedCash    DECIMAL(18,2) NOT NULL,
    CashSales       DECIMAL(18,2) NOT NULL DEFAULT 0,
    CardSales       DECIMAL(18,2) NOT NULL DEFAULT 0,
    ShortOver       DECIMAL(18,2) NOT NULL,
    CashRefunds     DECIMAL(18,2) NOT NULL CONSTRAINT DF_ShiftClosings_CashRefunds DEFAULT 0,  -- return transactions
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
    DiscOther       DECIMAL(18,2) NOT NULL CONSTRAINT DF_ZReads_DiscOther DEFAULT 0,  -- 30: regular/other discounts
    DiscPromo       DECIMAL(18,2) NOT NULL CONSTRAINT DF_ZReads_DiscPromo DEFAULT 0,  -- 34: promos (Buy N Take M)
    GcSales         DECIMAL(18,2) NOT NULL CONSTRAINT DF_ZReads_GcSales DEFAULT 0,    -- 38: gift certificate payments
    DrawerOpens     INT NOT NULL CONSTRAINT DF_ZReads_DrawerOpens DEFAULT 0,          -- 39: drawer opened with no sale
    TxnCount        INT NOT NULL,
    VoidCount       INT NOT NULL,
    VoidAmount      DECIMAL(18,2) NOT NULL DEFAULT 0,
    BeginningOR     BIGINT NULL,
    EndingOR        BIGINT NULL,
    OldGrandTotal   DECIMAL(18,2) NOT NULL DEFAULT 0,
    NewGrandTotal   DECIMAL(18,2) NOT NULL DEFAULT 0,
    ReturnCount       INT NOT NULL CONSTRAINT DF_ZReads_ReturnCount DEFAULT 0,
    ReturnAmount      DECIMAL(18,2) NOT NULL CONSTRAINT DF_ZReads_ReturnAmount DEFAULT 0,
    BeginningReturnNo INT NULL,
    EndingReturnNo    INT NULL,
    ZReadUid        UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_ZReads_ZReadUid DEFAULT NEWID(),   -- the ERP's key
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
    IsActive        BIT NOT NULL DEFAULT 1,
    SendInvoices    BIT NOT NULL CONSTRAINT DF_EmailConfig_SendInvoices DEFAULT 0,   -- e-invoice copies (24)
    InvoiceRepository NVARCHAR(254) NULL                                             -- when the customer gives no email
);
GO

/* ============================ TVPs ============================ */
CREATE TYPE dbo.TVP_SaleItem AS TABLE (
    [LineNo] INT, ProductId INT, Barcode NVARCHAR(50), ProductName NVARCHAR(150),
    CategoryId INT, Quantity DECIMAL(18,3), UnitPrice DECIMAL(18,2),
    OrigUnitPrice DECIMAL(18,2), LineDiscount DECIMAL(18,2), LineTotal DECIMAL(18,2),
    IsVatable BIT, IsDiscountable BIT,
    NetAmount DECIMAL(18,2) DEFAULT 0, VatableAmount DECIMAL(18,2) DEFAULT 0,
    VatAmount DECIMAL(18,2) DEFAULT 0, VatExemptAmount DECIMAL(18,2) DEFAULT 0,
    ZeroRatedAmount DECIMAL(18,2) DEFAULT 0, VatAdjustment DECIMAL(18,2) DEFAULT 0,
    PriceApprovedBy INT NULL
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

/* E-invoice email queue (24_invoice_email.sql): a copy of each invoice / return receipt to the
   customer's email, or to EmailConfig.InvoiceRepository when they gave none. */
IF OBJECT_ID('dbo.InvoiceEmails', 'U') IS NULL
CREATE TABLE dbo.InvoiceEmails (
    InvoiceEmailId  BIGINT IDENTITY(1,1) PRIMARY KEY,
    Kind            VARCHAR(10)   NOT NULL CONSTRAINT CK_InvoiceEmails_Kind CHECK (Kind IN ('SALE', 'RETURN')),
    RefUid          UNIQUEIDENTIFIER NOT NULL,          -- Sales.SaleUid / SaleReturns.ReturnUid
    BranchCode      VARCHAR(10)   NOT NULL,
    ToAddress       NVARCHAR(254) NOT NULL,
    ToRepository    BIT NOT NULL DEFAULT 0,             -- 1 = the customer gave no email
    IsManual        BIT NOT NULL DEFAULT 0,             -- 1 = "Email a copy" from Reprint
    RequestedBy     INT NULL,
    Status          VARCHAR(10)   NOT NULL DEFAULT 'Pending'
                    CONSTRAINT CK_InvoiceEmails_Status CHECK (Status IN ('Pending', 'Sent', 'Failed')),
    Attempts        INT NOT NULL DEFAULT 0,
    NextAttemptAt   DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    LastError       NVARCHAR(400) NULL,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    SentAt          DATETIME2 NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_InvoiceEmails_Due' AND object_id = OBJECT_ID('dbo.InvoiceEmails'))
    CREATE INDEX IX_InvoiceEmails_Due ON dbo.InvoiceEmails (Status, NextAttemptAt);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_InvoiceEmails_Ref' AND object_id = OBJECT_ID('dbo.InvoiceEmails'))
    CREATE INDEX IX_InvoiceEmails_Ref ON dbo.InvoiceEmails (Kind, RefUid);
GO

/* Suki / reward cards (26_loyalty.sql). */
IF OBJECT_ID('dbo.LoyaltySettings', 'U') IS NULL
CREATE TABLE dbo.LoyaltySettings (
    SettingsId      INT NOT NULL CONSTRAINT PK_LoyaltySettings PRIMARY KEY CONSTRAINT CK_LoyaltySettings_One CHECK (SettingsId = 1),
    IsEnabled       BIT NOT NULL DEFAULT 0,
    AmountPerPoint  DECIMAL(18,2) NOT NULL DEFAULT 200 CONSTRAINT CK_LoyaltySettings_Amount CHECK (AmountPerPoint >= 1),
    ProgramName     NVARCHAR(40) NOT NULL DEFAULT N'Suki card',
    UpdatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    UpdatedBy       INT NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM dbo.LoyaltySettings)
    INSERT INTO dbo.LoyaltySettings (SettingsId) VALUES (1);
GO

/* Wholesale prices by quantity (33_wholesale.sql): the rules, and each sale line sold at one. */
IF OBJECT_ID('dbo.WholesaleRules', 'U') IS NULL
CREATE TABLE dbo.WholesaleRules (
    RuleId      INT IDENTITY(1,1) CONSTRAINT PK_WholesaleRules PRIMARY KEY,
    ProductId   INT NULL REFERENCES dbo.Products(ProductId),       -- an item ...
    CategoryId  INT NULL REFERENCES dbo.Categories(CategoryId),    -- ... or every item of a category
    BranchCode  VARCHAR(10) NULL REFERENCES dbo.Branches(BranchCode),   -- NULL = every branch
    MinQty      DECIMAL(18,3) NOT NULL CONSTRAINT CK_WholesaleRules_MinQty CHECK (MinQty > 0),
    AmountOff   DECIMAL(18,2) NOT NULL CONSTRAINT CK_WholesaleRules_AmountOff CHECK (AmountOff > 0),   -- per unit (kg / pc)
    IsActive    BIT NOT NULL DEFAULT 1,
    UpdatedAt   DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    UpdatedBy   INT NULL,
    CONSTRAINT CK_WholesaleRules_Target CHECK ((ProductId IS NULL AND CategoryId IS NOT NULL) OR (ProductId IS NOT NULL AND CategoryId IS NULL))
);
GO
CREATE UNIQUE INDEX UQ_WholesaleRules ON dbo.WholesaleRules (ProductId, CategoryId, BranchCode, MinQty);
GO

IF OBJECT_ID('dbo.SaleItemWholesale', 'U') IS NULL
CREATE TABLE dbo.SaleItemWholesale (
    SaleUid        UNIQUEIDENTIFIER NOT NULL,
    [LineNo]       INT NOT NULL,
    ProductId      INT NOT NULL,
    Quantity       DECIMAL(18,3) NOT NULL,   -- this line's
    RegularPrice   DECIMAL(18,2) NOT NULL,   -- per unit before wholesale (the sale's price level, if any)
    AmountOff      DECIMAL(18,2) NOT NULL,   -- per unit
    WholesalePrice DECIMAL(18,2) NOT NULL,   -- per unit, as charged
    MinQty         DECIMAL(18,3) NOT NULL,   -- the minimum the sale reached
    ItemTotalQty   DECIMAL(18,3) NOT NULL,   -- the item's quantity across the sale's lines
    CONSTRAINT PK_SaleItemWholesale PRIMARY KEY (SaleUid, [LineNo])
);
GO
CREATE OR ALTER TRIGGER dbo.TR_SaleItemWholesale_Immutable ON dbo.SaleItemWholesale
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM deleted)
        THROW 51104, 'Wholesale lines of a sales invoice cannot be changed or deleted.', 1;
END
GO

/* Promos: Buy N Take M (34_promos.sql). */
IF OBJECT_ID('dbo.Promos', 'U') IS NULL
CREATE TABLE dbo.Promos (
    PromoId        INT IDENTITY(1,1) CONSTRAINT PK_Promos PRIMARY KEY,
    PromoName      NVARCHAR(40) NOT NULL,
    Kind           VARCHAR(10) NOT NULL CONSTRAINT CK_Promos_Kind CHECK (Kind IN ('SAME', 'GROUP', 'GIFT')),
    BuyQty         INT NOT NULL CONSTRAINT CK_Promos_BuyQty CHECK (BuyQty BETWEEN 1 AND 99),
    FreeQty        INT NOT NULL CONSTRAINT CK_Promos_FreeQty CHECK (FreeQty BETWEEN 1 AND 99),
    FreeProductId  INT NULL REFERENCES dbo.Products(ProductId),   -- GIFT only
    MaxFreePerSale INT NULL CONSTRAINT CK_Promos_MaxFree CHECK (MaxFreePerSale IS NULL OR MaxFreePerSale > 0),
    StartDate      DATE NOT NULL,
    EndDate        DATE NOT NULL,
    IsActive       BIT NOT NULL DEFAULT 1,
    UpdatedAt      DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    UpdatedBy      INT NULL,
    CONSTRAINT CK_Promos_Dates CHECK (EndDate >= StartDate),
    CONSTRAINT CK_Promos_Gift CHECK ((Kind = 'GIFT' AND FreeProductId IS NOT NULL) OR (Kind <> 'GIFT' AND FreeProductId IS NULL))
);
GO

IF OBJECT_ID('dbo.PromoItems', 'U') IS NULL
CREATE TABLE dbo.PromoItems (
    PromoItemId INT IDENTITY(1,1) CONSTRAINT PK_PromoItems PRIMARY KEY,
    PromoId     INT NOT NULL REFERENCES dbo.Promos(PromoId) ON DELETE CASCADE,
    ProductId   INT NULL REFERENCES dbo.Products(ProductId),
    CategoryId  INT NULL REFERENCES dbo.Categories(CategoryId),
    CONSTRAINT CK_PromoItems_Target CHECK ((ProductId IS NULL AND CategoryId IS NOT NULL) OR (ProductId IS NOT NULL AND CategoryId IS NULL))
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_PromoItems' AND object_id = OBJECT_ID('dbo.PromoItems'))
    CREATE UNIQUE INDEX UQ_PromoItems ON dbo.PromoItems (PromoId, ProductId, CategoryId);
GO

IF OBJECT_ID('dbo.PromoBranches', 'U') IS NULL
CREATE TABLE dbo.PromoBranches (
    PromoId    INT NOT NULL REFERENCES dbo.Promos(PromoId) ON DELETE CASCADE,
    BranchCode VARCHAR(10) NOT NULL REFERENCES dbo.Branches(BranchCode),
    CONSTRAINT PK_PromoBranches PRIMARY KEY (PromoId, BranchCode)
);
GO

IF OBJECT_ID('dbo.SaleItemPromo', 'U') IS NULL
CREATE TABLE dbo.SaleItemPromo (
    SaleUid      UNIQUEIDENTIFIER NOT NULL,
    [LineNo]     INT NOT NULL,
    PromoId      INT NOT NULL,
    PromoName    NVARCHAR(40) NOT NULL,     -- as printed
    FreeQty      DECIMAL(18,3) NOT NULL,    -- units of this line given free
    RegularPrice DECIMAL(18,2) NOT NULL,    -- per unit
    PromoAmount  DECIMAL(18,2) NOT NULL,    -- taken off this line
    CONSTRAINT PK_SaleItemPromo PRIMARY KEY (SaleUid, [LineNo])
);
GO
CREATE OR ALTER TRIGGER dbo.TR_SaleItemPromo_Immutable ON dbo.SaleItemPromo
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM deleted)
        THROW 51105, 'Promo lines of a sales invoice cannot be changed or deleted.', 1;
END
GO

/* 39: every time the drawer was opened without a sale (Pos → Open drawer): the till's own id (an
   offline one sent again isn't counted twice), who, the supervisor if one approved, the reason. */
IF OBJECT_ID('dbo.DrawerOpens', 'U') IS NULL
CREATE TABLE dbo.DrawerOpens (
    DrawerOpenUid UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_DrawerOpens PRIMARY KEY,
    ShiftUid      UNIQUEIDENTIFIER NOT NULL,
    BranchCode    VARCHAR(10) NOT NULL,
    TerminalId    INT NOT NULL,
    UserId        INT NOT NULL,
    ApprovedBy    INT NULL,
    Reason        NVARCHAR(60) NOT NULL,
    Note          NVARCHAR(200) NULL,
    OpenedAt      DATETIME2 NOT NULL,
    LoggedAt      DATETIME2 NOT NULL CONSTRAINT DF_DrawerOpens_LoggedAt DEFAULT SYSDATETIME(),
    Method        VARCHAR(10) NULL          -- KICK (drawer command) / SLIP (NO SALE slip printed)
);
CREATE INDEX IX_DrawerOpens_Shift ON dbo.DrawerOpens(ShiftUid);
GO

/* A terminal's own supervisor-approval answer per function (35_approvals.sql); no row = the branch's. */
IF OBJECT_ID('dbo.TerminalOverrides', 'U') IS NULL
CREATE TABLE dbo.TerminalOverrides (
    TerminalId INT NOT NULL REFERENCES dbo.Terminals(TerminalId),
    Func       VARCHAR(20) NOT NULL CONSTRAINT CK_TerminalOverrides_Func
               CHECK (Func IN ('CANCEL_LINE', 'VOID', 'RETURN', 'XREAD', 'REPRINT', 'DISCOUNT', 'PRICE_LEVEL', 'OPEN_DRAWER')),   -- PRICE_LEVEL: 36, OPEN_DRAWER: 39
    Required   BIT NOT NULL,
    UpdatedAt  DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    UpdatedBy  INT NULL,
    CONSTRAINT PK_TerminalOverrides PRIMARY KEY (TerminalId, Func)
);
GO

/* Price levels Price1..4: names and on/off (31_price_levels.sql). All off until an Admin turns them on. */
IF OBJECT_ID('dbo.PriceLevels', 'U') IS NULL
CREATE TABLE dbo.PriceLevels (
    PriceLevel  TINYINT NOT NULL CONSTRAINT PK_PriceLevels PRIMARY KEY CONSTRAINT CK_PriceLevels_Level CHECK (PriceLevel BETWEEN 1 AND 4),
    LevelName   NVARCHAR(30) NOT NULL,
    IsActive    BIT NOT NULL DEFAULT 0,
    UpdatedAt   DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    UpdatedBy   INT NULL
);
GO
INSERT INTO dbo.PriceLevels (PriceLevel, LevelName)
SELECT v.l, CONCAT(N'Price ', v.l) FROM (VALUES (1), (2), (3), (4)) v (l)
WHERE NOT EXISTS (SELECT 1 FROM dbo.PriceLevels x WHERE x.PriceLevel = v.l);
GO

/* 40: a price level by time of day (e.g. Price 1 from 7 PM). BranchCode NULL = every branch; TerminalId
   set = that till only. A till uses its own schedules if any, else its branch's, else every branch's. Days: 7 characters, Monday first, Y / N. An end before
   the start runs past midnight. The till applies it by its own clock, from the next sale. */
IF OBJECT_ID('dbo.PriceLevelSchedules', 'U') IS NULL
CREATE TABLE dbo.PriceLevelSchedules (
    ScheduleId  INT IDENTITY(1,1) PRIMARY KEY,
    BranchCode  VARCHAR(10) NULL,
    TerminalId  INT NULL,
    PriceLevel  TINYINT NOT NULL CONSTRAINT CK_PriceLevelSchedules_Level CHECK (PriceLevel BETWEEN 1 AND 4),
    StartTime   TIME(0) NOT NULL,
    EndTime     TIME(0) NOT NULL,
    Days        CHAR(7) NOT NULL CONSTRAINT DF_PriceLevelSchedules_Days DEFAULT 'YYYYYYY'
                CONSTRAINT CK_PriceLevelSchedules_Days CHECK (Days NOT LIKE '%[^YN]%' AND Days LIKE '%Y%'),
    IsActive    BIT NOT NULL CONSTRAINT DF_PriceLevelSchedules_IsActive DEFAULT 1,
    Note        NVARCHAR(100) NULL,
    UpdatedAt   DATETIME2 NOT NULL CONSTRAINT DF_PriceLevelSchedules_UpdatedAt DEFAULT SYSDATETIME(),
    UpdatedBy   INT NULL,
    CONSTRAINT CK_PriceLevelSchedules_Times CHECK (StartTime <> EndTime)
);
GO

IF OBJECT_ID('dbo.LoyaltyCards', 'U') IS NULL
CREATE TABLE dbo.LoyaltyCards (
    CardId          INT IDENTITY(1,1) PRIMARY KEY,
    CardNo          NVARCHAR(50)  NOT NULL CONSTRAINT UQ_LoyaltyCards_CardNo UNIQUE,
    CustomerName    NVARCHAR(150) NOT NULL,
    Mobile          VARCHAR(20)   NULL,     -- digits only; lookup by mobile when the card is left at home
    Email           NVARCHAR(254) NULL,
    Points          INT NOT NULL DEFAULT 0 CONSTRAINT CK_LoyaltyCards_Points CHECK (Points >= 0),
    IsActive        BIT NOT NULL DEFAULT 1,
    IssuedBranch    VARCHAR(10)   NULL,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CreatedBy       INT NULL,
    UpdatedAt       DATETIME2 NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_LoyaltyCards_Mobile' AND object_id = OBJECT_ID('dbo.LoyaltyCards'))
    CREATE UNIQUE INDEX UQ_LoyaltyCards_Mobile ON dbo.LoyaltyCards (Mobile) WHERE Mobile IS NOT NULL;
GO

IF OBJECT_ID('dbo.LoyaltyLedger', 'U') IS NULL
CREATE TABLE dbo.LoyaltyLedger (
    EntryId         BIGINT IDENTITY(1,1) PRIMARY KEY,
    CardId          INT NOT NULL CONSTRAINT FK_LoyaltyLedger_Card REFERENCES dbo.LoyaltyCards (CardId),
    Kind            VARCHAR(10) NOT NULL CONSTRAINT CK_LoyaltyLedger_Kind CHECK (Kind IN ('EARN', 'VOID', 'RETURN', 'ADJUST')),
    Points          INT NOT NULL,                       -- + earned / added, - taken back
    SaleUid         UNIQUEIDENTIFIER NULL,              -- the sale behind EARN / VOID / RETURN
    RefUid          UNIQUEIDENTIFIER NULL,              -- SaleUid (EARN, VOID) or ReturnUid (RETURN)
    Amount          DECIMAL(18,2) NULL,                 -- the amount the points were worked out from
    AmountPerPoint  DECIMAL(18,2) NULL,                 -- the rate in effect (EARN), reused for its returns
    BranchCode      VARCHAR(10) NULL,
    Note            NVARCHAR(200) NULL,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CreatedBy       INT NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_LoyaltyLedger_Ref' AND object_id = OBJECT_ID('dbo.LoyaltyLedger'))
    CREATE UNIQUE INDEX UQ_LoyaltyLedger_Ref ON dbo.LoyaltyLedger (Kind, RefUid) WHERE RefUid IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_LoyaltyLedger_Card' AND object_id = OBJECT_ID('dbo.LoyaltyLedger'))
    CREATE INDEX IX_LoyaltyLedger_Card ON dbo.LoyaltyLedger (CardId, EntryId);
GO

/* The ledger is the history: entries are never changed or deleted (a correction is an ADJUST). */
CREATE OR ALTER TRIGGER dbo.TR_LoyaltyLedger_Immutable ON dbo.LoyaltyLedger
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    THROW 51300, 'Points history cannot be changed or deleted. Add an adjustment instead.', 1;
END
GO

/* Each till device assigned to its own terminal (27_terminal_devices.sql): the token's SHA-256. */
IF OBJECT_ID('dbo.TerminalDevices', 'U') IS NULL
CREATE TABLE dbo.TerminalDevices (
    TerminalId      INT NOT NULL CONSTRAINT PK_TerminalDevices PRIMARY KEY
                    CONSTRAINT FK_TerminalDevices_Terminal REFERENCES dbo.Terminals (TerminalId),
    TokenHash       VARBINARY(32) NOT NULL CONSTRAINT UQ_TerminalDevices_Token UNIQUE,
    DeviceLabel     NVARCHAR(100) NULL,
    AssignedAt      DATETIME2 NOT NULL CONSTRAINT DF_TerminalDevices_AssignedAt DEFAULT SYSDATETIME(),
    AssignedBy      INT NULL
);
GO

/* ERP posting queue (22_erp_posting.sql). */
IF OBJECT_ID('dbo.ErpOutbox', 'U') IS NULL
CREATE TABLE dbo.ErpOutbox (
    OutboxId        BIGINT IDENTITY(1,1) PRIMARY KEY,   -- posting order
    Kind            VARCHAR(10) NOT NULL CONSTRAINT CK_ErpOutbox_Kind
                    CHECK (Kind IN ('OPEN', 'SALE', 'VOID', 'RETURN', 'CLOSE', 'ZREAD')),
    RefUid          UNIQUEIDENTIFIER NOT NULL,          -- SaleUid / ShiftUid / ReturnUid / ZReadUid
    BranchCode      VARCHAR(10) NOT NULL,
    TerminalId      INT NOT NULL,
    BusinessDate    DATE NOT NULL,
    Status          VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (Status IN ('Pending', 'Posted', 'Failed')),
    Attempts        INT NOT NULL DEFAULT 0,
    NextAttemptAt   DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    LastErrorNumber INT NULL,
    LastError       NVARCHAR(1000) NULL,
    ErpResult       VARCHAR(20) NULL,                   -- POSTED / DUPLICATE / VOIDED
    ShortLines      INT NULL,                           -- lines the branch didn't have enough stock for
    NeedsReview     BIT NULL,                           -- the ERP flagged it (e.g. a non-ERP approver)
    ErpMessage      NVARCHAR(1000) NULL,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    PostedAt        DATETIME2 NULL,
    CONSTRAINT UQ_ErpOutbox UNIQUE (Kind, RefUid)
);
GO
-- Each line's discount code (e.g. SENIOR20E) as first sent, so a retry sends exactly the same
-- sale even if the discount settings change in between (the ERP refuses changed content: 61122).
IF COL_LENGTH('dbo.ErpOutbox', 'LineDiscountCodes') IS NULL
    ALTER TABLE dbo.ErpOutbox ADD LineDiscountCodes NVARCHAR(MAX) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ErpOutbox_Due' AND object_id = OBJECT_ID('dbo.ErpOutbox'))
    CREATE INDEX IX_ErpOutbox_Due ON dbo.ErpOutbox(Status, NextAttemptAt) INCLUDE (TerminalId);
GO

/* BIR sworn statement (18_bir_invoice_returns.sql): return transactions + guards. */
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

/* ERP master-data sync (dbo.sp_ErpSyncMasterData). Wider than the target columns on
   purpose: oversized ERP values come back as "skipped" issues, not a truncation error. */
CREATE TYPE dbo.TVP_ErpCategory AS TABLE (
    ErpCategoryId INT, CategoryName NVARCHAR(400)
);
GO

CREATE TYPE dbo.TVP_ErpProduct AS TABLE (
    ErpProductCode VARCHAR(100), Barcode NVARCHAR(400), ProductName NVARCHAR(400),
    ErpCategoryId INT, Unit NVARCHAR(100), IsVatable BIT, IsDiscountable BIT,
    Cost DECIMAL(18,2), IsActive BIT
);
GO

CREATE TYPE dbo.TVP_ErpBranch AS TABLE (
    BranchCode VARCHAR(100), BranchName NVARCHAR(400), Address NVARCHAR(1000)
);
GO

/* ERP users (20_erp_users.sql). */
CREATE TYPE dbo.TVP_ErpUser AS TABLE (
    UserID VARCHAR(100), FullName NVARCHAR(400), AssignedBranch VARCHAR(100), Role VARCHAR(40),
    MustChangePassword BIT, PasswordHash VARBINARY(64), PasswordSalt VARBINARY(64),
    PasswordIterations INT, PasswordAlgoVersion TINYINT
);
GO

/* ERP SellingPrice per branch (19_erp_prices.sql). */
CREATE TYPE dbo.TVP_ErpPrice AS TABLE (
    BranchCode VARCHAR(100), ErpProductCode VARCHAR(100), Price DECIMAL(19,4)
);
GO

/* ERP Price1..4 per branch (31_price_levels.sql). */
CREATE TYPE dbo.TVP_ErpPriceLevel AS TABLE (
    BranchCode VARCHAR(100), ErpProductCode VARCHAR(100),
    Price1 DECIMAL(19,4), Price2 DECIMAL(19,4), Price3 DECIMAL(19,4), Price4 DECIMAL(19,4)
);
GO

/* ============================ ACCOUNTING (acc schema) ============================
   Addendum B. Kept identical to 16_accounting.sql (same idempotent guards) so a fresh
   install and an upgraded DB end up with the same schema. Procedures: 02_procedures.sql. */
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
