/* =====================================================================
   BIR sworn-statement tests (18_bir_invoice_returns.sql + 02_procedures.sql).
   Every batch is rolled back, so this is safe on any DB with the schema and the seed
   (03_seed.sql: at least one terminal, user and product). Each result row must show Pass = 1.
   Business dates are in 2099 so they never meet a real day.
   ===================================================================== */
SET NOCOUNT ON;
GO

/* T1. Sales invoice numbers: a block starts right after the last SI the terminal used, so an
       abandoned block never leaves a gap; @From continues after a device's unsynced sales but
       can't jump past what was handed out. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    DECLARE @term INT, @branch VARCHAR(10), @user INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId);
    SELECT TOP 1 @term = TerminalId, @branch = BranchCode FROM dbo.Terminals ORDER BY TerminalId;
    DECLARE @prod INT, @cat INT; SELECT TOP 1 @prod = ProductId, @cat = CategoryId FROM dbo.Products ORDER BY ProductId;
    DECLARE @d DATE = '2099-02-01', @shift UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
    INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@shift, @branch, @term, @user, @d, 1000, @now);

    DECLARE @used BIGINT = ISNULL((SELECT MAX(ORNumber) FROM dbo.Sales WHERE TerminalId = @term), 0);
    DECLARE @A TABLE (RangeStart BIGINT, RangeEnd BIGINT);
    INSERT @A EXEC dbo.sp_AllocateORRange @TerminalId = @term, @BlockSize = 500;
    INSERT @r SELECT 'T1a block starts after the last SI used (000000000000000001 on a new terminal)',
        CASE WHEN RangeStart = @used + 1 AND RangeEnd = @used + 500 THEN 1 ELSE 0 END,
        CONCAT(RangeStart, '-', RangeEnd) FROM @A;

    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @u UNIQUEIDENTIFIER = NEWID(), @si BIGINT = @used + 1;
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount)
    VALUES (1, @prod, 'B1', 'Test', @cat, 1, 112, 112, 0, 112, 1, 1, 112, 100, 12);
    INSERT @p VALUES (1, 'CASH', 112, NULL, NULL, NULL, NULL);
    EXEC dbo.sp_UpsertSale @SaleUid=@u, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=100, @VatAmount=12, @ZeroRatedAmount=0, @NetAmount=112,
        @TenderedAmount=112, @ChangeAmount=0, @Items=@i, @Payments=@p;

    DELETE @A;
    INSERT @A EXEC dbo.sp_AllocateORRange @TerminalId = @term, @BlockSize = 500;
    INSERT @r SELECT 'T1b re-reserving continues at the next SI (rest of the old block is not skipped)',
        CASE WHEN RangeStart = @si + 1 THEN 1 ELSE 0 END, CONCAT(RangeStart, '-', RangeEnd) FROM @A;

    DECLARE @from BIGINT = @si + 6;
    DELETE @A;
    INSERT @A EXEC dbo.sp_AllocateORRange @TerminalId = @term, @BlockSize = 500, @From = @from;
    INSERT @r SELECT 'T1c @From continues after the device''s unsynced sales',
        CASE WHEN RangeStart = @si + 6 THEN 1 ELSE 0 END, CONCAT(RangeStart, '-', RangeEnd) FROM @A;

    DECLARE @issued BIGINT = (SELECT MAX(RangeEnd) FROM dbo.ORRanges WHERE TerminalId = @term);
    DELETE @A;
    INSERT @A EXEC dbo.sp_AllocateORRange @TerminalId = @term, @BlockSize = 500, @From = 900000000000000000;
    INSERT @r SELECT 'T1d @From can''t jump past the numbers already handed out',
        CASE WHEN RangeStart = @issued + 1 THEN 1 ELSE 0 END, CONCAT(RangeStart, '-', RangeEnd) FROM @A;

    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'T1 batch' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE(), ' line ', ERROR_LINE()) AS Detail;
END CATCH
GO

/* T2. An SI number outside 1..999999999999999999 (18 digits) is refused. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @term INT, @branch VARCHAR(10), @user INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId);
    SELECT TOP 1 @term = TerminalId, @branch = BranchCode FROM dbo.Terminals ORDER BY TerminalId;
    DECLARE @prod INT, @cat INT; SELECT TOP 1 @prod = ProductId, @cat = CategoryId FROM dbo.Products ORDER BY ProductId;
    DECLARE @d DATE = '2099-02-02', @shift UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
    INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@shift, @branch, @term, @user, @d, 1000, @now);
    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @u UNIQUEIDENTIFIER = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable)
    VALUES (1, @prod, 'B2', 'Test', @cat, 1, 112, 112, 0, 112, 1, 1);
    INSERT @p VALUES (1, 'CASH', 112, NULL, NULL, NULL, NULL);
    EXEC dbo.sp_UpsertSale @SaleUid=@u, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=1000000000000000000, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=100, @VatAmount=12, @ZeroRatedAmount=0, @NetAmount=112,
        @TenderedAmount=112, @ChangeAmount=0, @Items=@i, @Payments=@p;
    ROLLBACK;
    SELECT 'T2 a 19-digit SI number is refused' AS Test, 0 AS Pass, 'no error' AS Detail;
END TRY
BEGIN CATCH
    DECLARE @e INT = ERROR_NUMBER(), @m NVARCHAR(400) = ERROR_MESSAGE();
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'T2 a 19-digit SI number is refused' AS Test, CASE WHEN @e = 547 THEN 1 ELSE 0 END AS Pass, @m AS Detail;
END CATCH
GO

/* T3-T8. Customer info and the printed text are stored; invoices, lines and counters can't be
          rewritten. Each refusal is the last step of its own batch (a trigger error ends the
          transaction). The setup is repeated so each batch stands alone. */
DECLARE @case INT = 3;
WHILE @case <= 8
BEGIN
    DECLARE @name NVARCHAR(120) = CASE @case
        WHEN 3 THEN 'T3 customer, printed text and per-line VAT stored; status can still change'
        WHEN 4 THEN 'T4 a sales invoice can''t be deleted'
        WHEN 5 THEN 'T5 a sales invoice''s amount can''t be changed'
        WHEN 6 THEN 'T6 the printed text can''t be changed'
        WHEN 7 THEN 'T7 a sales invoice line can''t be deleted'
        WHEN 8 THEN 'T8 the grand total can''t go down' END;
    DECLARE @want INT = CASE @case WHEN 4 THEN 51100 WHEN 5 THEN 51101 WHEN 6 THEN 51101
                                   WHEN 7 THEN 51102 WHEN 8 THEN 51107 ELSE 0 END;
    BEGIN TRY
        BEGIN TRAN;
        DECLARE @term INT, @branch VARCHAR(10), @user INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId);
        SELECT TOP 1 @term = TerminalId, @branch = BranchCode FROM dbo.Terminals ORDER BY TerminalId;
        DECLARE @prod INT, @cat INT; SELECT TOP 1 @prod = ProductId, @cat = CategoryId FROM dbo.Products ORDER BY ProductId;
        DECLARE @d DATE = '2099-02-03', @shift UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
        INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
        VALUES (@shift, @branch, @term, @user, @d, 1000, @now);
        DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @u UNIQUEIDENTIFIER = NEWID();
        DELETE @i; DELETE @p;
        DECLARE @si BIGINT = ISNULL((SELECT MAX(ORNumber) FROM dbo.Sales WHERE TerminalId = @term), 0) + 1;
        INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
                   LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount)
        VALUES (1, @prod, 'B3', 'Test', @cat, 1, 112, 112, 0, 112, 1, 1, 112, 100, 12);
        INSERT @p VALUES (1, 'CASH', 112, NULL, NULL, NULL, NULL);
        EXEC dbo.sp_UpsertSale @SaleUid=@u, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
            @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=0,
            @VatExemptAmount=0, @VatableAmount=100, @VatAmount=12, @ZeroRatedAmount=0, @NetAmount=112,
            @TenderedAmount=112, @ChangeAmount=0, @Items=@i, @Payments=@p,
            @CustomerName=N' Juan Dela Cruz ', @CustomerAddress=N'Cebu City', @CustomerTin='123-456-789-00000',
            @CustomerBusinessStyle=N'', @ReceiptText=N'SALES INVOICE';

        DECLARE @ok BIT = 0;
        IF @case = 3
        BEGIN
            UPDATE dbo.Sales SET Status = 'Voided', VoidedAt = SYSDATETIME() WHERE SaleUid = @u;
            SET @ok = CASE WHEN EXISTS (SELECT 1 FROM dbo.Sales WHERE SaleUid = @u AND CustomerName = N'Juan Dela Cruz'
                                AND CustomerAddress = N'Cebu City' AND CustomerTin = '123-456-789-00000'
                                AND CustomerBusinessStyle IS NULL AND ReceiptText = N'SALES INVOICE' AND Status = 'Voided')
                            AND EXISTS (SELECT 1 FROM dbo.SaleItems WHERE SaleUid = @u AND NetAmount = 112
                                AND VatableAmount = 100 AND VatAmount = 12 AND ReturnedQty = 0)
                           THEN 1 ELSE 0 END;
            ROLLBACK;
            SELECT @name AS Test, @ok AS Pass, '' AS Detail;
        END
        ELSE
        BEGIN
            IF @case = 4 DELETE dbo.Sales WHERE SaleUid = @u;
            IF @case = 5 UPDATE dbo.Sales SET NetAmount = 1 WHERE SaleUid = @u;
            IF @case = 6 UPDATE dbo.Sales SET ReceiptText = N'edited' WHERE SaleUid = @u;
            IF @case = 7 DELETE dbo.SaleItems WHERE SaleUid = @u;
            IF @case = 8 UPDATE dbo.Terminals SET GrandTotalSales = GrandTotalSales - 0.01 WHERE TerminalId = @term;
            ROLLBACK;
            SELECT @name AS Test, 0 AS Pass, 'no error' AS Detail;
        END
    END TRY
    BEGIN CATCH
        DECLARE @e INT = ERROR_NUMBER(), @m NVARCHAR(400) = ERROR_MESSAGE();
        IF @@TRANCOUNT > 0 ROLLBACK;
        SELECT @name AS Test, CASE WHEN @e = @want THEN 1 ELSE 0 END AS Pass, CONCAT(@e, ' ', @m) AS Detail;
    END CATCH
    SET @case += 1;
END
GO

/* T9. Return transactions end to end: preview writes nothing; commit numbers it, fills the
       placeholder, marks what came back; a retry is idempotent; returning a line in several goes
       adds up to exactly the original; blind close takes the refunds out of expected cash; End of
       Day reports returns and SI range (voided included) without lowering the grand total; the
       day's ledger entry (if accounting exists) still balances. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    DECLARE @term INT, @branch VARCHAR(10), @user INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId);
    -- End of Day refuses a day while an earlier one on the terminal is unclosed (51013), so use a
    -- terminal that has no real day left unclosed.
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
    DECLARE @d DATE = '2099-02-09', @shift UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
    UPDATE dbo.PosSettings SET RefundEnabled = 1 WHERE BranchCode = @branch;
    INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@shift, @branch, @term, @user, @d, 1000, @now);

    /* Sale A: 3 x 112 (vatable) + 3 x 33.35 (vatable, so the thirds don't divide evenly). */
    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @sale UNIQUEIDENTIFIER = NEWID(), @void UNIQUEIDENTIFIER = NEWID();
    DECLARE @si BIGINT = ISNULL((SELECT MAX(ORNumber) FROM dbo.Sales WHERE TerminalId = @term), 0) + 1;
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount)
    VALUES (1, @prod, 'R1', 'Return A', @cat, 3, 112,   112,   0, 336,    1, 1, 336,    300,   36),
           (2, @prod, 'R2', 'Return B', @cat, 3, 33.35, 33.35, 0, 100.05, 1, 1, 100.05, 89.33, 10.72);
    INSERT @p VALUES (1, 'CASH', 500, NULL, NULL, NULL, NULL);
    EXEC dbo.sp_UpsertSale @SaleUid=@sale, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=436.05, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=389.33, @VatAmount=46.72, @ZeroRatedAmount=0, @NetAmount=436.05,
        @TenderedAmount=500, @ChangeAmount=63.95, @Items=@i, @Payments=@p, @ReceiptText=N'SALES INVOICE A';
    /* Sale B: voided — still counts in the day's SI range. */
    DELETE @p; INSERT @p VALUES (1, 'CASH', 112, NULL, NULL, NULL, NULL);
    DELETE @i;
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount)
    VALUES (1, @prod, 'R3', 'Voided', @cat, 1, 112, 112, 0, 112, 1, 1, 112, 100, 12);
    DECLARE @si2 BIGINT = @si + 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@void, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si2, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=100, @VatAmount=12, @ZeroRatedAmount=0, @NetAmount=112,
        @TenderedAmount=112, @ChangeAmount=0, @Status='Voided', @Items=@i, @Payments=@p;

    DECLARE @lastNo INT = (SELECT LastReturnNo FROM dbo.Terminals WHERE TerminalId = @term);
    DECLARE @H TABLE (ReturnNo INT, OrigSaleUid UNIQUEIDENTIFIER, OrigTerminalId INT, OrigORNumber BIGINT,
        GrossAmount DECIMAL(18,2), DiscountAmount DECIMAL(18,2), VatableAmount DECIMAL(18,2), VatAmount DECIMAL(18,2),
        VatExemptAmount DECIMAL(18,2), ZeroRatedAmount DECIMAL(18,2), VatAdjustment DECIMAL(18,2), NetAmount DECIMAL(18,2));
    DECLARE @ri dbo.TVP_ReturnItem, @ret1 UNIQUEIDENTIFIER = NEWID(), @ret2 UNIQUEIDENTIFIER = NEWID();
    INSERT @ri VALUES (1, 1);

    /* Preview: header only (INSERT-EXEC takes the first result set's shape; the proc returns
       two, so read the preview through a wrapper-free check on what it would refund). */
    DECLARE @before INT = (SELECT COUNT(*) FROM dbo.SaleReturns);
    EXEC dbo.sp_ProcessReturn @ReturnUid=@ret1, @OrigSaleUid=@sale, @ShiftUid=@shift, @CashierUserId=@user,
        @ApprovedByUserId=@user, @Reason=N'preview', @Items=@ri, @Commit=0;
    INSERT @r SELECT 'T9a preview writes nothing and takes no number',
        CASE WHEN (SELECT COUNT(*) FROM dbo.SaleReturns) = @before
              AND (SELECT LastReturnNo FROM dbo.Terminals WHERE TerminalId = @term) = @lastNo
              AND NOT EXISTS (SELECT 1 FROM dbo.SaleItems WHERE SaleUid = @sale AND ReturnedQty <> 0) THEN 1 ELSE 0 END, '';

    /* Return 1: 1 of line 1 + 1 of line 2. */
    DELETE @ri; INSERT @ri VALUES (1, 1), (2, 1);
    DECLARE @text NVARCHAR(MAX) = N'RETURN TRANSACTION' + CHAR(10) + N'Return No. ######' + CHAR(10) + N'item ######';
    EXEC dbo.sp_ProcessReturn @ReturnUid=@ret1, @OrigSaleUid=@sale, @ShiftUid=@shift, @CashierUserId=@user,
        @ApprovedByUserId=@user, @Reason=N'damaged', @Items=@ri, @ReturnDateTime=@now, @ExpectedNet=145.35,
        @ReceiptText=@text, @Commit=1;
    DECLARE @no1 INT = (SELECT ReturnNo FROM dbo.SaleReturns WHERE ReturnUid = @ret1);
    INSERT @r SELECT 'T9b return numbered next on the terminal, refund = each line''s share',
        CASE WHEN @no1 = @lastNo + 1 AND NetAmount = 145.35 AND GrossAmount = 145.35 AND VatableAmount = 129.78
              AND VatAmount = 15.57 AND OrigORNumber = @si THEN 1 ELSE 0 END,
        CONCAT('no ', @no1, ' net ', NetAmount, ' vatable ', VatableAmount, ' vat ', VatAmount)
    FROM dbo.SaleReturns WHERE ReturnUid = @ret1;
    INSERT @r SELECT 'T9c 6-digit number replaces the first placeholder only',
        CASE WHEN ReceiptText = N'RETURN TRANSACTION' + CHAR(10) + N'Return No. ' + RIGHT('00000' + CAST(@no1 AS VARCHAR(6)), 6)
                                + CHAR(10) + N'item ######' THEN 1 ELSE 0 END, ReceiptText
    FROM dbo.SaleReturns WHERE ReturnUid = @ret1;

    EXEC dbo.sp_ProcessReturn @ReturnUid=@ret1, @OrigSaleUid=@sale, @ShiftUid=@shift, @CashierUserId=@user,
        @ApprovedByUserId=@user, @Reason=N'damaged', @Items=@ri, @ReturnDateTime=@now, @ExpectedNet=145.35,
        @ReceiptText=@text, @Commit=1;
    INSERT @r SELECT 'T9d retrying the same return changes nothing',
        CASE WHEN (SELECT COUNT(*) FROM dbo.SaleReturns WHERE OrigSaleUid = @sale) = 1
              AND (SELECT LastReturnNo FROM dbo.Terminals WHERE TerminalId = @term) = @no1
              AND (SELECT ReturnedQty FROM dbo.SaleItems WHERE SaleUid = @sale AND [LineNo] = 2) = 1 THEN 1 ELSE 0 END, '';

    /* Return 2: the remaining 2 of line 2. */
    DELETE @ri; INSERT @ri VALUES (2, 2);
    EXEC dbo.sp_ProcessReturn @ReturnUid=@ret2, @OrigSaleUid=@sale, @ShiftUid=@shift, @CashierUserId=@user,
        @ApprovedByUserId=@user, @Reason=N'wrong item', @Items=@ri, @ReturnDateTime=@now, @ExpectedNet=66.70,
        @ReceiptText=@text, @Commit=1;
    INSERT @r SELECT 'T9e a line returned in two goes adds up to exactly the original line',
        CASE WHEN SUM(ri.NetAmount) = 100.05 AND SUM(ri.VatableAmount) = 89.33 AND SUM(ri.VatAmount) = 10.72
              AND SUM(ri.LineTotal) = 100.05 THEN 1 ELSE 0 END,
        CONCAT('net ', SUM(ri.NetAmount), ' vatable ', SUM(ri.VatableAmount), ' vat ', SUM(ri.VatAmount))
    FROM dbo.SaleReturnItems ri JOIN dbo.SaleReturns r ON r.ReturnUid = ri.ReturnUid
    WHERE r.OrigSaleUid = @sale AND ri.[LineNo] = 2;
    INSERT @r SELECT 'T9f second return takes the next number',
        CASE WHEN ReturnNo = @no1 + 1 AND NetAmount = 66.70 THEN 1 ELSE 0 END, CONCAT(ReturnNo, ' ', NetAmount)
    FROM dbo.SaleReturns WHERE ReturnUid = @ret2;

    /* Blind close: 1000 + 500 cash - 63.95 change - 212.05 refunded = 1224.00. */
    EXEC dbo.sp_ProcessBlindClose @ShiftUid = @shift, @DeclaredCash = 1224, @DenominationsJson = N'{}';
    INSERT @r SELECT 'T9g blind close takes cash refunds out of expected cash',
        CASE WHEN ExpectedCash = 1224 AND CashRefunds = 212.05 AND ShortOver = 0 THEN 1 ELSE 0 END,
        CONCAT('expected ', ExpectedCash, ' refunds ', CashRefunds)
    FROM dbo.ShiftClosings WHERE ShiftUid = @shift;

    /* End of Day (with accounting on, if this DB has it). */
    DECLARE @accOn BIT = 0;
    IF OBJECT_ID('acc.sp_SetupCompany', 'P') IS NOT NULL
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM acc.Settings WHERE CompanyId = 1)
            EXEC acc.sp_SetupCompany @CompanyId = 1, @TemplateCode = 'RETAIL', @StartDate = '2026-01-01';
        UPDATE acc.Settings SET IsEnabled = 1 WHERE CompanyId = 1;
        SET @accOn = 1;
    END
    DECLARE @gtBefore DECIMAL(18,2) = (SELECT GrandTotalSales FROM dbo.Terminals WHERE TerminalId = @term);
    EXEC dbo.sp_ProcessEndOfDay @TerminalId = @term, @BusinessDate = @d, @ClosedByUserId = @user, @ApprovedByUserId = @user;
    INSERT @r SELECT 'T9h Z-Read: returns reported, SI range includes the voided SI',
        CASE WHEN ReturnCount = 2 AND ReturnAmount = 212.05 AND BeginningReturnNo = @no1 AND EndingReturnNo = @no1 + 1
              AND BeginningOR = @si AND EndingOR = @si + 1 AND VoidCount = 1 AND NetSales = 436.05 THEN 1 ELSE 0 END,
        CONCAT('returns ', ReturnCount, '/', ReturnAmount, ' SI ', BeginningOR, '-', EndingOR)
    FROM dbo.ZReads WHERE TerminalId = @term AND BusinessDate = @d;
    INSERT @r SELECT 'T9i grand total adds the day''s sales and is not lowered by returns',
        CASE WHEN GrandTotalSales = @gtBefore + 436.05 THEN 1 ELSE 0 END, CONCAT(@gtBefore, ' -> ', GrandTotalSales)
    FROM dbo.Terminals WHERE TerminalId = @term;

    IF @accOn = 1
    BEGIN
        DECLARE @src VARCHAR(50) = (SELECT CONVERT(VARCHAR(50), ZReadId) FROM dbo.ZReads WHERE TerminalId = @term AND BusinessDate = @d);
        INSERT @r SELECT 'T9j ledger entry balances and credits the cash refunded',
            CASE WHEN SUM(l.Debit) = SUM(l.Credit)
                  AND SUM(CASE WHEN l.Memo = N'Returns: cash refunded' THEN l.Credit ELSE 0 END) = 212.05
                  AND SUM(CASE WHEN l.Memo = N'Returns: vatable sales' THEN l.Debit ELSE 0 END) = 189.33
                  AND SUM(CASE WHEN l.Memo = N'Returns: output VAT' THEN l.Debit ELSE 0 END) = 22.72 THEN 1 ELSE 0 END,
            CONCAT('Dr ', SUM(l.Debit), ' Cr ', SUM(l.Credit))
        FROM acc.JournalEntries e JOIN acc.JournalLines l ON l.EntryUid = e.EntryUid
        WHERE e.SourceType = 'ZREAD' AND e.SourceUid = @src;
    END

    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    DECLARE @e INT = ERROR_NUMBER(), @m NVARCHAR(400) = ERROR_MESSAGE(), @l INT = ERROR_LINE();
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'T9 batch' AS Test, 0 AS Pass, CONCAT(@e, ' ', @m, ' line ', @l) AS Detail;
END CATCH
GO

