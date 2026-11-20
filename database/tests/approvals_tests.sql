/* =====================================================================
   Supervisor approval tests (35_approvals.sql, 36_price_level_approval.sql + 02_procedures.sql): the new switches start off,
   a terminal's own answer, and what a sale keeps: the approver of an SC/PWD discount and the
   lines removed with an approval.
   Every batch is rolled back, so this is safe on any DB with the schema and a terminal, user,
   branch and product. Each result row must show Pass = 1. Business dates are in 2099.
   ===================================================================== */
SET NOCOUNT ON;
GO

/* A1. The switches and the terminal table. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    INSERT dbo.Branches (BranchCode, BranchName) VALUES ('ZA1', N'ZZTEST Approvals');
    INSERT dbo.PosSettings (BranchCode) VALUES ('ZA1');
    INSERT @r SELECT 'A1a a new branch: Cancel line, X-Read and Discount off; Void and Return on',
        CASE WHEN CancelLineOverride = 0 AND XReadOverride = 0 AND DiscountOverride = 0 AND VoidOverride = 1 AND ReturnOverride = 1
             THEN 1 ELSE 0 END, '' FROM dbo.PosSettings WHERE BranchCode = 'ZA1';
    INSERT dbo.Terminals (BranchCode, TerminalCode, TerminalName) VALUES ('ZA1', 'ZZ-A1', N'ZZTEST terminal');
    DECLARE @t INT = SCOPE_IDENTITY();
    INSERT dbo.TerminalOverrides (TerminalId, Func, Required) VALUES (@t, 'CANCEL_LINE', 1), (@t, 'VOID', 0);
    INSERT @r SELECT 'A1b a terminal keeps its own answers', CASE WHEN COUNT(*) = 2 THEN 1 ELSE 0 END, CONCAT(COUNT(*), '')
    FROM dbo.TerminalOverrides WHERE TerminalId = @t;
    DECLARE @e INT = 0;
    BEGIN TRY INSERT dbo.TerminalOverrides (TerminalId, Func, Required) VALUES (@t, 'PRICE', 1); END TRY
    BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'A1c an unknown action is refused', CASE WHEN @e = 547 THEN 1 ELSE 0 END, CONCAT(@e, '');
    SET @e = 0;
    BEGIN TRY INSERT dbo.TerminalOverrides (TerminalId, Func, Required) VALUES (@t, 'VOID', 1); END TRY
    BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'A1d one answer per terminal and action', CASE WHEN @e IN (2601, 2627) THEN 1 ELSE 0 END, CONCAT(@e, '');
    -- 36: the price level approval, off by default and allowed per terminal
    INSERT @r SELECT 'A1e Price level (36) starts off and a terminal can have its own answer',
        CASE WHEN (SELECT PriceLevelOverride FROM dbo.PosSettings WHERE BranchCode = 'ZA1') = 0 THEN 1 ELSE 0 END, '';
    INSERT dbo.TerminalOverrides (TerminalId, Func, Required) VALUES (@t, 'PRICE_LEVEL', 1);
    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'A1 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO

/* A2. A senior's sale approved by a supervisor, with two lines removed on approval: the approver is
       kept on the sale, DISCOUNT_APPROVED and two LINE_CANCEL audit rows; a re-sync adds none. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    DECLARE @term INT, @branch VARCHAR(10), @user INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId),
            @sup INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId DESC);
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
    DECLARE @d DATE = '2099-05-02', @shift UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
    INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@shift, @branch, @term, @user, @d, 1000, @now);
    DECLARE @si BIGINT = ISNULL((SELECT MAX(ORNumber) FROM dbo.Sales WHERE TerminalId = @term), 0) + 1;
    DECLARE @audit BIGINT = ISNULL((SELECT MAX(AuditId) FROM dbo.AuditLogs), 0);

    /* 64.50 at the senior's 5%: 2.88 + 0.34 VAT adj., net 61.28 */
    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @a UNIQUEIDENTIFIER = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount, VatAdjustment)
    VALUES (1, @prod, 'ML', 'Test meat loaf', @cat, 3, 21.50, 21.50, 2.88, 64.50, 1, 1, 61.28, 54.71, 6.57, 0.34);
    INSERT @p VALUES (1, 'CASH', 61.28, NULL, NULL, NULL, NULL);
    DECLARE @cl NVARCHAR(MAX) = CONCAT(N'[{"productId":', @prod, N',"productName":"ZZ Sardines","quantity":2,"unitPrice":25.75,"approvedBy":', @sup,
        N'},{"productId":', @prod, N',"productName":"ZZ Noodles","quantity":1,"unitPrice":14,"approvedBy":', @sup, N'}]');
    EXEC dbo.sp_UpsertSale @SaleUid=@a, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=64.50, @DiscountAmount=2.88,
        @VatExemptAmount=0, @VatableAmount=54.71, @VatAmount=6.57, @ZeroRatedAmount=0, @NetAmount=61.28,
        @TenderedAmount=61.28, @ChangeAmount=0, @DiscountCode='SENIOR', @DiscountCtrlNo=N'ZZ-1', @DiscountName=N'ZZ Senior',
        @VatAdjustment=0.34, @DiscountApprovedBy=@sup, @CancelledLines=@cl, @Items=@i, @Payments=@p;
    INSERT @r SELECT 'A2a the SC discount keeps its approver', CASE WHEN DiscountApprovedBy = @sup THEN 1 ELSE 0 END,
        CONCAT(DiscountApprovedBy, '') FROM dbo.Sales WHERE SaleUid = @a;
    INSERT @r SELECT 'A2b one DISCOUNT_APPROVED row, by the supervisor', CASE WHEN COUNT(*) = 1 AND MAX(UserId) = @sup THEN 1 ELSE 0 END,
        CONCAT(COUNT(*), '') FROM dbo.AuditLogs WHERE AuditId > @audit AND Action = 'DISCOUNT_APPROVED' AND TerminalId = @term;
    INSERT @r SELECT 'A2c two LINE_CANCEL rows naming the items', CASE WHEN COUNT(*) = 2
            AND SUM(CASE WHEN Detail LIKE N'%ZZ Sardines 2.000 x 25.75%' THEN 1 ELSE 0 END) = 1 THEN 1 ELSE 0 END,
        CONCAT(COUNT(*), ' ', MAX(Detail)) FROM dbo.AuditLogs WHERE AuditId > @audit AND Action = 'LINE_CANCEL' AND TerminalId = @term;
    EXEC dbo.sp_UpsertSale @SaleUid=@a, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=64.50, @DiscountAmount=2.88,
        @VatExemptAmount=0, @VatableAmount=54.71, @VatAmount=6.57, @ZeroRatedAmount=0, @NetAmount=61.28,
        @TenderedAmount=61.28, @ChangeAmount=0, @DiscountCode='SENIOR', @DiscountCtrlNo=N'ZZ-1', @DiscountName=N'ZZ Senior',
        @VatAdjustment=0.34, @DiscountApprovedBy=@sup, @CancelledLines=@cl, @Items=@i, @Payments=@p;
    INSERT @r SELECT 'A2d a re-synced sale adds no audit rows', CASE WHEN COUNT(*) = 3 THEN 1 ELSE 0 END, CONCAT(COUNT(*), '')
    FROM dbo.AuditLogs WHERE AuditId > @audit AND Action IN ('LINE_CANCEL', 'DISCOUNT_APPROVED') AND TerminalId = @term;

    /* a sale with no discount: an approver sent by mistake isn't kept; bad JSON adds nothing, never refuses */
    DECLARE @b UNIQUEIDENTIFIER = NEWID();
    DELETE @i; DELETE @p;
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount, VatAdjustment)
    VALUES (1, @prod, 'ML', 'Test meat loaf', @cat, 1, 112, 112, 0, 112, 1, 1, 112, 100, 12, 0);
    INSERT @p VALUES (1, 'CASH', 112, NULL, NULL, NULL, NULL);
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@b, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=100, @VatAmount=12, @ZeroRatedAmount=0, @NetAmount=112,
        @TenderedAmount=112, @ChangeAmount=0, @DiscountApprovedBy=@sup, @CancelledLines=N'not json', @Items=@i, @Payments=@p;
    INSERT @r SELECT 'A2e no discount: no approver kept, bad JSON ignored, the sale is in',
        CASE WHEN s.DiscountApprovedBy IS NULL AND NOT EXISTS (SELECT 1 FROM dbo.AuditLogs WHERE AuditId > @audit
             AND Action IN ('LINE_CANCEL', 'DISCOUNT_APPROVED') AND Detail LIKE CONCAT(N'SI ', @si, N':%')) THEN 1 ELSE 0 END, ''
    FROM dbo.Sales s WHERE s.SaleUid = @b;

    /* the senior's own items: 1 of 3 dinuguan (non-VAT) discounted 20%, 6.80 off; one DISCOUNT_QTY row
       by the supervisor, none on a re-sync */
    DECLARE @c UNIQUEIDENTIFIER = NEWID();
    DELETE @i; DELETE @p;
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount, VatExemptAmount, VatAdjustment)
    VALUES (1, @prod, 'DG', 'ZZ Dinuguan', @cat, 3, 34, 34, 6.80, 102, 0, 1, 95.20, 0, 0, 102, 0);
    INSERT @p VALUES (1, 'CASH', 95.20, NULL, NULL, NULL, NULL);
    SET @si += 1;
    DECLARE @dl NVARCHAR(MAX) = N'[{"lineNo":1,"productName":"ZZ Dinuguan","quantity":3,"discountQty":1}]';
    EXEC dbo.sp_UpsertSale @SaleUid=@c, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=102, @DiscountAmount=6.80,
        @VatExemptAmount=102, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=95.20,
        @TenderedAmount=95.20, @ChangeAmount=0, @DiscountCode='SENIOR', @DiscountCtrlNo=N'ZZ-2', @DiscountName=N'ZZ Senior',
        @VatAdjustment=0, @DiscountApprovedBy=@sup, @DiscountLines=@dl, @Items=@i, @Payments=@p;
    EXEC dbo.sp_UpsertSale @SaleUid=@c, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=102, @DiscountAmount=6.80,
        @VatExemptAmount=102, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=95.20,
        @TenderedAmount=95.20, @ChangeAmount=0, @DiscountCode='SENIOR', @DiscountCtrlNo=N'ZZ-2', @DiscountName=N'ZZ Senior',
        @VatAdjustment=0, @DiscountApprovedBy=@sup, @DiscountLines=@dl, @Items=@i, @Payments=@p;
    INSERT @r SELECT 'A2f own items: one DISCOUNT_QTY row (1 of 3), by the supervisor, none on a re-sync',
        CASE WHEN COUNT(*) = 1 AND MAX(UserId) = @sup AND MAX(Detail) LIKE N'%SENIOR on 1.000 of 3.000 ZZ Dinuguan%' THEN 1 ELSE 0 END,
        CONCAT(COUNT(*), ' ', MAX(Detail)) FROM dbo.AuditLogs WHERE AuditId > @audit AND Action = 'DISCOUNT_QTY' AND TerminalId = @term;
    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'A2 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO
