/* =====================================================================
   TabletPOS v2 — Stored Procedures
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

/* ---------- Effective price list for a branch (base ?? override) ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_GetPriceList
    @BranchCode VARCHAR(10)
AS
BEGIN
    SET NOCOUNT ON;
    SELECT p.ProductId, p.Barcode, p.ProductName, p.CategoryId, c.CategoryName, p.Unit,
           p.BasePrice, COALESCE(pp.Price, p.BasePrice) AS Price,
           CAST(CASE WHEN pp.Price IS NULL THEN 0 ELSE 1 END AS BIT) AS HasOverride,
           p.IsVatable, p.IsDiscountable, p.AllowPriceEdit, p.IsActive, p.ImageUrl, p.ErpProductCode,
           -- Price levels (31) come from the same row as the price: the branch's own, else head office's.
           CASE WHEN pp.ProductId IS NULL THEN p.Price1 ELSE pp.Price1 END AS Price1,
           CASE WHEN pp.ProductId IS NULL THEN p.Price2 ELSE pp.Price2 END AS Price2,
           CASE WHEN pp.ProductId IS NULL THEN p.Price3 ELSE pp.Price3 END AS Price3,
           CASE WHEN pp.ProductId IS NULL THEN p.Price4 ELSE pp.Price4 END AS Price4
    FROM dbo.Products p
    JOIN dbo.Categories c ON c.CategoryId = p.CategoryId
    LEFT JOIN dbo.ProductPrices pp
           ON pp.ProductId = p.ProductId AND pp.BranchCode = @BranchCode
    WHERE p.IsActive = 1
      -- A product with no price at this branch stays off the till. The exception is a local
      -- open-price item (AllowPriceEdit, not from the ERP) whose price is keyed in at the till.
      -- An ERP product at 0 means head office hasn't priced it for this branch yet.
      AND (COALESCE(pp.Price, p.BasePrice) > 0 OR (p.AllowPriceEdit = 1 AND p.ErpProductCode IS NULL))
    ORDER BY c.CategoryName, p.ProductName;
END
GO

/* ---------- ERP master-data sync (17_erp_master_data.sql) ----------
   Takes the full category / product / branch lists the API just read from the CORECS
   ERP and applies them in one transaction. The ERP is the master for identity, name,
   category, unit, VAT/discount flags, cost and price. Prices (@Prices, the ERP's
   SellingPrice per branch) are applied only when the list isn't empty: @PriceBranch's
   (head office) price becomes Products.BasePrice, and every branch's own price becomes its
   ProductPrices row, mirrored exactly for ERP products (a branch with no ERP price row
   falls back to the base price, as the ERP itself does). A NULL price means "head office
   hasn't set it yet" (the ERP returns NULL while SellingPrice = 0): the current price is
   kept, never overwritten or removed. Price1..4 (31_price_levels.sql, @PriceLevels) ride on the
   same rows and are mirrored only when @LevelsSent = 1 (the ERP's list has the columns); a NULL
   clears one.
   Rows without an ERP link (ErpCategoryId / ErpProductCode NULL) are
   local-only and left alone, except that an unused local category is deactivated.
   Matching: by the ERP key first; an unlinked local row with the same category name /
   barcode is adopted (linked) rather than duplicated. A linked product the ERP no
   longer returns is deactivated, never deleted (SaleItems reference it).
   Returns: 1) one row of counts, 2) the issues (rows skipped, and why). */
