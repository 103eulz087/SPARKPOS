/* =====================================================================
   Promo tests (34_promos.sql + 02_procedures.sql): what a branch's tills download, the promo
   lines kept with a sale, the X-Read's promo line, and the report.
   Every batch is rolled back, so this is safe on any DB with the schema and a terminal, user,
   branch and product. Each result row must show Pass = 1. Business dates are in 2099.
   ===================================================================== */
SET NOCOUNT ON;
GO

/* P1. What sp_GetPromos sends a branch: on, not ended, for it (or every branch); categories expanded.
       (It returns two result sets, which INSERT-EXEC can't take, so its rules are run here as it runs them.) */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    INSERT dbo.Branches (BranchCode, BranchName) VALUES ('ZP1', N'ZZTEST Promo 1'), ('ZP2', N'ZZTEST Promo 2');
    INSERT dbo.Categories (CategoryName) VALUES (N'ZZTEST ICE CREAM');
    DECLARE @ice INT = SCOPE_IDENTITY(), @cat INT = (SELECT TOP 1 CategoryId FROM dbo.Categories ORDER BY CategoryId);
    INSERT dbo.Products (Barcode, ProductName, CategoryId, Unit, BasePrice) VALUES
        ('ZZP-SIOMAI', N'ZZTEST SIOMAI', @cat, 'pc', 120), ('ZZP-ICE-A', N'ZZTEST ICE A', @ice, 'pc', 100),
        ('ZZP-ICE-B', N'ZZTEST ICE B', @ice, 'pc', 80), ('ZZP-SACHET', N'ZZTEST SACHET', @cat, 'pc', 10);
    DECLARE @siomai INT = (SELECT ProductId FROM dbo.Products WHERE Barcode = 'ZZP-SIOMAI'),
            @sachet INT = (SELECT ProductId FROM dbo.Products WHERE Barcode = 'ZZP-SACHET');
    INSERT dbo.Promos (PromoName, Kind, BuyQty, FreeQty, FreeProductId, StartDate, EndDate, IsActive) VALUES
        (N'ZZ B1T1 Siomai', 'SAME', 1, 1, NULL, '2099-06-01', '2099-06-30', 1),
        (N'ZZ Any 2 ice', 'GROUP', 1, 1, NULL, '2099-06-01', '2099-06-30', 1),
        (N'ZZ Gift sachet', 'GIFT', 1, 1, @sachet, '2099-06-20', '2099-06-30', 1),
        (N'ZZ Ended', 'SAME', 1, 1, NULL, '2099-05-01', '2099-05-31', 1),
        (N'ZZ Off', 'SAME', 1, 1, NULL, '2099-06-01', '2099-06-30', 0);
    DECLARE @grp INT = (SELECT PromoId FROM dbo.Promos WHERE PromoName = N'ZZ Any 2 ice');
    INSERT dbo.PromoItems (PromoId, ProductId, CategoryId)
    SELECT PromoId, @siomai, NULL FROM dbo.Promos WHERE PromoName IN (N'ZZ B1T1 Siomai', N'ZZ Ended', N'ZZ Off', N'ZZ Gift sachet');
    INSERT dbo.PromoItems (PromoId, ProductId, CategoryId) VALUES (@grp, NULL, @ice);
    INSERT dbo.PromoBranches (PromoId, BranchCode) VALUES (@grp, 'ZP2');

    CREATE TABLE #pr (PromoId INT, PromoName NVARCHAR(40), Kind VARCHAR(10), BuyQty INT, FreeQty INT, FreeProductId INT,
        MaxFreePerSale INT, StartDate DATE, EndDate DATE);
    CREATE TABLE #it (PromoId INT, ProductId INT);
    DECLARE @sql NVARCHAR(MAX) = OBJECT_DEFINITION(OBJECT_ID('dbo.sp_GetPromos'));
    INSERT #pr SELECT p.PromoId, p.PromoName, p.Kind, p.BuyQty, p.FreeQty, p.FreeProductId, p.MaxFreePerSale, p.StartDate, p.EndDate
    FROM dbo.Promos p WHERE p.IsActive = 1 AND p.EndDate >= '2099-06-15'
      AND (NOT EXISTS (SELECT 1 FROM dbo.PromoBranches b WHERE b.PromoId = p.PromoId)
           OR EXISTS (SELECT 1 FROM dbo.PromoBranches b WHERE b.PromoId = p.PromoId AND b.BranchCode = 'ZP1'));
    INSERT @r SELECT 'P1a ZP1: B1T1 and the gift (starts later) come down; ZP2''s, the ended and the off one don''t',
        CASE WHEN (SELECT COUNT(*) FROM #pr WHERE PromoName LIKE N'ZZ %') = 2
              AND EXISTS (SELECT 1 FROM #pr WHERE PromoName = N'ZZ B1T1 Siomai')
              AND EXISTS (SELECT 1 FROM #pr WHERE PromoName = N'ZZ Gift sachet') THEN 1 ELSE 0 END,
        (SELECT STRING_AGG(PromoName, ', ') FROM #pr WHERE PromoName LIKE N'ZZ %');
    INSERT @r SELECT 'P1b the proc text filters on IsActive, EndDate and the branch (kept in step with this test)',
        CASE WHEN @sql LIKE '%p.IsActive = 1 AND p.EndDate >= @Today%' AND @sql LIKE '%PromoBranches%' THEN 1 ELSE 0 END, '';
    -- the items: a category is expanded to its active items
    INSERT #it SELECT DISTINCT i.PromoId, pr.ProductId FROM dbo.PromoItems i
    JOIN dbo.Products pr ON pr.IsActive = 1 AND (pr.ProductId = i.ProductId OR (i.ProductId IS NULL AND pr.CategoryId = i.CategoryId))
    WHERE i.PromoId = @grp;
    INSERT @r SELECT 'P1c a category promo covers each of its items', CASE WHEN (SELECT COUNT(*) FROM #it) = 2 THEN 1 ELSE 0 END,
        CONCAT((SELECT COUNT(*) FROM #it), ' items');
    DECLARE @e INT = 0;
    BEGIN TRY INSERT dbo.Promos (PromoName, Kind, BuyQty, FreeQty, StartDate, EndDate) VALUES (N'ZZ bad gift', 'GIFT', 1, 1, '2099-06-01', '2099-06-30'); END TRY
    BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'P1d a gift promo needs its gift item', CASE WHEN @e = 547 THEN 1 ELSE 0 END, CONCAT(@e, '');
    SET @e = 0;
    BEGIN TRY INSERT dbo.Promos (PromoName, Kind, BuyQty, FreeQty, StartDate, EndDate) VALUES (N'ZZ bad dates', 'SAME', 1, 1, '2099-06-30', '2099-06-01'); END TRY
    BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'P1e an end before the start is refused', CASE WHEN @e = 547 THEN 1 ELSE 0 END, CONCAT(@e, '');
    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'P1 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO

/* P2. A senior's sale with a B1T1 line: the promo line and total are kept (once), the X-Read shows
       the promo on its own line and leaves it out of the SENIOR discount, the report lists it. */
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
    INSERT dbo.Promos (PromoName, Kind, BuyQty, FreeQty, StartDate, EndDate) VALUES (N'ZZ B1T1 Siomai', 'SAME', 1, 1, '2099-04-01', '2099-06-30');
    DECLARE @pid INT = SCOPE_IDENTITY();

    /* siomai 2 x 120, 1 free (120 off, VAT on the 120 paid: 107.14 + 12.86); rice 500 at the senior's
       5% (22.32 + 2.68 VAT adj.): net 595, discount 142.32 of which promo 120 */
    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @a UNIQUEIDENTIFIER = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount, VatAdjustment)
    VALUES (1, @prod, 'PS', 'Test siomai', @cat, 2, 120, 120, 120, 240, 1, 1, 120, 107.14, 12.86, 0),
           (2, @prod, 'PR', 'Test rice', @cat, 1, 500, 500, 22.32, 500, 1, 1, 475, 424.11, 50.89, 2.68);
    INSERT @p VALUES (1, 'CASH', 595, NULL, NULL, NULL, NULL);
    DECLARE @pl NVARCHAR(MAX) = CONCAT(N'[{"lineNo":1,"promoId":', @pid, N',"promoName":"ZZ B1T1 Siomai","freeQty":1,"regularPrice":120,"promoAmount":120}]');
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@a, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=740, @DiscountAmount=142.32,
        @VatExemptAmount=0, @VatableAmount=531.25, @VatAmount=63.75, @ZeroRatedAmount=0, @NetAmount=595,
        @TenderedAmount=595, @ChangeAmount=0, @DiscountCode='SENIOR', @DiscountCtrlNo=N'ZZ-1', @DiscountName=N'ZZ Senior',
        @VatAdjustment=2.68, @PromoLines=@pl, @Items=@i, @Payments=@p;
    INSERT @r SELECT 'P2a the sale keeps its promo total (120) inside the discount (142.32)',
        CASE WHEN PromoAmount = 120 AND DiscountAmount = 142.32 THEN 1 ELSE 0 END, CONCAT(PromoAmount, ' / ', DiscountAmount)
    FROM dbo.Sales WHERE SaleUid = @a;
    INSERT @r SELECT 'P2b the promo line is kept: 1 free at 120',
        CASE WHEN COUNT(*) = 1 AND MAX(FreeQty) = 1 AND MAX(PromoAmount) = 120 AND MAX(PromoId) = @pid THEN 1 ELSE 0 END, CONCAT(COUNT(*), '')
    FROM dbo.SaleItemPromo WHERE SaleUid = @a;
    EXEC dbo.sp_UpsertSale @SaleUid=@a, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=740, @DiscountAmount=142.32,
        @VatExemptAmount=0, @VatableAmount=531.25, @VatAmount=63.75, @ZeroRatedAmount=0, @NetAmount=595,
        @TenderedAmount=595, @ChangeAmount=0, @DiscountCode='SENIOR', @DiscountCtrlNo=N'ZZ-1', @DiscountName=N'ZZ Senior',
        @VatAdjustment=2.68, @PromoLines=@pl, @Items=@i, @Payments=@p;
    INSERT @r SELECT 'P2c a re-synced sale doesn''t add it twice',
        CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END, CONCAT(COUNT(*), '') FROM dbo.SaleItemPromo WHERE SaleUid = @a;

    DECLARE @xr TABLE (BranchCode VARCHAR(10), BranchName NVARCHAR(120), TerminalCode VARCHAR(20), Cashier NVARCHAR(120),
        BusinessDate DATE, CashBegin DECIMAL(18,2), OpenedAt DATETIME2, TxnCount INT, VoidCount INT,
        GrossSales DECIMAL(18,2), TotalDiscounts DECIMAL(18,2), NetSales DECIMAL(18,2), VatableAmount DECIMAL(18,2),
        VatAmount DECIMAL(18,2), VatExemptAmount DECIMAL(18,2), ZeroRatedAmount DECIMAL(18,2),
        DiscSenior DECIMAL(18,2), DiscPwd DECIMAL(18,2), DiscNaac DECIMAL(18,2), DiscMov DECIMAL(18,2), DiscSolo DECIMAL(18,2),
        DiscOther DECIMAL(18,2), DiscPromo DECIMAL(18,2), CashSales DECIMAL(18,2), CardSales DECIMAL(18,2), GcSales DECIMAL(18,2), DrawerOpens INT, ChangeGiven DECIMAL(18,2), VoidAmount DECIMAL(18,2),
        BeginningOR BIGINT, EndingOR BIGINT, ReturnCount INT, ReturnAmount DECIMAL(18,2), BeginningReturnNo INT, EndingReturnNo INT);
    INSERT @xr EXEC dbo.sp_rpt_XRead @ShiftUid = @shift;
    INSERT @r SELECT 'P2d X-Read: PROMOS 120 on its own line, SENIOR 22.32 without it, total discounts 142.32',
        CASE WHEN DiscPromo = 120 AND DiscSenior = 22.32 AND TotalDiscounts = 142.32 THEN 1 ELSE 0 END,
        CONCAT(DiscPromo, ' / ', DiscSenior, ' / ', TotalDiscounts) FROM @xr;

    DECLARE @rep TABLE (BusinessDate DATE, BranchCode VARCHAR(10), TerminalCode VARCHAR(20), ORNumber BIGINT, SaleDateTime DATETIME2,
        Cashier NVARCHAR(120), PromoName NVARCHAR(40), Kind VARCHAR(10), ItemCode VARCHAR(50), ProductName NVARCHAR(150),
        Quantity DECIMAL(18,3), FreeQty DECIMAL(18,3), RegularPrice DECIMAL(18,2), PromoAmount DECIMAL(18,2),
        LineTotal DECIMAL(18,2), NetAmount DECIMAL(18,2), DiscountCode VARCHAR(10), ReturnedQty DECIMAL(18,3));
    INSERT @rep EXEC dbo.sp_rpt_Promos @DateFrom = @d, @DateTo = @d, @BranchCode = @branch;
    INSERT @r SELECT 'P2e the promo report lists the line', CASE WHEN COUNT(*) = 1 AND SUM(PromoAmount) = 120 AND MAX(Kind) = 'SAME' THEN 1 ELSE 0 END, ''
    FROM @rep WHERE ORNumber = @si;

    -- last: the trigger's error dooms the transaction, so the result is recorded after the rollback
    DECLARE @e INT = 0;
    BEGIN TRY UPDATE dbo.SaleItemPromo SET PromoAmount = 1 WHERE SaleUid = @a; END TRY BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    ROLLBACK;
    INSERT @r SELECT 'P2f a kept promo line can''t be changed', CASE WHEN @e = 51105 THEN 1 ELSE 0 END, CONCAT(@e, '');
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'P2 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO
