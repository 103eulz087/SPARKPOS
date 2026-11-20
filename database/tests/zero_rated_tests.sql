/* =====================================================================
   Zero-rated sale tests (28_zero_rated_sales.sql + 02_procedures.sql).
   Every batch is rolled back, so this is safe on any DB with the schema and a terminal, user
   and product. Each result row must show Pass = 1. Business dates are in 2099.
   ===================================================================== */
SET NOCOUNT ON;
GO

/* Z1. A zero-rated sale keeps the buyer's certificate, its approver and its figures, and is
       audited; an ordinary sale has none of it. */
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
    DECLARE @d DATE = '2099-04-01', @shift UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
    INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@shift, @branch, @term, @user, @d, 1000, @now);
    DECLARE @si BIGINT = ISNULL((SELECT MAX(ORNumber) FROM dbo.Sales WHERE TerminalId = @term), 0);

    /* a VAT-able line at 112.00 sold zero-rated at 100.00, plus a VAT-exempt line at 50.00 */
    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @z UNIQUEIDENTIFIER = NEWID(), @o UNIQUEIDENTIFIER = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, ZeroRatedAmount, VatExemptAmount, PriceApprovedBy)
    VALUES (1, @prod, 'B1', 'Test VATable', @cat, 1, 100, 112, 0, 100, 1, 1, 100, 100, 0, @sup),
           (2, @prod, 'B2', 'Test exempt',  @cat, 1, 50,  50,  0, 50,  0, 1, 50,  0,   50, NULL);
    INSERT @p VALUES (1, 'CASH', 150, NULL, NULL, NULL, NULL);
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@z, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=150, @DiscountAmount=0,
        @VatExemptAmount=50, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=100, @NetAmount=150,
        @TenderedAmount=150, @ChangeAmount=0, @CustomerName=N'ZZTEST Ecozone Inc.', @CustomerTin='000-111-222-00000',
        @CustomerAddress=N'Mactan Economic Zone', @ZeroRatedCertNo=N' PEZA-ZZ-001 ', @ZeroRatedApprovedBy=@sup,
        @Items=@i, @Payments=@p;
    INSERT @r SELECT 'Z1a the sale keeps the certificate (trimmed), the approver and its figures',
        CASE WHEN ZeroRatedCertNo = N'PEZA-ZZ-001' AND ZeroRatedApprovedBy = @sup AND ZeroRatedAmount = 100
              AND VatExemptAmount = 50 AND VatableAmount = 0 AND VatAmount = 0 AND NetAmount = 150 THEN 1 ELSE 0 END,
        CONCAT(ZeroRatedCertNo, ' / ', ZeroRatedApprovedBy, ' / ', ZeroRatedAmount)
    FROM dbo.Sales WHERE SaleUid = @z;
    INSERT @r SELECT 'Z1b the repriced line keeps its shelf price and the approver',
        CASE WHEN UnitPrice = 100 AND OrigUnitPrice = 112 AND PriceApprovedBy = @sup AND ZeroRatedAmount = 100 THEN 1 ELSE 0 END,
        CONCAT(UnitPrice, ' / ', OrigUnitPrice, ' / ', PriceApprovedBy)
    FROM dbo.SaleItems WHERE SaleUid = @z AND [LineNo] = 1;
    INSERT @r SELECT 'Z1c a ZERO_RATED audit row names the buyer, TIN and certificate',
        CASE WHEN COUNT(*) = 1 AND MAX(UserId) = @sup THEN 1 ELSE 0 END, MAX(Detail)
    FROM dbo.AuditLogs WHERE Action = 'ZERO_RATED' AND TerminalId = @term AND Detail LIKE CONCAT(N'SI ', @si, N':%PEZA-ZZ-001%');

    /* sent again (the till retries): nothing doubles */
    EXEC dbo.sp_UpsertSale @SaleUid=@z, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=150, @DiscountAmount=0,
        @VatExemptAmount=50, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=100, @NetAmount=150,
        @TenderedAmount=150, @ChangeAmount=0, @ZeroRatedCertNo=N'PEZA-ZZ-001', @ZeroRatedApprovedBy=@sup,
        @Items=@i, @Payments=@p;
    INSERT @r SELECT 'Z1d a re-synced zero-rated sale isn''t audited twice',
        CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END, CONCAT(COUNT(*), ' rows')
    FROM dbo.AuditLogs WHERE Action = 'ZERO_RATED' AND TerminalId = @term AND Detail LIKE CONCAT(N'SI ', @si, N':%');

    /* an ordinary sale */
    DELETE @i;
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatExemptAmount)
    VALUES (1, @prod, 'B2', 'Test exempt', @cat, 1, 50, 50, 0, 50, 0, 1, 50, 50);
    DELETE @p; INSERT @p VALUES (1, 'CASH', 50, NULL, NULL, NULL, NULL);
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@o, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=50, @DiscountAmount=0,
        @VatExemptAmount=50, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=50,
        @TenderedAmount=50, @ChangeAmount=0, @Items=@i, @Payments=@p;
    INSERT @r SELECT 'Z1e an ordinary sale has no certificate, no approver and no audit row',
        CASE WHEN s.ZeroRatedCertNo IS NULL AND s.ZeroRatedApprovedBy IS NULL
              AND NOT EXISTS (SELECT 1 FROM dbo.AuditLogs WHERE Action = 'ZERO_RATED' AND TerminalId = @term
                              AND Detail LIKE CONCAT(N'SI ', @si, N':%')) THEN 1 ELSE 0 END, ''
    FROM dbo.Sales s WHERE s.SaleUid = @o;

    SELECT Test, Pass, Detail FROM @r;
    ROLLBACK;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'Z1 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO

/* Z2. Nothing from these tests survived. */
SELECT 'Z2 nothing left behind' AS Test,
    CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.Sales WHERE BusinessDate = '2099-04-01') THEN 1 ELSE 0 END AS Pass, '' AS Detail;
GO