CREATE OR ALTER PROCEDURE dbo.sp_ErpSyncMasterData
    @Categories dbo.TVP_ErpCategory READONLY,
    @Products   dbo.TVP_ErpProduct  READONLY,
    @Branches   dbo.TVP_ErpBranch   READONLY,
    @Prices     dbo.TVP_ErpPrice    READONLY,
    @PriceBranch VARCHAR(10) = '888',
    -- 31: the ERP's Price1..4, a separate list so an older API (no levels) still calls this as before
    @PriceLevels dbo.TVP_ErpPriceLevel READONLY,
    @LevelsSent  BIT = 0          -- 1 = the ERP sent Price1..4: mirror them, a NULL clears one
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;

    -- An empty list would deactivate everything; far more likely a bad connection or branch.
    IF NOT EXISTS (SELECT 1 FROM @Categories)
        THROW 53001, 'The ERP returned no categories. Nothing was changed.', 1;
    IF NOT EXISTS (SELECT 1 FROM @Products)
        THROW 53002, 'The ERP returned no products. Nothing was changed.', 1;

    DECLARE @Issues TABLE (Kind VARCHAR(20), Code NVARCHAR(100), Message NVARCHAR(400));

    /* ---- clean the inputs ---- */
    DECLARE @Cat TABLE (ErpCategoryId INT PRIMARY KEY, CategoryName NVARCHAR(80));
    INSERT INTO @Issues
    SELECT 'Category', CAST(ErpCategoryId AS NVARCHAR(100)),
           CASE WHEN ErpCategoryId IS NULL THEN N'No ERP category id — skipped'
                WHEN LEN(LTRIM(RTRIM(ISNULL(CategoryName, N'')))) = 0 THEN N'Blank name — skipped'
                ELSE N'Name longer than 80 characters — skipped' END
    FROM @Categories
    WHERE ErpCategoryId IS NULL OR LEN(LTRIM(RTRIM(ISNULL(CategoryName, N'')))) NOT BETWEEN 1 AND 80;

    INSERT INTO @Cat (ErpCategoryId, CategoryName)
    SELECT ErpCategoryId, Name FROM (
        SELECT ErpCategoryId, LTRIM(RTRIM(CategoryName)) AS Name,
               ROW_NUMBER() OVER (PARTITION BY ErpCategoryId ORDER BY (SELECT 0)) AS rn
        FROM @Categories
        WHERE ErpCategoryId IS NOT NULL AND LEN(LTRIM(RTRIM(ISNULL(CategoryName, N'')))) BETWEEN 1 AND 80
    ) x WHERE rn = 1;

    -- Every code the ERP returned, valid or not: only these count as "still in the ERP"
    -- when deciding what to deactivate, so a row skipped for bad data is never deactivated.
    DECLARE @Seen TABLE (ErpProductCode VARCHAR(100) PRIMARY KEY);
    INSERT INTO @Seen SELECT DISTINCT LTRIM(RTRIM(ErpProductCode)) FROM @Products
    WHERE LEN(LTRIM(RTRIM(ISNULL(ErpProductCode, '')))) > 0;

    DECLARE @Prod TABLE (
        ErpProductCode VARCHAR(50) PRIMARY KEY, Barcode NVARCHAR(50), ProductName NVARCHAR(150),
        ErpCategoryId INT, CategoryId INT NULL, Unit NVARCHAR(20), IsVatable BIT,
        IsDiscountable BIT, Cost DECIMAL(18,2), IsActive BIT);

    ;WITH src AS (
        SELECT LTRIM(RTRIM(ISNULL(ErpProductCode, ''))) AS Code,
               -- The ERP has no product barcodes: 'NULL' (as text) or blank means none,
               -- and the product code is used as the barcode instead.
               NULLIF(NULLIF(LTRIM(RTRIM(ISNULL(Barcode, N''))), N''), N'NULL') AS Bc,
               LTRIM(RTRIM(ISNULL(ProductName, N''))) AS Name,
               ErpCategoryId,
               NULLIF(LTRIM(RTRIM(ISNULL(Unit, N''))), N'') AS Unit,
               IsVatable, IsDiscountable, Cost, IsActive
        FROM @Products
    ), chk AS (
        SELECT *, COALESCE(Bc, CAST(Code AS NVARCHAR(400))) AS EffBarcode,
               CASE WHEN LEN(Code) = 0 THEN N'No ERP product code — skipped'
                    WHEN LEN(Code) > 50 THEN N'Product code longer than 50 characters — skipped'
                    WHEN LEN(Name) = 0 THEN N'Blank name — skipped'
                    WHEN LEN(Name) > 150 THEN N'Name longer than 150 characters — skipped'
                    WHEN LEN(COALESCE(Bc, CAST(Code AS NVARCHAR(400)))) > 50 THEN N'Barcode longer than 50 characters — skipped'
                    WHEN LEN(ISNULL(Unit, N'kg')) > 20 THEN N'Unit longer than 20 characters — skipped'
                    WHEN ErpCategoryId IS NULL THEN N'No ERP category — skipped'
                    WHEN IsVatable IS NULL OR IsDiscountable IS NULL THEN N'VAT / discount flag missing — skipped'
               END AS Problem,
               ROW_NUMBER() OVER (PARTITION BY Code ORDER BY (SELECT 0)) AS rn
        FROM src
    )
    INSERT INTO @Prod (ErpProductCode, Barcode, ProductName, ErpCategoryId, Unit, IsVatable,
                       IsDiscountable, Cost, IsActive)
    SELECT Code, EffBarcode, Name, ErpCategoryId, ISNULL(Unit, N'kg'), IsVatable,
           IsDiscountable, ISNULL(Cost, 0), ISNULL(IsActive, 1)
    FROM chk WHERE Problem IS NULL AND rn = 1;

    ;WITH src AS (
        SELECT LTRIM(RTRIM(ISNULL(ErpProductCode, ''))) AS Code, ProductName, Barcode, Unit,
               ErpCategoryId, IsVatable, IsDiscountable
        FROM @Products
    )
    INSERT INTO @Issues
    SELECT 'Product', LEFT(Code, 100),
           CASE WHEN LEN(Code) = 0 THEN N'No ERP product code — skipped'
                WHEN LEN(Code) > 50 THEN N'Product code longer than 50 characters — skipped'
                WHEN LEN(LTRIM(RTRIM(ISNULL(ProductName, N'')))) = 0 THEN N'Blank name — skipped'
                WHEN LEN(LTRIM(RTRIM(ProductName))) > 150 THEN N'Name longer than 150 characters — skipped'
                WHEN ErpCategoryId IS NULL THEN N'No ERP category — skipped'
                WHEN IsVatable IS NULL OR IsDiscountable IS NULL THEN N'VAT / discount flag missing — skipped'
                WHEN LEN(ISNULL(NULLIF(LTRIM(RTRIM(ISNULL(Unit, N''))), N''), N'kg')) > 20 THEN N'Unit longer than 20 characters — skipped'
                ELSE N'Barcode longer than 50 characters — skipped' END
    FROM src
    WHERE NOT EXISTS (SELECT 1 FROM @Prod p WHERE p.ErpProductCode = src.Code);

    -- Two ERP products sharing one barcode would break UNIQUE(Barcode) and fail the whole sync.
    INSERT INTO @Issues
    SELECT 'Product', p.ErpProductCode, N'Barcode ' + p.Barcode + N' is used by more than one ERP product — skipped'
    FROM @Prod p WHERE (SELECT COUNT(*) FROM @Prod x WHERE x.Barcode = p.Barcode) > 1;
    DELETE p FROM @Prod p WHERE (SELECT COUNT(*) FROM @Prod x WHERE x.Barcode = p.Barcode) > 1;

    DECLARE @Br TABLE (BranchCode VARCHAR(10) PRIMARY KEY, BranchName NVARCHAR(120), Address NVARCHAR(250));
    INSERT INTO @Issues
    SELECT 'Branch', LEFT(LTRIM(RTRIM(ISNULL(BranchCode, ''))), 100),
           CASE WHEN LEN(LTRIM(RTRIM(ISNULL(BranchCode, '')))) = 0 THEN N'No branch code — skipped'
                WHEN LEN(LTRIM(RTRIM(BranchCode))) > 10 THEN N'Branch code longer than 10 characters — skipped'
                WHEN LEN(LTRIM(RTRIM(ISNULL(BranchName, N'')))) = 0 THEN N'Blank name — skipped'
                WHEN LEN(LTRIM(RTRIM(BranchName))) > 120 THEN N'Name longer than 120 characters — skipped'
                ELSE N'Address longer than 250 characters — skipped' END
    FROM @Branches
    WHERE LEN(LTRIM(RTRIM(ISNULL(BranchCode, '')))) NOT BETWEEN 1 AND 10
       OR LEN(LTRIM(RTRIM(ISNULL(BranchName, N'')))) NOT BETWEEN 1 AND 120
       OR LEN(LTRIM(RTRIM(ISNULL(Address, N'')))) > 250;

    INSERT INTO @Br (BranchCode, BranchName, Address)
    SELECT Code, Name, Addr FROM (
        SELECT LTRIM(RTRIM(BranchCode)) AS Code, LTRIM(RTRIM(BranchName)) AS Name,
               NULLIF(LTRIM(RTRIM(ISNULL(Address, N''))), N'') AS Addr,
               ROW_NUMBER() OVER (PARTITION BY LTRIM(RTRIM(BranchCode)) ORDER BY (SELECT 0)) AS rn
        FROM @Branches
        WHERE LEN(LTRIM(RTRIM(ISNULL(BranchCode, '')))) BETWEEN 1 AND 10
          AND LEN(LTRIM(RTRIM(ISNULL(BranchName, N'')))) BETWEEN 1 AND 120
          AND LEN(LTRIM(RTRIM(ISNULL(Address, N'')))) <= 250
    ) x WHERE rn = 1;

    /* Prices: SellingPrice is money (4 decimals); SparkPOS keeps 2. Negative = bad data. */
    DECLARE @Price TABLE (BranchCode VARCHAR(10), ErpProductCode VARCHAR(50), Price DECIMAL(18,2) NULL,
                          P1 DECIMAL(18,2) NULL, P2 DECIMAL(18,2) NULL, P3 DECIMAL(18,2) NULL, P4 DECIMAL(18,2) NULL,
                          PRIMARY KEY (BranchCode, ErpProductCode));   -- Price NULL = not set yet; a level NULL = none
    INSERT INTO @Issues
    SELECT 'Price', LEFT(CONCAT(LTRIM(RTRIM(BranchCode)), '/', LTRIM(RTRIM(ErpProductCode))), 100),
           CASE WHEN Price < 0 THEN N'Negative price — skipped'
                ELSE N'Price ' + CONVERT(NVARCHAR(30), Price) + N' has more than 2 decimals — rounded' END
    FROM @Prices
    WHERE Price < 0 OR Price <> ROUND(Price, 2);
    INSERT INTO @Price (BranchCode, ErpProductCode, Price)
    SELECT Br, Code, ROUND(Price, 2) FROM (
        SELECT LTRIM(RTRIM(BranchCode)) AS Br, LTRIM(RTRIM(ErpProductCode)) AS Code, Price,
               ROW_NUMBER() OVER (PARTITION BY LTRIM(RTRIM(BranchCode)), LTRIM(RTRIM(ErpProductCode))
                                  ORDER BY (SELECT 0)) AS rn
        FROM @Prices
        WHERE LEN(LTRIM(RTRIM(ISNULL(BranchCode, '')))) BETWEEN 1 AND 10
          AND LEN(LTRIM(RTRIM(ISNULL(ErpProductCode, '')))) BETWEEN 1 AND 50
          AND (Price IS NULL OR Price >= 0)
    ) x WHERE rn = 1;
    -- Price levels (31) ride on the price rows. A level at 0 or below is "none" (the item then
    -- sells at SellingPrice at that level).
    IF @LevelsSent = 1
    BEGIN
        DECLARE @Lvl TABLE (BranchCode VARCHAR(10), ErpProductCode VARCHAR(50),
                            P1 DECIMAL(18,2) NULL, P2 DECIMAL(18,2) NULL, P3 DECIMAL(18,2) NULL, P4 DECIMAL(18,2) NULL,
                            PRIMARY KEY (BranchCode, ErpProductCode));
        INSERT INTO @Lvl
        SELECT Br, Code, CASE WHEN Price1 > 0 THEN ROUND(Price1, 2) END, CASE WHEN Price2 > 0 THEN ROUND(Price2, 2) END,
                         CASE WHEN Price3 > 0 THEN ROUND(Price3, 2) END, CASE WHEN Price4 > 0 THEN ROUND(Price4, 2) END
        FROM (
            SELECT LTRIM(RTRIM(BranchCode)) AS Br, LTRIM(RTRIM(ErpProductCode)) AS Code, Price1, Price2, Price3, Price4,
                   ROW_NUMBER() OVER (PARTITION BY LTRIM(RTRIM(BranchCode)), LTRIM(RTRIM(ErpProductCode))
                                      ORDER BY (SELECT 0)) AS rn
            FROM @PriceLevels
            WHERE LEN(LTRIM(RTRIM(ISNULL(BranchCode, '')))) BETWEEN 1 AND 10
              AND LEN(LTRIM(RTRIM(ISNULL(ErpProductCode, '')))) BETWEEN 1 AND 50
        ) x WHERE rn = 1;
        UPDATE pr SET P1 = l.P1, P2 = l.P2, P3 = l.P3, P4 = l.P4
        FROM @Price pr JOIN @Lvl l ON l.BranchCode = pr.BranchCode AND l.ErpProductCode = pr.ErpProductCode;
    END
    DECLARE @PricesApplied BIT = CASE WHEN EXISTS (SELECT 1 FROM @Price) THEN 1 ELSE 0 END;
    DECLARE @BasePricesUpdated INT = 0, @BranchPricesChanged INT = 0, @LevelsUpdated INT = 0;

    DECLARE @CatAdded INT = 0, @CatUpdated INT = 0, @CatLinked INT = 0, @CatDeactivated INT = 0,
            @ProdAdded INT = 0, @ProdUpdated INT = 0, @ProdLinked INT = 0, @ProdDeactivated INT = 0,
            @BrAdded INT = 0, @BrUpdated INT = 0;

    BEGIN TRAN;
        -- One sync at a time (two Admins clicking at once would race the adopt/insert steps).
        DECLARE @lock INT;
        EXEC @lock = sp_getapplock @Resource = 'dbo.sp_ErpSyncMasterData', @LockMode = 'Exclusive',
                                   @LockOwner = 'Transaction', @LockTimeout = 30000;
        IF @lock < 0 THROW 53003, 'Another ERP sync is running. Try again in a moment.', 1;

        /* ---- categories ---- */
        -- Adopt an unlinked local category with the same name (e.g. the seed 'Others').
        UPDATE c SET ErpCategoryId = s.ErpCategoryId
        FROM dbo.Categories c JOIN @Cat s ON s.CategoryName = c.CategoryName
        WHERE c.ErpCategoryId IS NULL
          AND NOT EXISTS (SELECT 1 FROM dbo.Categories x WHERE x.ErpCategoryId = s.ErpCategoryId);
        SET @CatLinked = @@ROWCOUNT;

        -- The name is UNIQUE: an ERP name already used by a different category can't be applied.
        INSERT INTO @Issues
        SELECT 'Category', CAST(s.ErpCategoryId AS NVARCHAR(100)),
               N'Name "' + s.CategoryName + N'" is already used by another category — name not applied'
        FROM @Cat s
        WHERE EXISTS (SELECT 1 FROM dbo.Categories c WHERE c.CategoryName = s.CategoryName
                        AND (c.ErpCategoryId IS NULL OR c.ErpCategoryId <> s.ErpCategoryId));

        UPDATE c SET CategoryName = s.CategoryName, IsActive = 1
        FROM dbo.Categories c JOIN @Cat s ON s.ErpCategoryId = c.ErpCategoryId
        WHERE (c.CategoryName <> s.CategoryName COLLATE Latin1_General_BIN2 OR c.IsActive = 0)
          AND NOT EXISTS (SELECT 1 FROM dbo.Categories x WHERE x.CategoryName = s.CategoryName
                            AND x.CategoryId <> c.CategoryId);
        SET @CatUpdated = @@ROWCOUNT;

        INSERT INTO dbo.Categories (CategoryName, IsActive, ErpCategoryId)
        SELECT s.CategoryName, 1, s.ErpCategoryId FROM @Cat s
        WHERE NOT EXISTS (SELECT 1 FROM dbo.Categories c WHERE c.ErpCategoryId = s.ErpCategoryId)
          AND NOT EXISTS (SELECT 1 FROM dbo.Categories c WHERE c.CategoryName = s.CategoryName);
        SET @CatAdded = @@ROWCOUNT;

        UPDATE p SET CategoryId = c.CategoryId
        FROM @Prod p JOIN dbo.Categories c ON c.ErpCategoryId = p.ErpCategoryId;

        INSERT INTO @Issues
        SELECT 'Product', p.ErpProductCode,
               N'ERP category ' + CAST(p.ErpCategoryId AS NVARCHAR(20)) + N' not found — skipped'
        FROM @Prod p WHERE p.CategoryId IS NULL;
        DELETE FROM @Prod WHERE CategoryId IS NULL;

        /* ---- products ---- */
        -- Adopt an unlinked local product whose barcode is the ERP code / barcode.
        UPDATE p SET ErpProductCode = s.ErpProductCode
        FROM dbo.Products p JOIN @Prod s ON s.Barcode = p.Barcode
        WHERE p.ErpProductCode IS NULL
          AND NOT EXISTS (SELECT 1 FROM dbo.Products x WHERE x.ErpProductCode = s.ErpProductCode);
        SET @ProdLinked = @@ROWCOUNT;

        -- Barcode is UNIQUE: a new ERP product whose barcode another linked product already has.
        INSERT INTO @Issues
        SELECT 'Product', s.ErpProductCode,
               N'Barcode ' + s.Barcode + N' already belongs to another product — skipped'
        FROM @Prod s
        WHERE NOT EXISTS (SELECT 1 FROM dbo.Products p WHERE p.ErpProductCode = s.ErpProductCode)
          AND EXISTS (SELECT 1 FROM dbo.Products p WHERE p.Barcode = s.Barcode);

        -- A real ERP barcode (one that isn't just the product code) replaces ours. The ERP doesn't
        -- enforce barcode uniqueness, so one another product already has is skipped and logged —
        -- never moved silently.
        INSERT INTO @Issues
        SELECT 'Product', s.ErpProductCode, N'ERP barcode ' + s.Barcode + N' already belongs to another product — barcode not changed'
        FROM @Prod s JOIN dbo.Products p ON p.ErpProductCode = s.ErpProductCode
        WHERE s.Barcode <> s.ErpProductCode AND p.Barcode <> s.Barcode
          AND EXISTS (SELECT 1 FROM dbo.Products x WHERE x.Barcode = s.Barcode AND x.ProductId <> p.ProductId);
        UPDATE p SET Barcode = s.Barcode, RowVersionTs = SYSDATETIME()
        FROM dbo.Products p JOIN @Prod s ON s.ErpProductCode = p.ErpProductCode
        WHERE s.Barcode <> s.ErpProductCode AND p.Barcode <> s.Barcode
          AND NOT EXISTS (SELECT 1 FROM dbo.Products x WHERE x.Barcode = s.Barcode AND x.ProductId <> p.ProductId);

        -- AllowPriceEdit and the photo stay SparkPOS-managed after import (price is below).
        UPDATE p SET ProductName = s.ProductName, CategoryId = s.CategoryId, Unit = s.Unit,
                     IsVatable = s.IsVatable, IsDiscountable = s.IsDiscountable, Cost = s.Cost,
                     IsActive = s.IsActive, RowVersionTs = SYSDATETIME()
        FROM dbo.Products p JOIN @Prod s ON s.ErpProductCode = p.ErpProductCode
        WHERE p.ProductName <> s.ProductName COLLATE Latin1_General_BIN2 OR p.CategoryId <> s.CategoryId
           OR p.Unit <> s.Unit COLLATE Latin1_General_BIN2 OR p.IsVatable <> s.IsVatable
           OR p.IsDiscountable <> s.IsDiscountable OR p.Cost <> s.Cost OR p.IsActive <> s.IsActive;
        SET @ProdUpdated = @@ROWCOUNT;

        -- AllowPriceEdit = 1: an ERP item's price can be changed at the till for a special
        -- deal, with a supervisor's override (PosSettings.PriceEditOverride).
        INSERT INTO dbo.Products (Barcode, ProductName, CategoryId, Unit, BasePrice, Cost,
            IsVatable, IsDiscountable, AllowPriceEdit, IsActive, ErpProductCode)
        SELECT s.Barcode, s.ProductName, s.CategoryId, s.Unit,
               ISNULL((SELECT pr.Price FROM @Price pr WHERE pr.BranchCode = @PriceBranch
                                                       AND pr.ErpProductCode = s.ErpProductCode), 0),   -- NULL: not priced yet
               s.Cost, s.IsVatable, s.IsDiscountable, 1, s.IsActive, s.ErpProductCode
        FROM @Prod s
        WHERE NOT EXISTS (SELECT 1 FROM dbo.Products p WHERE p.ErpProductCode = s.ErpProductCode)
          AND NOT EXISTS (SELECT 1 FROM dbo.Products p WHERE p.Barcode = s.Barcode);
        SET @ProdAdded = @@ROWCOUNT;

        UPDATE p SET IsActive = 0, RowVersionTs = SYSDATETIME()
        FROM dbo.Products p
        WHERE p.ErpProductCode IS NOT NULL AND p.IsActive = 1
          AND NOT EXISTS (SELECT 1 FROM @Seen s WHERE s.ErpProductCode = p.ErpProductCode);
        SET @ProdDeactivated = @@ROWCOUNT;

        -- A category the ERP no longer has, or a local-only one, goes inactive once nothing
        -- active uses it (the ERP's categories replace the local set).
        UPDATE c SET IsActive = 0
        FROM dbo.Categories c
        WHERE c.IsActive = 1
          AND NOT EXISTS (SELECT 1 FROM @Cat s WHERE s.ErpCategoryId = c.ErpCategoryId)
          AND NOT EXISTS (SELECT 1 FROM dbo.Products p WHERE p.CategoryId = c.CategoryId AND p.IsActive = 1);
        SET @CatDeactivated = @@ROWCOUNT;

        /* ---- branches (name/address only; TIN, BIR codes etc. stay SparkPOS-managed) ---- */
        UPDATE b SET BranchName = s.BranchName, Address = s.Address
        FROM dbo.Branches b JOIN @Br s ON s.BranchCode = b.BranchCode
        WHERE b.BranchName <> s.BranchName COLLATE Latin1_General_BIN2
           OR ISNULL(b.Address, N'') <> ISNULL(s.Address, N'') COLLATE Latin1_General_BIN2;
        SET @BrUpdated = @@ROWCOUNT;

        INSERT INTO dbo.Branches (BranchCode, BranchName, Address, IsActive)
        SELECT s.BranchCode, s.BranchName, s.Address, 1 FROM @Br s
        WHERE NOT EXISTS (SELECT 1 FROM dbo.Branches b WHERE b.BranchCode = s.BranchCode);
        SET @BrAdded = @@ROWCOUNT;

        -- Same as BranchesController.Create: every branch needs its PosSettings row. ERP
        -- branches start with price changes at the till needing a supervisor.
        INSERT INTO dbo.PosSettings (BranchCode, StoreHeader2, PriceEditOverride)
        SELECT s.BranchCode, LEFT(s.BranchName, 60), 1 FROM @Br s
        WHERE NOT EXISTS (SELECT 1 FROM dbo.PosSettings ps WHERE ps.BranchCode = s.BranchCode);

        /* ---- prices (only when the ERP sent any) ---- */
        IF @PricesApplied = 1
        BEGIN
            INSERT INTO @Issues
            SELECT DISTINCT 'Price', pr.BranchCode, N'Branch ' + pr.BranchCode + N' is not in SparkPOS — its prices were skipped'
            FROM @Price pr WHERE NOT EXISTS (SELECT 1 FROM dbo.Branches b WHERE b.BranchCode = pr.BranchCode);

            UPDATE p SET BasePrice = pr.Price, RowVersionTs = SYSDATETIME()
            FROM dbo.Products p
            JOIN @Price pr ON pr.ErpProductCode = p.ErpProductCode AND pr.BranchCode = @PriceBranch
            WHERE pr.Price IS NOT NULL AND p.BasePrice <> pr.Price;
            SET @BasePricesUpdated = @@ROWCOUNT;

            -- Head office's price levels (31), mirrored as sent.
            IF @LevelsSent = 1
            BEGIN
                UPDATE p SET Price1 = pr.P1, Price2 = pr.P2, Price3 = pr.P3, Price4 = pr.P4, RowVersionTs = SYSDATETIME()
                FROM dbo.Products p
                JOIN @Price pr ON pr.ErpProductCode = p.ErpProductCode AND pr.BranchCode = @PriceBranch
                WHERE EXISTS (SELECT p.Price1, p.Price2, p.Price3, p.Price4 EXCEPT SELECT pr.P1, pr.P2, pr.P3, pr.P4);
                SET @LevelsUpdated = @@ROWCOUNT;
            END

            -- Branch rows mirror the ERP, but only for ERP products and only for the branches the
            -- ERP sent prices for (a non-ERP branch's own prices are left alone). A row is removed
            -- only when the ERP has no row at all for that branch and product; a NULL price keeps it.
            DECLARE @PriceActions TABLE (Act NVARCHAR(10));
            ;WITH target AS (
                SELECT * FROM dbo.ProductPrices pp
                WHERE EXISTS (SELECT 1 FROM dbo.Products p WHERE p.ProductId = pp.ProductId AND p.ErpProductCode IS NOT NULL)
                  AND pp.BranchCode IN (SELECT DISTINCT BranchCode FROM @Price)
            )
            MERGE target AS t
            USING (SELECT p.ProductId, pr.BranchCode, pr.Price, pr.P1, pr.P2, pr.P3, pr.P4
                   FROM @Price pr
                   JOIN dbo.Products p ON p.ErpProductCode = pr.ErpProductCode
                   JOIN dbo.Branches b ON b.BranchCode = pr.BranchCode
                   WHERE pr.Price IS NOT NULL) AS s
               ON t.ProductId = s.ProductId AND t.BranchCode = s.BranchCode
            WHEN MATCHED AND (t.Price <> s.Price OR (@LevelsSent = 1 AND EXISTS (
                    SELECT t.Price1, t.Price2, t.Price3, t.Price4 EXCEPT SELECT s.P1, s.P2, s.P3, s.P4))) THEN
                UPDATE SET Price = s.Price, UpdatedBy = NULL, UpdatedAt = SYSDATETIME(),
                           EffectiveDate = CASE WHEN t.Price <> s.Price THEN CAST(SYSDATETIME() AS DATE) ELSE t.EffectiveDate END,
                           Price1 = CASE WHEN @LevelsSent = 1 THEN s.P1 ELSE t.Price1 END,
                           Price2 = CASE WHEN @LevelsSent = 1 THEN s.P2 ELSE t.Price2 END,
                           Price3 = CASE WHEN @LevelsSent = 1 THEN s.P3 ELSE t.Price3 END,
                           Price4 = CASE WHEN @LevelsSent = 1 THEN s.P4 ELSE t.Price4 END
            WHEN NOT MATCHED BY TARGET THEN
                INSERT (ProductId, BranchCode, Price, Price1, Price2, Price3, Price4)
                VALUES (s.ProductId, s.BranchCode, s.Price,
                        CASE WHEN @LevelsSent = 1 THEN s.P1 END, CASE WHEN @LevelsSent = 1 THEN s.P2 END,
                        CASE WHEN @LevelsSent = 1 THEN s.P3 END, CASE WHEN @LevelsSent = 1 THEN s.P4 END)
            WHEN NOT MATCHED BY SOURCE AND NOT EXISTS (
                    SELECT 1 FROM @Price x JOIN dbo.Products xp ON xp.ErpProductCode = x.ErpProductCode
                    WHERE xp.ProductId = t.ProductId AND x.BranchCode = t.BranchCode) THEN DELETE
            OUTPUT $action INTO @PriceActions;
            SET @BranchPricesChanged = (SELECT COUNT(*) FROM @PriceActions);
        END
    COMMIT;

    SELECT @CatAdded AS CategoriesAdded, @CatUpdated AS CategoriesUpdated, @CatLinked AS CategoriesLinked,
           @CatDeactivated AS CategoriesDeactivated,
           @ProdAdded AS ProductsAdded, @ProdUpdated AS ProductsUpdated, @ProdLinked AS ProductsLinked,
           @ProdDeactivated AS ProductsDeactivated,
           (SELECT COUNT(*) FROM dbo.Products WHERE ErpProductCode IS NOT NULL AND IsActive = 1
              AND BasePrice <= 0) AS ProductsNeedPrice,
           @PricesApplied AS PricesApplied, @BasePricesUpdated AS BasePricesUpdated,
           @BranchPricesChanged AS BranchPricesChanged, @LevelsSent AS LevelsSent, @LevelsUpdated AS BaseLevelsUpdated,
           (SELECT COUNT(*) FROM dbo.Products WHERE ErpProductCode IS NULL AND IsActive = 1) AS LocalProductsActive,
           @BrAdded AS BranchesAdded, @BrUpdated AS BranchesUpdated;

    SELECT Kind, Code, Message FROM @Issues ORDER BY Kind, Code;
END
GO

/* ---------- ERP users sync (20_erp_users.sql) ----------
   Applies users from the ERP's sp_SparkPOS_GetUsers: role (the ERP's computed Role column),
   assigned branch and PBKDF2 password hash, copied as is (SparkPOS checks the password the
   way the ERP does — ErpPassword.cs). The username is the ERP UserID.
   - Never adopts a local SparkPOS user: an ERP UserID equal to a local username (e.g. the
     break-glass 'sparkpos-admin') is skipped and reported, so a local account never starts
     depending on the ERP.
   - @FullPull = 1 is the complete list: linked users missing from it are deactivated, but only
     when the pull looks sane — nobody when the list is empty, and per branch only when the
     list still has at least one user for that branch (admins: at least one admin). A glitch
     must never lock a branch out of its tills.
   - @FullPull = 0 (a login refresh of one user) updates what it's given and deactivates nobody.
   Returns: 1) counts, 2) issues. */
CREATE OR ALTER PROCEDURE dbo.sp_ErpSyncUsers
    @Users dbo.TVP_ErpUser READONLY,
    @FullPull BIT = 1
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    DECLARE @Issues TABLE (Kind VARCHAR(20), Code NVARCHAR(100), Message NVARCHAR(400));
    DECLARE @U TABLE (ErpUserId VARCHAR(50) PRIMARY KEY, FullName NVARCHAR(120), BranchCode VARCHAR(10) NULL,
        Role VARCHAR(20), MustChange BIT, Hash VARBINARY(64), Salt VARBINARY(64), Iter INT, Algo TINYINT);

    ;WITH src AS (
        SELECT LTRIM(RTRIM(ISNULL(UserID, ''))) AS Id,
               LTRIM(RTRIM(ISNULL(FullName, N''))) AS Name,
               NULLIF(LTRIM(RTRIM(ISNULL(AssignedBranch, ''))), '') AS Br,
               LTRIM(RTRIM(ISNULL(Role, ''))) AS Role,
               MustChangePassword, PasswordHash, PasswordSalt, PasswordIterations, PasswordAlgoVersion,
               ROW_NUMBER() OVER (PARTITION BY LTRIM(RTRIM(ISNULL(UserID, ''))) ORDER BY (SELECT 0)) AS rn
        FROM @Users
    ), chk AS (
        SELECT *, CASE
            WHEN LEN(Id) = 0 THEN N'No UserID — skipped'
            WHEN LEN(Id) > 50 THEN N'UserID longer than 50 characters — skipped'
            WHEN Role NOT IN ('Cashier', 'Supervisor', 'Admin') THEN N'Role "' + Role + N'" is not a POS role — skipped'
            WHEN PasswordHash IS NULL OR PasswordSalt IS NULL OR ISNULL(PasswordIterations, 0) <= 0
                THEN N'No password hash — skipped (reset the password in the ERP)'
            WHEN ISNULL(PasswordAlgoVersion, 0) <> 1 THEN N'Unknown password algorithm version — skipped'
            WHEN Role <> 'Admin' AND Br IS NULL THEN N'No assigned branch — skipped'
            WHEN Role <> 'Admin' AND NOT EXISTS (SELECT 1 FROM dbo.Branches b WHERE b.BranchCode = Br)
                THEN N'Branch ' + Br + N' is not in SparkPOS — skipped (sync branches first)'
            END AS Problem
        FROM src WHERE rn = 1
    )
    INSERT INTO @U (ErpUserId, FullName, BranchCode, Role, MustChange, Hash, Salt, Iter, Algo)
    SELECT Id, LEFT(CASE WHEN LEN(Name) = 0 THEN Id ELSE Name END, 120),
           CASE WHEN Role = 'Admin' THEN NULL ELSE Br END, Role, ISNULL(MustChangePassword, 0),
           PasswordHash, PasswordSalt, PasswordIterations, PasswordAlgoVersion
    FROM chk WHERE Problem IS NULL;

    INSERT INTO @Issues
    SELECT 'User', LEFT(LTRIM(RTRIM(ISNULL(UserID, ''))), 100), x.Problem
    FROM (
        SELECT UserID, CASE
            WHEN LEN(LTRIM(RTRIM(ISNULL(UserID, '')))) = 0 THEN N'No UserID — skipped'
            WHEN LEN(LTRIM(RTRIM(UserID))) > 50 THEN N'UserID longer than 50 characters — skipped'
            WHEN LTRIM(RTRIM(ISNULL(Role, ''))) NOT IN ('Cashier', 'Supervisor', 'Admin') THEN N'Role "' + ISNULL(Role, '') + N'" is not a POS role — skipped'
            WHEN PasswordHash IS NULL OR PasswordSalt IS NULL OR ISNULL(PasswordIterations, 0) <= 0
                THEN N'No password hash — skipped (reset the password in the ERP)'
            WHEN ISNULL(PasswordAlgoVersion, 0) <> 1 THEN N'Unknown password algorithm version — skipped'
            WHEN LTRIM(RTRIM(Role)) <> 'Admin' AND NULLIF(LTRIM(RTRIM(ISNULL(AssignedBranch, ''))), '') IS NULL THEN N'No assigned branch — skipped'
            ELSE N'Branch ' + LTRIM(RTRIM(AssignedBranch)) + N' is not in SparkPOS — skipped (sync branches first)' END AS Problem
        FROM @Users u
        WHERE NOT EXISTS (SELECT 1 FROM @U x WHERE x.ErpUserId = LTRIM(RTRIM(ISNULL(u.UserID, ''))))
    ) x;

    DECLARE @Added INT = 0, @Updated INT = 0, @Deactivated INT = 0, @Kept INT = 0;

    BEGIN TRAN;
        DECLARE @lock INT;
        EXEC @lock = sp_getapplock @Resource = 'dbo.sp_ErpSyncUsers', @LockMode = 'Exclusive',
                                   @LockOwner = 'Transaction', @LockTimeout = 30000;
        IF @lock < 0 THROW 53020, 'Another user sync is running. Try again in a moment.', 1;

        -- A local SparkPOS user already has this name: never adopt it.
        INSERT INTO @Issues
        SELECT 'User', x.ErpUserId, N'A local SparkPOS user is already called "' + u.Username + N'" — not synced. Rename one of them.'
        FROM @U x JOIN dbo.Users u ON u.Username = x.ErpUserId AND u.ErpUserId IS NULL;
        DELETE x FROM @U x WHERE EXISTS (SELECT 1 FROM dbo.Users u WHERE u.Username = x.ErpUserId AND u.ErpUserId IS NULL);

        UPDATE u SET FullName = x.FullName, Role = x.Role, IsActive = 1, MustChangePassword = x.MustChange,
            -- a new password in the ERP clears SparkPOS's lockout for that user
            FailedLogins = CASE WHEN u.ErpPasswordHash = x.Hash THEN u.FailedLogins ELSE 0 END,
            LockedUntil  = CASE WHEN u.ErpPasswordHash = x.Hash THEN u.LockedUntil ELSE NULL END,
            ErpPasswordHash = x.Hash, ErpPasswordSalt = x.Salt, ErpPasswordIterations = x.Iter,
            ErpPasswordAlgo = x.Algo, ErpSyncedAt = SYSDATETIME()
        FROM dbo.Users u JOIN @U x ON x.ErpUserId = u.ErpUserId
        WHERE u.FullName <> x.FullName COLLATE Latin1_General_BIN2 OR u.Role <> x.Role OR u.IsActive = 0
           OR u.MustChangePassword <> x.MustChange OR ISNULL(u.ErpPasswordHash, 0x) <> x.Hash
           OR ISNULL(u.ErpPasswordSalt, 0x) <> x.Salt OR ISNULL(u.ErpPasswordIterations, 0) <> x.Iter
           OR ISNULL(u.ErpPasswordAlgo, 0) <> x.Algo;
        SET @Updated = @@ROWCOUNT;
        UPDATE u SET ErpSyncedAt = SYSDATETIME() FROM dbo.Users u JOIN @U x ON x.ErpUserId = u.ErpUserId;

        -- PasswordHash/Salt are the local-login columns; an ERP user never uses them.
        INSERT INTO dbo.Users (Username, PasswordHash, PasswordSalt, FullName, Role, IsActive, ErpUserId,
            ErpPasswordHash, ErpPasswordSalt, ErpPasswordIterations, ErpPasswordAlgo, MustChangePassword, ErpSyncedAt)
        SELECT x.ErpUserId, 'ERP', '', x.FullName, x.Role, 1, x.ErpUserId,
               x.Hash, x.Salt, x.Iter, x.Algo, x.MustChange, SYSDATETIME()
        FROM @U x WHERE NOT EXISTS (SELECT 1 FROM dbo.Users u WHERE u.ErpUserId = x.ErpUserId);
        SET @Added = @@ROWCOUNT;

        -- Branch: exactly the ERP's assigned branch; an Admin has none (= every branch).
        DELETE ub FROM dbo.UserBranches ub
        JOIN dbo.Users u ON u.UserId = ub.UserId
        JOIN @U x ON x.ErpUserId = u.ErpUserId
        WHERE x.BranchCode IS NULL OR ub.BranchCode <> x.BranchCode;
        INSERT INTO dbo.UserBranches (UserId, BranchCode)
        SELECT u.UserId, x.BranchCode FROM @U x JOIN dbo.Users u ON u.ErpUserId = x.ErpUserId
        WHERE x.BranchCode IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM dbo.UserBranches ub WHERE ub.UserId = u.UserId AND ub.BranchCode = x.BranchCode);

        IF @FullPull = 1
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM @U)
                INSERT INTO @Issues VALUES ('User', '', N'The ERP returned no usable users — nobody was deactivated.');
            ELSE
            BEGIN
                -- Linked users the ERP no longer returns, grouped by their SparkPOS branch.
                DECLARE @Gone TABLE (UserId INT PRIMARY KEY, Username NVARCHAR(50), Role VARCHAR(20), BranchCode VARCHAR(10) NULL);
                INSERT INTO @Gone
                SELECT u.UserId, u.Username, u.Role,
                       (SELECT TOP 1 ub.BranchCode FROM dbo.UserBranches ub WHERE ub.UserId = u.UserId)
                FROM dbo.Users u
                WHERE u.ErpUserId IS NOT NULL AND u.IsActive = 1
                  AND NOT EXISTS (SELECT 1 FROM @U x WHERE x.ErpUserId = u.ErpUserId);

                -- Sanity: only where the ERP's list still has someone for that branch / any admin.
                UPDATE u SET IsActive = 0
                FROM dbo.Users u JOIN @Gone g ON g.UserId = u.UserId
                WHERE (g.Role = 'Admin' AND EXISTS (SELECT 1 FROM @U x WHERE x.Role = 'Admin'))
                   OR (g.Role <> 'Admin' AND EXISTS (SELECT 1 FROM @U x WHERE x.BranchCode = g.BranchCode));
                SET @Deactivated = @@ROWCOUNT;

                INSERT INTO @Issues
                SELECT 'User', g.Username,
                       N'No longer returned by the ERP, but the ERP sent nobody for '
                       + CASE WHEN g.Role = 'Admin' THEN N'admins' ELSE N'branch ' + ISNULL(g.BranchCode, N'?') END
                       + N' — kept active (could be a glitch)'
                FROM @Gone g JOIN dbo.Users u ON u.UserId = g.UserId
                WHERE u.IsActive = 1;
                SET @Kept = @@ROWCOUNT;
            END
        END
    COMMIT;

    SELECT @Added AS UsersAdded, @Updated AS UsersUpdated, @Deactivated AS UsersDeactivated, @Kept AS UsersKeptForSafety,
           (SELECT COUNT(*) FROM dbo.Users WHERE ErpUserId IS NOT NULL AND IsActive = 1) AS ErpUsersActive,
           (SELECT COUNT(*) FROM dbo.Users WHERE ErpUserId IS NULL AND IsActive = 1) AS LocalUsersActive;
    SELECT Kind, Code, Message FROM @Issues ORDER BY Kind, Code;
END
GO

/* ---------- Save branch overrides for one product (replace set) ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_SaveProductPrices
    @ProductId INT, @UpdatedBy INT, @Prices dbo.TVP_BranchPrice READONLY
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    IF EXISTS (SELECT 1 FROM dbo.Products WHERE ProductId = @ProductId AND ErpProductCode IS NOT NULL)
        THROW 53010, 'This product''s prices come from the ERP. Change them there.', 1;
    BEGIN TRAN;
        DELETE pp FROM dbo.ProductPrices pp
        WHERE pp.ProductId = @ProductId
          AND NOT EXISTS (SELECT 1 FROM @Prices x WHERE x.BranchCode = pp.BranchCode);

        MERGE dbo.ProductPrices AS t
        USING (SELECT BranchCode, Price FROM @Prices) AS s
           ON t.ProductId = @ProductId AND t.BranchCode = s.BranchCode
        WHEN MATCHED AND t.Price <> s.Price
            THEN UPDATE SET Price = s.Price, UpdatedBy = @UpdatedBy, UpdatedAt = SYSDATETIME()
        WHEN NOT MATCHED BY TARGET
            THEN INSERT (ProductId, BranchCode, Price, UpdatedBy)
                 VALUES (@ProductId, s.BranchCode, s.Price, @UpdatedBy);

        UPDATE dbo.Products SET RowVersionTs = SYSDATETIME() WHERE ProductId = @ProductId;
    COMMIT;
END
GO

/* ---------- Bulk price adjustment ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_BulkPriceUpdate
    @BranchCode VARCHAR(10),      -- NULL = adjust BasePrice for all branches
    @CategoryId INT = NULL,
    @Mode VARCHAR(20),            -- PERCENT | AMOUNT | SETBASE
    @Value DECIMAL(18,4) = 0,
    @UpdatedBy INT
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    BEGIN TRAN;
    IF @BranchCode IS NULL
    BEGIN
        UPDATE p SET BasePrice = CASE
                WHEN @Mode = 'PERCENT' THEN ROUND(p.BasePrice * (1 + @Value / 100.0), 2)
                WHEN @Mode = 'AMOUNT'  THEN ROUND(p.BasePrice + @Value, 2)
                ELSE p.BasePrice END,
            RowVersionTs = SYSDATETIME()
        FROM dbo.Products p
        WHERE p.IsActive = 1 AND p.ErpProductCode IS NULL   -- ERP prices come from the ERP
          AND (@CategoryId IS NULL OR p.CategoryId = @CategoryId);
    END
    ELSE IF @Mode = 'SETBASE'
    BEGIN
        DELETE pp FROM dbo.ProductPrices pp
        JOIN dbo.Products p ON p.ProductId = pp.ProductId
        WHERE pp.BranchCode = @BranchCode AND p.ErpProductCode IS NULL
          AND (@CategoryId IS NULL OR p.CategoryId = @CategoryId);
    END
    ELSE
    BEGIN
        MERGE dbo.ProductPrices AS t
        USING (SELECT p.ProductId,
                      CASE WHEN @Mode = 'PERCENT'
                           THEN ROUND(COALESCE(pp.Price, p.BasePrice) * (1 + @Value / 100.0), 2)
                           ELSE ROUND(COALESCE(pp.Price, p.BasePrice) + @Value, 2) END AS NewPrice
               FROM dbo.Products p
               LEFT JOIN dbo.ProductPrices pp
                      ON pp.ProductId = p.ProductId AND pp.BranchCode = @BranchCode
               WHERE p.IsActive = 1 AND p.ErpProductCode IS NULL
                 AND (@CategoryId IS NULL OR p.CategoryId = @CategoryId)) AS s
           ON t.ProductId = s.ProductId AND t.BranchCode = @BranchCode
        WHEN MATCHED THEN UPDATE SET Price = s.NewPrice, UpdatedBy = @UpdatedBy, UpdatedAt = SYSDATETIME()
        WHEN NOT MATCHED BY TARGET THEN
            INSERT (ProductId, BranchCode, Price, UpdatedBy)
            VALUES (s.ProductId, @BranchCode, s.NewPrice, @UpdatedBy);
    END
    DECLARE @rows INT = @@ROWCOUNT;
    COMMIT;
    SELECT @rows AS RowsAffected;
END
GO

/* ---------- Copy one branch's price list onto another ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_CopyBranchPrices
    @FromBranch VARCHAR(10), @ToBranch VARCHAR(10), @UpdatedBy INT
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    BEGIN TRAN;
        -- ERP products' branch prices come from the ERP: never copied over.
        DELETE pp FROM dbo.ProductPrices pp
        WHERE pp.BranchCode = @ToBranch
          AND NOT EXISTS (SELECT 1 FROM dbo.Products p WHERE p.ProductId = pp.ProductId AND p.ErpProductCode IS NOT NULL);
        INSERT INTO dbo.ProductPrices (ProductId, BranchCode, Price, UpdatedBy)
        SELECT pp.ProductId, @ToBranch, pp.Price, @UpdatedBy
        FROM dbo.ProductPrices pp
        WHERE pp.BranchCode = @FromBranch
          AND NOT EXISTS (SELECT 1 FROM dbo.Products p WHERE p.ProductId = pp.ProductId AND p.ErpProductCode IS NOT NULL);
    COMMIT;
END
GO

/* ---------- OR number blocks ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_AllocateORRange
    @TerminalId INT, @BlockSize INT = 500, @From BIGINT = NULL
AS
BEGIN
    /* BIR Sales Invoice numbers: 18 digits, non-resettable, gap-free per terminal, starting at
       000000000000000001. A block always starts right after the last number this terminal has
       actually used (dbo.Sales), so an abandoned block never leaves a gap. @From is the device's
       own next number, sent only while it still holds unsynced sales (a mid-shift top-up) so the
       new block continues after those. It can't jump past what was handed out before. */
    SET NOCOUNT ON; SET XACT_ABORT ON;
    IF @BlockSize IS NULL OR @BlockSize < 1 SET @BlockSize = 500;
    BEGIN TRAN;
        DECLARE @Branch VARCHAR(10);
        SELECT @Branch = BranchCode FROM dbo.Terminals WITH (UPDLOCK) WHERE TerminalId = @TerminalId;
        IF @Branch IS NULL THROW 51020, 'Terminal not found.', 1;

        DECLARE @Start BIGINT = ISNULL((SELECT MAX(ORNumber) FROM dbo.Sales WHERE TerminalId = @TerminalId), 0) + 1;
        DECLARE @Issued BIGINT = ISNULL((SELECT MAX(RangeEnd) FROM dbo.ORRanges WHERE TerminalId = @TerminalId), 0) + 1;
        IF @From > @Start SET @Start = CASE WHEN @From > @Issued THEN @Issued ELSE @From END;
        IF @Start > 999999999999999999 THROW 51021, 'This terminal has used every 18-digit sales invoice number.', 1;

        DECLARE @End BIGINT = CASE WHEN @Start + @BlockSize - 1 > 999999999999999999
                                   THEN 999999999999999999 ELSE @Start + @BlockSize - 1 END;
        INSERT INTO dbo.ORRanges (BranchCode, TerminalId, RangeStart, RangeEnd)
        VALUES (@Branch, @TerminalId, @Start, @End);
        SELECT RangeStart, RangeEnd FROM dbo.ORRanges WHERE ORRangeId = SCOPE_IDENTITY();
    COMMIT;
END
GO

/* ---------- Shifts ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_OpenShift
    @ShiftUid UNIQUEIDENTIFIER, @BranchCode VARCHAR(10), @TerminalId INT,
    @CashierUserId INT, @BusinessDate DATE, @CashBegin DECIMAL(18,2), @OpenedAt DATETIME2
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM dbo.Shifts WHERE ShiftUid = @ShiftUid) RETURN;
    -- Who and where before when: the shift belongs to the terminal's own branch, and a
    -- Cashier/Supervisor works only at a branch they're assigned to (the ERP's AssignedBranch).
    IF NOT EXISTS (SELECT 1 FROM dbo.Terminals WHERE TerminalId = @TerminalId AND BranchCode = @BranchCode)
        THROW 51014, 'This terminal belongs to another branch.', 1;
    IF NOT EXISTS (SELECT 1 FROM dbo.Users u WHERE u.UserId = @CashierUserId AND u.IsActive = 1
                     AND (u.Role = 'Admin' OR EXISTS (SELECT 1 FROM dbo.UserBranches ub
                                                      WHERE ub.UserId = u.UserId AND ub.BranchCode = @BranchCode)))
    BEGIN
        DECLARE @NotHereMsg NVARCHAR(200) = CONCAT(N'This user is not assigned to branch ', @BranchCode,
            N' and can''t open a shift there.');
        THROW 51015, @NotHereMsg, 1;
    END
    IF EXISTS (SELECT 1 FROM dbo.ZReads WHERE TerminalId = @TerminalId AND BusinessDate = @BusinessDate)
        THROW 51010, 'End of Day already processed for this terminal and date.', 1;
    -- A new business day starts only once every earlier day on this terminal is closed
    -- (its shifts blind-closed, then its End of Day run): one Z-Read per day, in date order.
    DECLARE @Unclosed DATE = (SELECT MIN(s.BusinessDate) FROM dbo.Shifts s
        WHERE s.TerminalId = @TerminalId AND s.BusinessDate < @BusinessDate
          AND NOT EXISTS (SELECT 1 FROM dbo.ZReads z WHERE z.TerminalId = s.TerminalId AND z.BusinessDate = s.BusinessDate));
    IF @Unclosed IS NOT NULL
    BEGIN
        DECLARE @UnclosedMsg NVARCHAR(200) = CONCAT(N'Business day ', CONVERT(CHAR(10), @Unclosed, 23),
            N' on this terminal was never closed. Blind-close its shift and run its End of Day first.');
        THROW 51012, @UnclosedMsg, 1;
    END
    IF EXISTS (SELECT 1 FROM dbo.Shifts WHERE TerminalId = @TerminalId AND Status = 'Open')
        THROW 51000, 'Terminal already has an open shift.', 1;
    INSERT INTO dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@ShiftUid, @BranchCode, @TerminalId, @CashierUserId, @BusinessDate, @CashBegin, @OpenedAt);
    -- A terminal that posts to the ERP opens the shift there first (its sales need it).
    IF EXISTS (SELECT 1 FROM dbo.Terminals WHERE TerminalId = @TerminalId AND PostToErp = 1)
        INSERT INTO dbo.ErpOutbox (Kind, RefUid, BranchCode, TerminalId, BusinessDate)
        VALUES ('OPEN', @ShiftUid, @BranchCode, @TerminalId, @BusinessDate);
END
GO

/* ---------- Suki / reward cards (26_loyalty.sql) ----------
   A sale rung up with a card earns FLOOR(amount paid / AmountPerPoint) points, once per sale
   (UQ_LoyaltyLedger_Ref). A void takes back what the sale still holds; a return keeps only the
   points the amount left after all its returns would earn, at the sale's own rate. Cards.Points
   is the running balance; LoyaltyLedger is its history. Phase 1: no redeeming. */
CREATE OR ALTER PROCEDURE dbo.sp_LoyaltyEarn
    @SaleUid UNIQUEIDENTIFIER, @CardId INT, @NetAmount DECIMAL(18,2), @BranchCode VARCHAR(10), @UserId INT
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @Rate DECIMAL(18,2), @On BIT;
    SELECT @On = IsEnabled, @Rate = AmountPerPoint FROM dbo.LoyaltySettings WHERE SettingsId = 1;
    IF ISNULL(@On, 0) = 0 OR @Rate IS NULL OR @Rate <= 0 RETURN;
    IF EXISTS (SELECT 1 FROM dbo.LoyaltyLedger WHERE Kind = 'EARN' AND RefUid = @SaleUid) RETURN;
    DECLARE @Pts INT = FLOOR(CASE WHEN @NetAmount > 0 THEN @NetAmount ELSE 0 END / @Rate);
    IF @Pts <= 0 RETURN;
    INSERT INTO dbo.LoyaltyLedger (CardId, Kind, Points, SaleUid, RefUid, Amount, AmountPerPoint, BranchCode, CreatedBy)
    VALUES (@CardId, 'EARN', @Pts, @SaleUid, @SaleUid, @NetAmount, @Rate, @BranchCode, @UserId);
    UPDATE dbo.LoyaltyCards SET Points = Points + @Pts, UpdatedAt = SYSDATETIME() WHERE CardId = @CardId;
END
GO

/* Takes points back from a sale's card: @Kind 'VOID' = everything the sale still holds;
   'RETURN' = down to what the amount left after its returns earns. Never below 0 on the card
   (an earlier manual adjustment may have used them). Safe to call twice (UQ_LoyaltyLedger_Ref). */
CREATE OR ALTER PROCEDURE dbo.sp_LoyaltyTakeBack
    @SaleUid UNIQUEIDENTIFIER, @Kind VARCHAR(10), @RefUid UNIQUEIDENTIFIER, @UserId INT
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @CardId INT, @Rate DECIMAL(18,2), @Amount DECIMAL(18,2), @Branch VARCHAR(10);
    SELECT @CardId = CardId, @Rate = AmountPerPoint, @Amount = Amount, @Branch = BranchCode
    FROM dbo.LoyaltyLedger WHERE Kind = 'EARN' AND RefUid = @SaleUid;
    IF @CardId IS NULL RETURN;                                   -- the sale earned nothing
    IF EXISTS (SELECT 1 FROM dbo.LoyaltyLedger WHERE Kind = @Kind AND RefUid = @RefUid) RETURN;
    IF EXISTS (SELECT 1 FROM dbo.LoyaltyLedger WHERE Kind = 'VOID' AND SaleUid = @SaleUid) RETURN;

    DECLARE @Holds INT = (SELECT SUM(Points) FROM dbo.LoyaltyLedger WHERE SaleUid = @SaleUid);
    DECLARE @Keep INT = 0;
    IF @Kind = 'RETURN'
    BEGIN
        DECLARE @Left DECIMAL(18,2) = @Amount - ISNULL((SELECT SUM(NetAmount) FROM dbo.SaleReturns WHERE OrigSaleUid = @SaleUid), 0);
        SET @Keep = FLOOR(CASE WHEN @Left > 0 THEN @Left ELSE 0 END / @Rate);
    END
    DECLARE @Take INT = @Holds - @Keep;
    DECLARE @Has INT = (SELECT Points FROM dbo.LoyaltyCards WITH (UPDLOCK) WHERE CardId = @CardId);
    IF @Take > @Has SET @Take = @Has;
    IF @Take <= 0 RETURN;
    INSERT INTO dbo.LoyaltyLedger (CardId, Kind, Points, SaleUid, RefUid, BranchCode, CreatedBy)
    VALUES (@CardId, @Kind, -@Take, @SaleUid, @RefUid, @Branch, @UserId);
    UPDATE dbo.LoyaltyCards SET Points = Points - @Take, UpdatedAt = SYSDATETIME() WHERE CardId = @CardId;
END
GO

/* A manual correction by an Admin (e.g. points from a lost card moved to its replacement). */
CREATE OR ALTER PROCEDURE dbo.sp_LoyaltyAdjust
    @CardId INT, @Points INT, @Note NVARCHAR(200), @UserId INT, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    IF @Points = 0 THROW 51302, 'Enter the points to add (or a minus number to take away).', 1;
    IF LEN(LTRIM(RTRIM(ISNULL(@Note, N'')))) = 0 THROW 51303, 'Enter the reason for the adjustment.', 1;
    BEGIN TRAN;
        DECLARE @Has INT = (SELECT Points FROM dbo.LoyaltyCards WITH (UPDLOCK) WHERE CardId = @CardId);
        IF @Has IS NULL THROW 51304, 'Card not found.', 1;
        IF @Has + @Points < 0 THROW 51301, 'The card doesn''t have that many points.', 1;
        INSERT INTO dbo.LoyaltyLedger (CardId, Kind, Points, BranchCode, Note, CreatedBy)
        VALUES (@CardId, 'ADJUST', @Points, @BranchCode, LTRIM(RTRIM(@Note)), @UserId);
        UPDATE dbo.LoyaltyCards SET Points = Points + @Points, UpdatedAt = SYSDATETIME() WHERE CardId = @CardId;
    COMMIT;
    SELECT Points FROM dbo.LoyaltyCards WHERE CardId = @CardId;
END
GO

/* ---------- Idempotent sale upsert (offline queue replay-safe) ---------- */
/* ---------- E-INVOICE COPY: queue an emailed copy of an invoice / return receipt ----------
   Automatic (@ToAddress NULL): only when the branch's email config has SendInvoices on; goes to
   @CustomerEmail when it looks like an address, else to the config's InvoiceRepository; at most
   one automatic copy per document. Manual (@ToAddress given, "Email a copy" from Reprint): always
   queued. InvoiceEmailService sends the queue. Called inside the sale / return transaction. */
CREATE OR ALTER PROCEDURE dbo.sp_QueueInvoiceEmail
    @Kind VARCHAR(10), @RefUid UNIQUEIDENTIFIER, @BranchCode VARCHAR(10),
    @CustomerEmail NVARCHAR(254) = NULL, @ToAddress NVARCHAR(254) = NULL, @RequestedBy INT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @to NVARCHAR(254), @repo BIT = 0;
    IF @ToAddress IS NOT NULL
    BEGIN
        SET @to = LTRIM(RTRIM(@ToAddress));
        IF @to NOT LIKE N'%_@_%._%' OR @to LIKE N'% %' OR @to LIKE N'%@%@%'
            THROW 53201, 'That doesn''t look like an email address.', 1;
        INSERT INTO dbo.InvoiceEmails (Kind, RefUid, BranchCode, ToAddress, ToRepository, IsManual, RequestedBy)
        VALUES (@Kind, @RefUid, @BranchCode, @to, 0, 1, @RequestedBy);
        RETURN;
    END

    IF EXISTS (SELECT 1 FROM dbo.InvoiceEmails WHERE Kind = @Kind AND RefUid = @RefUid AND IsManual = 0) RETURN;
    DECLARE @on BIT, @repository NVARCHAR(254);
    SELECT TOP 1 @on = SendInvoices, @repository = NULLIF(LTRIM(RTRIM(InvoiceRepository)), N'')
    FROM dbo.EmailConfig
    WHERE IsActive = 1 AND (BranchCode = @BranchCode OR BranchCode IS NULL)
    ORDER BY CASE WHEN BranchCode IS NULL THEN 1 ELSE 0 END;
    IF ISNULL(@on, 0) = 0 RETURN;

    SET @to = LTRIM(RTRIM(@CustomerEmail));
    IF @to IS NULL OR @to NOT LIKE N'%_@_%._%' OR @to LIKE N'% %' OR @to LIKE N'%@%@%'
        SELECT @to = @repository, @repo = 1;
    IF @to IS NULL RETURN;
    INSERT INTO dbo.InvoiceEmails (Kind, RefUid, BranchCode, ToAddress, ToRepository)
    VALUES (@Kind, @RefUid, @BranchCode, @to, @repo);
END
GO

/* 38: a voided sale gives its gift certificates back (Redeemed → Active), so the customer can
   use them again. Called by sp_UpsertSale (voided offline) and the void endpoint. */
CREATE OR ALTER PROCEDURE dbo.sp_GiftCertRelease
    @SaleUid UNIQUEIDENTIFIER, @UserId INT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF OBJECT_ID('dbo.GiftCertificates', 'U') IS NULL RETURN;
    DECLARE @gone TABLE (GcNo NVARCHAR(30), RedeemedBranch VARCHAR(10));
    UPDATE dbo.GiftCertificates
    SET Status = 'Active', RedeemedSaleUid = NULL, RedeemedAt = NULL, RedeemedBranch = NULL
    OUTPUT inserted.GcNo, deleted.RedeemedBranch INTO @gone
    WHERE RedeemedSaleUid = @SaleUid AND Status = 'Redeemed';
    INSERT INTO dbo.AuditLogs (BranchCode, UserId, Action, Detail)
    SELECT RedeemedBranch, @UserId, 'GC_RELEASED', CONCAT(N'Gift certificate ', GcNo, N' usable again: its sale was voided')
    FROM @gone;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_UpsertSale
    @SaleUid UNIQUEIDENTIFIER, @ShiftUid UNIQUEIDENTIFIER, @BranchCode VARCHAR(10),
    @TerminalId INT, @CashierUserId INT, @ORNumber BIGINT, @BusinessDate DATE,
    @SaleDateTime DATETIME2, @GrossAmount DECIMAL(18,2), @DiscountAmount DECIMAL(18,2),
    @VatExemptAmount DECIMAL(18,2), @VatableAmount DECIMAL(18,2), @VatAmount DECIMAL(18,2),
    @ZeroRatedAmount DECIMAL(18,2), @NetAmount DECIMAL(18,2), @TenderedAmount DECIMAL(18,2),
    @ChangeAmount DECIMAL(18,2), @DiscountCode VARCHAR(10) = NULL,
    @DiscountCtrlNo NVARCHAR(60) = NULL, @DiscountName NVARCHAR(120) = NULL,
    @VatAdjustment DECIMAL(18,2) = 0, @DinerCount INT = NULL, @SeniorCount INT = NULL,
    @Status VARCHAR(12) = 'Completed',
    @CustomerName NVARCHAR(150) = NULL, @CustomerAddress NVARCHAR(250) = NULL,
    @CustomerTin VARCHAR(20) = NULL, @CustomerBusinessStyle NVARCHAR(150) = NULL,
    @ReceiptText NVARCHAR(MAX) = NULL, @CustomerEmail NVARCHAR(254) = NULL,
    @LoyaltyCardNo NVARCHAR(50) = NULL,
    @ZeroRatedCertNo NVARCHAR(50) = NULL, @ZeroRatedApprovedBy INT = NULL,
    @DiscountApprovedBy INT = NULL,
    @PriceLevel TINYINT = NULL,          -- 31: the sale was rung up at Price1..4 (NULL = SellingPrice)
    @DiscountCap DECIMAL(18,2) = NULL,   -- 32: an SC/PWD discount limited to this (the weekly cap), approver in @DiscountApprovedBy
    -- 33: the lines sold at a wholesale price, JSON [{lineNo, regularPrice, amountOff, minQty, itemTotalQty}],
    -- and the supervisor who took the wholesale price off the sale
    @WholesaleLines NVARCHAR(MAX) = NULL, @WholesaleRemovedBy INT = NULL,
    -- 34: the lines with promo-free units, JSON [{lineNo, promoId, promoName, freeQty, regularPrice, promoAmount}]
    @PromoLines NVARCHAR(MAX) = NULL,
    -- 35: lines taken off the cart with a supervisor's approval, JSON
    -- [{productId, productName, quantity, unitPrice, approvedBy}] (audit only)
    @CancelledLines NVARCHAR(MAX) = NULL,
    @DiscountLines NVARCHAR(MAX) = NULL,      -- SC/PWD on only the senior's own quantity of a line (audit)
    -- 38: the GC payments' details, JSON [{seqNo, gcNo, faceValue}] (TVP_SalePayment is unchanged)
    @GiftCerts NVARCHAR(MAX) = NULL,
    @Items dbo.TVP_SaleItem READONLY, @Payments dbo.TVP_SalePayment READONLY
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    BEGIN TRAN;
        IF EXISTS (SELECT 1 FROM dbo.ZReads WHERE TerminalId = @TerminalId AND BusinessDate = @BusinessDate)
        BEGIN
            ROLLBACK;
            THROW 51011, 'Business date already closed by End of Day. Sale rejected.', 1;
        END

        IF EXISTS (SELECT 1 FROM dbo.Sales WHERE SaleUid = @SaleUid)
        BEGIN
            UPDATE dbo.Sales SET Status = @Status
            WHERE SaleUid = @SaleUid AND Status = 'Completed' AND @Status <> 'Completed';
            -- voided offline after it was first synced: the ERP gets the void after the sale
            DECLARE @Changed INT = @@ROWCOUNT;
            IF @Changed > 0 AND @Status = 'Voided'
               AND EXISTS (SELECT 1 FROM dbo.ErpOutbox WHERE Kind = 'SALE' AND RefUid = @SaleUid)
               AND NOT EXISTS (SELECT 1 FROM dbo.ErpOutbox WHERE Kind = 'VOID' AND RefUid = @SaleUid)
                INSERT INTO dbo.ErpOutbox (Kind, RefUid, BranchCode, TerminalId, BusinessDate)
                VALUES ('VOID', @SaleUid, @BranchCode, @TerminalId, @BusinessDate);
            IF @Changed > 0 AND @Status = 'Voided'
                EXEC dbo.sp_LoyaltyTakeBack @SaleUid = @SaleUid, @Kind = 'VOID', @RefUid = @SaleUid, @UserId = @CashierUserId;
            -- 38: the customer gets their gift certificate back
            IF @Changed > 0 AND @Status = 'Voided' AND OBJECT_ID('dbo.GiftCertificates', 'U') IS NOT NULL
                EXEC dbo.sp_GiftCertRelease @SaleUid = @SaleUid, @UserId = @CashierUserId;
            COMMIT; RETURN;
        END

        -- Suki card: an unknown or switched-off card doesn't stop the sale, it just earns nothing.
        DECLARE @CardId INT = NULL, @CardNo NVARCHAR(50) = NULLIF(LTRIM(RTRIM(@LoyaltyCardNo)), N'');
        IF @CardNo IS NOT NULL
        BEGIN
            SELECT @CardId = CardId FROM dbo.LoyaltyCards WHERE CardNo = @CardNo AND IsActive = 1;
            IF @CardId IS NULL
                INSERT INTO dbo.AuditLogs (BranchCode, UserId, TerminalId, Action, Detail)
                VALUES (@BranchCode, @CashierUserId, @TerminalId, 'LOYALTY_UNKNOWN',
                        CONCAT(N'SI ', @ORNumber, N': card ', @CardNo, N' not found or inactive, no points'));
        END

        -- 34: the promo total (part of DiscountAmount; the per-type discount totals leave it out)
        DECLARE @PromoTotal DECIMAL(18,2) = 0;
        IF @PromoLines IS NOT NULL AND ISJSON(@PromoLines) = 1
            SELECT @PromoTotal = ISNULL(SUM(j.PromoAmount), 0)
            FROM OPENJSON(@PromoLines) WITH ([LineNo] INT '$.lineNo', PromoAmount DECIMAL(18,2) '$.promoAmount') j
            WHERE j.PromoAmount > 0 AND EXISTS (SELECT 1 FROM @Items i WHERE i.[LineNo] = j.[LineNo]);

        INSERT INTO dbo.Sales (SaleUid, ShiftUid, BranchCode, TerminalId, CashierUserId, ORNumber,
            BusinessDate, SaleDateTime, GrossAmount, DiscountAmount, VatExemptAmount, VatableAmount,
            VatAmount, ZeroRatedAmount, NetAmount, TenderedAmount, ChangeAmount,
            DiscountCode, DiscountCtrlNo, DiscountName, VatAdjustment, DinerCount, SeniorCount, Status,
            CustomerName, CustomerAddress, CustomerTin, CustomerBusinessStyle, ReceiptText, CustomerEmail,
            LoyaltyCardId, ZeroRatedCertNo, ZeroRatedApprovedBy, DiscountApprovedBy, PriceLevel, DiscountCap, WholesaleRemovedBy,
            PromoAmount)
        VALUES (@SaleUid, @ShiftUid, @BranchCode, @TerminalId, @CashierUserId, @ORNumber,
            @BusinessDate, @SaleDateTime, @GrossAmount, @DiscountAmount, @VatExemptAmount, @VatableAmount,
            @VatAmount, @ZeroRatedAmount, @NetAmount, @TenderedAmount, @ChangeAmount,
            @DiscountCode, @DiscountCtrlNo, @DiscountName, @VatAdjustment, @DinerCount, @SeniorCount, @Status,
            NULLIF(LTRIM(RTRIM(@CustomerName)), N''), NULLIF(LTRIM(RTRIM(@CustomerAddress)), N''),
            NULLIF(LTRIM(RTRIM(@CustomerTin)), ''), NULLIF(LTRIM(RTRIM(@CustomerBusinessStyle)), N''),
            @ReceiptText, NULLIF(LTRIM(RTRIM(@CustomerEmail)), N''), @CardId,
            NULLIF(LTRIM(RTRIM(@ZeroRatedCertNo)), N''), @ZeroRatedApprovedBy,
            -- OTHER, a weekly cap, or (35) an SC/PWD discount the branch's Discount approval covers
            CASE WHEN @DiscountCode IS NOT NULL THEN @DiscountApprovedBy END,
            CASE WHEN @PriceLevel BETWEEN 1 AND 4 THEN @PriceLevel END,
            CASE WHEN @DiscountCode IS NOT NULL AND @DiscountCode <> 'OTHER' THEN @DiscountCap END,
            @WholesaleRemovedBy, @PromoTotal);

        IF @WholesaleRemovedBy IS NOT NULL
            INSERT INTO dbo.AuditLogs (BranchCode, UserId, TerminalId, Action, Detail)
            VALUES (@BranchCode, @WholesaleRemovedBy, @TerminalId, 'WHOLESALE_REMOVED',
                    CONCAT(N'SI ', @ORNumber, N': wholesale prices taken off',
                           CASE WHEN @DiscountCode IS NOT NULL THEN CONCAT(N' for a ', @DiscountCode, N' discount') END));

        -- a regular / other discount (30_other_discount.sql): the amount, reason and approver
        IF @DiscountCode = 'OTHER'
            INSERT INTO dbo.AuditLogs (BranchCode, UserId, TerminalId, Action, Detail)
            VALUES (@BranchCode, ISNULL(@DiscountApprovedBy, @CashierUserId), @TerminalId, 'OTHER_DISCOUNT',
                    CONCAT(N'SI ', @ORNumber, N': less ', @DiscountAmount, N' of ', @GrossAmount,
                           N' (', LEFT(ISNULL(@DiscountName, N'no reason'), 120), N')'));

        -- an SC/PWD discount limited to the booklet's weekly cap (32): the cap and who approved it
        IF @DiscountCap IS NOT NULL AND @DiscountCode IS NOT NULL AND @DiscountCode <> 'OTHER'
            INSERT INTO dbo.AuditLogs (BranchCode, UserId, TerminalId, Action, Detail)
            VALUES (@BranchCode, ISNULL(@DiscountApprovedBy, @CashierUserId), @TerminalId, 'DISCOUNT_CAP',
                    CONCAT(N'SI ', @ORNumber, N': ', @DiscountCode, N' discount limited to ', @DiscountCap,
                           N' (given ', @DiscountAmount, N'), ', LEFT(ISNULL(@DiscountName, N'?'), 60),
                           N' ', LEFT(ISNULL(@DiscountCtrlNo, N''), 30)));

        -- 35: an SC/PWD discount approved by a supervisor (the branch's or terminal's Discount switch)
        IF @DiscountApprovedBy IS NOT NULL AND @DiscountCode IS NOT NULL AND @DiscountCode <> 'OTHER' AND @DiscountCap IS NULL
            INSERT INTO dbo.AuditLogs (BranchCode, UserId, TerminalId, Action, Detail)
            VALUES (@BranchCode, @DiscountApprovedBy, @TerminalId, 'DISCOUNT_APPROVED',
                    CONCAT(N'SI ', @ORNumber, N': ', @DiscountCode, N' discount ', @DiscountAmount, N', ',
                           LEFT(ISNULL(@DiscountName, N'?'), 60), N' ', LEFT(ISNULL(@DiscountCtrlNo, N''), 30)));

        -- 35: lines removed from the cart with a supervisor's approval (they never reach SaleItems)
        IF @CancelledLines IS NOT NULL AND ISJSON(@CancelledLines) = 1
            INSERT INTO dbo.AuditLogs (BranchCode, UserId, TerminalId, Action, Detail)
            SELECT TOP (200) @BranchCode, ISNULL(j.ApprovedBy, @CashierUserId), @TerminalId, 'LINE_CANCEL',
                   CONCAT(N'SI ', @ORNumber, N': removed ', LEFT(ISNULL(j.ProductName, N'?'), 60), N' ',
                          j.Quantity, N' x ', j.UnitPrice, N' (cashier ', @CashierUserId, N')')
            FROM OPENJSON(@CancelledLines) WITH (ProductName NVARCHAR(150) '$.productName',
                 Quantity DECIMAL(18,3) '$.quantity', UnitPrice DECIMAL(18,2) '$.unitPrice', ApprovedBy INT '$.approvedBy') j;

        -- the senior's own items: lines where only part of the quantity got the SC/PWD discount
        IF @DiscountLines IS NOT NULL AND ISJSON(@DiscountLines) = 1 AND @DiscountCode IS NOT NULL AND @DiscountCode <> 'OTHER'
            INSERT INTO dbo.AuditLogs (BranchCode, UserId, TerminalId, Action, Detail)
            SELECT TOP (200) @BranchCode, ISNULL(@DiscountApprovedBy, @CashierUserId), @TerminalId, 'DISCOUNT_QTY',
                   CONCAT(N'SI ', @ORNumber, N': ', @DiscountCode, N' on ', j.DiscountQty, N' of ', j.Quantity, N' ',
                          LEFT(ISNULL(j.ProductName, N'?'), 60), N' (line ', j.[LineNo], N', cashier ', @CashierUserId, N')')
            FROM OPENJSON(@DiscountLines) WITH ([LineNo] INT '$.lineNo', ProductName NVARCHAR(150) '$.productName',
                 Quantity DECIMAL(18,3) '$.quantity', DiscountQty DECIMAL(18,3) '$.discountQty') j;

        -- a zero-rated sale (28_zero_rated_sales.sql): who approved it, for the audit
        IF NULLIF(LTRIM(RTRIM(@ZeroRatedCertNo)), N'') IS NOT NULL
            INSERT INTO dbo.AuditLogs (BranchCode, UserId, TerminalId, Action, Detail)
            VALUES (@BranchCode, ISNULL(@ZeroRatedApprovedBy, @CashierUserId), @TerminalId, 'ZERO_RATED',
                    CONCAT(N'SI ', @ORNumber, N': zero-rated ', @ZeroRatedAmount, N' to ',
                           LEFT(ISNULL(@CustomerName, N'?'), 60), N' (TIN ', ISNULL(@CustomerTin, '?'),
                           N', cert/ID ', LEFT(@ZeroRatedCertNo, 50), N')'));

        INSERT INTO dbo.SaleItems (SaleUid, BranchCode, [LineNo], ProductId, Barcode, ProductName,
            CategoryId, Quantity, UnitPrice, OrigUnitPrice, LineDiscount, LineTotal, IsVatable, IsDiscountable,
            NetAmount, VatableAmount, VatAmount, VatExemptAmount, ZeroRatedAmount, VatAdjustment, PriceApprovedBy)
        SELECT @SaleUid, @BranchCode, [LineNo], ProductId, Barcode, ProductName, CategoryId,
               Quantity, UnitPrice, OrigUnitPrice, LineDiscount, LineTotal, IsVatable, IsDiscountable,
               ISNULL(NetAmount, 0), ISNULL(VatableAmount, 0), ISNULL(VatAmount, 0),
               ISNULL(VatExemptAmount, 0), ISNULL(ZeroRatedAmount, 0), ISNULL(VatAdjustment, 0),
               CASE WHEN UnitPrice <> OrigUnitPrice THEN PriceApprovedBy END
        FROM @Items;

        -- 33: the lines sold at a wholesale price, for the DTI wholesale report. The wholesale
        -- price is the line's own price before any supervisor change (OrigUnitPrice).
        IF @WholesaleLines IS NOT NULL AND ISJSON(@WholesaleLines) = 1
            INSERT INTO dbo.SaleItemWholesale (SaleUid, [LineNo], ProductId, Quantity, RegularPrice, AmountOff,
                WholesalePrice, MinQty, ItemTotalQty)
            SELECT @SaleUid, i.[LineNo], i.ProductId, i.Quantity, j.RegularPrice, j.AmountOff, i.OrigUnitPrice,
                   j.MinQty, ISNULL(j.ItemTotalQty, i.Quantity)
            FROM OPENJSON(@WholesaleLines) WITH ([LineNo] INT '$.lineNo', RegularPrice DECIMAL(18,2) '$.regularPrice',
                     AmountOff DECIMAL(18,2) '$.amountOff', MinQty DECIMAL(18,3) '$.minQty',
                     ItemTotalQty DECIMAL(18,3) '$.itemTotalQty') j
            JOIN @Items i ON i.[LineNo] = j.[LineNo]
            WHERE j.AmountOff > 0 AND j.RegularPrice > 0 AND j.MinQty > 0;

        -- 34: the lines with promo-free units, for the promo report
        IF @PromoLines IS NOT NULL AND ISJSON(@PromoLines) = 1
            INSERT INTO dbo.SaleItemPromo (SaleUid, [LineNo], PromoId, PromoName, FreeQty, RegularPrice, PromoAmount)
            SELECT @SaleUid, i.[LineNo], j.PromoId, LEFT(ISNULL(j.PromoName, N'Promo'), 40), j.FreeQty, j.RegularPrice, j.PromoAmount
            FROM OPENJSON(@PromoLines) WITH ([LineNo] INT '$.lineNo', PromoId INT '$.promoId', PromoName NVARCHAR(60) '$.promoName',
                     FreeQty DECIMAL(18,3) '$.freeQty', RegularPrice DECIMAL(18,2) '$.regularPrice',
                     PromoAmount DECIMAL(18,2) '$.promoAmount') j
            JOIN @Items i ON i.[LineNo] = j.[LineNo]
            WHERE j.PromoAmount > 0 AND j.FreeQty > 0 AND j.PromoId IS NOT NULL;

        -- A terminal that posts to the ERP queues the sale (and, if it was voided offline, the
        -- void right after it). ErpPostingService sends them in this order.
        IF EXISTS (SELECT 1 FROM dbo.Terminals WHERE TerminalId = @TerminalId AND PostToErp = 1)
        BEGIN
            INSERT INTO dbo.ErpOutbox (Kind, RefUid, BranchCode, TerminalId, BusinessDate)
            VALUES ('SALE', @SaleUid, @BranchCode, @TerminalId, @BusinessDate);
            IF @Status = 'Voided'
                INSERT INTO dbo.ErpOutbox (Kind, RefUid, BranchCode, TerminalId, BusinessDate)
                VALUES ('VOID', @SaleUid, @BranchCode, @TerminalId, @BusinessDate);
        END

        -- Every price changed at the till is logged (once: a re-synced sale returns above).
        INSERT INTO dbo.AuditLogs (BranchCode, UserId, TerminalId, Action, Detail)
        SELECT @BranchCode, @CashierUserId, @TerminalId, 'PRICE_EDIT',
               CONCAT(N'SI ', RIGHT(REPLICATE('0', 18) + CAST(@ORNumber AS VARCHAR(18)), 18), N' line ', [LineNo], N' ',
                      Barcode, N' ', ProductName, N': ', OrigUnitPrice, N' -> ', UnitPrice,
                      N', approved by userId ', ISNULL(CAST(PriceApprovedBy AS NVARCHAR(20)), N'(none)'))
        FROM @Items WHERE UnitPrice <> OrigUnitPrice;

        IF @GiftCerts IS NULL OR COL_LENGTH('dbo.SalePayments', 'GcNo') IS NULL
            INSERT INTO dbo.SalePayments (SaleUid, BranchCode, SeqNo, PaymentType, Amount,
                CardNo, CardBank, CardRefNo, CardName)
            SELECT @SaleUid, @BranchCode, SeqNo, PaymentType, Amount,
                   CardNo, CardBank, CardRefNo, CardName
            FROM @Payments;
        ELSE
        BEGIN
            /* 38: gift certificates. The sale stands whatever the register says (the invoice is
               printed, and it may have been sold offline); a GC that isn't good is flagged for
               review (GcCheck, audit GC_REVIEW). A GC the till took in is used up either way. */
            INSERT INTO dbo.SalePayments (SaleUid, BranchCode, SeqNo, PaymentType, Amount,
                CardNo, CardBank, CardRefNo, CardName, GcNo, GcValue)
            SELECT @SaleUid, @BranchCode, p.SeqNo, p.PaymentType, p.Amount,
                   p.CardNo, p.CardBank, p.CardRefNo, p.CardName,
                   CASE WHEN p.PaymentType = 'GC' THEN NULLIF(LEFT(LTRIM(RTRIM(j.GcNo)), 30), N'') END,
                   CASE WHEN p.PaymentType = 'GC' THEN j.FaceValue END
            FROM @Payments p
            LEFT JOIN OPENJSON(CASE WHEN ISJSON(@GiftCerts) = 1 THEN @GiftCerts ELSE N'[]' END)
                 WITH (SeqNo INT '$.seqNo', GcNo NVARCHAR(60) '$.gcNo', FaceValue DECIMAL(18,2) '$.faceValue') j
                 ON j.SeqNo = p.SeqNo;

            ;WITH x AS (
                SELECT sp.GcCheck, sp.GcNo, sp.GcValue, sp.Amount, g.GcId, g.Status, g.ExpiryDate, g.FaceValue,
                       g.BranchCode AS GcBranch,
                       ROW_NUMBER() OVER (PARTITION BY sp.GcNo ORDER BY sp.SeqNo) AS Rn
                FROM dbo.SalePayments sp
                LEFT JOIN dbo.GiftCertificates g WITH (UPDLOCK, HOLDLOCK) ON g.GcNo = sp.GcNo
                WHERE sp.SaleUid = @SaleUid AND sp.PaymentType = 'GC')
            UPDATE x SET GcCheck = CASE
                WHEN GcNo IS NULL OR GcId IS NULL THEN 'UNKNOWN'
                WHEN Status = 'Cancelled' THEN 'CANCELLED'
                WHEN Status = 'Redeemed' OR Rn > 1 THEN 'USED'          -- used before, or twice on this sale
                WHEN ExpiryDate < @BusinessDate THEN 'EXPIRED'
                WHEN GcBranch IS NOT NULL AND GcBranch <> @BranchCode THEN 'BRANCH'
                WHEN GcValue IS NULL OR GcValue <> FaceValue OR Amount > FaceValue THEN 'VALUE'
                ELSE 'OK' END;

            IF @Status = 'Completed'
                UPDATE g SET Status = 'Redeemed', RedeemedSaleUid = @SaleUid, RedeemedAt = @SaleDateTime,
                             RedeemedBranch = @BranchCode
                FROM dbo.GiftCertificates g
                JOIN dbo.SalePayments sp ON sp.GcNo = g.GcNo AND sp.SaleUid = @SaleUid AND sp.PaymentType = 'GC'
                WHERE g.Status = 'Active';

            INSERT INTO dbo.AuditLogs (BranchCode, UserId, TerminalId, Action, Detail)
            SELECT @BranchCode, @CashierUserId, @TerminalId, 'GC_REVIEW',
                   CONCAT(N'SI ', @ORNumber, N': gift certificate ', ISNULL(GcNo, N'(no number)'), N' ', GcCheck,
                          N', paid ', Amount, N' of face value ', ISNULL(CAST(GcValue AS NVARCHAR(20)), N'?'))
            FROM dbo.SalePayments
            WHERE SaleUid = @SaleUid AND PaymentType = 'GC' AND GcCheck <> 'OK';
        END

        -- E-invoice copy (a sale voided before it ever synced gets none).
        IF @Status = 'Completed'
            EXEC dbo.sp_QueueInvoiceEmail @Kind = 'SALE', @RefUid = @SaleUid, @BranchCode = @BranchCode,
                 @CustomerEmail = @CustomerEmail;

        -- Points (a sale voided before it ever synced earns none).
        IF @CardId IS NOT NULL AND @Status = 'Completed'
            EXEC dbo.sp_LoyaltyEarn @SaleUid = @SaleUid, @CardId = @CardId, @NetAmount = @NetAmount,
                 @BranchCode = @BranchCode, @UserId = @CashierUserId;
    COMMIT;
END
GO

/* ---------- RETURN TRANSACTION (BIR: tagged RETURN, quotes the Ref SI No.) ----------
   Refunds part or all of an earlier invoice, in cash, out of the current shift's drawer.
   Each returned line refunds its proportional share of that line's stored BIR breakdown
   (SaleItems.NetAmount/VatableAmount/...): share = round(x * returnedSoFarAfter / qty)
   - round(x * returnedSoFarBefore / qty), so returning a line in several goes adds up to
   exactly the original. @Commit = 0 is a preview: computes, writes nothing, takes no number.
   On commit the return gets the terminal's next 6-digit number (Terminals.LastReturnNo,
   gap-free because it's taken inside this transaction) and '######' in @ReceiptText becomes
   that number (first occurrence only), so the stored text is exactly what prints. Idempotent by @ReturnUid. */
CREATE OR ALTER PROCEDURE dbo.sp_ProcessReturn
    @ReturnUid UNIQUEIDENTIFIER, @OrigSaleUid UNIQUEIDENTIFIER, @ShiftUid UNIQUEIDENTIFIER,
    @CashierUserId INT, @ApprovedByUserId INT, @Reason NVARCHAR(200),
    @Items dbo.TVP_ReturnItem READONLY,
    @ReturnDateTime DATETIME2 = NULL, @ExpectedNet DECIMAL(18,2) = NULL,
    @ReceiptText NVARCHAR(MAX) = NULL, @Commit BIT = 1
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;

    IF @Commit = 1 AND EXISTS (SELECT 1 FROM dbo.SaleReturns WHERE ReturnUid = @ReturnUid)
    BEGIN
        SELECT * FROM dbo.SaleReturns WHERE ReturnUid = @ReturnUid;
        SELECT * FROM dbo.SaleReturnItems WHERE ReturnUid = @ReturnUid ORDER BY [LineNo];
        RETURN;
    END

    /* A preview only reads, so it opens no transaction of its own (a ROLLBACK here would
       also undo a caller's transaction). */
    IF @Commit = 1 BEGIN TRAN;
        DECLARE @Branch VARCHAR(10), @TerminalId INT, @BusinessDate DATE, @ShiftStatus VARCHAR(15);
        SELECT @Branch = BranchCode, @TerminalId = TerminalId, @BusinessDate = BusinessDate, @ShiftStatus = Status
        FROM dbo.Shifts WITH (UPDLOCK) WHERE ShiftUid = @ShiftUid;
        IF @Branch IS NULL THROW 51201, 'Shift not found.', 1;
        IF @ShiftStatus <> 'Open' THROW 51202, 'A return needs an open shift.', 1;
        IF EXISTS (SELECT 1 FROM dbo.ZReads WHERE TerminalId = @TerminalId AND BusinessDate = @BusinessDate)
            THROW 51203, 'Business date already closed by End of Day.', 1;

        DECLARE @OrigBranch VARCHAR(10), @OrigTerminal INT, @OrigOR BIGINT, @OrigStatus VARCHAR(12);
        SELECT @OrigBranch = BranchCode, @OrigTerminal = TerminalId, @OrigOR = ORNumber, @OrigStatus = Status
        FROM dbo.Sales WITH (UPDLOCK) WHERE SaleUid = @OrigSaleUid;
        IF @OrigBranch IS NULL THROW 51204, 'The original sales invoice was not found.', 1;
        IF @OrigBranch <> @Branch THROW 51205, 'An invoice can only be returned at the branch that issued it.', 1;
        IF @OrigStatus <> 'Completed' THROW 51206, 'A voided invoice cannot be returned.', 1;
        IF @Commit = 1 AND LEN(LTRIM(RTRIM(ISNULL(@Reason, N'')))) = 0 THROW 51213, 'Enter the reason for the return.', 1;

        IF NOT EXISTS (SELECT 1 FROM @Items WHERE Quantity > 0)
            THROW 51207, 'Pick at least one item to return.', 1;
        IF EXISTS (SELECT [LineNo] FROM @Items GROUP BY [LineNo] HAVING COUNT(*) > 1)
            THROW 51208, 'An invoice line is listed twice.', 1;
        IF EXISTS (SELECT 1 FROM @Items r
                   LEFT JOIN dbo.SaleItems si ON si.SaleUid = @OrigSaleUid AND si.[LineNo] = r.[LineNo]
                   WHERE si.SaleItemId IS NULL)
            THROW 51209, 'An item is not on the original invoice.', 1;
        IF EXISTS (SELECT 1 FROM @Items r
                   JOIN dbo.SaleItems si WITH (UPDLOCK) ON si.SaleUid = @OrigSaleUid AND si.[LineNo] = r.[LineNo]
                   WHERE r.Quantity < 0 OR r.Quantity > si.Quantity - si.ReturnedQty)
            THROW 51210, 'You can''t return more than was sold (less what was already returned).', 1;
        IF EXISTS (SELECT 1 FROM @Items r
                   JOIN dbo.SaleItems si ON si.SaleUid = @OrigSaleUid AND si.[LineNo] = r.[LineNo]
                   WHERE r.Quantity > 0 AND si.LineTotal <> 0 AND si.NetAmount = 0
                     AND si.VatableAmount = 0 AND si.VatExemptAmount = 0 AND si.ZeroRatedAmount = 0)
            THROW 51211, 'This invoice was issued before per-line VAT figures were kept, so it can''t be returned here.', 1;

        DECLARE @L TABLE ([LineNo] INT PRIMARY KEY, ProductId INT, Barcode NVARCHAR(50), ProductName NVARCHAR(150),
            CategoryId INT, Quantity DECIMAL(18,3), UnitPrice DECIMAL(18,2), LineTotal DECIMAL(18,2),
            LineDiscount DECIMAL(18,2), NetAmount DECIMAL(18,2), VatableAmount DECIMAL(18,2), VatAmount DECIMAL(18,2),
            VatExemptAmount DECIMAL(18,2), ZeroRatedAmount DECIMAL(18,2), VatAdjustment DECIMAL(18,2),
            IsVatable BIT, IsDiscountable BIT);
        INSERT INTO @L
        SELECT si.[LineNo], si.ProductId, si.Barcode, si.ProductName, si.CategoryId, r.Quantity, si.UnitPrice,
            ROUND(si.LineTotal       * (si.ReturnedQty + r.Quantity) / si.Quantity, 2) - ROUND(si.LineTotal       * si.ReturnedQty / si.Quantity, 2),
            ROUND(si.LineDiscount    * (si.ReturnedQty + r.Quantity) / si.Quantity, 2) - ROUND(si.LineDiscount    * si.ReturnedQty / si.Quantity, 2),
            ROUND(si.NetAmount       * (si.ReturnedQty + r.Quantity) / si.Quantity, 2) - ROUND(si.NetAmount       * si.ReturnedQty / si.Quantity, 2),
            ROUND(si.VatableAmount   * (si.ReturnedQty + r.Quantity) / si.Quantity, 2) - ROUND(si.VatableAmount   * si.ReturnedQty / si.Quantity, 2),
            ROUND(si.VatAmount       * (si.ReturnedQty + r.Quantity) / si.Quantity, 2) - ROUND(si.VatAmount       * si.ReturnedQty / si.Quantity, 2),
            ROUND(si.VatExemptAmount * (si.ReturnedQty + r.Quantity) / si.Quantity, 2) - ROUND(si.VatExemptAmount * si.ReturnedQty / si.Quantity, 2),
            ROUND(si.ZeroRatedAmount * (si.ReturnedQty + r.Quantity) / si.Quantity, 2) - ROUND(si.ZeroRatedAmount * si.ReturnedQty / si.Quantity, 2),
            ROUND(si.VatAdjustment   * (si.ReturnedQty + r.Quantity) / si.Quantity, 2) - ROUND(si.VatAdjustment   * si.ReturnedQty / si.Quantity, 2),
            si.IsVatable, si.IsDiscountable
        FROM @Items r
        JOIN dbo.SaleItems si ON si.SaleUid = @OrigSaleUid AND si.[LineNo] = r.[LineNo]
        WHERE r.Quantity > 0;

        DECLARE @Gross DECIMAL(18,2), @Disc DECIMAL(18,2), @Net DECIMAL(18,2), @Vatable DECIMAL(18,2),
            @Vat DECIMAL(18,2), @Exempt DECIMAL(18,2), @Zero DECIMAL(18,2), @Adj DECIMAL(18,2);
        SELECT @Gross = SUM(LineTotal), @Disc = SUM(LineDiscount), @Net = SUM(NetAmount),
            @Vatable = SUM(VatableAmount), @Vat = SUM(VatAmount), @Exempt = SUM(VatExemptAmount),
            @Zero = SUM(ZeroRatedAmount), @Adj = SUM(VatAdjustment)
        FROM @L;

        IF @Commit = 0
        BEGIN
            SELECT CAST(NULL AS INT) AS ReturnNo, @OrigSaleUid AS OrigSaleUid, @OrigTerminal AS OrigTerminalId,
                @OrigOR AS OrigORNumber, @Gross AS GrossAmount, @Disc AS DiscountAmount, @Vatable AS VatableAmount,
                @Vat AS VatAmount, @Exempt AS VatExemptAmount, @Zero AS ZeroRatedAmount, @Adj AS VatAdjustment,
                @Net AS NetAmount;
            SELECT * FROM @L ORDER BY [LineNo];
            RETURN;
        END

        IF @ExpectedNet IS NOT NULL AND @ExpectedNet <> @Net
            THROW 51212, 'The refund changed since it was shown (was part of this invoice just returned elsewhere?). Review it again.', 1;

        DECLARE @No INT;
        SELECT @No = LastReturnNo + 1 FROM dbo.Terminals WITH (UPDLOCK) WHERE TerminalId = @TerminalId;
        IF @No > 999999 THROW 51214, 'This terminal has used every 6-digit return number.', 1;
        UPDATE dbo.Terminals SET LastReturnNo = @No WHERE TerminalId = @TerminalId;

        DECLARE @NoText CHAR(6) = RIGHT('000000' + CAST(@No AS VARCHAR(6)), 6);
        INSERT INTO dbo.SaleReturns (ReturnUid, ReturnNo, BranchCode, TerminalId, ShiftUid, BusinessDate,
            ReturnDateTime, CashierUserId, ApprovedByUserId, OrigSaleUid, OrigTerminalId, OrigORNumber,
            GrossAmount, DiscountAmount, VatableAmount, VatAmount, VatExemptAmount, ZeroRatedAmount,
            VatAdjustment, NetAmount, Reason, ReceiptText)
        VALUES (@ReturnUid, @No, @Branch, @TerminalId, @ShiftUid, @BusinessDate,
            ISNULL(@ReturnDateTime, SYSDATETIME()), @CashierUserId, @ApprovedByUserId, @OrigSaleUid, @OrigTerminal, @OrigOR,
            @Gross, @Disc, @Vatable, @Vat, @Exempt, @Zero, @Adj, @Net, LTRIM(RTRIM(@Reason)),
            CASE WHEN CHARINDEX('######', @ReceiptText) > 0   -- first occurrence only: the Return No. line
                 THEN STUFF(@ReceiptText, CHARINDEX('######', @ReceiptText), 6, @NoText) ELSE @ReceiptText END);

        INSERT INTO dbo.SaleReturnItems (ReturnUid, [LineNo], ProductId, Barcode, ProductName, CategoryId,
            Quantity, UnitPrice, LineTotal, LineDiscount, NetAmount, VatableAmount, VatAmount,
            VatExemptAmount, ZeroRatedAmount, VatAdjustment, IsVatable, IsDiscountable)
        SELECT @ReturnUid, [LineNo], ProductId, Barcode, ProductName, CategoryId,
            Quantity, UnitPrice, LineTotal, LineDiscount, NetAmount, VatableAmount, VatAmount,
            VatExemptAmount, ZeroRatedAmount, VatAdjustment, IsVatable, IsDiscountable
        FROM @L;

        UPDATE si SET ReturnedQty = si.ReturnedQty + l.Quantity
        FROM dbo.SaleItems si JOIN @L l ON l.[LineNo] = si.[LineNo]
        WHERE si.SaleUid = @OrigSaleUid;

        -- A terminal that posts to the ERP sends the return too. If the original sale never went
        -- to the ERP (sold in trial mode), the ERP can't take it: listed for attention right away.
        IF EXISTS (SELECT 1 FROM dbo.Terminals WHERE TerminalId = @TerminalId AND PostToErp = 1)
            INSERT INTO dbo.ErpOutbox (Kind, RefUid, BranchCode, TerminalId, BusinessDate, Status, LastError)
            SELECT 'RETURN', @ReturnUid, @Branch, @TerminalId, @BusinessDate,
                   CASE WHEN EXISTS (SELECT 1 FROM dbo.ErpOutbox WHERE Kind = 'SALE' AND RefUid = @OrigSaleUid)
                        THEN 'Pending' ELSE 'Failed' END,
                   CASE WHEN EXISTS (SELECT 1 FROM dbo.ErpOutbox WHERE Kind = 'SALE' AND RefUid = @OrigSaleUid)
                        THEN NULL ELSE N'The original sale was never sent to the ERP (sold before this terminal posted), so the ERP can''t take this return. Head office handles the stock and sales there.' END;

        -- E-invoice copy of the return receipt: to the original sale's customer email, if any.
        EXEC dbo.sp_LoyaltyTakeBack @SaleUid = @OrigSaleUid, @Kind = 'RETURN', @RefUid = @ReturnUid, @UserId = @CashierUserId;

        DECLARE @OrigEmail NVARCHAR(254) = (SELECT CustomerEmail FROM dbo.Sales WHERE SaleUid = @OrigSaleUid);
        EXEC dbo.sp_QueueInvoiceEmail @Kind = 'RETURN', @RefUid = @ReturnUid, @BranchCode = @Branch,
             @CustomerEmail = @OrigEmail;
    COMMIT;

    SELECT * FROM dbo.SaleReturns WHERE ReturnUid = @ReturnUid;
    SELECT * FROM dbo.SaleReturnItems WHERE ReturnUid = @ReturnUid ORDER BY [LineNo];
END
GO

/* ---------- BLIND CLOSE: computes Short/Over server-side, returns nothing ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_ProcessBlindClose
    @ShiftUid UNIQUEIDENTIFIER, @DeclaredCash DECIMAL(18,2), @DenominationsJson NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    BEGIN TRAN;
        DECLARE @CashBegin DECIMAL(18,2), @Status VARCHAR(15), @Branch VARCHAR(10);
        SELECT @CashBegin = CashBegin, @Status = Status, @Branch = BranchCode
        FROM dbo.Shifts WITH (UPDLOCK) WHERE ShiftUid = @ShiftUid;

        IF @CashBegin IS NULL THROW 51001, 'Shift not found.', 1;
        IF @Status <> 'Open'  THROW 51002, 'Shift is not open.', 1;

        /* Only CASH tenders count toward the drawer. Card sales are excluded. */
        DECLARE @CashSales DECIMAL(18,2) = ISNULL((
            SELECT SUM(sp.Amount) FROM dbo.SalePayments sp
            JOIN dbo.Sales s ON s.SaleUid = sp.SaleUid
            WHERE s.ShiftUid = @ShiftUid AND s.Status = 'Completed' AND sp.PaymentType = 'CASH'), 0);
        DECLARE @CardSales DECIMAL(18,2) = ISNULL((
            SELECT SUM(sp.Amount) FROM dbo.SalePayments sp
            JOIN dbo.Sales s ON s.SaleUid = sp.SaleUid
            WHERE s.ShiftUid = @ShiftUid AND s.Status = 'Completed' AND sp.PaymentType = 'CARD'), 0);
        DECLARE @Change DECIMAL(18,2) = ISNULL((
            SELECT SUM(ChangeAmount) FROM dbo.Sales
            WHERE ShiftUid = @ShiftUid AND Status = 'Completed'), 0);

        /* Return transactions are refunded in cash, out of this drawer. */
        DECLARE @Refunds DECIMAL(18,2) = ISNULL((
            SELECT SUM(NetAmount) FROM dbo.SaleReturns WHERE ShiftUid = @ShiftUid), 0);

        DECLARE @Expected DECIMAL(18,2) = @CashBegin + @CashSales - @Change - @Refunds;

        INSERT INTO dbo.ShiftClosings (ShiftUid, BranchCode, DeclaredCash, ExpectedCash,
            CashSales, CardSales, ShortOver, CashRefunds, DenominationsJson)
        VALUES (@ShiftUid, @Branch, @DeclaredCash, @Expected,
            @CashSales, @CardSales, @DeclaredCash - @Expected, @Refunds, @DenominationsJson);

        UPDATE dbo.Shifts SET Status = 'BlindClosed', ClosedAt = SYSDATETIME() WHERE ShiftUid = @ShiftUid;
    COMMIT;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_GetShiftVariance   /* Supervisor/Admin only */
    @ShiftUid UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.ShiftUid, s.BranchCode, t.TerminalCode, u.FullName AS Cashier, s.BusinessDate,
           s.CashBegin, c.CashSales, c.CardSales, c.CashRefunds, c.DeclaredCash, c.ExpectedCash, c.ShortOver,
           c.DenominationsJson, c.ClosedAt,
           -- the printed report lists what isn't in the drawer (the change it works out from the figures above)
           (SELECT ISNULL(SUM(p.Amount), 0) FROM dbo.SalePayments p JOIN dbo.Sales x ON x.SaleUid = p.SaleUid
            WHERE x.ShiftUid = c.ShiftUid AND x.Status = 'Completed' AND p.PaymentType = 'GC') AS GcSales
    FROM dbo.ShiftClosings c
    JOIN dbo.Shifts s ON s.ShiftUid = c.ShiftUid
    JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    JOIN dbo.Users u ON u.UserId = s.CashierUserId
    WHERE c.ShiftUid = @ShiftUid;
END
GO

/* ---------- X-READ ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_rpt_XRead
    @ShiftUid UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BranchCode, b.BranchName, t.TerminalCode, u.FullName AS Cashier,
        s.BusinessDate, s.CashBegin, s.OpenedAt,
        COUNT(CASE WHEN sa.Status='Completed' THEN 1 END) AS TxnCount,
        COUNT(CASE WHEN sa.Status='Voided'    THEN 1 END) AS VoidCount,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.GrossAmount     END),0) AS GrossSales,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.DiscountAmount  END),0) AS TotalDiscounts,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.NetAmount       END),0) AS NetSales,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.VatableAmount   END),0) AS VatableAmount,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.VatAmount       END),0) AS VatAmount,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.VatExemptAmount END),0) AS VatExemptAmount,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.ZeroRatedAmount END),0) AS ZeroRatedAmount,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' AND sa.DiscountCode='SENIOR' THEN sa.DiscountAmount - sa.PromoAmount END),0) AS DiscSenior,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' AND sa.DiscountCode='PWD'    THEN sa.DiscountAmount - sa.PromoAmount END),0) AS DiscPwd,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' AND sa.DiscountCode='NAAC'   THEN sa.DiscountAmount - sa.PromoAmount END),0) AS DiscNaac,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' AND sa.DiscountCode='MOV'    THEN sa.DiscountAmount - sa.PromoAmount END),0) AS DiscMov,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' AND sa.DiscountCode='SOLO'   THEN sa.DiscountAmount - sa.PromoAmount END),0) AS DiscSolo,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' AND sa.DiscountCode='OTHER'  THEN sa.DiscountAmount - sa.PromoAmount END),0) AS DiscOther,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.PromoAmount END),0) AS DiscPromo,   -- 34: Buy N Take M
        ISNULL((SELECT SUM(p.Amount) FROM dbo.SalePayments p JOIN dbo.Sales x ON x.SaleUid=p.SaleUid
                WHERE x.ShiftUid=@ShiftUid AND x.Status='Completed' AND p.PaymentType='CASH'),0) AS CashSales,
        ISNULL((SELECT SUM(p.Amount) FROM dbo.SalePayments p JOIN dbo.Sales x ON x.SaleUid=p.SaleUid
                WHERE x.ShiftUid=@ShiftUid AND x.Status='Completed' AND p.PaymentType='CARD'),0) AS CardSales,
        ISNULL((SELECT SUM(p.Amount) FROM dbo.SalePayments p JOIN dbo.Sales x ON x.SaleUid=p.SaleUid
                WHERE x.ShiftUid=@ShiftUid AND x.Status='Completed' AND p.PaymentType='GC'),0) AS GcSales,   -- 38
        (SELECT COUNT(*) FROM dbo.DrawerOpens d WHERE d.ShiftUid = @ShiftUid) AS DrawerOpens,   -- 39: no-sale openings
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.ChangeAmount END),0) AS ChangeGiven,   -- printed: cash received less change
        ISNULL(SUM(CASE WHEN sa.Status='Voided' THEN sa.NetAmount END),0) AS VoidAmount,
        MIN(sa.ORNumber) AS BeginningOR,
        MAX(sa.ORNumber) AS EndingOR,
        (SELECT COUNT(*) FROM dbo.SaleReturns r WHERE r.ShiftUid = @ShiftUid) AS ReturnCount,
        ISNULL((SELECT SUM(r.NetAmount) FROM dbo.SaleReturns r WHERE r.ShiftUid = @ShiftUid),0) AS ReturnAmount,
        (SELECT MIN(r.ReturnNo) FROM dbo.SaleReturns r WHERE r.ShiftUid = @ShiftUid) AS BeginningReturnNo,
        (SELECT MAX(r.ReturnNo) FROM dbo.SaleReturns r WHERE r.ShiftUid = @ShiftUid) AS EndingReturnNo
    FROM dbo.Shifts s
    JOIN dbo.Branches b ON b.BranchCode = s.BranchCode
    JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    JOIN dbo.Users u ON u.UserId = s.CashierUserId
    LEFT JOIN dbo.Sales sa ON sa.ShiftUid = s.ShiftUid
    WHERE s.ShiftUid = @ShiftUid
    GROUP BY s.BranchCode, b.BranchName, t.TerminalCode, u.FullName, s.BusinessDate, s.CashBegin, s.OpenedAt;
END
GO

/* ---------- END OF DAY / Z-READ ----------
   Callable by cashier (own terminal), by the same cashier signing back in,
   or by Admin remotely. Always requires an approver (enforced in the API). */
CREATE OR ALTER PROCEDURE dbo.sp_ProcessEndOfDay
    @TerminalId INT, @BusinessDate DATE,
    @ClosedByUserId INT, @ApprovedByUserId INT, @Remarks NVARCHAR(200) = NULL
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    BEGIN TRAN;
        IF EXISTS (SELECT 1 FROM dbo.ZReads WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate)
            THROW 51003, 'End of Day already processed for this terminal and date.', 1;
        IF EXISTS (SELECT 1 FROM dbo.Shifts WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate AND Status='Open')
            THROW 51004, 'An open shift exists. Blind-close all shifts first.', 1;
        IF NOT EXISTS (SELECT 1 FROM dbo.Shifts WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate)
            THROW 51005, 'No shift was opened on this terminal for that date, so there is no day to close.', 1;
        DECLARE @Earlier DATE = (SELECT MIN(s.BusinessDate) FROM dbo.Shifts s
            WHERE s.TerminalId = @TerminalId AND s.BusinessDate < @BusinessDate
              AND NOT EXISTS (SELECT 1 FROM dbo.ZReads z WHERE z.TerminalId = s.TerminalId AND z.BusinessDate = s.BusinessDate));
        IF @Earlier IS NOT NULL
        BEGIN
            DECLARE @EarlierMsg NVARCHAR(200) = CONCAT(N'Business day ', CONVERT(CHAR(10), @Earlier, 23),
                N' on this terminal was never closed. Run its End of Day first.');
            THROW 51013, @EarlierMsg, 1;
        END

        DECLARE @Branch VARCHAR(10), @Old DECIMAL(18,2), @Z INT;
        SELECT @Branch = BranchCode, @Old = GrandTotalSales, @Z = LastZCounter + 1
        FROM dbo.Terminals WITH (UPDLOCK) WHERE TerminalId = @TerminalId;

        DECLARE @Net DECIMAL(18,2) = ISNULL((SELECT SUM(NetAmount) FROM dbo.Sales
            WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate AND Status='Completed'), 0);
        /* The grand total only ever accumulates sales (non-resettable, never goes down).
           Return transactions are reported on their own lines, not netted into it. */
        DECLARE @RetCount INT, @RetAmount DECIMAL(18,2), @RetFirst INT, @RetLast INT;
        SELECT @RetCount = COUNT(*), @RetAmount = SUM(NetAmount), @RetFirst = MIN(ReturnNo), @RetLast = MAX(ReturnNo)
        FROM dbo.SaleReturns WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate;

        INSERT INTO dbo.ZReads (BranchCode, TerminalId, BusinessDate, ZCounter,
            GrossSales, TotalDiscounts, NetSales, VatableAmount, VatAmount, VatExemptAmount, ZeroRatedAmount,
            CashSales, CardSales, DiscSenior, DiscPwd, DiscNaac, DiscMov, DiscSolo, DiscOther, DiscPromo, GcSales, DrawerOpens,
            TxnCount, VoidCount, VoidAmount, BeginningOR, EndingOR,
            OldGrandTotal, NewGrandTotal, ClosedByUserId, ApprovedByUserId, Remarks,
            ReturnCount, ReturnAmount, BeginningReturnNo, EndingReturnNo)
        SELECT @Branch, @TerminalId, @BusinessDate, @Z,
            ISNULL(SUM(CASE WHEN Status='Completed' THEN GrossAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' THEN DiscountAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' THEN NetAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' THEN VatableAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' THEN VatAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' THEN VatExemptAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' THEN ZeroRatedAmount END),0),
            ISNULL((SELECT SUM(p.Amount) FROM dbo.SalePayments p JOIN dbo.Sales x ON x.SaleUid=p.SaleUid
                    WHERE x.TerminalId=@TerminalId AND x.BusinessDate=@BusinessDate
                      AND x.Status='Completed' AND p.PaymentType='CASH'),0),
            ISNULL((SELECT SUM(p.Amount) FROM dbo.SalePayments p JOIN dbo.Sales x ON x.SaleUid=p.SaleUid
                    WHERE x.TerminalId=@TerminalId AND x.BusinessDate=@BusinessDate
                      AND x.Status='Completed' AND p.PaymentType='CARD'),0),
            ISNULL(SUM(CASE WHEN Status='Completed' AND DiscountCode='SENIOR' THEN DiscountAmount - PromoAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' AND DiscountCode='PWD'    THEN DiscountAmount - PromoAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' AND DiscountCode='NAAC'   THEN DiscountAmount - PromoAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' AND DiscountCode='MOV'    THEN DiscountAmount - PromoAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' AND DiscountCode='SOLO'   THEN DiscountAmount - PromoAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' AND DiscountCode='OTHER'  THEN DiscountAmount - PromoAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' THEN PromoAmount END),0),
            ISNULL((SELECT SUM(p.Amount) FROM dbo.SalePayments p JOIN dbo.Sales x ON x.SaleUid=p.SaleUid
                    WHERE x.TerminalId=@TerminalId AND x.BusinessDate=@BusinessDate
                      AND x.Status='Completed' AND p.PaymentType='GC'),0),   -- 38: gift certificates
            (SELECT COUNT(*) FROM dbo.DrawerOpens d JOIN dbo.Shifts sh ON sh.ShiftUid = d.ShiftUid
             WHERE sh.TerminalId = @TerminalId AND sh.BusinessDate = @BusinessDate),   -- 39: drawer opened, no sale
            COUNT(CASE WHEN Status='Completed' THEN 1 END),
            COUNT(CASE WHEN Status='Voided' THEN 1 END),
            ISNULL(SUM(CASE WHEN Status='Voided' THEN NetAmount END),0),
            MIN(ORNumber),   -- every SI issued today, voided ones included
            MAX(ORNumber),
            @Old, @Old + @Net, @ClosedByUserId, @ApprovedByUserId, @Remarks,
            ISNULL(@RetCount, 0), ISNULL(@RetAmount, 0), @RetFirst, @RetLast
        FROM dbo.Sales WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate;

        UPDATE dbo.Terminals
        SET GrandTotalSales = @Old + @Net, LastZCounter = @Z
        WHERE TerminalId = @TerminalId;

        UPDATE dbo.Shifts SET Status='Locked'
        WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate;

        /* ERP posting: close each of the day's shifts that were opened there, then the Z-Read. */
        IF EXISTS (SELECT 1 FROM dbo.Terminals WHERE TerminalId = @TerminalId AND PostToErp = 1)
        BEGIN
            INSERT INTO dbo.ErpOutbox (Kind, RefUid, BranchCode, TerminalId, BusinessDate)
            SELECT 'CLOSE', s.ShiftUid, s.BranchCode, s.TerminalId, s.BusinessDate
            FROM dbo.Shifts s
            WHERE s.TerminalId = @TerminalId AND s.BusinessDate = @BusinessDate
              AND EXISTS (SELECT 1 FROM dbo.ErpOutbox o WHERE o.Kind = 'OPEN' AND o.RefUid = s.ShiftUid)
            ORDER BY s.OpenedAt;
            INSERT INTO dbo.ErpOutbox (Kind, RefUid, BranchCode, TerminalId, BusinessDate)
            SELECT 'ZREAD', z.ZReadUid, z.BranchCode, z.TerminalId, z.BusinessDate
            FROM dbo.ZReads z WHERE z.TerminalId = @TerminalId AND z.BusinessDate = @BusinessDate;
        END

        /* Accounting (Addendum B): post the day's summary entry in this same transaction —
           if posting fails, EOD fails. A no-op unless accounting has been turned on. The
           OBJECT_ID guard keeps EOD working on a DB where 16_accounting.sql never ran. */
        IF OBJECT_ID('acc.sp_PostZReadToLedger', 'P') IS NOT NULL
        BEGIN
            DECLARE @ZReadId INT = (SELECT ZReadId FROM dbo.ZReads
                                    WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate);
            EXEC acc.sp_PostZReadToLedger @ZReadId = @ZReadId;
        END

        SELECT z.*, t.TerminalCode, b.BranchName,
               cu.FullName AS ClosedByName, au.FullName AS ApprovedByName,
               -- printed: cash received less the change handed back (ZReads.CashSales is what was received)
               (SELECT ISNULL(SUM(x.ChangeAmount), 0) FROM dbo.Sales x
                WHERE x.TerminalId = z.TerminalId AND x.BusinessDate = z.BusinessDate AND x.Status = 'Completed') AS ChangeGiven
        FROM dbo.ZReads z
        JOIN dbo.Terminals t ON t.TerminalId = z.TerminalId
        JOIN dbo.Branches b ON b.BranchCode = z.BranchCode
        JOIN dbo.Users cu ON cu.UserId = z.ClosedByUserId
        JOIN dbo.Users au ON au.UserId = z.ApprovedByUserId
        WHERE z.TerminalId=@TerminalId AND z.BusinessDate=@BusinessDate;
    COMMIT;
END
GO

/* ---------- Terminal day state: drives login gating and the EOD-only screen ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_GetTerminalDayState
    @TerminalId INT, @BusinessDate DATE
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @openShifts INT = (SELECT COUNT(*) FROM dbo.Shifts
        WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate AND Status='Open');
    DECLARE @closedShifts INT = (SELECT COUNT(*) FROM dbo.Shifts
        WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate AND Status='BlindClosed');
    DECLARE @eod BIT = CASE WHEN EXISTS (SELECT 1 FROM dbo.ZReads
        WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate) THEN 1 ELSE 0 END;

    -- The earliest earlier business day this terminal never closed (shifts, no Z-Read):
    -- Cash Begin has it closed first (sp_OpenShift refuses a new day until then).
    DECLARE @unclosed DATE = (SELECT MIN(s.BusinessDate) FROM dbo.Shifts s
        WHERE s.TerminalId=@TerminalId AND s.BusinessDate < @BusinessDate
          AND NOT EXISTS (SELECT 1 FROM dbo.ZReads z WHERE z.TerminalId=s.TerminalId AND z.BusinessDate=s.BusinessDate));

    SELECT
        CASE WHEN @eod = 1 THEN 'eodDone'
             WHEN @openShifts = 0 AND @closedShifts > 0 THEN 'eodPending'
             ELSE 'open' END AS DayState,
        @openShifts AS OpenShifts, @closedShifts AS ClosedShifts, @eod AS EodDone,
        (SELECT TOP 1 u.FullName FROM dbo.Shifts s JOIN dbo.Users u ON u.UserId=s.CashierUserId
         WHERE s.TerminalId=@TerminalId AND s.BusinessDate=@BusinessDate
         ORDER BY s.ClosedAt DESC) AS LastCashier,
        @unclosed AS UnclosedDate,
        o.ShiftUid AS UnclosedShiftUid, o.CashierUserId AS UnclosedCashierUserId,
        o.FullName AS UnclosedCashier, o.CashBegin AS UnclosedCashBegin
    FROM (SELECT 1 AS x) one
    OUTER APPLY (SELECT TOP 1 s.ShiftUid, s.CashierUserId, u.FullName, s.CashBegin
                 FROM dbo.Shifts s JOIN dbo.Users u ON u.UserId=s.CashierUserId
                 WHERE s.TerminalId=@TerminalId AND s.BusinessDate=@unclosed AND s.Status='Open') o;
END
GO

/* Terminals with a business date still awaiting EOD (admin recovery list) */
CREATE OR ALTER PROCEDURE dbo.sp_GetPendingEod
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BranchCode, t.TerminalId, t.TerminalCode, s.BusinessDate,
           COUNT(*) AS ShiftCount,
           MAX(u.FullName) AS LastCashier,
           MAX(s.ClosedAt) AS LastClosedAt
    FROM dbo.Shifts s
    JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    JOIN dbo.Users u ON u.UserId = s.CashierUserId
    WHERE s.Status = 'BlindClosed'
      AND NOT EXISTS (SELECT 1 FROM dbo.ZReads z
                      WHERE z.TerminalId = s.TerminalId AND z.BusinessDate = s.BusinessDate)
    GROUP BY s.BranchCode, t.TerminalId, t.TerminalCode, s.BusinessDate
    ORDER BY s.BusinessDate, s.BranchCode;
END
GO

/* ============================ REPORTS ============================ */

CREATE OR ALTER PROCEDURE dbo.sp_rpt_SalesSummary
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL, @TerminalId INT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    /* One row per business date × terminal, everything a Z-Read carries. Sales figures count
       Completed sales only; voids and returns are shown on their own. Cash sales = cash
       received less the change handed back, so Cash + Card + GC = Net sales. Returns are counted on
       the day they were made (refunded in cash out of that day's drawer). */
    WITH pay AS (
        SELECT p.SaleUid,
               SUM(CASE WHEN p.PaymentType = 'CASH' THEN p.Amount ELSE 0 END) AS Cash,
               SUM(CASE WHEN p.PaymentType = 'CARD' THEN p.Amount ELSE 0 END) AS Card,
               SUM(CASE WHEN p.PaymentType = 'GC' THEN p.Amount ELSE 0 END) AS Gc   -- 38: gift certificates
        FROM dbo.SalePayments p JOIN dbo.Sales s ON s.SaleUid = p.SaleUid
        WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo
          AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
          AND (@TerminalId IS NULL OR s.TerminalId = @TerminalId)
        GROUP BY p.SaleUid),
    sal AS (
        SELECT s.BusinessDate, s.BranchCode, s.TerminalId,
            MIN(s.ORNumber) AS BegSI, MAX(s.ORNumber) AS EndSI, COUNT(*) AS InvoiceCount,
            COUNT(CASE WHEN s.Status = 'Completed' THEN 1 END) AS TxnCount,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.GrossAmount ELSE 0 END)    AS GrossSales,
            SUM(CASE WHEN s.Status = 'Completed' AND s.DiscountCode = 'SENIOR' THEN s.DiscountAmount - s.PromoAmount ELSE 0 END) AS DiscSenior,
            SUM(CASE WHEN s.Status = 'Completed' AND s.DiscountCode = 'PWD'    THEN s.DiscountAmount - s.PromoAmount ELSE 0 END) AS DiscPwd,
            SUM(CASE WHEN s.Status = 'Completed' AND s.DiscountCode = 'NAAC'   THEN s.DiscountAmount - s.PromoAmount ELSE 0 END) AS DiscNaac,
            SUM(CASE WHEN s.Status = 'Completed' AND s.DiscountCode = 'MOV'    THEN s.DiscountAmount - s.PromoAmount ELSE 0 END) AS DiscMov,
            SUM(CASE WHEN s.Status = 'Completed' AND s.DiscountCode = 'SOLO'   THEN s.DiscountAmount - s.PromoAmount ELSE 0 END) AS DiscSolo,
            SUM(CASE WHEN s.Status = 'Completed' AND ISNULL(s.DiscountCode, '') NOT IN ('SENIOR','PWD','NAAC','MOV','SOLO')
                     THEN s.DiscountAmount - s.PromoAmount ELSE 0 END) AS DiscOther,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.PromoAmount ELSE 0 END) AS DiscPromo,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.DiscountAmount ELSE 0 END) AS Discounts,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.NetAmount ELSE 0 END)       AS NetSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.VatableAmount ELSE 0 END)   AS VatableSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.VatAmount ELSE 0 END)       AS VatAmount,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.VatExemptAmount ELSE 0 END) AS VatExemptSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.ZeroRatedAmount ELSE 0 END) AS ZeroRatedSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.VatAdjustment ELSE 0 END)   AS VatAdjustment,
            SUM(CASE WHEN s.Status = 'Completed' THEN ISNULL(p.Cash, 0) - s.ChangeAmount ELSE 0 END) AS CashSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN ISNULL(p.Card, 0) ELSE 0 END) AS CardSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN ISNULL(p.Gc, 0) ELSE 0 END) AS GcSales,
            COUNT(CASE WHEN s.Status = 'Completed' AND p.Card > 0 THEN 1 END)        AS CardTxns,
            COUNT(CASE WHEN s.Status = 'Voided' THEN 1 END)                          AS VoidCount,
            SUM(CASE WHEN s.Status = 'Voided' THEN s.NetAmount ELSE 0 END)           AS VoidAmount
        FROM dbo.Sales s LEFT JOIN pay p ON p.SaleUid = s.SaleUid
        WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo
          AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
          AND (@TerminalId IS NULL OR s.TerminalId = @TerminalId)
        GROUP BY s.BusinessDate, s.BranchCode, s.TerminalId),
    ret AS (
        SELECT r.BusinessDate, r.BranchCode, r.TerminalId,
               COUNT(*) AS ReturnCount, SUM(r.NetAmount) AS ReturnAmount
        FROM dbo.SaleReturns r
        WHERE r.BusinessDate BETWEEN @DateFrom AND @DateTo
          AND (@BranchCode IS NULL OR r.BranchCode = @BranchCode)
          AND (@TerminalId IS NULL OR r.TerminalId = @TerminalId)
        GROUP BY r.BusinessDate, r.BranchCode, r.TerminalId)
    SELECT COALESCE(a.BusinessDate, r.BusinessDate) AS BusinessDate,
           COALESCE(a.BranchCode, r.BranchCode) AS BranchCode, t.TerminalCode,
           a.BegSI, a.EndSI, ISNULL(a.InvoiceCount, 0) AS InvoiceCount, ISNULL(a.TxnCount, 0) AS TxnCount,
           ISNULL(a.GrossSales, 0) AS GrossSales,
           ISNULL(a.DiscSenior, 0) AS DiscSenior, ISNULL(a.DiscPwd, 0) AS DiscPwd, ISNULL(a.DiscNaac, 0) AS DiscNaac,
           ISNULL(a.DiscMov, 0) AS DiscMov, ISNULL(a.DiscSolo, 0) AS DiscSolo, ISNULL(a.DiscOther, 0) AS DiscOther,
           ISNULL(a.DiscPromo, 0) AS DiscPromo,
           ISNULL(a.Discounts, 0) AS Discounts,
           ISNULL(a.GrossSales, 0) - ISNULL(a.Discounts, 0) - ISNULL(a.NetSales, 0) AS LessVat,   -- VAT taken off SC/PWD-exempt sales
           ISNULL(a.NetSales, 0) AS NetSales,
           ISNULL(a.VatableSales, 0) AS VatableSales, ISNULL(a.VatAmount, 0) AS VatAmount,
           ISNULL(a.VatExemptSales, 0) AS VatExemptSales, ISNULL(a.ZeroRatedSales, 0) AS ZeroRatedSales,
           ISNULL(a.VatAdjustment, 0) AS VatAdjustment,
           ISNULL(a.CashSales, 0) AS CashSales, ISNULL(a.CardSales, 0) AS CardSales, ISNULL(a.CardTxns, 0) AS CardTxns,
           ISNULL(a.GcSales, 0) AS GcSales,
           ISNULL(a.VoidCount, 0) AS VoidCount, ISNULL(a.VoidAmount, 0) AS VoidAmount,
           ISNULL(r.ReturnCount, 0) AS ReturnCount, ISNULL(r.ReturnAmount, 0) AS ReturnAmount,
           ISNULL(a.NetSales, 0) - ISNULL(r.ReturnAmount, 0) AS NetAfterReturns,
           CAST(CASE WHEN a.TxnCount > 0 THEN a.NetSales / a.TxnCount ELSE 0 END AS DECIMAL(18,2)) AS AvgSale
    FROM sal a
    FULL JOIN ret r ON r.BusinessDate = a.BusinessDate AND r.TerminalId = a.TerminalId
    JOIN dbo.Terminals t ON t.TerminalId = COALESCE(a.TerminalId, r.TerminalId)
    ORDER BY BusinessDate, BranchCode, t.TerminalCode;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_BranchComparison
    @DateFrom DATE, @DateTo DATE
AS
BEGIN
    SET NOCOUNT ON;
    WITH pay AS (
        SELECT p.SaleUid,
               SUM(CASE WHEN p.PaymentType = 'CASH' THEN p.Amount ELSE 0 END) AS Cash,
               SUM(CASE WHEN p.PaymentType = 'CARD' THEN p.Amount ELSE 0 END) AS Card,
               SUM(CASE WHEN p.PaymentType = 'GC' THEN p.Amount ELSE 0 END) AS Gc   -- 38: gift certificates
        FROM dbo.SalePayments p JOIN dbo.Sales s ON s.SaleUid = p.SaleUid
        WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo
        GROUP BY p.SaleUid),
    sal AS (
        SELECT s.BranchCode,
            COUNT(DISTINCT s.TerminalId) AS Terminals,
            COUNT(CASE WHEN s.Status = 'Completed' THEN 1 END) AS TxnCount,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.GrossAmount ELSE 0 END)    AS GrossSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.DiscountAmount ELSE 0 END) AS Discounts,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.NetAmount ELSE 0 END)      AS NetSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.VatableAmount ELSE 0 END)  AS VatableSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.VatAmount ELSE 0 END)      AS VatAmount,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.VatExemptAmount ELSE 0 END) AS VatExemptSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.ZeroRatedAmount ELSE 0 END) AS ZeroRatedSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN ISNULL(p.Cash, 0) - s.ChangeAmount ELSE 0 END) AS CashSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN ISNULL(p.Card, 0) ELSE 0 END) AS CardSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN ISNULL(p.Gc, 0) ELSE 0 END) AS GcSales,
            COUNT(CASE WHEN s.Status = 'Voided' THEN 1 END)                         AS VoidCount,
            SUM(CASE WHEN s.Status = 'Voided' THEN s.NetAmount ELSE 0 END)          AS VoidAmount
        FROM dbo.Sales s LEFT JOIN pay p ON p.SaleUid = s.SaleUid
        WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo
        GROUP BY s.BranchCode),
    ret AS (
        SELECT r.BranchCode, COUNT(*) AS ReturnCount, SUM(r.NetAmount) AS ReturnAmount
        FROM dbo.SaleReturns r WHERE r.BusinessDate BETWEEN @DateFrom AND @DateTo
        GROUP BY r.BranchCode)
    SELECT b.BranchCode, b.BranchName, a.Terminals, a.TxnCount, a.GrossSales, a.Discounts,
           a.GrossSales - a.Discounts - a.NetSales AS LessVat, a.NetSales,
           a.VatableSales, a.VatAmount, a.VatExemptSales, a.ZeroRatedSales, a.CashSales, a.CardSales, a.GcSales,
           a.VoidCount, a.VoidAmount, ISNULL(r.ReturnCount, 0) AS ReturnCount, ISNULL(r.ReturnAmount, 0) AS ReturnAmount,
           a.NetSales - ISNULL(r.ReturnAmount, 0) AS NetAfterReturns,
           CAST(CASE WHEN a.TxnCount > 0 THEN a.NetSales / a.TxnCount ELSE 0 END AS DECIMAL(18,2)) AS AvgBasket,
           CAST(CASE WHEN SUM(a.NetSales) OVER () > 0 THEN 100.0 * a.NetSales / SUM(a.NetSales) OVER () ELSE 0 END AS DECIMAL(5,1)) AS SharePct
    FROM sal a JOIN dbo.Branches b ON b.BranchCode = a.BranchCode
    LEFT JOIN ret r ON r.BranchCode = a.BranchCode
    ORDER BY a.NetSales DESC;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_SalesDetails
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL, @TerminalId INT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    -- the BIR breakdown as printed on the invoice: VAT-exempt holds the pre-discount base of an
    -- SC/PWD-exempt line, so the four buckets don't always add up to Net (see CLAUDE.md).
    -- CashSales = cash received less change; Returned = refunds made later against this invoice.
    SELECT s.BusinessDate, s.BranchCode, t.TerminalCode, s.ORNumber, s.SaleDateTime,
           u.FullName AS Cashier, s.Status,
           s.CustomerName, s.CustomerTin, s.CustomerAddress, s.CustomerBusinessStyle,
           it.LineCount, it.ItemQty,
           s.GrossAmount, s.DiscountCode, s.DiscountAmount, s.DiscountCtrlNo, s.DiscountName,
           da.FullName AS DiscountApprovedBy, s.DiscountCap, s.DinerCount, s.SeniorCount,
           s.GrossAmount - s.DiscountAmount - s.NetAmount AS LessVat,
           s.VatableAmount, s.VatAmount, s.VatExemptAmount, s.ZeroRatedAmount, s.VatAdjustment,
           s.NetAmount, s.TenderedAmount, s.ChangeAmount,
           ISNULL(p.Cash, 0) - CASE WHEN p.Cash > 0 THEN s.ChangeAmount ELSE 0 END AS CashSales,
           ISNULL(p.Card, 0) AS CardSales, ISNULL(p.Gc, 0) AS GcSales, ISNULL(p.GcForfeited, 0) AS GcForfeited, p.Payments,
           ISNULL(rt.ReturnedAmount, 0) AS ReturnedAmount,
           s.ZeroRatedCertNo, pl.LevelName AS PriceLevel, s.VoidedAt, vb.FullName AS VoidedBy, s.VoidReason
    FROM dbo.Sales s
    JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    JOIN dbo.Users u ON u.UserId = s.CashierUserId
    LEFT JOIN dbo.Users vb ON vb.UserId = s.VoidedBy
    LEFT JOIN dbo.Users da ON da.UserId = s.DiscountApprovedBy
    LEFT JOIN dbo.PriceLevels pl ON pl.PriceLevel = s.PriceLevel   -- 31: NULL = SellingPrice
    OUTER APPLY (SELECT COUNT(*) AS LineCount, SUM(si.Quantity) AS ItemQty
                 FROM dbo.SaleItems si WHERE si.SaleUid = s.SaleUid) it
    OUTER APPLY (SELECT SUM(CASE WHEN sp.PaymentType = 'CASH' THEN sp.Amount ELSE 0 END) AS Cash,
                        SUM(CASE WHEN sp.PaymentType = 'CARD' THEN sp.Amount ELSE 0 END) AS Card,
                        SUM(CASE WHEN sp.PaymentType = 'GC' THEN sp.Amount ELSE 0 END) AS Gc,
                        SUM(CASE WHEN sp.PaymentType = 'GC' THEN ISNULL(sp.GcValue, sp.Amount) - sp.Amount ELSE 0 END) AS GcForfeited,
                        STUFF((SELECT ', ' + p2.PaymentType FROM dbo.SalePayments p2
                               WHERE p2.SaleUid = s.SaleUid ORDER BY p2.SeqNo FOR XML PATH('')), 1, 2, '') AS Payments
                 FROM dbo.SalePayments sp WHERE sp.SaleUid = s.SaleUid) p
    OUTER APPLY (SELECT SUM(r.NetAmount) AS ReturnedAmount FROM dbo.SaleReturns r WHERE r.OrigSaleUid = s.SaleUid) rt
    WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
      AND (@TerminalId IS NULL OR s.TerminalId = @TerminalId)
    ORDER BY s.SaleDateTime;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_PaymentBreakdown
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    /* Cash received includes the change handed back; Cash sales = received − change.
       Cash refunds are the day's returns (always paid out in cash). */
    WITH pay AS (
        SELECT s.BusinessDate, s.BranchCode, s.SaleUid, s.ChangeAmount, s.NetAmount,
               SUM(CASE WHEN p.PaymentType = 'CASH' THEN p.Amount ELSE 0 END) AS Cash,
               SUM(CASE WHEN p.PaymentType = 'CARD' THEN p.Amount ELSE 0 END) AS Card,
               SUM(CASE WHEN p.PaymentType = 'GC' THEN p.Amount ELSE 0 END) AS Gc   -- 38: gift certificates
        FROM dbo.Sales s JOIN dbo.SalePayments p ON p.SaleUid = s.SaleUid
        WHERE s.Status = 'Completed' AND s.BusinessDate BETWEEN @DateFrom AND @DateTo
          AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
        GROUP BY s.BusinessDate, s.BranchCode, s.SaleUid, s.ChangeAmount, s.NetAmount),
    d AS (
        SELECT BusinessDate, BranchCode, COUNT(*) AS TxnCount,
               COUNT(CASE WHEN Cash > 0 THEN 1 END) AS CashTxns,
               SUM(Cash) AS CashReceived, SUM(ChangeAmount) AS ChangeGiven,
               SUM(Cash) - SUM(ChangeAmount) AS CashSales,
               COUNT(CASE WHEN Card > 0 THEN 1 END) AS CardTxns, SUM(Card) AS CardSales,
               COUNT(CASE WHEN Gc > 0 THEN 1 END) AS GcTxns, SUM(Gc) AS GcSales,
               COUNT(CASE WHEN (CASE WHEN Cash > 0 THEN 1 ELSE 0 END) + (CASE WHEN Card > 0 THEN 1 ELSE 0 END)
                               + (CASE WHEN Gc > 0 THEN 1 ELSE 0 END) > 1 THEN 1 END) AS SplitTxns,
               SUM(NetAmount) AS NetSales
        FROM pay GROUP BY BusinessDate, BranchCode),
    ret AS (
        SELECT BusinessDate, BranchCode, COUNT(*) AS ReturnCount, SUM(NetAmount) AS CashRefunds
        FROM dbo.SaleReturns
        WHERE BusinessDate BETWEEN @DateFrom AND @DateTo AND (@BranchCode IS NULL OR BranchCode = @BranchCode)
        GROUP BY BusinessDate, BranchCode)
    SELECT COALESCE(d.BusinessDate, r.BusinessDate) AS BusinessDate, COALESCE(d.BranchCode, r.BranchCode) AS BranchCode,
           ISNULL(d.TxnCount, 0) AS TxnCount, ISNULL(d.CashTxns, 0) AS CashTxns,
           ISNULL(d.CashReceived, 0) AS CashReceived, ISNULL(d.ChangeGiven, 0) AS ChangeGiven,
           ISNULL(d.CashSales, 0) AS CashSales, ISNULL(d.CardTxns, 0) AS CardTxns, ISNULL(d.CardSales, 0) AS CardSales,
           ISNULL(d.GcTxns, 0) AS GcTxns, ISNULL(d.GcSales, 0) AS GcSales,
           ISNULL(d.SplitTxns, 0) AS SplitTxns, ISNULL(d.NetSales, 0) AS NetSales,
           ISNULL(r.ReturnCount, 0) AS ReturnCount, ISNULL(r.CashRefunds, 0) AS CashRefunds,
           ISNULL(d.CashSales, 0) - ISNULL(r.CashRefunds, 0) AS NetCash
    FROM d FULL JOIN ret r ON r.BusinessDate = d.BusinessDate AND r.BranchCode = d.BranchCode
    ORDER BY BusinessDate, BranchCode;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_CardTransactions
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BusinessDate, s.BranchCode, t.TerminalCode, s.ORNumber, s.SaleDateTime, u.FullName AS Cashier,
           p.CardBank, p.CardNo, p.CardName, p.CardRefNo, s.NetAmount AS InvoiceAmount, p.Amount
    FROM dbo.SalePayments p JOIN dbo.Sales s ON s.SaleUid = p.SaleUid
    JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    JOIN dbo.Users u ON u.UserId = s.CashierUserId
    WHERE p.PaymentType='CARD' AND s.Status='Completed'
      AND s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
    ORDER BY s.BusinessDate, s.ORNumber;
