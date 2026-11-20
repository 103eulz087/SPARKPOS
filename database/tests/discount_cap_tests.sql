/* =====================================================================
   Discount per POS type + weekly cap tests (32_discount_pos_type.sql + 02_procedures.sql).
   Every batch is rolled back, so this is safe on any DB with the schema and a terminal, user
   and product. Each result row must show Pass = 1. Business dates are in 2099.
   ===================================================================== */
SET NOCOUNT ON;
GO

/* C1. A capped SC discount keeps the cap and its supervisor, audited once; an uncapped one keeps
       neither; an OTHER discount ignores a cap sent by mistake. */
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

    /* ₱2,000 VAT-able at 5% (VAT stays), limited to ₱20 off: 448 discounted (400 + 48, less 20 → 380
       + 45.60) and 1,552 at full price. Net 1,980 = 1,767.86 VAT-able + 212.14 VAT. */
    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @a UNIQUEIDENTIFIER = NEWID(), @b UNIQUEIDENTIFIER = NEWID(), @o UNIQUEIDENTIFIER = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount, VatAdjustment)
    VALUES (1, @prod, 'C1', 'Test grocery', @cat, 4, 500, 500, 17.86, 2000, 1, 1, 1980, 1767.86, 212.14, 2.14);
    INSERT @p VALUES (1, 'CASH', 1980, NULL, NULL, NULL, NULL);
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@a, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=2000, @DiscountAmount=17.86,
        @VatExemptAmount=0, @VatableAmount=1767.86, @VatAmount=212.14, @ZeroRatedAmount=0, @NetAmount=1980,
        @TenderedAmount=1980, @ChangeAmount=0, @DiscountCode='SENIOR', @DiscountCtrlNo=N'ZZ-77', @DiscountName=N'ZZTEST Senior',
        @VatAdjustment=2.14, @DiscountCap=20, @DiscountApprovedBy=@sup, @Items=@i, @Payments=@p;
    INSERT @r SELECT 'C1a a capped SC sale keeps the cap and the supervisor',
        CASE WHEN DiscountCap = 20 AND DiscountApprovedBy = @sup AND NetAmount = 1980 THEN 1 ELSE 0 END,
        CONCAT(DiscountCap, ' / ', DiscountApprovedBy) FROM dbo.Sales WHERE SaleUid = @a;
    INSERT @r SELECT 'C1b one DISCOUNT_CAP audit row by the supervisor names the cap and the ID',
        CASE WHEN COUNT(*) = 1 AND MAX(UserId) = @sup THEN 1 ELSE 0 END, MAX(Detail)
    FROM dbo.AuditLogs WHERE Action = 'DISCOUNT_CAP' AND TerminalId = @term AND Detail LIKE CONCAT(N'SI ', @si, N': SENIOR%20.00%ZZ-77%');
    -- the till retries: nothing doubles
    EXEC dbo.sp_UpsertSale @SaleUid=@a, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=2000, @DiscountAmount=17.86,
        @VatExemptAmount=0, @VatableAmount=1767.86, @VatAmount=212.14, @ZeroRatedAmount=0, @NetAmount=1980,
        @TenderedAmount=1980, @ChangeAmount=0, @DiscountCode='SENIOR', @DiscountCtrlNo=N'ZZ-77', @DiscountName=N'ZZTEST Senior',
        @VatAdjustment=2.14, @DiscountCap=20, @DiscountApprovedBy=@sup, @Items=@i, @Payments=@p;
    INSERT @r SELECT 'C1c a re-synced capped sale isn''t audited twice',
        CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END, CONCAT(COUNT(*), ' rows')
    FROM dbo.AuditLogs WHERE Action = 'DISCOUNT_CAP' AND TerminalId = @term AND Detail LIKE CONCAT(N'SI ', @si, N':%');

    /* the same sale uncapped: no cap, no approver, no audit row */
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@b, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=2000, @DiscountAmount=17.86,
        @VatExemptAmount=0, @VatableAmount=1767.86, @VatAmount=212.14, @ZeroRatedAmount=0, @NetAmount=1980,
        @TenderedAmount=1980, @ChangeAmount=0, @DiscountCode='SENIOR', @DiscountCtrlNo=N'ZZ-78', @DiscountName=N'ZZTEST Senior',
        @VatAdjustment=2.14, @DiscountApprovedBy=@sup, @Items=@i, @Payments=@p;
    -- since 35 an approved SC/PWD discount keeps its approver (the till's Discount approval)
    INSERT @r SELECT 'C1d an uncapped SC sale keeps no cap (its approver since 35) and no DISCOUNT_CAP row',
        CASE WHEN s.DiscountCap IS NULL AND s.DiscountApprovedBy = @sup
              AND NOT EXISTS (SELECT 1 FROM dbo.AuditLogs WHERE Action = 'DISCOUNT_CAP' AND TerminalId = @term
                              AND Detail LIKE CONCAT(N'SI ', @si, N':%')) THEN 1 ELSE 0 END, ''
    FROM dbo.Sales s WHERE s.SaleUid = @b;

    /* an OTHER discount with a cap passed by mistake: the cap isn't kept */
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@o, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=2000, @DiscountAmount=17.86,
        @VatExemptAmount=0, @VatableAmount=1767.86, @VatAmount=212.14, @ZeroRatedAmount=0, @NetAmount=1980,
        @TenderedAmount=1980, @ChangeAmount=0, @DiscountCode='OTHER', @DiscountName=N'ZZTEST reason',
        @DiscountCap=20, @DiscountApprovedBy=@sup, @Items=@i, @Payments=@p;
    INSERT @r SELECT 'C1e an OTHER discount keeps its approver but no cap, and no DISCOUNT_CAP row',
        CASE WHEN s.DiscountCap IS NULL AND s.DiscountApprovedBy = @sup
              AND NOT EXISTS (SELECT 1 FROM dbo.AuditLogs WHERE Action = 'DISCOUNT_CAP' AND TerminalId = @term
                              AND Detail LIKE CONCAT(N'SI ', @si, N':%')) THEN 1 ELSE 0 END, ''
    FROM dbo.Sales s WHERE s.SaleUid = @o;

    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'C1 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO

/* C2. The rate table: one rule per discount, POS type and category (one "every category" rule);
       a bad POS type or rate is refused. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    DECLARE @cat INT = (SELECT TOP 1 CategoryId FROM dbo.Categories ORDER BY CategoryId), @e INT;
    DELETE dbo.DiscountPosTypeRates WHERE DiscountCode IN ('SENIOR', 'PWD');   -- a DB's real rates (rolled back)
    INSERT dbo.DiscountPosTypeRates (DiscountCode, PosType, CategoryId, Rate, IsVatExempt)
    VALUES ('SENIOR', 'Retail', NULL, 0.05, 0), ('SENIOR', 'Retail', @cat, 0.20, 1), ('SENIOR', 'Restaurant', NULL, 0.20, 1);
    INSERT @r SELECT 'C2a Retail every-category, Retail + category and Restaurant rules can sit together',
        CASE WHEN COUNT(*) = 3 THEN 1 ELSE 0 END, CONCAT(COUNT(*), '') FROM dbo.DiscountPosTypeRates WHERE DiscountCode = 'SENIOR';

    SET @e = 0;
    BEGIN TRY INSERT dbo.DiscountPosTypeRates (DiscountCode, PosType, CategoryId, Rate, IsVatExempt) VALUES ('SENIOR', 'Retail', NULL, 0.10, 0);
    END TRY BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'C2b a second every-category rule for the same POS type is refused', CASE WHEN @e IN (2601, 2627) THEN 1 ELSE 0 END, CONCAT(@e, '');

    SET @e = 0;
    BEGIN TRY INSERT dbo.DiscountPosTypeRates (DiscountCode, PosType, CategoryId, Rate, IsVatExempt) VALUES ('SENIOR', 'Grocery', NULL, 0.05, 0);
    END TRY BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'C2c an unknown POS type is refused', CASE WHEN @e = 547 THEN 1 ELSE 0 END, CONCAT(@e, '');

    SET @e = 0;
    BEGIN TRY INSERT dbo.DiscountPosTypeRates (DiscountCode, PosType, CategoryId, Rate, IsVatExempt) VALUES ('PWD', 'Retail', NULL, 1.5, 0);
    END TRY BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'C2d a rate over 100% is refused', CASE WHEN @e = 547 THEN 1 ELSE 0 END, CONCAT(@e, '');

    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'C2 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO
