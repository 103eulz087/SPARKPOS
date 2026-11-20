/* =====================================================================
   Suki / reward card tests (26_loyalty.sql + 02_procedures.sql).
   Every batch is rolled back, so this is safe on any DB with the schema and a terminal, user
   and product. Each result row must show Pass = 1. Business dates are in 2099.
   ===================================================================== */
SET NOCOUNT ON;
GO

/* L1. Earning, re-sync, the rounding, unknown / switched-off cards, voids (re-sync and the
       void endpoint's call), partial returns, the on/off switch and adjustments. */
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
    DECLARE @prod INT, @cat INT; SELECT TOP 1 @prod = ProductId, @cat = CategoryId FROM dbo.Products ORDER BY ProductId;
    DECLARE @d DATE = '2099-03-01', @shift UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
    UPDATE dbo.PosSettings SET RefundEnabled = 1 WHERE BranchCode = @branch;
    UPDATE dbo.LoyaltySettings SET IsEnabled = 1, AmountPerPoint = 200 WHERE SettingsId = 1;
    INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@shift, @branch, @term, @user, @d, 1000, @now);
    INSERT dbo.LoyaltyCards (CardNo, CustomerName, Mobile) VALUES (N'ZZTEST-A', N'Test A', '9999990901');
    INSERT dbo.LoyaltyCards (CardNo, CustomerName, IsActive) VALUES (N'ZZTEST-OFF', N'Test Off', 0);
    DECLARE @A INT = (SELECT CardId FROM dbo.LoyaltyCards WHERE CardNo = N'ZZTEST-A');

    -- every test sale: 13 x 50.00 = 650.00 (or one line at the given amount)
    DECLARE @si BIGINT = ISNULL((SELECT MAX(ORNumber) FROM dbo.Sales WHERE TerminalId = @term), 0);
    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @u UNIQUEIDENTIFIER;
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount)
    VALUES (1, @prod, 'B1', 'Test', @cat, 13, 50, 50, 0, 650, 1, 1, 650, 580.36, 69.64);
    INSERT @p VALUES (1, 'CASH', 650, NULL, NULL, NULL, NULL);
    DECLARE @s1 UNIQUEIDENTIFIER = NEWID(), @s3 UNIQUEIDENTIFIER = NEWID(), @s4 UNIQUEIDENTIFIER = NEWID(),
            @s5 UNIQUEIDENTIFIER = NEWID(), @s6 UNIQUEIDENTIFIER = NEWID(), @s7 UNIQUEIDENTIFIER = NEWID(),
            @s8 UNIQUEIDENTIFIER = NEWID();

    /* 650 at 200 a point = 3 points */
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@s1, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=650, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=580.36, @VatAmount=69.64, @ZeroRatedAmount=0, @NetAmount=650,
        @TenderedAmount=650, @ChangeAmount=0, @LoyaltyCardNo=N' ZZTEST-A ', @Items=@i, @Payments=@p;
    INSERT @r SELECT 'L1a a 650 sale at 200 a point earns 3 (card no. trimmed)',
        CASE WHEN c.Points = 3 AND s.LoyaltyCardId = @A
              AND (SELECT COUNT(*) FROM dbo.LoyaltyLedger WHERE Kind = 'EARN' AND RefUid = @s1 AND Points = 3 AND AmountPerPoint = 200) = 1
             THEN 1 ELSE 0 END, CONCAT(c.Points, ' pts')
    FROM dbo.LoyaltyCards c CROSS JOIN dbo.Sales s WHERE c.CardId = @A AND s.SaleUid = @s1;

    /* the same sale sent again earns nothing more */
    EXEC dbo.sp_UpsertSale @SaleUid=@s1, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=650, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=580.36, @VatAmount=69.64, @ZeroRatedAmount=0, @NetAmount=650,
        @TenderedAmount=650, @ChangeAmount=0, @LoyaltyCardNo=N'ZZTEST-A', @Items=@i, @Payments=@p;
    INSERT @r SELECT 'L1b a re-synced sale doesn''t earn twice', CASE WHEN Points = 3 THEN 1 ELSE 0 END, CONCAT(Points, ' pts')
    FROM dbo.LoyaltyCards WHERE CardId = @A;

    /* under one point's worth: nothing */
    DECLARE @i2 dbo.TVP_SaleItem, @p2 dbo.TVP_SalePayment;
    INSERT @i2 ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
                LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount)
    VALUES (1, @prod, 'B1', 'Test', @cat, 1, 199.99, 199.99, 0, 199.99, 1, 1, 199.99, 178.56, 21.43);
    INSERT @p2 VALUES (1, 'CASH', 199.99, NULL, NULL, NULL, NULL);
    SET @si += 1; SET @u = NEWID();
    EXEC dbo.sp_UpsertSale @SaleUid=@u, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=199.99, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=178.56, @VatAmount=21.43, @ZeroRatedAmount=0, @NetAmount=199.99,
        @TenderedAmount=199.99, @ChangeAmount=0, @LoyaltyCardNo=N'ZZTEST-A', @Items=@i2, @Payments=@p2;
    INSERT @r SELECT 'L1c 199.99 earns nothing (rounded down)',
        CASE WHEN Points = 3 AND NOT EXISTS (SELECT 1 FROM dbo.LoyaltyLedger WHERE RefUid = @u) THEN 1 ELSE 0 END, CONCAT(Points, ' pts')
    FROM dbo.LoyaltyCards WHERE CardId = @A;

    /* an unknown card: the sale still syncs, without a card, and the audit log says why */
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@s3, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=650, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=580.36, @VatAmount=69.64, @ZeroRatedAmount=0, @NetAmount=650,
        @TenderedAmount=650, @ChangeAmount=0, @LoyaltyCardNo=N'ZZTEST-NOPE', @Items=@i, @Payments=@p;
    INSERT @r SELECT 'L1d an unknown card: sale kept, no card, audit row',
        CASE WHEN EXISTS (SELECT 1 FROM dbo.Sales WHERE SaleUid = @s3 AND LoyaltyCardId IS NULL)
              AND EXISTS (SELECT 1 FROM dbo.AuditLogs WHERE Action = 'LOYALTY_UNKNOWN' AND Detail LIKE N'%ZZTEST-NOPE%')
             THEN 1 ELSE 0 END, '';

    /* a switched-off card earns nothing */
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@s4, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=650, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=580.36, @VatAmount=69.64, @ZeroRatedAmount=0, @NetAmount=650,
        @TenderedAmount=650, @ChangeAmount=0, @LoyaltyCardNo=N'ZZTEST-OFF', @Items=@i, @Payments=@p;
    INSERT @r SELECT 'L1e a switched-off card earns nothing',
        CASE WHEN Points = 0 AND NOT EXISTS (SELECT 1 FROM dbo.LoyaltyLedger WHERE RefUid = @s4) THEN 1 ELSE 0 END, CONCAT(Points, ' pts')
    FROM dbo.LoyaltyCards WHERE CardNo = N'ZZTEST-OFF';

    /* voided offline after it first synced: the re-sync takes the points back */
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@s5, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=650, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=580.36, @VatAmount=69.64, @ZeroRatedAmount=0, @NetAmount=650,
        @TenderedAmount=650, @ChangeAmount=0, @LoyaltyCardNo=N'ZZTEST-A', @Items=@i, @Payments=@p;
    EXEC dbo.sp_UpsertSale @SaleUid=@s5, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=650, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=580.36, @VatAmount=69.64, @ZeroRatedAmount=0, @NetAmount=650,
        @TenderedAmount=650, @ChangeAmount=0, @LoyaltyCardNo=N'ZZTEST-A', @Status='Voided', @Items=@i, @Payments=@p;
    INSERT @r SELECT 'L1f a void sent on re-sync takes the 3 points back',
        CASE WHEN Points = 3 AND EXISTS (SELECT 1 FROM dbo.LoyaltyLedger WHERE Kind = 'VOID' AND RefUid = @s5 AND Points = -3)
             THEN 1 ELSE 0 END, CONCAT(Points, ' pts')
    FROM dbo.LoyaltyCards WHERE CardId = @A;

    /* the void endpoint's call, twice */
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@s6, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=650, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=580.36, @VatAmount=69.64, @ZeroRatedAmount=0, @NetAmount=650,
        @TenderedAmount=650, @ChangeAmount=0, @LoyaltyCardNo=N'ZZTEST-A', @Items=@i, @Payments=@p;
    EXEC dbo.sp_LoyaltyTakeBack @SaleUid=@s6, @Kind='VOID', @RefUid=@s6, @UserId=@user;
    EXEC dbo.sp_LoyaltyTakeBack @SaleUid=@s6, @Kind='VOID', @RefUid=@s6, @UserId=@user;
    INSERT @r SELECT 'L1g a void takes the points back once',
        CASE WHEN Points = 3 AND (SELECT SUM(Points) FROM dbo.LoyaltyLedger WHERE SaleUid = @s6) = 0 THEN 1 ELSE 0 END, CONCAT(Points, ' pts')
    FROM dbo.LoyaltyCards WHERE CardId = @A;

    /* returns: 650 -> return 2 x 50 (550 left = 2 points) -> return 4 x 50 (350 left = 1 point) */
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@s7, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=650, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=580.36, @VatAmount=69.64, @ZeroRatedAmount=0, @NetAmount=650,
        @TenderedAmount=650, @ChangeAmount=0, @LoyaltyCardNo=N'ZZTEST-A', @Items=@i, @Payments=@p;
    DECLARE @ri dbo.TVP_ReturnItem, @ret1 UNIQUEIDENTIFIER = NEWID(), @ret2 UNIQUEIDENTIFIER = NEWID();
    INSERT @ri VALUES (1, 2);
    EXEC dbo.sp_ProcessReturn @ReturnUid=@ret1, @OrigSaleUid=@s7, @ShiftUid=@shift, @CashierUserId=@user,
        @ApprovedByUserId=@user, @Reason=N'test', @Items=@ri, @ReceiptText=N'Return No. ######', @Commit=1;
    INSERT @r SELECT 'L1h a return of 100 leaves 550 = 2 of the 3 points',
        CASE WHEN Points = 5 AND EXISTS (SELECT 1 FROM dbo.LoyaltyLedger WHERE Kind = 'RETURN' AND RefUid = @ret1 AND Points = -1)
             THEN 1 ELSE 0 END, CONCAT(Points, ' pts')
    FROM dbo.LoyaltyCards WHERE CardId = @A;
    DELETE @ri; INSERT @ri VALUES (1, 4);
    EXEC dbo.sp_ProcessReturn @ReturnUid=@ret2, @OrigSaleUid=@s7, @ShiftUid=@shift, @CashierUserId=@user,
        @ApprovedByUserId=@user, @Reason=N'test', @Items=@ri, @ReceiptText=N'Return No. ######', @Commit=1;
    INSERT @r SELECT 'L1i a second return of 200 leaves 350 = 1 point',
        CASE WHEN Points = 4 AND (SELECT SUM(Points) FROM dbo.LoyaltyLedger WHERE SaleUid = @s7) = 1 THEN 1 ELSE 0 END, CONCAT(Points, ' pts')
    FROM dbo.LoyaltyCards WHERE CardId = @A;

    /* earning switched off */
    UPDATE dbo.LoyaltySettings SET IsEnabled = 0 WHERE SettingsId = 1;
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@s8, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=650, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=580.36, @VatAmount=69.64, @ZeroRatedAmount=0, @NetAmount=650,
        @TenderedAmount=650, @ChangeAmount=0, @LoyaltyCardNo=N'ZZTEST-A', @Items=@i, @Payments=@p;
    INSERT @r SELECT 'L1j with earning off, the card is kept on the sale but earns nothing',
        CASE WHEN c.Points = 4 AND s.LoyaltyCardId = @A THEN 1 ELSE 0 END, CONCAT(c.Points, ' pts')
    FROM dbo.LoyaltyCards c CROSS JOIN dbo.Sales s WHERE c.CardId = @A AND s.SaleUid = @s8;

    /* an adjustment, and the balance always equals its history */
    DECLARE @adj TABLE (Points INT);
    INSERT @adj EXEC dbo.sp_LoyaltyAdjust @CardId=@A, @Points=5, @Note=N'test', @UserId=@user;
    INSERT @r SELECT 'L1k an adjustment adds to the balance, which matches the history',
        CASE WHEN c.Points = 9 AND (SELECT Points FROM @adj) = 9
              AND c.Points = (SELECT SUM(Points) FROM dbo.LoyaltyLedger WHERE CardId = @A) THEN 1 ELSE 0 END, CONCAT(c.Points, ' pts')
    FROM dbo.LoyaltyCards c WHERE c.CardId = @A;

    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'L1 batch' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE(), ' line ', ERROR_LINE()) AS Detail;
END CATCH
GO

/* L2. Refusals, each in its own transaction (the procs abort it): taking more points than the
       card has, a second card with the same mobile number, and editing the history. */
DECLARE @case INT = 1;
WHILE @case <= 3
BEGIN
    DECLARE @name NVARCHAR(120) = CASE @case WHEN 1 THEN 'L2a an adjustment can''t take the card below 0'
                                             WHEN 2 THEN 'L2b one mobile number, one card'
                                             ELSE 'L2c the points history can''t be edited' END,
            @want INT = CASE @case WHEN 1 THEN 51301 WHEN 2 THEN 2601 ELSE 51300 END;
    BEGIN TRY
        BEGIN TRAN;
        DECLARE @user INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId);
        INSERT dbo.LoyaltyCards (CardNo, CustomerName, Mobile) VALUES (N'ZZTEST-B', N'Test B', '9999990902');
        DECLARE @B INT = SCOPE_IDENTITY();
        IF @case = 1 EXEC dbo.sp_LoyaltyAdjust @CardId=@B, @Points=-1, @Note=N'test', @UserId=@user;
        IF @case = 2 INSERT dbo.LoyaltyCards (CardNo, CustomerName, Mobile) VALUES (N'ZZTEST-C', N'Test C', '9999990902');
        IF @case = 3
        BEGIN
            EXEC dbo.sp_LoyaltyAdjust @CardId=@B, @Points=2, @Note=N'test', @UserId=@user;
            UPDATE dbo.LoyaltyLedger SET Points = 200 WHERE CardId = @B;
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

/* L3. Nothing from these tests survived. */
SELECT 'L3 nothing left behind' AS Test,
    CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.LoyaltyCards WHERE CardNo LIKE N'ZZTEST-%')
          AND NOT EXISTS (SELECT 1 FROM dbo.Sales WHERE BusinessDate = '2099-03-01')
         THEN 1 ELSE 0 END AS Pass, '' AS Detail;
GO
