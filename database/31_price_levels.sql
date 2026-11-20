/* =====================================================================
   31 — Price levels Price1–Price4 (2026-11-17)
   The ERP's Price1–Price4 (per branch, like SellingPrice) become price levels at the till. The
   cashier picks one level for the whole sale (no approval); every line takes that level's price,
   and an item without one stays at SellingPrice, which is still the default. Discounts apply on
   top with the usual rules.
   - Products.Price1..4: head office's (Erp:ProductBranch) levels, next to BasePrice.
   - ProductPrices.Price1..4: a branch's own levels, on its SellingPrice row. A branch uses the
     levels of the same row its price comes from (its own row, else head office's).
   - PriceLevels: the four names and which are switched on. All off until an Admin turns them on.
   - Sales.PriceLevel: the level a sale was rung up at (NULL = SellingPrice).
   - TVP_ErpPriceLevel: the ERP's Price1..4 per branch row, sp_ErpSyncMasterData @PriceLevels.
   Idempotent. Run this, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('dbo.Products', 'Price1') IS NULL
    ALTER TABLE dbo.Products ADD Price1 DECIMAL(18,2) NULL, Price2 DECIMAL(18,2) NULL,
                                 Price3 DECIMAL(18,2) NULL, Price4 DECIMAL(18,2) NULL;
GO
IF COL_LENGTH('dbo.ProductPrices', 'Price1') IS NULL
    ALTER TABLE dbo.ProductPrices ADD Price1 DECIMAL(18,2) NULL, Price2 DECIMAL(18,2) NULL,
                                      Price3 DECIMAL(18,2) NULL, Price4 DECIMAL(18,2) NULL;
GO
IF COL_LENGTH('dbo.Sales', 'PriceLevel') IS NULL
    ALTER TABLE dbo.Sales ADD PriceLevel TINYINT NULL
        CONSTRAINT CK_Sales_PriceLevel CHECK (PriceLevel BETWEEN 1 AND 4);
GO

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

/* The ERP's Price1..4 come in their own list, so an API without them still calls
   sp_ErpSyncMasterData with the 3-column TVP_ErpPrice it always used. */
IF TYPE_ID('dbo.TVP_ErpPriceLevel') IS NULL
    CREATE TYPE dbo.TVP_ErpPriceLevel AS TABLE (
        BranchCode VARCHAR(100), ErpProductCode VARCHAR(100),
        Price1 DECIMAL(19,4), Price2 DECIMAL(19,4), Price3 DECIMAL(19,4), Price4 DECIMAL(19,4)
    );
GO

/* A first copy of this script (2026-11-17, on the test DBs only) widened TVP_ErpPrice itself,
   which broke the older API's sync. Put it back the way 19 made it. */
IF EXISTS (SELECT 1 FROM sys.table_types tt JOIN sys.columns c ON c.object_id = tt.type_table_object_id
           WHERE tt.name = 'TVP_ErpPrice' AND c.name = 'Price1')
BEGIN
    IF OBJECT_ID('dbo.sp_ErpSyncMasterData', 'P') IS NOT NULL DROP PROCEDURE dbo.sp_ErpSyncMasterData;
    DROP TYPE dbo.TVP_ErpPrice;
END
GO
IF TYPE_ID('dbo.TVP_ErpPrice') IS NULL
    CREATE TYPE dbo.TVP_ErpPrice AS TABLE (
        BranchCode VARCHAR(100), ErpProductCode VARCHAR(100), Price DECIMAL(19,4)
    );
GO
