/* =====================================================================
   Price level tests (31_price_levels.sql + 02_procedures.sql): the ERP's Price1..4 synced per
   branch, the till's price list, and the level kept on a sale.
   Every batch is rolled back, so this is safe on any DB with the schema and a terminal, user
   and product. Each result row must show Pass = 1. Business dates are in 2099.
   ===================================================================== */
SET NOCOUNT ON;
GO

/* L1. Sync: head office's and each branch's levels; 0 / negative = none; not sent = kept;
       the till gets the levels of the row its price comes from. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    DECLARE @c dbo.TVP_ErpCategory, @p dbo.TVP_ErpProduct, @b dbo.TVP_ErpBranch, @pr dbo.TVP_ErpPrice, @lv dbo.TVP_ErpPriceLevel;
    INSERT @c VALUES (12, N'INGREDIENTS');
    INSERT @p VALUES ('Z9200', N'Z9200', N'TEST LEVELS', 12, N'kg', 1, 1, 0, 1);
    INSERT @b VALUES ('Z88', N'TEST HEAD OFFICE', NULL), ('Z01', N'TEST BRANCH 1', NULL), ('Z02', N'TEST BRANCH 2', NULL);
    INSERT @pr VALUES ('Z88', 'Z9200', 100), ('Z01', 'Z9200', 110);
    INSERT @lv VALUES ('Z88', 'Z9200', 90.0000, 0, NULL, -5), ('Z01', 'Z9200', 95.1250, 80, NULL, NULL);
    -- Z02 has no ERP row: it sells at head office's price, so it gets head office's levels
    EXEC dbo.sp_ErpSyncMasterData @Categories = @c, @Products = @p, @Branches = @b, @Prices = @pr,
        @PriceBranch = 'Z88', @PriceLevels = @lv, @LevelsSent = 1;

    DECLARE @pid INT = (SELECT ProductId FROM dbo.Products WHERE ErpProductCode = 'Z9200');
    INSERT @r SELECT 'L1a head office levels: 90 kept, 0 and a negative become none',
        CASE WHEN Price1 = 90 AND Price2 IS NULL AND Price3 IS NULL AND Price4 IS NULL THEN 1 ELSE 0 END,
        CONCAT(Price1, '/', Price2, '/', Price3, '/', Price4) FROM dbo.Products WHERE ProductId = @pid;
    INSERT @r SELECT 'L1b a branch row keeps its own levels (4 decimals rounded)',
        CASE WHEN Price = 110 AND Price1 = 95.13 AND Price2 = 80 AND Price3 IS NULL THEN 1 ELSE 0 END,
        CONCAT(Price, ' ', Price1, '/', Price2) FROM dbo.ProductPrices WHERE ProductId = @pid AND BranchCode = 'Z01';

    DECLARE @PL TABLE (ProductId INT, Barcode NVARCHAR(50), ProductName NVARCHAR(150), CategoryId INT,
        CategoryName NVARCHAR(80), Unit NVARCHAR(20), BasePrice DECIMAL(18,2), Price DECIMAL(18,2),
        HasOverride BIT, IsVatable BIT, IsDiscountable BIT, AllowPriceEdit BIT, IsActive BIT, ImageUrl NVARCHAR(255),
        ErpProductCode VARCHAR(50), Price1 DECIMAL(18,2), Price2 DECIMAL(18,2), Price3 DECIMAL(18,2), Price4 DECIMAL(18,2));
    INSERT @PL EXEC dbo.sp_GetPriceList @BranchCode = 'Z01';
    INSERT @r SELECT 'L1c till at Z01: its own price and levels',
        CASE WHEN Price = 110 AND Price1 = 95.13 AND Price2 = 80 THEN 1 ELSE 0 END, CONCAT(Price, ' ', Price1, '/', Price2)
    FROM @PL WHERE ErpProductCode = 'Z9200';
    DELETE @PL;
    INSERT @PL EXEC dbo.sp_GetPriceList @BranchCode = 'Z02';
    INSERT @r SELECT 'L1d till at Z02 (no row of its own): head office''s price and levels',
        CASE WHEN Price = 100 AND Price1 = 90 AND Price2 IS NULL THEN 1 ELSE 0 END, CONCAT(Price, ' ', Price1, '/', Price2)
    FROM @PL WHERE ErpProductCode = 'Z9200';

    /* An ERP proc without the columns (LevelsSent = 0) leaves the levels alone. */
    UPDATE @lv SET Price1 = NULL, Price2 = NULL;
    EXEC dbo.sp_ErpSyncMasterData @Categories = @c, @Products = @p, @Branches = @b, @Prices = @pr,
        @PriceBranch = 'Z88', @PriceLevels = @lv, @LevelsSent = 0;
    -- an older API: the 3-column price list only, no level list or flag at all
    EXEC dbo.sp_ErpSyncMasterData @Categories = @c, @Products = @p, @Branches = @b, @Prices = @pr, @PriceBranch = 'Z88';
    INSERT @r SELECT 'L1e levels not sent, and an older API''s call: nothing is cleared',
        CASE WHEN p.Price1 = 90 AND pp.Price1 = 95.13 AND pp.Price2 = 80 THEN 1 ELSE 0 END, CONCAT(p.Price1, ' / ', pp.Price1)
    FROM dbo.Products p JOIN dbo.ProductPrices pp ON pp.ProductId = p.ProductId AND pp.BranchCode = 'Z01'
    WHERE p.ProductId = @pid;

    /* Sent with Z01's Price1 gone and head office's changed: mirrored; the price itself unchanged. */
    UPDATE @lv SET Price1 = CASE BranchCode WHEN 'Z88' THEN 85 END, Price2 = CASE BranchCode WHEN 'Z01' THEN 80 END;
    EXEC dbo.sp_ErpSyncMasterData @Categories = @c, @Products = @p, @Branches = @b, @Prices = @pr,
        @PriceBranch = 'Z88', @PriceLevels = @lv, @LevelsSent = 1;
    INSERT @r SELECT 'L1f levels sent again: a removed level clears, a changed one updates, prices stay',
        CASE WHEN p.Price1 = 85 AND p.BasePrice = 100 AND pp.Price1 IS NULL AND pp.Price2 = 80 AND pp.Price = 110 THEN 1 ELSE 0 END,
        CONCAT(p.Price1, ' / ', pp.Price1, '/', pp.Price2, ' ', pp.Price)
    FROM dbo.Products p JOIN dbo.ProductPrices pp ON pp.ProductId = p.ProductId AND pp.BranchCode = 'Z01'
    WHERE p.ProductId = @pid;

    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'L1 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO

/* L2. A sale at a price level keeps it; no level, or an out-of-range one, keeps none. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    DECLARE @term INT, @branch VARCHAR(10), @user INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId);
    SET @term = NULL;
    SELECT TOP 1 @term = TerminalId, @branch = BranchCode FROM dbo.Terminals t
    WHERE NOT EXISTS (SELECT 1 FROM dbo.Shifts s WHERE s.TerminalId = t.TerminalId
        AND NOT EXISTS (SELECT 1 FROM dbo.ZReads z WHERE z.TerminalId = s.TerminalId AND z.BusinessDate = s.BusinessDate))
    ORDER BY TerminalId;
    IF @term IS NULL   -- every real terminal has a day left open: use a throwaway one (rolled back)
    BEGIN
        SELECT TOP 1 @branch = BranchCode FROM dbo.Branches WHERE IsActive = 1 ORDER BY BranchCode;
        INSERT dbo.Terminals (BranchCode, TerminalCode, TerminalName) VALUES (@branch, 'ZZ-TEST', N'ZZTEST terminal');
        SET @term = SCOPE_IDENTITY();
    END
    DECLARE @prod INT, @cat INT; SELECT TOP 1 @prod = ProductId, @cat = CategoryId FROM dbo.Products ORDER BY ProductId;
    DECLARE @d DATE = '2099-05-01', @shift UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
    INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@shift, @branch, @term, @user, @d, 1000, @now);
    DECLARE @si BIGINT = ISNULL((SELECT MAX(ORNumber) FROM dbo.Sales WHERE TerminalId = @term), 0);

    /* ₱112 VAT-able at level 1: 100 + 12 */
    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment;
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount)
    VALUES (1, @prod, 'L1', 'Test level item', @cat, 1, 112, 112, 0, 112, 1, 1, 112, 100, 12);
    INSERT @p VALUES (1, 'CASH', 112, NULL, NULL, NULL, NULL);
    DECLARE @edits INT = (SELECT COUNT(*) FROM dbo.AuditLogs WHERE Action = 'PRICE_EDIT' AND TerminalId = @term);
    DECLARE @n INT = 0, @lvl TINYINT, @u UNIQUEIDENTIFIER;
    DECLARE @want TABLE (n INT, lvl TINYINT NULL, uid UNIQUEIDENTIFIER);
    WHILE @n < 3
    BEGIN
        SET @n += 1; SET @si += 1; SET @u = NEWID();
        SET @lvl = CASE @n WHEN 1 THEN 1 WHEN 2 THEN NULL ELSE 7 END;
        INSERT @want VALUES (@n, @lvl, @u);
        EXEC dbo.sp_UpsertSale @SaleUid=@u, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
            @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=0,
            @VatExemptAmount=0, @VatableAmount=100, @VatAmount=12, @ZeroRatedAmount=0, @NetAmount=112,
            @TenderedAmount=112, @ChangeAmount=0, @PriceLevel=@lvl, @Items=@i, @Payments=@p;
    END
    INSERT @r SELECT 'L2a a sale at level 1 keeps PriceLevel 1',
        CASE WHEN s.PriceLevel = 1 THEN 1 ELSE 0 END, CONCAT(s.PriceLevel, '')
    FROM dbo.Sales s JOIN @want w ON w.uid = s.SaleUid WHERE w.n = 1;
    INSERT @r SELECT 'L2b a sale at the regular price keeps none',
        CASE WHEN s.PriceLevel IS NULL THEN 1 ELSE 0 END, CONCAT(s.PriceLevel, '')
    FROM dbo.Sales s JOIN @want w ON w.uid = s.SaleUid WHERE w.n = 2;
    INSERT @r SELECT 'L2c an out-of-range level is stored as none, and the sale still goes through',
        CASE WHEN s.PriceLevel IS NULL THEN 1 ELSE 0 END, CONCAT(s.PriceLevel, '')
    FROM dbo.Sales s JOIN @want w ON w.uid = s.SaleUid WHERE w.n = 3;
    INSERT @r SELECT 'L2d no price change audited for a level sale (its price is the level price)',
        CASE WHEN (SELECT COUNT(*) FROM dbo.AuditLogs WHERE Action = 'PRICE_EDIT' AND TerminalId = @term) = @edits
             THEN 1 ELSE 0 END, '';

    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'L2 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO

/* L3. The four levels exist (named and switched on in Admin). */
SELECT 'L3 four price levels exist' AS Test,
    CASE WHEN (SELECT COUNT(*) FROM dbo.PriceLevels) = 4
          AND NOT EXISTS (SELECT 1 FROM dbo.PriceLevels WHERE PriceLevel NOT BETWEEN 1 AND 4) THEN 1 ELSE 0 END AS Pass,
    (SELECT STRING_AGG(CONCAT(PriceLevel, ' ', LevelName, CASE WHEN IsActive = 1 THEN ' on' ELSE ' off' END), ', ')
     FROM dbo.PriceLevels) AS Detail;
GO
