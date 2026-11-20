/* Smoke test for dbo.sp_ErpSyncMasterData. Every batch is rolled back. Each check row must show Pass = 1. */
SET NOCOUNT ON;
GO

/* 1. An empty product list is refused and changes nothing. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @c dbo.TVP_ErpCategory, @p dbo.TVP_ErpProduct, @b dbo.TVP_ErpBranch;
    INSERT @c VALUES (12, N'INGREDIENTS');
    EXEC dbo.sp_ErpSyncMasterData @Categories = @c, @Products = @p, @Branches = @b;
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'T1 empty product list refused' AS Test, 0 AS Pass;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'T1 empty product list refused' AS Test, CASE WHEN ERROR_NUMBER() = 53002 THEN 1 ELSE 0 END AS Pass, ERROR_MESSAGE() AS Msg;
END CATCH
GO

/* 2-6. Import, idempotent re-run, change + removal, price list hiding. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @c dbo.TVP_ErpCategory, @p dbo.TVP_ErpProduct, @b dbo.TVP_ErpBranch;
    DECLARE @R TABLE (CategoriesAdded INT, CategoriesUpdated INT, CategoriesLinked INT, CategoriesDeactivated INT,
        ProductsAdded INT, ProductsUpdated INT, ProductsLinked INT, ProductsDeactivated INT,
        ProductsNeedPrice INT, LocalProductsActive INT, BranchesAdded INT, BranchesUpdated INT);
    DECLARE @I TABLE (Kind VARCHAR(20), Code NVARCHAR(100), Message NVARCHAR(400));

    INSERT @c VALUES (12, N'INGREDIENTS'), (13, N'IMPORTED PORK'), (14, N'IMPORTED CHICKEN'),
                     (15, N'IMPORTED BEEF'), (16, N'OTHERS');
    INSERT @p VALUES
        ('Z9000', N'Z9000', N'TEST ACCORD BRINE',        12, N'kg', 1, 1, 0, 1),
        ('Z9001', N'Z9001', N'TEST FRIES 1KG',           12, N'kg', 1, 0, 0, 1),
        ('Z9002', N'NULL',  N'TEST SHEEP CASING',        13, N'kg', 0, 1, 0, 1),   -- 'NULL' barcode -> code
        ('Z9003', N'',      N'TEST BOXES',               13, N'pc', 0, 1, 0, 1),   -- blank barcode -> code
        ('Z9BAD', N'Z9BAD', N'TEST UNKNOWN CATEGORY',    99, N'kg', 0, 1, 0, 1),   -- skipped
        ('',      N'',      N'TEST NO CODE',             12, N'kg', 0, 1, 0, 1);   -- skipped
    INSERT @b VALUES ('Z88', N'TEST HEAD OFFICE', N'TEST ADDRESS');

    -- Run 1: import. Proc returns 2 result sets; capture via INSERT-EXEC isn't possible for two
    -- sets, so let them print and assert on table state instead.
    EXEC dbo.sp_ErpSyncMasterData @Categories = @c, @Products = @p, @Branches = @b;

    SELECT 'T2 four test products imported, price 0 (no ERP prices sent), price-editable with override' AS Test,
           CASE WHEN COUNT(*) = 4 AND SUM(CASE WHEN BasePrice = 0 AND AllowPriceEdit = 1 AND IsActive = 1 THEN 1 ELSE 0 END) = 4
                THEN 1 ELSE 0 END AS Pass
    FROM dbo.Products WHERE ErpProductCode LIKE 'Z900%';

    SELECT 'T3 NULL/blank barcode became the product code' AS Test,
           CASE WHEN SUM(CASE WHEN Barcode = ErpProductCode THEN 1 ELSE 0 END) = 4 THEN 1 ELSE 0 END AS Pass
    FROM dbo.Products WHERE ErpProductCode LIKE 'Z900%';

    SELECT 'T4 all five ERP categories linked and active' AS Test,
           CASE WHEN COUNT(*) = 5 AND MIN(CAST(IsActive AS INT)) = 1 THEN 1 ELSE 0 END AS Pass
    FROM dbo.Categories WHERE ErpCategoryId IN (12, 13, 14, 15, 16);

    SELECT 'T5 product category + flags + unit mapped' AS Test,
           CASE WHEN EXISTS (SELECT 1 FROM dbo.Products p JOIN dbo.Categories c ON c.CategoryId = p.CategoryId
                             WHERE p.ErpProductCode = 'Z9003' AND c.ErpCategoryId = 13 AND p.Unit = 'pc'
                               AND p.IsVatable = 0 AND p.IsDiscountable = 1)
                 AND EXISTS (SELECT 1 FROM dbo.Products WHERE ErpProductCode = 'Z9001' AND IsDiscountable = 0)
                THEN 1 ELSE 0 END AS Pass;

    SELECT 'T6 bad rows skipped, not imported' AS Test,
           CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.Products WHERE ErpProductCode = 'Z9BAD' OR ProductName = N'TEST NO CODE')
                THEN 1 ELSE 0 END AS Pass;

    SELECT 'T7 new branch inserted with its PosSettings row' AS Test,
           CASE WHEN EXISTS (SELECT 1 FROM dbo.Branches WHERE BranchCode = 'Z88' AND BranchName = N'TEST HEAD OFFICE')
                 AND EXISTS (SELECT 1 FROM dbo.PosSettings WHERE BranchCode = 'Z88') THEN 1 ELSE 0 END AS Pass;

    -- Price list: unpriced ERP products stay off the till; once priced, they appear.
    DECLARE @PL TABLE (ProductId INT, Barcode NVARCHAR(50), ProductName NVARCHAR(150), CategoryId INT,
        CategoryName NVARCHAR(80), Unit NVARCHAR(20), BasePrice DECIMAL(18,2), Price DECIMAL(18,2),
        HasOverride BIT, IsVatable BIT, IsDiscountable BIT, AllowPriceEdit BIT, IsActive BIT, ImageUrl NVARCHAR(255),
        ErpProductCode VARCHAR(50), Price1 DECIMAL(18,2), Price2 DECIMAL(18,2), Price3 DECIMAL(18,2), Price4 DECIMAL(18,2));
    INSERT @PL EXEC dbo.sp_GetPriceList @BranchCode = 'Z88';
    SELECT 'T8 unpriced ERP products hidden from the price list' AS Test,
           CASE WHEN NOT EXISTS (SELECT 1 FROM @PL WHERE Barcode LIKE 'Z900%') THEN 1 ELSE 0 END AS Pass;

    UPDATE dbo.Products SET BasePrice = 99.50 WHERE ErpProductCode = 'Z9000';
    DELETE @PL; INSERT @PL EXEC dbo.sp_GetPriceList @BranchCode = 'Z88';
    SELECT 'T9 priced product appears on the price list' AS Test,
           CASE WHEN EXISTS (SELECT 1 FROM @PL WHERE Barcode = 'Z9000' AND Price = 99.50)
                 AND (SELECT COUNT(*) FROM @PL WHERE Barcode LIKE 'Z900%') = 1 THEN 1 ELSE 0 END AS Pass;

    -- Run 2: same input again changes nothing on the test rows (and keeps the price).
    DECLARE @before DATETIME2 = (SELECT MAX(RowVersionTs) FROM dbo.Products WHERE ErpProductCode LIKE 'Z900%');
    EXEC dbo.sp_ErpSyncMasterData @Categories = @c, @Products = @p, @Branches = @b;
    SELECT 'T10 re-run is idempotent and keeps the admin price' AS Test,
           CASE WHEN (SELECT MAX(RowVersionTs) FROM dbo.Products WHERE ErpProductCode LIKE 'Z900%') = @before
                 AND (SELECT COUNT(*) FROM dbo.Products WHERE ErpProductCode LIKE 'Z900%') = 4
                 AND (SELECT BasePrice FROM dbo.Products WHERE ErpProductCode = 'Z9000') = 99.50
                THEN 1 ELSE 0 END AS Pass;

    -- Run 3: rename one, drop one from the ERP list.
    UPDATE @p SET ProductName = N'TEST ACCORD BRINE RENAMED' WHERE ErpProductCode = 'Z9000';
    DELETE @p WHERE ErpProductCode = 'Z9001';
    EXEC dbo.sp_ErpSyncMasterData @Categories = @c, @Products = @p, @Branches = @b;
    SELECT 'T11 rename applied, missing product deactivated (not deleted)' AS Test,
           CASE WHEN EXISTS (SELECT 1 FROM dbo.Products WHERE ErpProductCode = 'Z9000' AND ProductName = N'TEST ACCORD BRINE RENAMED' AND BasePrice = 99.50)
                 AND EXISTS (SELECT 1 FROM dbo.Products WHERE ErpProductCode = 'Z9001' AND IsActive = 0)
                THEN 1 ELSE 0 END AS Pass;

    ROLLBACK;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'T2-T11 batch' AS Test, 0 AS Pass, ERROR_NUMBER() AS Err, ERROR_MESSAGE() AS Msg, ERROR_LINE() AS Line;
END CATCH
GO

/* 13-17. ERP prices: head office's SellingPrice is the base price, each branch's is its
   branch price, mirrored exactly; admin price changes on ERP products are refused. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    DECLARE @c dbo.TVP_ErpCategory, @p dbo.TVP_ErpProduct, @b dbo.TVP_ErpBranch, @pr dbo.TVP_ErpPrice;
    INSERT @c VALUES (12, N'INGREDIENTS');
    INSERT @p VALUES ('Z9100', N'Z9100', N'TEST PRICED',   12, N'kg', 1, 1, 0, 1),
                     ('Z9101', N'Z9101', N'TEST UNPRICED', 12, N'kg', 1, 1, 0, 1);
    INSERT @b VALUES ('Z88', N'TEST HEAD OFFICE', NULL), ('Z01', N'TEST BRANCH 1', NULL), ('Z02', N'TEST BRANCH 2', NULL);
    INSERT @pr (BranchCode, ErpProductCode, Price) VALUES ('Z88', 'Z9100', 100.0000), ('Z01', 'Z9100', 110.0000), ('Z02', 'Z9100', 95.1250),
                      ('Z88', 'Z9101', 0), ('Z99', 'Z9100', 1);
    EXEC dbo.sp_ErpSyncMasterData @Categories = @c, @Products = @p, @Branches = @b, @Prices = @pr, @PriceBranch = 'Z88';

    DECLARE @pid INT = (SELECT ProductId FROM dbo.Products WHERE ErpProductCode = 'Z9100');
    INSERT @r SELECT 'T13 head office price became the base price; each branch got its own',
        CASE WHEN p.BasePrice = 100 AND (SELECT Price FROM dbo.ProductPrices WHERE ProductId = @pid AND BranchCode = 'Z01') = 110
              AND (SELECT Price FROM dbo.ProductPrices WHERE ProductId = @pid AND BranchCode = 'Z02') = 95.13 THEN 1 ELSE 0 END,
        CONCAT('base ', p.BasePrice) FROM dbo.Products p WHERE p.ProductId = @pid;
    INSERT @r SELECT 'T14 a price on an unknown branch is skipped; 4-decimal price rounded',
        CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.ProductPrices WHERE BranchCode = 'Z99') THEN 1 ELSE 0 END, '';

    DECLARE @PL TABLE (ProductId INT, Barcode NVARCHAR(50), ProductName NVARCHAR(150), CategoryId INT,
        CategoryName NVARCHAR(80), Unit NVARCHAR(20), BasePrice DECIMAL(18,2), Price DECIMAL(18,2),
        HasOverride BIT, IsVatable BIT, IsDiscountable BIT, AllowPriceEdit BIT, IsActive BIT, ImageUrl NVARCHAR(255),
        ErpProductCode VARCHAR(50), Price1 DECIMAL(18,2), Price2 DECIMAL(18,2), Price3 DECIMAL(18,2), Price4 DECIMAL(18,2));
    INSERT @PL EXEC dbo.sp_GetPriceList @BranchCode = 'Z01';
    INSERT @r SELECT 'T15 till shows the branch price; an ERP item at 0 stays hidden even though price-editable',
        CASE WHEN EXISTS (SELECT 1 FROM @PL WHERE Barcode = 'Z9100' AND Price = 110)
              AND NOT EXISTS (SELECT 1 FROM @PL WHERE Barcode = 'Z9101') THEN 1 ELSE 0 END, '';

    /* The ERP no longer has a Z02 row for Z9100 (falls back to base); a changed price applies;
       a NULL price ("not set yet") keeps what's there. */
    INSERT @pr (BranchCode, ErpProductCode, Price) VALUES ('Z02', 'Z9101', 50);          -- Z02 is still in the price list
    DELETE @pr WHERE BranchCode = 'Z02' AND ErpProductCode = 'Z9100';
    UPDATE @pr SET Price = 120 WHERE BranchCode = 'Z01' AND ErpProductCode = 'Z9100';
    UPDATE @pr SET Price = NULL WHERE BranchCode = 'Z88' AND ErpProductCode = 'Z9100';
    EXEC dbo.sp_ErpSyncMasterData @Categories = @c, @Products = @p, @Branches = @b, @Prices = @pr, @PriceBranch = 'Z88';
    INSERT @r SELECT 'T16 branch price changes and removals mirror the ERP; a NULL price keeps the old one',
        CASE WHEN (SELECT Price FROM dbo.ProductPrices WHERE ProductId = @pid AND BranchCode = 'Z01') = 120
              AND NOT EXISTS (SELECT 1 FROM dbo.ProductPrices WHERE ProductId = @pid AND BranchCode = 'Z02')
              AND (SELECT BasePrice FROM dbo.Products WHERE ProductId = @pid) = 100 THEN 1 ELSE 0 END, '';

    /* No prices sent (ERP not ready) = prices left alone. */
    DELETE @pr;
    EXEC dbo.sp_ErpSyncMasterData @Categories = @c, @Products = @p, @Branches = @b, @Prices = @pr, @PriceBranch = 'Z88';
    INSERT @r SELECT 'T17 a sync without prices leaves prices alone',
        CASE WHEN (SELECT BasePrice FROM dbo.Products WHERE ProductId = @pid) = 100
              AND (SELECT Price FROM dbo.ProductPrices WHERE ProductId = @pid AND BranchCode = 'Z01') = 120 THEN 1 ELSE 0 END, '';

    DECLARE @bp dbo.TVP_BranchPrice; INSERT @bp VALUES ('Z01', 1);
    BEGIN TRY
        EXEC dbo.sp_SaveProductPrices @ProductId = @pid, @UpdatedBy = 1, @Prices = @bp;
        INSERT @r VALUES ('T18 admin can''t set branch prices on an ERP product', 0, 'no error');
    END TRY
    BEGIN CATCH
        INSERT @r VALUES ('T18 admin can''t set branch prices on an ERP product', CASE WHEN ERROR_NUMBER() = 53010 THEN 1 ELSE 0 END, ERROR_MESSAGE());
    END CATCH

    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    DECLARE @e INT = ERROR_NUMBER(), @m NVARCHAR(400) = ERROR_MESSAGE(), @l INT = ERROR_LINE();
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'T13-T18 batch' AS Test, 0 AS Pass, CONCAT(@e, ' ', @m, ' line ', @l) AS Detail;
END CATCH
GO

/* Nothing from the tests survived. */
SELECT 'T12 nothing left behind' AS Test,
       CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.Products WHERE ErpProductCode LIKE 'Z9%')
             AND NOT EXISTS (SELECT 1 FROM dbo.Branches WHERE BranchCode IN ('Z88', 'Z01', 'Z02')) THEN 1 ELSE 0 END AS Pass;
GO
