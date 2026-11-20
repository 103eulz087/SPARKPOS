/* =====================================================================
   34 — Promos: Buy N Take M (2026-11-18)
   The user: stores run Buy 1 Take 1 and the like. Their calls: every kind (same item; a
   different free item; mix and match, the cheaper free; buy N take M), applied automatically
   at the till, with dates and branches; the free item prints at its full price less the promo.
   - Promos: name (printed), kind SAME / GROUP / GIFT, buy N, take M free, the free item (GIFT),
     an optional limit of free units per sale, start and end date, on/off.
       SAME  — each qualifying item on its own: every N + M of it, M are free.
       GROUP — mix and match: the qualifying items count together; every N + M, the M cheapest are free.
       GIFT  — every N qualifying items bought, M of FreeProductId are free.
   - PromoItems: what qualifies (an item or a whole category). PromoBranches: where it runs
     (none = every branch).
   - SaleItemPromo: each sale line with free units (the promo, how many free, the price, the
     amount off). Sales.PromoAmount: the sale's promo total. It is part of Sales.DiscountAmount
     (the invoice shows it as a discount); the per-type discount totals (Senior, PWD...) leave it
     out and the X-Read / Z-Read show it on its own line (ZReads.DiscPromo).
   The sale's promo lines go in a JSON parameter of sp_UpsertSale, so a build from before 34
   still sends TVP_SaleItem as it always did.
   Idempotent. Run this, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

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

IF COL_LENGTH('dbo.Sales', 'PromoAmount') IS NULL
    ALTER TABLE dbo.Sales ADD PromoAmount DECIMAL(18,2) NOT NULL CONSTRAINT DF_Sales_PromoAmount DEFAULT 0;   -- part of DiscountAmount
GO
IF COL_LENGTH('dbo.ZReads', 'DiscPromo') IS NULL
    ALTER TABLE dbo.ZReads ADD DiscPromo DECIMAL(18,2) NOT NULL CONSTRAINT DF_ZReads_DiscPromo DEFAULT 0;
GO
