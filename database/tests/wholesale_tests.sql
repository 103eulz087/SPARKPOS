/* =====================================================================
   Wholesale tests (33_wholesale.sql + 02_procedures.sql): the tiers a branch's tills get, the
   wholesale lines kept with a sale, and the DTI report.
   Every batch is rolled back, so this is safe on any DB with the schema and a terminal, user,
   branch and product. Each result row must show Pass = 1. Business dates are in 2099.
   ===================================================================== */
SET NOCOUNT ON;
GO

/* W1. Which tiers a branch gets, set up like VROSS's memo: category tiers, an item with its own,
       an excluded item, a branch with its own category rule, and a branch with wholesale off. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    INSERT dbo.Branches (BranchCode, BranchName) VALUES ('ZW1', N'ZZTEST Wholesale 1'), ('ZW2', N'ZZTEST Wholesale 2'), ('ZW4', N'ZZTEST Wholesale 4');
    INSERT dbo.PosSettings (BranchCode) VALUES ('ZW1'), ('ZW2'), ('ZW4');
    INSERT dbo.Categories (CategoryName) VALUES (N'ZZTEST PORK');
    DECLARE @pork INT = SCOPE_IDENTITY();
    INSERT dbo.Products (Barcode, ProductName, CategoryId, Unit, BasePrice) VALUES
        ('ZZW-KASIM', N'ZZTEST KASIM', @pork, 'kg', 300), ('ZZW-BELLY', N'ZZTEST PORK BELLY', @pork, 'kg', 380),
        ('ZZW-CHOP', N'ZZTEST PORK CHOP', @pork, 'kg', 285);
    DECLARE @kasim INT = (SELECT ProductId FROM dbo.Products WHERE Barcode = 'ZZW-KASIM'),
            @belly INT = (SELECT ProductId FROM dbo.Products WHERE Barcode = 'ZZW-BELLY'),
            @chop INT = (SELECT ProductId FROM dbo.Products WHERE Barcode = 'ZZW-CHOP');
    INSERT dbo.WholesaleRules (CategoryId, ProductId, BranchCode, MinQty, AmountOff, IsActive) VALUES
        (@pork, NULL, NULL, 5, 5, 1), (@pork, NULL, NULL, 10, 10, 1), (@pork, NULL, NULL, 15, 15, 1),  -- all pork
        (NULL, @belly, NULL, 10, 10, 1),                                                           -- belly: from 10 kg only
        (NULL, @chop, NULL, 1, 0.01, 0),                                                           -- chop: excluded
        (@pork, NULL, 'ZW2', 3, 2, 1);                                                             -- ZW2's own pork rule
    UPDATE dbo.PosSettings SET WholesaleOn = 0 WHERE BranchCode = 'ZW4';
    DECLARE @g TABLE (ProductId INT, MinQty DECIMAL(18,3), AmountOff DECIMAL(18,2));
    INSERT @g EXEC dbo.sp_GetWholesaleRules @BranchCode = 'ZW1';
    INSERT @r SELECT 'W1a a category''s three tiers reach each of its items',
        CASE WHEN (SELECT COUNT(*) FROM @g WHERE ProductId = @kasim) = 3
              AND EXISTS (SELECT 1 FROM @g WHERE ProductId = @kasim AND MinQty = 15 AND AmountOff = 15) THEN 1 ELSE 0 END,
        (SELECT STRING_AGG(CONCAT(MinQty, '/', AmountOff), ', ') FROM @g WHERE ProductId = @kasim);
    INSERT @r SELECT 'W1b an item''s own rule wins over its category (belly: only from 10 kg, 10 off)',
        CASE WHEN (SELECT COUNT(*) FROM @g WHERE ProductId = @belly) = 1
              AND EXISTS (SELECT 1 FROM @g WHERE ProductId = @belly AND MinQty = 10 AND AmountOff = 10) THEN 1 ELSE 0 END, '';
    INSERT @r SELECT 'W1c an item rule switched off excludes it (chop)',
        CASE WHEN NOT EXISTS (SELECT 1 FROM @g WHERE ProductId = @chop) THEN 1 ELSE 0 END, '';
    DELETE @g; INSERT @g EXEC dbo.sp_GetWholesaleRules @BranchCode = 'ZW2';
    INSERT @r SELECT 'W1d a branch''s own category rule replaces the every-branch one; item rules still win',
        CASE WHEN (SELECT COUNT(*) FROM @g WHERE ProductId = @kasim) = 1
              AND EXISTS (SELECT 1 FROM @g WHERE ProductId = @kasim AND MinQty = 3 AND AmountOff = 2)
              AND EXISTS (SELECT 1 FROM @g WHERE ProductId = @belly AND MinQty = 10)
              AND NOT EXISTS (SELECT 1 FROM @g WHERE ProductId = @chop) THEN 1 ELSE 0 END, '';
    DELETE @g; INSERT @g EXEC dbo.sp_GetWholesaleRules @BranchCode = 'ZW4';
    INSERT @r SELECT 'W1e a branch with wholesale off gets nothing', CASE WHEN NOT EXISTS (SELECT 1 FROM @g) THEN 1 ELSE 0 END, '';
    DECLARE @e INT = 0;
    BEGIN TRY INSERT dbo.WholesaleRules (CategoryId, BranchCode, MinQty, AmountOff) VALUES (@pork, NULL, 5, 6); END TRY
    BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'W1f one rule per target, branch and minimum', CASE WHEN @e IN (2601, 2627) THEN 1 ELSE 0 END, CONCAT(@e, '');
    SET @e = 0;
    BEGIN TRY INSERT dbo.WholesaleRules (ProductId, CategoryId, MinQty, AmountOff) VALUES (@kasim, @pork, 7, 1); END TRY
    BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'W1g a rule is for an item or a category, not both', CASE WHEN @e = 547 THEN 1 ELSE 0 END, CONCAT(@e, '');
    SET @e = 0;
    BEGIN TRY INSERT dbo.WholesaleRules (ProductId, BranchCode, MinQty, AmountOff) VALUES (@kasim, NULL, 7, 0); END TRY
    BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'W1h an amount off of 0 is refused', CASE WHEN @e = 547 THEN 1 ELSE 0 END, CONCAT(@e, '');
    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'W1 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO

/* W2. A sale's wholesale lines are kept (once), can't be changed, show on the DTI report; taking
       wholesale off is audited; bad JSON is ignored, not refused. */
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
    DECLARE @sup INT = (SELECT TOP 1 UserId FROM dbo.Users WHERE Role IN ('Supervisor', 'Admin') ORDER BY UserId);
    DECLARE @prod INT, @cat INT; SELECT TOP 1 @prod = ProductId, @cat = CategoryId FROM dbo.Products ORDER BY ProductId;
    DECLARE @d DATE = '2099-05-01', @shift UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
    INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@shift, @branch, @term, @user, @d, 1000, @now);
    DECLARE @si BIGINT = ISNULL((SELECT MAX(ORNumber) FROM dbo.Sales WHERE TerminalId = @term), 0);

    /* two stickers of one item, 3.000 + 2.500 kg at 370 (380 less 10, from 5 kg), non-VAT */
    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @a UNIQUEIDENTIFIER = NEWID(), @b UNIQUEIDENTIFIER = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatExemptAmount)
    VALUES (1, @prod, 'W1', 'Test belly', @cat, 3.000, 370, 370, 0, 1110, 0, 1, 1110, 1110),
           (2, @prod, 'W1', 'Test belly', @cat, 2.500, 370, 370, 0, 925, 0, 1, 925, 925);
    INSERT @p VALUES (1, 'CASH', 2035, NULL, NULL, NULL, NULL);
    DECLARE @wl NVARCHAR(MAX) = N'[{"lineNo":1,"regularPrice":380,"amountOff":10,"minQty":5,"itemTotalQty":5.5},
                                    {"lineNo":2,"regularPrice":380,"amountOff":10,"minQty":5,"itemTotalQty":5.5}]';
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@a, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=2035, @DiscountAmount=0,
        @VatExemptAmount=2035, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=2035,
        @TenderedAmount=2035, @ChangeAmount=0, @WholesaleLines=@wl, @Items=@i, @Payments=@p;
    INSERT @r SELECT 'W2a both wholesale lines are kept with regular price, amount off and the wholesale price',
        CASE WHEN COUNT(*) = 2 AND MIN(RegularPrice) = 380 AND MIN(AmountOff) = 10 AND MIN(WholesalePrice) = 370
              AND MIN(ItemTotalQty) = 5.5 AND SUM(Quantity) = 5.5 THEN 1 ELSE 0 END, CONCAT(COUNT(*), ' lines')
    FROM dbo.SaleItemWholesale WHERE SaleUid = @a;
    EXEC dbo.sp_UpsertSale @SaleUid=@a, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=2035, @DiscountAmount=0,
        @VatExemptAmount=2035, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=2035,
        @TenderedAmount=2035, @ChangeAmount=0, @WholesaleLines=@wl, @Items=@i, @Payments=@p;
    INSERT @r SELECT 'W2b a re-synced sale doesn''t add them twice',
        CASE WHEN COUNT(*) = 2 THEN 1 ELSE 0 END, CONCAT(COUNT(*), '') FROM dbo.SaleItemWholesale WHERE SaleUid = @a;

    DECLARE @rep TABLE (BusinessDate DATE, BranchCode VARCHAR(10), BranchName NVARCHAR(120), TerminalCode VARCHAR(20),
        ORNumber BIGINT, SaleDateTime DATETIME2, Cashier NVARCHAR(120), CustomerName NVARCHAR(150), CustomerTin VARCHAR(20),
        ItemCode VARCHAR(50), ProductName NVARCHAR(150), Unit NVARCHAR(20), Quantity DECIMAL(18,3), ItemTotalQty DECIMAL(18,3),
        MinQty DECIMAL(18,3), RegularPrice DECIMAL(18,2), AmountOff DECIMAL(18,2), WholesalePrice DECIMAL(18,2),
        RegularAmount DECIMAL(18,2), WholesaleAmount DECIMAL(18,2), WholesaleSavings DECIMAL(18,2), ReturnedQty DECIMAL(18,3));
    INSERT @rep EXEC dbo.sp_rpt_Wholesale @DateFrom = @d, @DateTo = @d, @BranchCode = @branch;
    INSERT @r SELECT 'W2d the DTI report lists both lines: 2,090 regular, 2,035 wholesale, 55 saved',
        CASE WHEN COUNT(*) = 2 AND SUM(RegularAmount) = 2090 AND SUM(WholesaleAmount) = 2035 AND SUM(WholesaleSavings) = 55
             THEN 1 ELSE 0 END, CONCAT(SUM(RegularAmount), ' / ', SUM(WholesaleAmount), ' / ', SUM(WholesaleSavings))
    FROM @rep WHERE ORNumber = @si;

    /* wholesale taken off by a supervisor (so a discount applies): audited; bad JSON: no lines, no error */
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@b, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=2035, @DiscountAmount=0,
        @VatExemptAmount=2035, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=2035,
        @TenderedAmount=2035, @ChangeAmount=0, @WholesaleLines=N'not json', @WholesaleRemovedBy=@sup, @Items=@i, @Payments=@p;
    INSERT @r SELECT 'W2e taking wholesale off is kept and audited; bad JSON adds no lines and doesn''t stop the sale',
        CASE WHEN s.WholesaleRemovedBy = @sup
              AND NOT EXISTS (SELECT 1 FROM dbo.SaleItemWholesale WHERE SaleUid = @b)
              AND EXISTS (SELECT 1 FROM dbo.AuditLogs WHERE Action = 'WHOLESALE_REMOVED' AND TerminalId = @term
                          AND UserId = @sup AND Detail LIKE CONCAT(N'SI ', @si, N':%')) THEN 1 ELSE 0 END, ''
    FROM dbo.Sales s WHERE s.SaleUid = @b;

    -- last: the trigger's error dooms the transaction, so the result is recorded after the rollback
    DECLARE @e INT = 0;
    BEGIN TRY UPDATE dbo.SaleItemWholesale SET AmountOff = 1 WHERE SaleUid = @a; END TRY BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    ROLLBACK;
    INSERT @r SELECT 'W2c a kept wholesale line can''t be changed', CASE WHEN @e = 51104 THEN 1 ELSE 0 END, CONCAT(@e, '');
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'W2 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO
