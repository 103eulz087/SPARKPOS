/* =====================================================================
   ERP master data, step 1: categories, products and branches pulled from the
   CORECS ERP (dbo.sp_SparkPOS_GetCategories / GetProducts / GetBranches on the
   ERP's own SQL Server) by Admin → Products → "Sync from ERP".

   The ERP is the master for product identity, name, category, unit, VAT and
   discount flags, and cost. It is NOT the master for price: the ERP has no
   retail selling price, so BasePrice / ProductPrices stay SparkPOS-only and the
   sync never writes them. A product imported without a price stays off the
   till until an Admin sets one (see sp_GetPriceList).

   - Categories.ErpCategoryId / Products.ErpProductCode link a row to the ERP.
     NULL = a local-only row the sync leaves alone (it only reports them).
   - The TVP columns are deliberately wider than the target columns, so an
     oversized ERP value reaches dbo.sp_ErpSyncMasterData and comes back as a
     clear "skipped" issue instead of failing the whole call on truncation.

   Safe to run more than once.
   Run: sqlcmd -S <server> -U sa -P <pwd> -d TabletPOS -i 17_erp_master_data.sql
   THEN re-run 02_procedures.sql (dbo.sp_ErpSyncMasterData and the updated
   dbo.sp_GetPriceList).
   ===================================================================== */
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Categories') AND name = 'ErpCategoryId')
BEGIN
    ALTER TABLE dbo.Categories ADD ErpCategoryId INT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.Categories') AND name = 'UQ_Categories_ErpCategoryId')
BEGIN
    CREATE UNIQUE INDEX UQ_Categories_ErpCategoryId ON dbo.Categories(ErpCategoryId) WHERE ErpCategoryId IS NOT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Products') AND name = 'ErpProductCode')
BEGIN
    ALTER TABLE dbo.Products ADD ErpProductCode VARCHAR(50) NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.Products') AND name = 'UQ_Products_ErpProductCode')
BEGIN
    CREATE UNIQUE INDEX UQ_Products_ErpProductCode ON dbo.Products(ErpProductCode) WHERE ErpProductCode IS NOT NULL;
END
GO

IF TYPE_ID('dbo.TVP_ErpCategory') IS NULL
    CREATE TYPE dbo.TVP_ErpCategory AS TABLE (
        ErpCategoryId INT, CategoryName NVARCHAR(400)
    );
GO

IF TYPE_ID('dbo.TVP_ErpProduct') IS NULL
    CREATE TYPE dbo.TVP_ErpProduct AS TABLE (
        ErpProductCode VARCHAR(100), Barcode NVARCHAR(400), ProductName NVARCHAR(400),
        ErpCategoryId INT, Unit NVARCHAR(100), IsVatable BIT, IsDiscountable BIT,
        Cost DECIMAL(18,2), IsActive BIT
    );
GO

IF TYPE_ID('dbo.TVP_ErpBranch') IS NULL
    CREATE TYPE dbo.TVP_ErpBranch AS TABLE (
        BranchCode VARCHAR(100), BranchName NVARCHAR(400), Address NVARCHAR(1000)
    );
GO
