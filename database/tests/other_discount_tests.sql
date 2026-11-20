/* =====================================================================
   Regular / other discount tests (30_other_discount.sql + 02_procedures.sql).
   Every batch is rolled back, so this is safe on any DB with the schema and a terminal, user
   and product. Each result row must show Pass = 1. Business dates are in 2099.
   ===================================================================== */
SET NOCOUNT ON;
GO

/* O1. An OTHER discount keeps its approver and reason, is audited once, and shows on the
       X-Read as its own line; an ordinary sale has no approver. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    DECLARE @term INT, @branch VARCHAR(10), @user INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId);
    SET @term = NULL;   -- a DECLARE inside a loop keeps the last value
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

    /* ₱1,000 (560 VAT-able + 440 VAT-exempt) less ₱100: 504 = 450 + 54, 396 exempt */
    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @z UNIQUEIDENTIFIER = NEWID(), @o UNIQUEIDENTIFIER = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount, VatExemptAmount)
    VALUES (1, @prod, 'B1', 'Test VATable', @cat, 1, 560, 560, 56, 560, 1, 1, 504, 450, 54, 0),
           (2, @prod, 'B2', 'Test exempt',  @cat, 1, 440, 440, 44, 440, 0, 0, 396, 0,   0,  396);
    INSERT @p VALUES (1, 'CASH', 900, NULL, NULL, NULL, NULL);
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@z, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=1000, @DiscountAmount=100,
        @VatExemptAmount=396, @VatableAmount=450, @VatAmount=54, @ZeroRatedAmount=0, @NetAmount=900,
        @TenderedAmount=900, @ChangeAmount=0, @DiscountCode='OTHER', @DiscountName=N'ZZTEST damaged packaging',
        @DiscountApprovedBy=@sup, @Items=@i, @Payments=@p;
    INSERT @r SELECT 'O1a the sale keeps the code, reason, approver and figures',
        CASE WHEN DiscountCode = 'OTHER' AND DiscountName = N'ZZTEST damaged packaging' AND DiscountApprovedBy = @sup
              AND DiscountAmount = 100 AND NetAmount = 900 AND VatableAmount + VatAmount + VatExemptAmount = NetAmount THEN 1 ELSE 0 END,
        CONCAT(DiscountCode, ' / ', DiscountApprovedBy, ' / ', NetAmount)
    FROM dbo.Sales WHERE SaleUid = @z;
    INSERT @r SELECT 'O1b an OTHER_DISCOUNT audit row by the approver names the amount and reason',
        CASE WHEN COUNT(*) = 1 AND MAX(UserId) = @sup THEN 1 ELSE 0 END, MAX(Detail)
    FROM dbo.AuditLogs WHERE Action = 'OTHER_DISCOUNT' AND TerminalId = @term AND Detail LIKE CONCAT(N'SI ', @si, N':%damaged packaging%');

    /* sent again (the till retries): nothing doubles */
    EXEC dbo.sp_UpsertSale @SaleUid=@z, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=1000, @DiscountAmount=100,
        @VatExemptAmount=396, @VatableAmount=450, @VatAmount=54, @ZeroRatedAmount=0, @NetAmount=900,
        @TenderedAmount=900, @ChangeAmount=0, @DiscountCode='OTHER', @DiscountName=N'ZZTEST damaged packaging',
        @DiscountApprovedBy=@sup, @Items=@i, @Payments=@p;
    INSERT @r SELECT 'O1c a re-synced sale isn''t audited twice',
        CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END, CONCAT(COUNT(*), ' rows')
    FROM dbo.AuditLogs WHERE Action = 'OTHER_DISCOUNT' AND TerminalId = @term AND Detail LIKE CONCAT(N'SI ', @si, N':%');

    /* a senior sale with an approver passed by mistake: the approver isn't kept (OTHER only) */
    DELETE @i;
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatExemptAmount)
    VALUES (1, @prod, 'B2', 'Test exempt', @cat, 1, 50, 50, 10, 50, 0, 1, 40, 50);
    DELETE @p; INSERT @p VALUES (1, 'CASH', 40, NULL, NULL, NULL, NULL);
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@o, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=50, @DiscountAmount=10,
        @VatExemptAmount=50, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=40,
        @TenderedAmount=40, @ChangeAmount=0, @DiscountCode='SENIOR', @DiscountCtrlNo=N'ZZ-1', @DiscountName=N'ZZ Senior',
        @DiscountApprovedBy=@sup, @Items=@i, @Payments=@p;
    -- since 35 an approved SC/PWD discount keeps its approver (the till's Discount approval)
    INSERT @r SELECT 'O1d a senior sale keeps its approver (35) but gets no OTHER_DISCOUNT row',
        CASE WHEN s.DiscountApprovedBy = @sup
              AND NOT EXISTS (SELECT 1 FROM dbo.AuditLogs WHERE Action = 'OTHER_DISCOUNT' AND TerminalId = @term
                              AND Detail LIKE CONCAT(N'SI ', @si, N':%')) THEN 1 ELSE 0 END, ''
    FROM dbo.Sales s WHERE s.SaleUid = @o;

    /* X-Read: OTHER on its own line, the senior one on its */
    DECLARE @x TABLE (DiscSenior DECIMAL(18,2), DiscOther DECIMAL(18,2), TotalDiscounts DECIMAL(18,2));
    DECLARE @xr TABLE (BranchCode VARCHAR(10), BranchName NVARCHAR(100), TerminalCode VARCHAR(20), Cashier NVARCHAR(200),
        BusinessDate DATE, CashBegin DECIMAL(18,2), OpenedAt DATETIME2, TxnCount INT, VoidCount INT,
        GrossSales DECIMAL(18,2), TotalDiscounts DECIMAL(18,2), NetSales DECIMAL(18,2), VatableAmount DECIMAL(18,2),
        VatAmount DECIMAL(18,2), VatExemptAmount DECIMAL(18,2), ZeroRatedAmount DECIMAL(18,2),
        DiscSenior DECIMAL(18,2), DiscPwd DECIMAL(18,2), DiscNaac DECIMAL(18,2), DiscMov DECIMAL(18,2), DiscSolo DECIMAL(18,2),
        DiscOther DECIMAL(18,2), DiscPromo DECIMAL(18,2), CashSales DECIMAL(18,2), CardSales DECIMAL(18,2), GcSales DECIMAL(18,2), DrawerOpens INT, ChangeGiven DECIMAL(18,2), VoidAmount DECIMAL(18,2),
        BeginningOR BIGINT, EndingOR BIGINT, ReturnCount INT, ReturnAmount DECIMAL(18,2), BeginningReturnNo INT, EndingReturnNo INT);
    INSERT @xr EXEC dbo.sp_rpt_XRead @ShiftUid = @shift;
    INSERT @r SELECT 'O1e X-Read: REGULAR/OTHER 100, SENIOR 10, total 110',
        CASE WHEN DiscOther = 100 AND DiscSenior = 10 AND TotalDiscounts = 110 THEN 1 ELSE 0 END,
        CONCAT(DiscOther, ' / ', DiscSenior, ' / ', TotalDiscounts)
    FROM @xr;

    SELECT Test, Pass, Detail FROM @r;
    ROLLBACK;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'O1 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO

/* O2. The Z-Read keeps the day's OTHER total (DiscOther). */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @term INT, @branch VARCHAR(10), @user INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId);
    SET @term = NULL;   -- a DECLARE inside a loop keeps the last value
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
    DECLARE @d DATE = '2099-05-02', @shift UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
    INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt, Status, ClosedAt)
    VALUES (@shift, @branch, @term, @user, @d, 1000, @now, 'BlindClosed', @now);
    DECLARE @si BIGINT = ISNULL((SELECT MAX(ORNumber) FROM dbo.Sales WHERE TerminalId = @term), 0) + 1;
    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @z UNIQUEIDENTIFIER = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatExemptAmount)
    VALUES (1, @prod, 'B2', 'Test exempt', @cat, 1, 300, 300, 25, 300, 0, 0, 275, 275);
    INSERT @p VALUES (1, 'CASH', 275, NULL, NULL, NULL, NULL);
    EXEC dbo.sp_UpsertSale @SaleUid=@z, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=300, @DiscountAmount=25,
        @VatExemptAmount=275, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=275,
        @TenderedAmount=275, @ChangeAmount=0, @DiscountCode='OTHER', @DiscountName=N'ZZTEST', @DiscountApprovedBy=@user,
        @Items=@i, @Payments=@p;
    EXEC dbo.sp_ProcessEndOfDay @TerminalId=@term, @BusinessDate=@d, @ClosedByUserId=@user, @ApprovedByUserId=@user;
    SELECT 'O2 Z-Read keeps DiscOther 25 of total 25' AS Test,
        CASE WHEN DiscOther = 25 AND TotalDiscounts = 25 THEN 1 ELSE 0 END AS Pass, CONCAT(DiscOther, ' / ', TotalDiscounts) AS Detail
    FROM dbo.ZReads WHERE TerminalId = @term AND BusinessDate = @d;
    ROLLBACK;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'O2 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO

/* O3. Nothing from these tests survived. */
SELECT 'O3 nothing left behind' AS Test,
    CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.Sales WHERE BusinessDate IN ('2099-05-01', '2099-05-02'))
          AND NOT EXISTS (SELECT 1 FROM dbo.ZReads WHERE BusinessDate = '2099-05-02') THEN 1 ELSE 0 END AS Pass, '' AS Detail;
GO