END
GO

/* 38: every gift certificate taken as payment: what it paid, the value forfeited (no change on a
   GC), and what the register said when the sale synced (GcCheck: OK, or a problem to review). */
CREATE OR ALTER PROCEDURE dbo.sp_rpt_GiftCertificates
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BusinessDate, s.BranchCode, t.TerminalCode, s.ORNumber, s.SaleDateTime, u.FullName AS Cashier,
           p.GcNo, p.GcValue, p.Amount, ISNULL(p.GcValue, p.Amount) - p.Amount AS Forfeited,
           ISNULL(p.GcCheck, 'UNKNOWN') AS GcCheck, g.IssuedTo, g.ExpiryDate, s.NetAmount AS InvoiceAmount
    FROM dbo.SalePayments p JOIN dbo.Sales s ON s.SaleUid = p.SaleUid
    JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    JOIN dbo.Users u ON u.UserId = s.CashierUserId
    LEFT JOIN dbo.GiftCertificates g ON g.GcNo = p.GcNo
    WHERE p.PaymentType = 'GC' AND s.Status = 'Completed'
      AND s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
    ORDER BY s.BusinessDate, s.BranchCode, t.TerminalCode, s.ORNumber;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_Discounts
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BusinessDate, s.BranchCode, t.TerminalCode, s.ORNumber, s.SaleDateTime, u.FullName AS Cashier,
           s.DiscountCode, s.DiscountCtrlNo, s.DiscountName, da.FullName AS ApprovedBy, s.DiscountCap, s.PromoAmount,
           s.DinerCount, s.SeniorCount, s.CustomerName, s.CustomerTin,
           s.GrossAmount, s.DiscountAmount, s.GrossAmount - s.DiscountAmount - s.NetAmount AS LessVat,
           s.VatExemptAmount, s.VatAdjustment, s.NetAmount
    FROM dbo.Sales s JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    JOIN dbo.Users u ON u.UserId = s.CashierUserId
    LEFT JOIN dbo.Users da ON da.UserId = s.DiscountApprovedBy
    WHERE s.DiscountAmount > 0 AND s.Status='Completed'
      AND s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
    ORDER BY s.BusinessDate, s.ORNumber;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_GroupCategory
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    /* Sold = Completed sales of the period: gross = qty × price, net = what the line was sold
       for (after its discount and, on an SC/PWD-exempt line, the VAT taken off). Returned =
       returns made in the period. */
    WITH x AS (
        SELECT si.BranchCode, si.CategoryId, si.SaleUid, si.Quantity AS Qty, si.LineTotal AS Gross,
               si.LineDiscount AS Discount, CASE WHEN si.NetAmount <> 0 OR si.LineTotal = si.LineDiscount THEN si.NetAmount
                    ELSE si.LineTotal - si.LineDiscount END AS Net, si.VatAmount AS Vat,
               CAST(0 AS DECIMAL(18,3)) AS RetQty, CAST(0 AS DECIMAL(18,2)) AS RetAmt
        FROM dbo.SaleItems si JOIN dbo.Sales s ON s.SaleUid = si.SaleUid AND s.Status = 'Completed'
        WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo AND (@BranchCode IS NULL OR si.BranchCode = @BranchCode)
        UNION ALL
        SELECT r.BranchCode, ri.CategoryId, NULL, 0, 0, 0, 0, 0, ri.Quantity, ri.NetAmount
        FROM dbo.SaleReturnItems ri JOIN dbo.SaleReturns r ON r.ReturnUid = ri.ReturnUid
        WHERE r.BusinessDate BETWEEN @DateFrom AND @DateTo AND (@BranchCode IS NULL OR r.BranchCode = @BranchCode))
    SELECT x.BranchCode, c.CategoryName, COUNT(DISTINCT x.SaleUid) AS TxnCount,
           SUM(x.Qty) AS TotalQty, SUM(x.Gross) AS GrossAmount, SUM(x.Discount) AS DiscountAmount,
           SUM(x.Gross) - SUM(x.Discount) - SUM(x.Net) AS LessVat, SUM(x.Net) AS TotalAmount, SUM(x.Vat) AS VatAmount,
           SUM(x.RetQty) AS ReturnedQty, SUM(x.RetAmt) AS ReturnedAmount, SUM(x.Net) - SUM(x.RetAmt) AS NetAfterReturns,
           CAST(CASE WHEN SUM(SUM(x.Net)) OVER () > 0 THEN 100.0 * SUM(x.Net) / SUM(SUM(x.Net)) OVER () ELSE 0 END AS DECIMAL(5,1)) AS SharePct
    FROM x JOIN dbo.Categories c ON c.CategoryId = x.CategoryId
    GROUP BY x.BranchCode, c.CategoryName ORDER BY TotalAmount DESC;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_GroupItems
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    WITH x AS (
        SELECT si.BranchCode, si.Barcode, si.ProductName, si.CategoryId, si.SaleUid, si.Quantity AS Qty,
               si.LineTotal AS Gross, si.LineDiscount AS Discount, CASE WHEN si.NetAmount <> 0 OR si.LineTotal = si.LineDiscount THEN si.NetAmount
                    ELSE si.LineTotal - si.LineDiscount END AS Net, si.VatAmount AS Vat,
               CAST(0 AS DECIMAL(18,3)) AS RetQty, CAST(0 AS DECIMAL(18,2)) AS RetAmt
        FROM dbo.SaleItems si JOIN dbo.Sales s ON s.SaleUid = si.SaleUid AND s.Status = 'Completed'
        WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo AND (@BranchCode IS NULL OR si.BranchCode = @BranchCode)
        UNION ALL
        SELECT r.BranchCode, ri.Barcode, ri.ProductName, ri.CategoryId, NULL, 0, 0, 0, 0, 0, ri.Quantity, ri.NetAmount
        FROM dbo.SaleReturnItems ri JOIN dbo.SaleReturns r ON r.ReturnUid = ri.ReturnUid
        WHERE r.BusinessDate BETWEEN @DateFrom AND @DateTo AND (@BranchCode IS NULL OR r.BranchCode = @BranchCode))
    SELECT x.BranchCode, x.Barcode, x.ProductName, c.CategoryName, COUNT(DISTINCT x.SaleUid) AS TxnCount,
           SUM(x.Qty) AS TotalQty,
           CAST(CASE WHEN SUM(x.Qty) <> 0 THEN SUM(x.Gross) / SUM(x.Qty) ELSE 0 END AS DECIMAL(18,2)) AS AvgPrice,
           SUM(x.Gross) AS GrossAmount, SUM(x.Discount) AS DiscountAmount,
           SUM(x.Gross) - SUM(x.Discount) - SUM(x.Net) AS LessVat, SUM(x.Net) AS TotalAmount, SUM(x.Vat) AS VatAmount,
           SUM(x.RetQty) AS ReturnedQty, SUM(x.RetAmt) AS ReturnedAmount, SUM(x.Net) - SUM(x.RetAmt) AS NetAfterReturns
    FROM x JOIN dbo.Categories c ON c.CategoryId = x.CategoryId
    GROUP BY x.BranchCode, x.Barcode, x.ProductName, c.CategoryName
    ORDER BY TotalAmount DESC;