/* T10-T15. Returns that must be refused (each the last step of its own batch). */
DECLARE @case INT = 10;
WHILE @case <= 15
BEGIN
    DECLARE @name NVARCHAR(120) = CASE @case
        WHEN 10 THEN 'T10 can''t return more than was sold less what came back'
        WHEN 11 THEN 'T11 refund changed since the preview is refused'
        WHEN 12 THEN 'T12 a voided invoice can''t be returned'
        WHEN 13 THEN 'T13 the 6-digit return counter stops at 999999'
        WHEN 14 THEN 'T14 a return needs an open shift'
        WHEN 15 THEN 'T15 a return transaction can''t be deleted' END;
    DECLARE @want INT = CASE @case WHEN 10 THEN 51210 WHEN 11 THEN 51212 WHEN 12 THEN 51206
                                   WHEN 13 THEN 51214 WHEN 14 THEN 51202 WHEN 15 THEN 51104 END;
    BEGIN TRY
        BEGIN TRAN;
        DECLARE @term INT, @branch VARCHAR(10), @user INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId);
        SELECT TOP 1 @term = TerminalId, @branch = BranchCode FROM dbo.Terminals ORDER BY TerminalId;
        DECLARE @prod INT, @cat INT; SELECT TOP 1 @prod = ProductId, @cat = CategoryId FROM dbo.Products ORDER BY ProductId;
        DECLARE @d DATE = '2099-02-10', @shift UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
        INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
        VALUES (@shift, @branch, @term, @user, @d, 1000, @now);
        DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @u UNIQUEIDENTIFIER = NEWID(), @ri dbo.TVP_ReturnItem;
        DELETE @i; DELETE @p; DELETE @ri;
        DECLARE @si BIGINT = ISNULL((SELECT MAX(ORNumber) FROM dbo.Sales WHERE TerminalId = @term), 0) + 1;
        INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
                   LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount)
        VALUES (1, @prod, 'X1', 'Test', @cat, 2, 112, 112, 0, 224, 1, 1, 224, 200, 24);
        INSERT @p VALUES (1, 'CASH', 224, NULL, NULL, NULL, NULL);
        DECLARE @status VARCHAR(12) = CASE WHEN @case = 12 THEN 'Voided' ELSE 'Completed' END;
        EXEC dbo.sp_UpsertSale @SaleUid=@u, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
            @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=224, @DiscountAmount=0,
            @VatExemptAmount=0, @VatableAmount=200, @VatAmount=24, @ZeroRatedAmount=0, @NetAmount=224,
            @TenderedAmount=224, @ChangeAmount=0, @Status=@status, @Items=@i, @Payments=@p;

        INSERT @ri VALUES (1, CASE WHEN @case = 10 THEN 3 ELSE 1 END);
        IF @case = 13 UPDATE dbo.Terminals SET LastReturnNo = 999999 WHERE TerminalId = @term;
        IF @case = 14 EXEC dbo.sp_ProcessBlindClose @ShiftUid = @shift, @DeclaredCash = 1224, @DenominationsJson = N'{}';
        DECLARE @ret UNIQUEIDENTIFIER = NEWID();
        DECLARE @expected DECIMAL(18,2) = CASE WHEN @case = 11 THEN 100 ELSE 112 END;
        IF @case <> 15
            EXEC dbo.sp_ProcessReturn @ReturnUid=@ret, @OrigSaleUid=@u, @ShiftUid=@shift, @CashierUserId=@user,
                @ApprovedByUserId=@user, @Reason=N'test', @Items=@ri, @ExpectedNet=@expected,
                @ReceiptText=N'Return No. ######', @Commit=1;
        ELSE
        BEGIN
            EXEC dbo.sp_ProcessReturn @ReturnUid=@ret, @OrigSaleUid=@u, @ShiftUid=@shift, @CashierUserId=@user,
                @ApprovedByUserId=@user, @Reason=N'test', @Items=@ri, @ExpectedNet=112,
                @ReceiptText=N'Return No. ######', @Commit=1;
            DELETE dbo.SaleReturns WHERE ReturnUid = @ret;
        END
        ROLLBACK;
        SELECT @name AS Test, 0 AS Pass, 'no error' AS Detail;
    END TRY
    BEGIN CATCH
        DECLARE @e INT = ERROR_NUMBER(), @m NVARCHAR(400) = ERROR_MESSAGE();
        IF @@TRANCOUNT > 0 ROLLBACK;
        SELECT @name AS Test, CASE WHEN @e = @want THEN 1 ELSE 0 END AS Pass, CONCAT(@e, ' ', @m) AS Detail;
    END CATCH
    SET @case += 1;
END
GO

/* T17. Days close in order: a new day can't start while an earlier day on the terminal is
        unclosed (shift still open, or no End of Day); once it's closed, the new day opens. */
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
    DECLARE @d1 DATE = '2099-02-20', @d2 DATE = '2099-02-21',
            @s1 UNIQUEIDENTIFIER = NEWID(), @s2 UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME(), @e INT;
    DECLARE @st TABLE (DayState VARCHAR(20), OpenShifts INT, ClosedShifts INT, EodDone BIT, LastCashier NVARCHAR(150),
        UnclosedDate DATE, UnclosedShiftUid UNIQUEIDENTIFIER, UnclosedCashierUserId INT, UnclosedCashier NVARCHAR(150),
        UnclosedCashBegin DECIMAL(18,2));

    /* Day 1's shift left open: the next day can't start, and the state names that shift. */
    EXEC dbo.sp_OpenShift @ShiftUid=@s1, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @BusinessDate=@d1, @CashBegin=1000, @OpenedAt=@now;
    SET @e = 0;
    BEGIN TRY EXEC dbo.sp_OpenShift @ShiftUid=@s2, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @BusinessDate=@d2, @CashBegin=1000, @OpenedAt=@now; END TRY BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'T17a no new day while an earlier day''s shift is open', CASE WHEN @e = 51012 THEN 1 ELSE 0 END, CONCAT(@e, '');
    INSERT @st EXEC dbo.sp_GetTerminalDayState @TerminalId=@term, @BusinessDate=@d2;
    INSERT @r SELECT 'T17b day state names the unclosed day and its open shift',
        CASE WHEN UnclosedDate = @d1 AND UnclosedShiftUid = @s1 AND UnclosedCashierUserId = @user THEN 1 ELSE 0 END,
        CONCAT(UnclosedDate, ' ', UnclosedShiftUid) FROM @st;

    /* Blind-closed but no End of Day: still blocked; the state shows no open shift. */
    EXEC dbo.sp_ProcessBlindClose @ShiftUid=@s1, @DeclaredCash=1000, @DenominationsJson=N'{}';
    SET @e = 0;
    BEGIN TRY EXEC dbo.sp_OpenShift @ShiftUid=@s2, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @BusinessDate=@d2, @CashBegin=1000, @OpenedAt=@now; END TRY BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'T17c no new day while an earlier day has no End of Day', CASE WHEN @e = 51012 THEN 1 ELSE 0 END, CONCAT(@e, '');
    DELETE @st; INSERT @st EXEC dbo.sp_GetTerminalDayState @TerminalId=@term, @BusinessDate=@d2;
    INSERT @r SELECT 'T17d day state: unclosed day, no open shift',
        CASE WHEN UnclosedDate = @d1 AND UnclosedShiftUid IS NULL THEN 1 ELSE 0 END, CONCAT(UnclosedDate, '') FROM @st;

    /* Close day 1: the new day opens. */
    EXEC dbo.sp_ProcessEndOfDay @TerminalId=@term, @BusinessDate=@d1, @ClosedByUserId=@user, @ApprovedByUserId=@user;
    SET @e = 0;
    BEGIN TRY EXEC dbo.sp_OpenShift @ShiftUid=@s2, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @BusinessDate=@d2, @CashBegin=1000, @OpenedAt=@now; END TRY BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    DELETE @st; INSERT @st EXEC dbo.sp_GetTerminalDayState @TerminalId=@term, @BusinessDate=@d2;
    INSERT @r SELECT 'T17e once the earlier day is closed, a new day opens',
        CASE WHEN @e = 0 AND EXISTS (SELECT 1 FROM dbo.Shifts WHERE ShiftUid = @s2 AND Status = 'Open')
              AND (SELECT UnclosedDate FROM @st) IS NULL THEN 1 ELSE 0 END, CONCAT(@e, '');

    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'T17 unexpected error' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO

/* T18. End of Day refusals (each in its own transaction: the proc aborts the transaction):
        a date with no shift (this made an empty Z-Read before), and a later day before an
        earlier unclosed one. */
DECLARE @case INT = 1;
WHILE @case <= 2
BEGIN
    DECLARE @name NVARCHAR(120) = CASE @case WHEN 1 THEN 'T18a End of Day for a date with no shift is refused'
                                             ELSE 'T18b a later day can''t be closed before an earlier one' END,
            @want INT = CASE @case WHEN 1 THEN 51005 ELSE 51013 END;
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
        DECLARE @now DATETIME2 = SYSDATETIME();
        IF @case = 2
            INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt, Status)
            VALUES (NEWID(), @branch, @term, @user, '2099-02-23', 1000, @now, 'BlindClosed'),
                   (NEWID(), @branch, @term, @user, '2099-02-24', 1000, @now, 'BlindClosed');
        EXEC dbo.sp_ProcessEndOfDay @TerminalId=@term, @BusinessDate='2099-02-24', @ClosedByUserId=@user, @ApprovedByUserId=@user;
        ROLLBACK;
        SELECT @name AS Test, 0 AS Pass, 'no error' AS Detail;
    END TRY
    BEGIN CATCH
        DECLARE @e INT = ERROR_NUMBER(), @m NVARCHAR(400) = ERROR_MESSAGE();
        IF @@TRANCOUNT > 0 ROLLBACK;
        SELECT @name AS Test, CASE WHEN @e = @want THEN 1 ELSE 0 END AS Pass, CONCAT(@e, ' ', @m) AS Detail;
    END CATCH
    SET @case += 1;
END
GO

/* T16. Nothing from these tests survived. */
SELECT 'T16 nothing left behind' AS Test,
    CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.Shifts WHERE BusinessDate BETWEEN '2099-02-01' AND '2099-02-28')
          AND NOT EXISTS (SELECT 1 FROM dbo.Sales WHERE BusinessDate BETWEEN '2099-02-01' AND '2099-02-28')
          AND NOT EXISTS (SELECT 1 FROM dbo.SaleReturns WHERE BusinessDate BETWEEN '2099-02-01' AND '2099-02-28')
         THEN 1 ELSE 0 END AS Pass, '' AS Detail;
GO