END
GO

/* ---------- Email report support: Blind Close (per shift) and EOD (per terminal/day) ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_rpt_GroupItemsByShift
    @ShiftUid UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT si.Barcode, si.ProductName, c.CategoryName,
           SUM(si.Quantity) AS TotalQty, SUM(si.LineTotal) AS TotalAmount
    FROM dbo.SaleItems si
    JOIN dbo.Sales s ON s.SaleUid = si.SaleUid AND s.Status = 'Completed'
    JOIN dbo.Categories c ON c.CategoryId = si.CategoryId
    WHERE s.ShiftUid = @ShiftUid
    GROUP BY si.Barcode, si.ProductName, c.CategoryName
    ORDER BY TotalAmount DESC;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_GroupItemsByTerminalDate
    @TerminalId INT, @BusinessDate DATE
AS
BEGIN
    SET NOCOUNT ON;
    SELECT si.Barcode, si.ProductName, c.CategoryName,
           SUM(si.Quantity) AS TotalQty, SUM(si.LineTotal) AS TotalAmount
    FROM dbo.SaleItems si
    JOIN dbo.Sales s ON s.SaleUid = si.SaleUid AND s.Status = 'Completed'
    JOIN dbo.Categories c ON c.CategoryId = si.CategoryId
    WHERE s.TerminalId = @TerminalId AND s.BusinessDate = @BusinessDate
    GROUP BY si.Barcode, si.ProductName, c.CategoryName
    ORDER BY TotalAmount DESC;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_HourlyByShift
    @ShiftUid UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT DATEPART(HOUR, s.SaleDateTime) AS HourOfDay,
           COUNT(*) AS TxnCount,
           SUM(s.NetAmount) AS NetSales
    FROM dbo.Sales s
    WHERE s.ShiftUid = @ShiftUid AND s.Status = 'Completed'
    GROUP BY DATEPART(HOUR, s.SaleDateTime)
    ORDER BY HourOfDay;
END
GO

/* ---------- Promos: Buy N Take M (34_promos.sql) ----------
   The promos a branch's tills use: switched on, for this branch (no branch rows = every branch),
   not yet over (the till checks the dates itself at each sale, so it holds offline across days).
   1) the promos, 2) the items that qualify for each (categories expanded to their active items).
   Downloaded with the price list at Cash Begin. */
CREATE OR ALTER PROCEDURE dbo.sp_GetPromos
    @BranchCode VARCHAR(10), @Today DATE = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET @Today = ISNULL(@Today, CAST(SYSDATETIME() AS DATE));
    DECLARE @p TABLE (PromoId INT PRIMARY KEY);
    INSERT @p SELECT p.PromoId FROM dbo.Promos p
    WHERE p.IsActive = 1 AND p.EndDate >= @Today
      AND (NOT EXISTS (SELECT 1 FROM dbo.PromoBranches b WHERE b.PromoId = p.PromoId)
           OR EXISTS (SELECT 1 FROM dbo.PromoBranches b WHERE b.PromoId = p.PromoId AND b.BranchCode = @BranchCode));
    SELECT p.PromoId, p.PromoName, p.Kind, p.BuyQty, p.FreeQty, p.FreeProductId, p.MaxFreePerSale, p.StartDate, p.EndDate
    FROM dbo.Promos p JOIN @p x ON x.PromoId = p.PromoId ORDER BY p.PromoId;
    SELECT DISTINCT i.PromoId, pr.ProductId
    FROM dbo.PromoItems i JOIN @p x ON x.PromoId = i.PromoId
    JOIN dbo.Products pr ON pr.IsActive = 1 AND (pr.ProductId = i.ProductId OR (i.ProductId IS NULL AND pr.CategoryId = i.CategoryId))
    ORDER BY i.PromoId, pr.ProductId;
END
GO

/* Promo sales: one row per invoice line with promo-free units. Completed sales only. */
CREATE OR ALTER PROCEDURE dbo.sp_rpt_Promos
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BusinessDate, s.BranchCode, t.TerminalCode, s.ORNumber, s.SaleDateTime, u.FullName AS Cashier,
           sp.PromoName, pr.Kind, p.ErpProductCode AS ItemCode, si.ProductName, si.Quantity, sp.FreeQty,
           sp.RegularPrice, sp.PromoAmount, si.LineTotal, si.NetAmount, s.DiscountCode, si.ReturnedQty
    FROM dbo.SaleItemPromo sp
    JOIN dbo.Sales s ON s.SaleUid = sp.SaleUid
    JOIN dbo.SaleItems si ON si.SaleUid = sp.SaleUid AND si.[LineNo] = sp.[LineNo]
    JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    LEFT JOIN dbo.Promos pr ON pr.PromoId = sp.PromoId
    LEFT JOIN dbo.Products p ON p.ProductId = si.ProductId
    LEFT JOIN dbo.Users u ON u.UserId = s.CashierUserId
    WHERE s.Status = 'Completed' AND s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
    ORDER BY s.BusinessDate, s.BranchCode, t.TerminalCode, s.ORNumber, sp.[LineNo];
END
GO

/* ---------- Wholesale (33_wholesale.sql) ----------
   The wholesale tiers a branch's tills use, per item. An item follows the first of these that
   has any rows for it: the item at this branch, the item at every branch, its category at this
   branch, its category at every branch; only the active rows of that set count (all switched
   off = the item is excluded). Nothing at all when the branch has wholesale off
   (PosSettings.WholesaleOn). Downloaded with the price list at Cash Begin. */
CREATE OR ALTER PROCEDURE dbo.sp_GetWholesaleRules
    @BranchCode VARCHAR(10)
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM dbo.PosSettings WHERE BranchCode = @BranchCode AND WholesaleOn = 0) RETURN;
    WITH cand AS (
        SELECT p.ProductId, r.MinQty, r.AmountOff, r.IsActive,
               CASE WHEN r.ProductId IS NOT NULL AND r.BranchCode IS NOT NULL THEN 1
                    WHEN r.ProductId IS NOT NULL THEN 2
                    WHEN r.BranchCode IS NOT NULL THEN 3 ELSE 4 END AS Lvl
        FROM dbo.Products p
        JOIN dbo.WholesaleRules r
          ON (r.ProductId = p.ProductId OR (r.ProductId IS NULL AND r.CategoryId = p.CategoryId))
         AND (r.BranchCode IS NULL OR r.BranchCode = @BranchCode)
        WHERE p.IsActive = 1),
    pick AS (SELECT ProductId, MIN(Lvl) AS Lvl FROM cand GROUP BY ProductId)
    SELECT c.ProductId, c.MinQty, c.AmountOff
    FROM cand c JOIN pick k ON k.ProductId = c.ProductId AND k.Lvl = c.Lvl
    WHERE c.IsActive = 1
    ORDER BY c.ProductId, c.MinQty;
END
GO

/* Wholesale sales, one row per invoice line sold at a wholesale price (the DTI report). Completed
   sales only; voided ones are left out. Returns are listed against their invoice. */
CREATE OR ALTER PROCEDURE dbo.sp_rpt_Wholesale
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BusinessDate, s.BranchCode, b.BranchName, t.TerminalCode, s.ORNumber, s.SaleDateTime,
           u.FullName AS Cashier, s.CustomerName, s.CustomerTin,
           p.ErpProductCode AS ItemCode, si.ProductName, p.Unit, w.Quantity, w.ItemTotalQty, w.MinQty,
           w.RegularPrice, w.AmountOff, w.WholesalePrice,
           CAST(ROUND(w.Quantity * w.RegularPrice, 2) AS DECIMAL(18,2)) AS RegularAmount,
           CAST(ROUND(w.Quantity * w.WholesalePrice, 2) AS DECIMAL(18,2)) AS WholesaleAmount,
           CAST(ROUND(w.Quantity * w.RegularPrice, 2) - ROUND(w.Quantity * w.WholesalePrice, 2) AS DECIMAL(18,2)) AS WholesaleSavings,
           si.ReturnedQty
    FROM dbo.SaleItemWholesale w
    JOIN dbo.Sales s ON s.SaleUid = w.SaleUid
    JOIN dbo.SaleItems si ON si.SaleUid = w.SaleUid AND si.[LineNo] = w.[LineNo]
    JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    JOIN dbo.Branches b ON b.BranchCode = s.BranchCode
    LEFT JOIN dbo.Products p ON p.ProductId = w.ProductId
    LEFT JOIN dbo.Users u ON u.UserId = s.CashierUserId
    WHERE s.Status = 'Completed' AND s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
    ORDER BY s.BusinessDate, s.BranchCode, t.TerminalCode, s.ORNumber, w.[LineNo];
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_VoidReturn
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT * FROM (
        SELECT 'Void' AS Kind, s.BusinessDate, s.BranchCode, t.TerminalCode, s.ORNumber,
               CAST(NULL AS INT) AS ReturnNo, u.FullName AS Cashier,
               v.FullName AS ApprovedBy, s.GrossAmount, s.DiscountAmount, s.NetAmount,
               s.VatAmount, s.VoidReason AS Reason, s.SaleDateTime AS SoldAt, s.VoidedAt AS DoneAt
        FROM dbo.Sales s
        JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
        JOIN dbo.Users u ON u.UserId = s.CashierUserId
        LEFT JOIN dbo.Users v ON v.UserId = s.VoidedBy
        WHERE s.Status IN ('Voided','Returned')
          AND s.BusinessDate BETWEEN @DateFrom AND @DateTo
          AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
        UNION ALL
        SELECT 'Return', r.BusinessDate, r.BranchCode, t.TerminalCode, r.OrigORNumber,
               r.ReturnNo, u.FullName, v.FullName, r.GrossAmount, r.DiscountAmount, r.NetAmount,
               r.VatAmount, r.Reason, os.SaleDateTime, r.ReturnDateTime
        FROM dbo.SaleReturns r
        JOIN dbo.Terminals t ON t.TerminalId = r.TerminalId
        JOIN dbo.Users u ON u.UserId = r.CashierUserId
        LEFT JOIN dbo.Users v ON v.UserId = r.ApprovedByUserId
        LEFT JOIN dbo.Sales os ON os.SaleUid = r.OrigSaleUid
        WHERE r.BusinessDate BETWEEN @DateFrom AND @DateTo
          AND (@BranchCode IS NULL OR r.BranchCode = @BranchCode)
    ) x
    ORDER BY x.DoneAt DESC;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_CashierPerformance
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    WITH pay AS (
        SELECT p.SaleUid,
               SUM(CASE WHEN p.PaymentType = 'CASH' THEN p.Amount ELSE 0 END) AS Cash,
               SUM(CASE WHEN p.PaymentType = 'CARD' THEN p.Amount ELSE 0 END) AS Card,
               SUM(CASE WHEN p.PaymentType = 'GC' THEN p.Amount ELSE 0 END) AS Gc   -- 38: gift certificates
        FROM dbo.SalePayments p JOIN dbo.Sales s ON s.SaleUid = p.SaleUid
        WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
        GROUP BY p.SaleUid),
    sal AS (
        SELECT s.CashierUserId, s.BranchCode,
            COUNT(DISTINCT s.ShiftUid) AS Shifts,
            COUNT(CASE WHEN s.Status = 'Completed' THEN 1 END) AS TxnCount,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.GrossAmount ELSE 0 END)    AS GrossSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.DiscountAmount ELSE 0 END) AS Discounts,
            SUM(CASE WHEN s.Status = 'Completed' THEN s.NetAmount ELSE 0 END)      AS NetSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN ISNULL(p.Cash, 0) - s.ChangeAmount ELSE 0 END) AS CashSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN ISNULL(p.Card, 0) ELSE 0 END) AS CardSales,
            SUM(CASE WHEN s.Status = 'Completed' THEN ISNULL(p.Gc, 0) ELSE 0 END) AS GcSales,
            COUNT(CASE WHEN s.Status = 'Voided' THEN 1 END)                         AS Voids,
            SUM(CASE WHEN s.Status = 'Voided' THEN s.NetAmount ELSE 0 END)          AS VoidAmount
        FROM dbo.Sales s LEFT JOIN pay p ON p.SaleUid = s.SaleUid
        WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
        GROUP BY s.CashierUserId, s.BranchCode)
    SELECT u.FullName AS Cashier, a.BranchCode, a.Shifts, a.TxnCount, a.GrossSales, a.Discounts,
        a.GrossSales - a.Discounts - a.NetSales AS LessVat, a.NetSales,
        a.CashSales, a.CardSales, a.GcSales, a.Voids, a.VoidAmount,
        ISNULL(r.ReturnCount, 0) AS ReturnCount, ISNULL(r.ReturnAmount, 0) AS ReturnAmount,
        CAST(CASE WHEN a.TxnCount > 0 THEN a.NetSales / a.TxnCount ELSE 0 END AS DECIMAL(18,2)) AS AvgSale,
        ISNULL((SELECT SUM(c.ShortOver) FROM dbo.ShiftClosings c
                JOIN dbo.Shifts sh ON sh.ShiftUid = c.ShiftUid
                WHERE sh.CashierUserId = a.CashierUserId AND sh.BranchCode = a.BranchCode
                  AND sh.BusinessDate BETWEEN @DateFrom AND @DateTo), 0) AS NetShortOver
    FROM sal a JOIN dbo.Users u ON u.UserId = a.CashierUserId
    OUTER APPLY (SELECT COUNT(*) AS ReturnCount, SUM(rr.NetAmount) AS ReturnAmount FROM dbo.SaleReturns rr
                 WHERE rr.CashierUserId = a.CashierUserId AND rr.BranchCode = a.BranchCode
                   AND rr.BusinessDate BETWEEN @DateFrom AND @DateTo) r
    ORDER BY a.NetSales DESC;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_Dashboard
    @BusinessDate DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    /* 1: today's headline numbers */
    SELECT ISNULL(SUM(CASE WHEN Status='Completed' THEN NetAmount END),0) AS NetSales,
           COUNT(CASE WHEN Status='Completed' THEN 1 END) AS TxnCount
    FROM dbo.Sales
    WHERE BusinessDate=@BusinessDate AND (@BranchCode IS NULL OR BranchCode=@BranchCode);

    /* 2: per branch today */
    SELECT s.BranchCode,
           COUNT(CASE WHEN s.Status='Completed' THEN 1 END) AS TxnCount,
           ISNULL(SUM(CASE WHEN s.Status='Completed' THEN s.NetAmount END),0) AS NetSales
    FROM dbo.Sales s WHERE s.BusinessDate=@BusinessDate
    GROUP BY s.BranchCode;

    /* 3: last 7 days */
    SELECT BusinessDate, ISNULL(SUM(CASE WHEN Status='Completed' THEN NetAmount END),0) AS NetSales
    FROM dbo.Sales
    WHERE BusinessDate BETWEEN DATEADD(DAY,-6,@BusinessDate) AND @BusinessDate
      AND (@BranchCode IS NULL OR BranchCode=@BranchCode)
    GROUP BY BusinessDate ORDER BY BusinessDate;

    /* 4: open shifts */
    SELECT COUNT(*) AS OpenShifts FROM dbo.Shifts WHERE Status='Open';
END
GO

/* ============================ ACCOUNTING (acc schema) ============================
   Addendum B. Tables are in 16_accounting.sql / 01_schema.sql. Every procedure takes
   @CompanyId (the API always passes 1 today — one client per deployment). */

/* ---------- Chart-of-accounts templates (idempotent; called by sp_SetupCompany) ---------- */
CREATE OR ALTER PROCEDURE acc.sp_SeedCoaTemplates
AS
BEGIN
    SET NOCOUNT ON;
    MERGE acc.CoaTemplateAccounts AS t
    USING (VALUES
        -- BASE: every template. Rows with a SystemKey become IsSystem accounts.
        ('BASE','1010','Cash on Hand',               N'Cash in the drawer',                 'Asset',    'Cash',           'CASH_ON_HAND',     10),
        ('BASE','1020','Cash in Bank',               N'Money in the bank',                  'Asset',    'Bank',           'CASH_IN_BANK',     20),
        ('BASE','1030','Card Receivable',            N'Card payments not yet deposited',    'Asset',    'CardReceivable', 'CARD_RECEIVABLE',  30),
        ('BASE','1100','Accounts Receivable',        N'Money customers owe me',             'Asset',    'AR',             'AR',               40),
        ('BASE','1200','Inventory',                  N'Stock on hand',                      'Asset',    'Inventory',      'INVENTORY',        50),
        ('BASE','1300','Input VAT',                  N'VAT I paid on purchases',            'Asset',    'VATInput',       'VAT_INPUT',        60),
        ('BASE','2010','Accounts Payable',           N'Money I owe suppliers',              'Liability','AP',             'AP',              100),
        ('BASE','2100','Output VAT',                 N'VAT collected from customers',       'Liability','VATOutput',      'VAT_OUTPUT',      110),
        ('BASE','2120','Gift Certificates Outstanding', N'Gift certificates sold, not yet used', 'Liability','GiftCert',    'GIFT_CERT',       115),
        ('BASE','2110','Expanded Withholding Tax Payable', N'Tax I withheld, to pay to BIR','Liability','EWTPayable',     'EWT_PAYABLE',     120),
        ('BASE','3010','Owner''s Capital',           N'Money I put into the business',      'Equity',   'Capital',        'OWNER_CAPITAL',   200),
        ('BASE','3020','Owner''s Drawings',          N'Money I took out for personal use',  'Equity',   'Drawings',       'OWNER_DRAWINGS',  210),
        ('BASE','3900','Retained Earnings',          N'Past profits kept in the business',  'Equity',   'RetainedEarnings','RETAINED_EARNINGS',220),
        ('BASE','4010','Sales - Vatable',            N'Sales (with VAT)',                   'Income',   'Sales',          'SALES_VATABLE',   300),
        ('BASE','4020','Sales - VAT Exempt',         N'Sales (VAT-exempt)',                 'Income',   'Sales',          'SALES_EXEMPT',    310),
        ('BASE','4030','Sales - Zero Rated',         N'Sales (zero-rated / non-VAT items)', 'Income',   'Sales',          'SALES_ZERORATED', 320),
        ('BASE','4090','Sales Discounts (SC/PWD and others)', N'Discounts given (senior, PWD, etc.)', 'Income', 'ContraRevenue', 'SCPWD_DISCOUNT', 330),
        ('BASE','5010','Cost of Goods Sold',         N'Cost of the items I sold',           'Expense',  'COGS',           'COGS',            400),
        ('BASE','6010','Cash Short/Over',            N'Cash drawer short or over',          'Expense',  'CashShortOver',  'CASH_SHORT_OVER', 500),
        ('BASE','6020','Inventory Loss',             N'Stock lost, spoiled or damaged',     'Expense',  'InventoryLoss',  'INVENTORY_LOSS',  510),
        ('BASE','6100','Rent Expense',               N'Rent',                               'Expense',  'Operating',      NULL,              520),
        ('BASE','6110','Salaries and Wages',         N'Staff pay',                          'Expense',  'Operating',      NULL,              530),
        ('BASE','6120','Utilities - Electricity',    N'Electricity bill',                   'Expense',  'Operating',      NULL,              540),
        ('BASE','6130','Utilities - Water',          N'Water bill',                         'Expense',  'Operating',      NULL,              550),
        ('BASE','6140','Communication',              N'Phone and internet',                 'Expense',  'Operating',      NULL,              560),
        ('BASE','6150','Supplies Expense',           N'Supplies',                           'Expense',  'Operating',      NULL,              570),
        ('BASE','6160','Repairs and Maintenance',    N'Repairs',                            'Expense',  'Operating',      NULL,              580),
        ('BASE','6170','Transportation',             N'Transport and gas',                  'Expense',  'Operating',      NULL,              590),
        ('BASE','6180','Taxes and Licenses',         N'Taxes, permits and licenses',        'Expense',  'Operating',      NULL,              600),
        ('BASE','6190','Bank Charges',               N'Bank and card fees',                 'Expense',  'Operating',      NULL,              610),
        ('BASE','6900','Miscellaneous Expense',      N'Other expenses',                     'Expense',  'Operating',      NULL,              690),
        ('BASE','6990','Rounding Differences',       N'Small rounding differences',         'Expense',  'Rounding',       'ROUNDING',        699),
        -- Industry extras
        ('WATER','1210','Container Inventory',       N'Water containers on hand',           'Asset',    'Inventory',      NULL,               55),
        ('WATER','2200','Container Deposit Liability', N'Container deposits I must refund', 'Liability','Deposits',       'CONTAINER_DEPOSIT',130),
        ('WATER','6200','Delivery Expense',          N'Delivery costs',                     'Expense',  'Operating',      NULL,              620),
        ('WATER','6210','Refilling Supplies',        N'Refilling supplies (filters, caps, seals)', 'Expense','Operating',  NULL,              630),
        ('RESTAURANT','2210','Service Charge Payable', N'Service charge owed to staff',     'Liability','ServiceCharge',  NULL,              140),
        ('RESTAURANT','5020','Food Cost',            N'Cost of food ingredients',           'Expense',  'COGS',           NULL,              410),
        ('RESTAURANT','5030','Beverage Cost',        N'Cost of drinks',                     'Expense',  'COGS',           NULL,              420),
        ('PHARMACY','6230','Expired Stock Written Off', N'Expired medicine thrown out',     'Expense',  'InventoryLoss',  NULL,              640),
        ('RETAIL','6220','Packaging Supplies',       N'Bags and packaging',                 'Expense',  'Operating',      NULL,              635)
    ) AS s (TemplateCode, AccountCode, AccountName, PlainName, AccountType, AccountSubType, SystemKey, SortOrder)
    ON t.TemplateCode = s.TemplateCode AND t.AccountCode = s.AccountCode
    WHEN MATCHED THEN UPDATE SET AccountName = s.AccountName, PlainName = s.PlainName,
        AccountType = s.AccountType, AccountSubType = s.AccountSubType, SystemKey = s.SystemKey, SortOrder = s.SortOrder
    WHEN NOT MATCHED THEN INSERT (TemplateCode, AccountCode, AccountName, PlainName, AccountType, AccountSubType, SystemKey, SortOrder)
        VALUES (s.TemplateCode, s.AccountCode, s.AccountName, s.PlainName, s.AccountType, s.AccountSubType, s.SystemKey, s.SortOrder);
END
GO

/* ---------- Turn accounting on for a company: chart of accounts + posting rules ---------- */
CREATE OR ALTER PROCEDURE acc.sp_SetupCompany
    @CompanyId INT, @TemplateCode VARCHAR(20), @StartDate DATE, @UserId INT = NULL
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    IF @TemplateCode NOT IN ('RETAIL','RESTAURANT','PHARMACY','WATER')
        THROW 52010, 'Unknown business type. Choose Retail, Restaurant, Pharmacy or Water refilling.', 1;

    EXEC acc.sp_SeedCoaTemplates;

    BEGIN TRAN;
        IF EXISTS (SELECT 1 FROM acc.Settings WITH (UPDLOCK, HOLDLOCK) WHERE CompanyId = @CompanyId)
            THROW 52011, 'Accounting is already set up for this company.', 1;

        INSERT INTO acc.ChartOfAccounts (CompanyId, AccountCode, AccountName, PlainName, AccountType,
            AccountSubType, IsSystem, SystemKey, SortOrder)
        SELECT @CompanyId, AccountCode, AccountName, PlainName, AccountType, AccountSubType,
               CASE WHEN SystemKey IS NULL THEN 0 ELSE 1 END, SystemKey, SortOrder
        FROM acc.CoaTemplateAccounts
        WHERE TemplateCode IN ('BASE', @TemplateCode);

        /* Z-Read posting rules: component → account, resolved by SystemKey. */
        INSERT INTO acc.PostingRules (CompanyId, SourceType, RuleKey, AccountId)
        SELECT @CompanyId, 'ZREAD', r.RuleKey, a.AccountId
        FROM (VALUES ('CASH','CASH_ON_HAND'), ('CARD','CARD_RECEIVABLE'), ('DISCOUNT','SCPWD_DISCOUNT'),
                     ('SALES_VATABLE','SALES_VATABLE'), ('VAT_OUTPUT','VAT_OUTPUT'),
                     ('SALES_EXEMPT','SALES_EXEMPT'), ('SALES_ZERORATED','SALES_ZERORATED'),
                     ('SHORT_OVER','CASH_SHORT_OVER'), ('ROUNDING','ROUNDING'), ('GC','GIFT_CERT')) r (RuleKey, SystemKey)
        JOIN acc.ChartOfAccounts a ON a.CompanyId = @CompanyId AND a.SystemKey = r.SystemKey;

        INSERT INTO acc.EntryCounters (CompanyId, LastEntryNo) VALUES (@CompanyId, 0);
        INSERT INTO acc.Settings (CompanyId, IsEnabled, TemplateCode, StartDate, EnabledByUserId)
        VALUES (@CompanyId, 1, @TemplateCode, @StartDate, @UserId);
    COMMIT;
END
GO

/* ---------- THE posting procedure. Every journal entry goes through here. ----------
   Rules (Addendum B §3): debits = credits exactly; ≥2 lines, each one-sided and positive;
   accounts must be active and belong to the company; the period must be Open; EntryNo is
   allocated inside this transaction so it stays gapless. Idempotent per
   (SourceType, SourceUid): a retry returns the existing live entry instead of double-posting. */
CREATE OR ALTER PROCEDURE acc.sp_PostJournalEntry
    @CompanyId INT, @BranchCode VARCHAR(10) = NULL, @EntryDate DATE,
    @EntryType VARCHAR(12) = 'Manual', @SourceType VARCHAR(20) = 'MANUAL', @SourceUid VARCHAR(50) = NULL,
    @PermitId INT = NULL, @Memo NVARCHAR(300) = NULL, @UserId INT = NULL,
    @ReversalOfUid UNIQUEIDENTIFIER = NULL,
    @Lines acc.TVP_JournalLine READONLY,
    @EntryUid UNIQUEIDENTIFIER = NULL OUTPUT
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    DECLARE @msg NVARCHAR(400);
    SET @EntryUid = NULL;
    BEGIN TRAN;
        IF NOT EXISTS (SELECT 1 FROM acc.Settings WHERE CompanyId = @CompanyId AND IsEnabled = 1)
            THROW 52001, 'Accounting is not set up for this company.', 1;

        IF @SourceUid IS NOT NULL
        BEGIN
            SELECT @EntryUid = EntryUid FROM acc.JournalEntries WITH (UPDLOCK, HOLDLOCK)
            WHERE CompanyId = @CompanyId AND SourceType = @SourceType AND SourceUid = @SourceUid
              AND ReversedByUid IS NULL;
            IF @EntryUid IS NOT NULL BEGIN COMMIT; RETURN; END
        END

        IF (SELECT COUNT(*) FROM @Lines) < 2
            THROW 52002, 'A journal entry needs at least two lines.', 1;
        IF EXISTS (SELECT 1 FROM @Lines WHERE Debit < 0 OR Credit < 0 OR (Debit <> 0 AND Credit <> 0)
                                           OR (Debit = 0 AND Credit = 0))
            THROW 52003, 'Each journal line must have either a debit or a credit, not both, and not zero.', 1;
        IF EXISTS (SELECT 1 FROM @Lines l LEFT JOIN acc.ChartOfAccounts a
                        ON a.AccountId = l.AccountId AND a.CompanyId = @CompanyId AND a.IsActive = 1
                   WHERE a.AccountId IS NULL)
            THROW 52004, 'A journal line uses an account that does not exist or is inactive.', 1;

        DECLARE @Dr DECIMAL(18,2), @Cr DECIMAL(18,2);
        SELECT @Dr = SUM(Debit), @Cr = SUM(Credit) FROM @Lines;
        IF @Dr <> @Cr
        BEGIN
            SET @msg = CONCAT(N'Entry does not balance: debits ', @Dr, N', credits ', @Cr, N'.');
            THROW 52005, @msg, 1;
        END

        DECLARE @Y INT = YEAR(@EntryDate), @M INT = MONTH(@EntryDate), @Status VARCHAR(10);
        IF NOT EXISTS (SELECT 1 FROM acc.Periods WITH (UPDLOCK, HOLDLOCK)
                       WHERE CompanyId = @CompanyId AND PeriodYear = @Y AND PeriodMonth = @M)
            INSERT INTO acc.Periods (CompanyId, PeriodYear, PeriodMonth, PeriodStart, PeriodEnd)
            VALUES (@CompanyId, @Y, @M, DATEFROMPARTS(@Y, @M, 1), EOMONTH(@EntryDate));
        SELECT @Status = Status FROM acc.Periods WITH (UPDLOCK)
        WHERE CompanyId = @CompanyId AND PeriodYear = @Y AND PeriodMonth = @M;
        IF @Status <> 'Open'
        BEGIN
            SET @msg = CONCAT(N'The accounting period ', DATENAME(month, @EntryDate), N' ', @Y, N' is ',
                              LOWER(@Status), N'. Nothing can be posted into it.');
            THROW 52006, @msg, 1;
        END

        DECLARE @No BIGINT;
        UPDATE acc.EntryCounters SET @No = LastEntryNo = LastEntryNo + 1 WHERE CompanyId = @CompanyId;
        IF @No IS NULL THROW 52007, 'Accounting entry counter is missing for this company.', 1;

        SET @EntryUid = NEWID();
        INSERT INTO acc.JournalEntries (EntryUid, CompanyId, BranchCode, EntryNo, EntryDate, EntryType,
            SourceType, SourceUid, PermitId, Memo, TotalAmount, PostedByUserId, ReversalOfUid)
        VALUES (@EntryUid, @CompanyId, @BranchCode, @No, @EntryDate, @EntryType,
            @SourceType, @SourceUid, @PermitId, @Memo, @Dr, @UserId, @ReversalOfUid);

        INSERT INTO acc.JournalLines (EntryUid, [LineNo], AccountId, BranchCode, Debit, Credit, Memo)
        SELECT @EntryUid, ROW_NUMBER() OVER (ORDER BY Seq), AccountId, COALESCE(BranchCode, @BranchCode),
               Debit, Credit, Memo
        FROM @Lines;

        IF @ReversalOfUid IS NOT NULL
            UPDATE acc.JournalEntries SET ReversedByUid = @EntryUid
            WHERE EntryUid = @ReversalOfUid AND ReversedByUid IS NULL;
    COMMIT;
END
GO

/* ---------- Reverse a posted entry: a new mirror entry, never an edit ---------- */
CREATE OR ALTER PROCEDURE acc.sp_ReverseJournalEntry
    @CompanyId INT, @EntryUid UNIQUEIDENTIFIER, @ReversalDate DATE = NULL,
    @UserId INT = NULL, @Memo NVARCHAR(300) = NULL,
    @NewEntryUid UNIQUEIDENTIFIER = NULL OUTPUT
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    DECLARE @Branch VARCHAR(10), @No BIGINT, @RevBy UNIQUEIDENTIFIER, @RevOf UNIQUEIDENTIFIER, @Found BIT = 0;
    BEGIN TRAN;
        SELECT @Found = 1, @Branch = BranchCode, @No = EntryNo, @RevBy = ReversedByUid, @RevOf = ReversalOfUid
        FROM acc.JournalEntries WITH (UPDLOCK) WHERE EntryUid = @EntryUid AND CompanyId = @CompanyId;
        IF @Found = 0            THROW 52020, 'Journal entry not found.', 1;
        IF @RevBy IS NOT NULL    THROW 52021, 'This entry has already been reversed.', 1;
        IF @RevOf IS NOT NULL    THROW 52022, 'This entry is itself a reversal and cannot be reversed again.', 1;

        DECLARE @Lines acc.TVP_JournalLine;
        INSERT INTO @Lines (Seq, AccountId, BranchCode, Debit, Credit, Memo)
        SELECT [LineNo], AccountId, BranchCode, Credit, Debit, Memo
        FROM acc.JournalLines WHERE EntryUid = @EntryUid;

        DECLARE @d DATE = ISNULL(@ReversalDate, CAST(SYSDATETIME() AS DATE));
        DECLARE @m NVARCHAR(300) = ISNULL(@Memo, CONCAT(N'Reversal of entry #', @No));
        DECLARE @src VARCHAR(50) = CONVERT(VARCHAR(50), @EntryUid);
        EXEC acc.sp_PostJournalEntry @CompanyId = @CompanyId, @BranchCode = @Branch, @EntryDate = @d,
            @EntryType = 'Adjustment', @SourceType = 'REVERSAL', @SourceUid = @src,
            @Memo = @m, @UserId = @UserId, @ReversalOfUid = @EntryUid,
            @Lines = @Lines, @EntryUid = @NewEntryUid OUTPUT;
    COMMIT;
END
GO

/* ---------- Period status: Open ⇄ Closed; Locked is final ---------- */
CREATE OR ALTER PROCEDURE acc.sp_SetPeriodStatus
    @CompanyId INT, @PeriodYear INT, @PeriodMonth INT, @Status VARCHAR(10), @UserId INT = NULL
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    IF @Status NOT IN ('Open','Closed','Locked') THROW 52030, 'Status must be Open, Closed or Locked.', 1;
    DECLARE @Start DATE = DATEFROMPARTS(@PeriodYear, @PeriodMonth, 1), @Cur VARCHAR(10);
    BEGIN TRAN;
        SELECT @Cur = Status FROM acc.Periods WITH (UPDLOCK, HOLDLOCK)
        WHERE CompanyId = @CompanyId AND PeriodYear = @PeriodYear AND PeriodMonth = @PeriodMonth;
        IF @Cur = 'Locked' THROW 52031, 'This period is locked permanently and cannot be reopened.', 1;
        IF @Cur IS NULL
            INSERT INTO acc.Periods (CompanyId, PeriodYear, PeriodMonth, PeriodStart, PeriodEnd, Status)
            VALUES (@CompanyId, @PeriodYear, @PeriodMonth, @Start, EOMONTH(@Start), 'Open');
        UPDATE acc.Periods
        SET Status = @Status,
            ClosedAt = CASE WHEN @Status = 'Open' THEN NULL ELSE SYSDATETIME() END,
            ClosedByUserId = CASE WHEN @Status = 'Open' THEN NULL ELSE @UserId END
        WHERE CompanyId = @CompanyId AND PeriodYear = @PeriodYear AND PeriodMonth = @PeriodMonth;
    COMMIT;
END
GO

/* ---------- End of Day → ledger: ONE summarized entry per terminal per business day ----------
   Called from dbo.sp_ProcessEndOfDay inside its transaction: if posting fails, EOD fails.
   Silently does nothing when accounting isn't turned on, or for business dates before the
   configured StartDate. Idempotent on SourceType='ZREAD' + SourceUid=ZReadId.

   Two deliberate departures from reading ZReads columns verbatim (Addendum B §5.1):
   - Cash: ZReads.CashSales is TENDERED cash (change included — see sp_ProcessBlindClose,
     which subtracts ChangeAmount separately). Cash on Hand gets CashSales − change.
   - Sales - Vatable: for a VAT-exempt discount (SC/PWD standard case) the exempt bucket
     holds the PRE-discount amount, but for a non-exempt discount (e.g. 5% on prime
     commodities) the vatable bucket holds the POST-discount amount (see computeTotals()
     in web/src/lib/store.js). The discount contra line always carries the full
     TotalDiscounts, so that second kind of discount is added back to Sales - Vatable —
     computed per sale as NetAmount + DiscountAmount − (sum of the four buckets), which is
     0 for every other sale. This makes the entry balance exactly by construction.
   Any remaining gap between money received (cash − change + card) and NetSales goes to
   the ROUNDING account rather than failing End of Day. */
CREATE OR ALTER PROCEDURE acc.sp_PostZReadToLedger
    @ZReadId INT, @CompanyId INT = 1
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    DECLARE @Start DATE;
    SELECT @Start = StartDate FROM acc.Settings WHERE CompanyId = @CompanyId AND IsEnabled = 1;
    IF @Start IS NULL RETURN;

    DECLARE @TerminalId INT, @Date DATE, @Branch VARCHAR(10), @ZCounter INT, @TerminalCode NVARCHAR(40),
        @CashSales DECIMAL(18,2), @CardSales DECIMAL(18,2), @Vatable DECIMAL(18,2), @Vat DECIMAL(18,2),
        @Exempt DECIMAL(18,2), @Zero DECIMAL(18,2), @Disc DECIMAL(18,2), @Net DECIMAL(18,2), @Approver INT,
        @GcSales DECIMAL(18,2);
    SELECT @TerminalId = z.TerminalId, @Date = z.BusinessDate, @Branch = z.BranchCode, @ZCounter = z.ZCounter,
        @TerminalCode = t.TerminalCode, @CashSales = z.CashSales, @CardSales = z.CardSales, @GcSales = z.GcSales,
        @Vatable = z.VatableAmount, @Vat = z.VatAmount, @Exempt = z.VatExemptAmount, @Zero = z.ZeroRatedAmount,
        @Disc = z.TotalDiscounts, @Net = z.NetSales, @Approver = z.ApprovedByUserId
    FROM dbo.ZReads z JOIN dbo.Terminals t ON t.TerminalId = z.TerminalId
    WHERE z.ZReadId = @ZReadId;
    IF @TerminalId IS NULL THROW 52040, 'Z-Read not found.', 1;
    IF @Date < @Start RETURN;

    DECLARE @Src VARCHAR(50) = CONVERT(VARCHAR(50), @ZReadId);
    IF EXISTS (SELECT 1 FROM acc.JournalEntries WHERE CompanyId = @CompanyId AND SourceType = 'ZREAD'
               AND SourceUid = @Src AND ReversedByUid IS NULL) RETURN;

    DECLARE @Change DECIMAL(18,2), @DiscInVatable DECIMAL(18,2);
    SELECT @Change = ISNULL(SUM(ChangeAmount), 0),
           @DiscInVatable = ISNULL(SUM(NetAmount + DiscountAmount
                                       - (VatableAmount + VatAmount + VatExemptAmount + ZeroRatedAmount)), 0)
    FROM dbo.Sales WHERE TerminalId = @TerminalId AND BusinessDate = @Date AND Status = 'Completed';

    DECLARE @ShortOver DECIMAL(18,2) = ISNULL((
        SELECT SUM(c.ShortOver) FROM dbo.ShiftClosings c JOIN dbo.Shifts s ON s.ShiftUid = c.ShiftUid
        WHERE s.TerminalId = @TerminalId AND s.BusinessDate = @Date), 0);

    /* Return transactions processed today (on any day's invoice): reverse the same sales,
       VAT and discount lines and credit the cash refunded. RetDiscInVatable is the same
       add-back as @DiscInVatable above, so this part balances by construction too. */
    DECLARE @RetNet DECIMAL(18,2), @RetDisc DECIMAL(18,2), @RetVatable DECIMAL(18,2), @RetVat DECIMAL(18,2),
        @RetExempt DECIMAL(18,2), @RetZero DECIMAL(18,2), @RetDiscInVatable DECIMAL(18,2);
    SELECT @RetNet = ISNULL(SUM(NetAmount), 0), @RetDisc = ISNULL(SUM(DiscountAmount), 0),
           @RetVatable = ISNULL(SUM(VatableAmount), 0), @RetVat = ISNULL(SUM(VatAmount), 0),
           @RetExempt = ISNULL(SUM(VatExemptAmount), 0), @RetZero = ISNULL(SUM(ZeroRatedAmount), 0),
           @RetDiscInVatable = ISNULL(SUM(NetAmount + DiscountAmount
                                          - (VatableAmount + VatAmount + VatExemptAmount + ZeroRatedAmount)), 0)
    FROM dbo.SaleReturns WHERE TerminalId = @TerminalId AND BusinessDate = @Date;

    DECLARE @Received DECIMAL(18,2) = @CashSales - @Change + @CardSales + @GcSales;

    /* Signed amounts: positive = debit, negative = credit. */
    DECLARE @Parts TABLE (Seq INT, RuleKey VARCHAR(40), Amount DECIMAL(18,2), Memo NVARCHAR(200));
    INSERT INTO @Parts VALUES
        (1, 'CASH',            @CashSales - @Change,        N'Cash sales (net of change)'),
        (2, 'CARD',            @CardSales,                  N'Card sales awaiting settlement'),
        (3, 'DISCOUNT',        @Disc,                       N'Discounts given'),
        (4, 'SALES_VATABLE',   -(@Vatable + @DiscInVatable), N'Vatable sales'),
        (5, 'VAT_OUTPUT',      -@Vat,                       N'Output VAT'),
        (6, 'SALES_EXEMPT',    -@Exempt,                    N'VAT-exempt sales'),
        (7, 'SALES_ZERORATED', -@Zero,                      N'Zero-rated sales'),
        (8, 'ROUNDING',        -(@Received - @Net),         N'Rounding / payment difference'),
        (9, 'SHORT_OVER',      -@ShortOver,                 CASE WHEN @ShortOver < 0 THEN N'Cash drawer short' ELSE N'Cash drawer over' END),
        (10,'CASH',            @ShortOver,                  CASE WHEN @ShortOver < 0 THEN N'Cash drawer short' ELSE N'Cash drawer over' END),
        (11,'SALES_VATABLE',   @RetVatable + @RetDiscInVatable, N'Returns: vatable sales'),
        (12,'VAT_OUTPUT',      @RetVat,                     N'Returns: output VAT'),
        (13,'SALES_EXEMPT',    @RetExempt,                  N'Returns: VAT-exempt sales'),
        (14,'SALES_ZERORATED', @RetZero,                    N'Returns: zero-rated sales'),
        (15,'DISCOUNT',        -@RetDisc,                   N'Returns: discounts given back'),
        (16,'CASH',            -@RetNet,                    N'Returns: cash refunded'),
        -- 38: what the gift certificates paid takes them off the books (the value forfeited is
        -- head office's: SparkPOS never booked the GCs' sale)
        (17,'GC',              @GcSales,                    N'Gift certificates redeemed');
    DELETE FROM @Parts WHERE Amount = 0;
    IF NOT EXISTS (SELECT 1 FROM @Parts) RETURN;   -- a day with no sales and no variance: nothing to post

    DECLARE @missing VARCHAR(40) = (SELECT TOP 1 p.RuleKey FROM @Parts p
        LEFT JOIN acc.PostingRules r ON r.CompanyId = @CompanyId AND r.SourceType = 'ZREAD' AND r.RuleKey = p.RuleKey
        WHERE r.RuleId IS NULL);
    IF @missing IS NOT NULL
    BEGIN
        DECLARE @msg NVARCHAR(400) = CONCAT(N'Accounting setup is incomplete: no account is mapped for End of Day item "', @missing, N'".');
        THROW 52041, @msg, 1;
    END

    DECLARE @Lines acc.TVP_JournalLine;
    INSERT INTO @Lines (Seq, AccountId, BranchCode, Debit, Credit, Memo)
    SELECT p.Seq, r.AccountId, @Branch,
           CASE WHEN p.Amount > 0 THEN p.Amount ELSE 0 END,
           CASE WHEN p.Amount < 0 THEN -p.Amount ELSE 0 END, p.Memo
    FROM @Parts p JOIN acc.PostingRules r
        ON r.CompanyId = @CompanyId AND r.SourceType = 'ZREAD' AND r.RuleKey = p.RuleKey;

    DECLARE @Memo NVARCHAR(300) = CONCAT(N'End of Day ', @Branch, N'/', @TerminalCode, N' ',
                                         CONVERT(CHAR(10), @Date, 120), N' (Z-Read #', @ZCounter, N')');
    DECLARE @EntryUid UNIQUEIDENTIFIER;
    /* PermitId: copy from the Z-Read once Addendum A adds dbo.ZReads.PermitId. */
    EXEC acc.sp_PostJournalEntry @CompanyId = @CompanyId, @BranchCode = @Branch, @EntryDate = @Date,
        @EntryType = 'Auto', @SourceType = 'ZREAD', @SourceUid = @Src, @Memo = @Memo,
        @UserId = @Approver, @Lines = @Lines, @EntryUid = @EntryUid OUTPUT;
END
GO

/* ============================ ACCOUNTING REPORTS ============================ */

/* Trial balance as of a date. Balances are debit-positive; Debit/Credit columns split them. */
CREATE OR ALTER PROCEDURE acc.sp_rpt_TrialBalance
    @CompanyId INT, @AsOf DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT a.AccountId, a.AccountCode, a.AccountName, a.PlainName, a.AccountType,
           x.TotalDebit, x.TotalCredit,
           CASE WHEN x.TotalDebit > x.TotalCredit THEN x.TotalDebit - x.TotalCredit ELSE 0 END AS Debit,
           CASE WHEN x.TotalCredit > x.TotalDebit THEN x.TotalCredit - x.TotalDebit ELSE 0 END AS Credit
    FROM acc.ChartOfAccounts a
    JOIN (SELECT l.AccountId, SUM(l.Debit) AS TotalDebit, SUM(l.Credit) AS TotalCredit
          FROM acc.JournalLines l JOIN acc.JournalEntries e ON e.EntryUid = l.EntryUid
          WHERE e.CompanyId = @CompanyId AND e.IsPosted = 1 AND e.EntryDate <= @AsOf
            AND (@BranchCode IS NULL OR l.BranchCode = @BranchCode)
          GROUP BY l.AccountId) x ON x.AccountId = a.AccountId
    WHERE a.CompanyId = @CompanyId AND x.TotalDebit <> x.TotalCredit
    ORDER BY a.AccountCode;
END
GO

/* General ledger for one account: opening balance, then each line with a running balance.
   Balances are debit-positive (NormalSide tells the UI how to present them). */
CREATE OR ALTER PROCEDURE acc.sp_rpt_GeneralLedger
    @CompanyId INT, @AccountId INT, @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @Opening DECIMAL(18,2) = ISNULL((
        SELECT SUM(l.Debit - l.Credit) FROM acc.JournalLines l JOIN acc.JournalEntries e ON e.EntryUid = l.EntryUid
        WHERE e.CompanyId = @CompanyId AND e.IsPosted = 1 AND l.AccountId = @AccountId AND e.EntryDate < @DateFrom
          AND (@BranchCode IS NULL OR l.BranchCode = @BranchCode)), 0);

    SELECT a.AccountId, a.AccountCode, a.AccountName, a.PlainName, a.AccountType,
           CASE WHEN a.AccountType IN ('Asset','Expense') THEN 'Debit' ELSE 'Credit' END AS NormalSide,
           @Opening AS OpeningBalance
    FROM acc.ChartOfAccounts a WHERE a.AccountId = @AccountId AND a.CompanyId = @CompanyId;

    SELECT e.EntryUid, e.EntryNo, e.EntryDate, e.EntryType, e.SourceType, e.SourceUid, e.Memo AS EntryMemo,
           l.[LineNo], l.BranchCode, l.Debit, l.Credit, l.Memo,
           @Opening + SUM(l.Debit - l.Credit) OVER (ORDER BY e.EntryDate, e.EntryNo, l.[LineNo]
                                                    ROWS UNBOUNDED PRECEDING) AS Balance
    FROM acc.JournalLines l JOIN acc.JournalEntries e ON e.EntryUid = l.EntryUid
    WHERE e.CompanyId = @CompanyId AND e.IsPosted = 1 AND l.AccountId = @AccountId
      AND e.EntryDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR l.BranchCode = @BranchCode)
    ORDER BY e.EntryDate, e.EntryNo, l.[LineNo];
END
GO

/* General journal: entries in a date range, then all their lines. */
CREATE OR ALTER PROCEDURE acc.sp_rpt_Journal
    @CompanyId INT, @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT e.EntryUid, e.EntryNo, e.EntryDate, e.EntryType, e.SourceType, e.SourceUid, e.BranchCode,
           e.Memo, e.TotalAmount, e.PostedAt, u.FullName AS PostedBy, e.ReversalOfUid, e.ReversedByUid
    INTO #e
    FROM acc.JournalEntries e LEFT JOIN dbo.Users u ON u.UserId = e.PostedByUserId
    WHERE e.CompanyId = @CompanyId AND e.EntryDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR e.BranchCode = @BranchCode);

    SELECT * FROM #e ORDER BY EntryDate, EntryNo;

    SELECT l.EntryUid, l.[LineNo], l.AccountId, a.AccountCode, a.AccountName, a.PlainName,
           l.BranchCode, l.Debit, l.Credit, l.Memo
    FROM acc.JournalLines l JOIN #e ON #e.EntryUid = l.EntryUid
    JOIN acc.ChartOfAccounts a ON a.AccountId = l.AccountId
    ORDER BY l.EntryUid, l.[LineNo];
END
GO
