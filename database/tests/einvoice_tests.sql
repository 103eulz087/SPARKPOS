/* =====================================================================
   E-invoice email tests (24_invoice_email.sql + dbo.sp_QueueInvoiceEmail and its calls in
   sp_UpsertSale / sp_ProcessReturn). Every batch is rolled back. Each result row must show
   Pass = 1. Business dates are in 2099 so they never meet a real day. Nothing is emailed:
   these only check what gets queued.
   ===================================================================== */
SET NOCOUNT ON;
GO

BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    DECLARE @term INT, @branch VARCHAR(10), @user INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId);
    SELECT TOP 1 @term = TerminalId, @branch = BranchCode FROM dbo.Terminals ORDER BY TerminalId;
    DECLARE @prod INT, @cat INT; SELECT TOP 1 @prod = ProductId, @cat = CategoryId FROM dbo.Products ORDER BY ProductId;
    DECLARE @d DATE = '2099-03-01', @shift UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
    INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@shift, @branch, @term, @user, @d, 1000, @now);

    /* E-invoice on, with a repository; no branch-specific row in the way */
    DELETE dbo.EmailConfig WHERE BranchCode = @branch;
    IF EXISTS (SELECT 1 FROM dbo.EmailConfig WHERE BranchCode IS NULL)
        UPDATE dbo.EmailConfig SET IsActive = 1, SendInvoices = 1, InvoiceRepository = N'repo@test.local' WHERE BranchCode IS NULL;
    ELSE
        INSERT dbo.EmailConfig (BranchCode, SmtpHost, SmtpUser, SmtpPassword, FromAddress, ToAddresses, IsActive, SendInvoices, InvoiceRepository)
        VALUES (NULL, N'smtp.test.local', N'u', N'p', N'pos@test.local', N'x@test.local', 1, 1, N'repo@test.local');

    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment;
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatableAmount, VatAmount)
    VALUES (1, @prod, 'E1', 'Test', @cat, 2, 56, 56, 0, 112, 1, 1, 112, 100, 12);
    INSERT @p VALUES (1, 'CASH', 112, NULL, NULL, NULL, NULL);
    DECLARE @si BIGINT = ISNULL((SELECT MAX(ORNumber) FROM dbo.Sales WHERE TerminalId = @term), 0);
    DECLARE @s1 UNIQUEIDENTIFIER = NEWID(), @s2 UNIQUEIDENTIFIER = NEWID(), @s3 UNIQUEIDENTIFIER = NEWID(),
            @s4 UNIQUEIDENTIFIER = NEWID(), @s5 UNIQUEIDENTIFIER = NEWID(), @n BIGINT;

    SET @n = @si + 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@s1, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@n, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=100, @VatAmount=12, @ZeroRatedAmount=0, @NetAmount=112,
        @TenderedAmount=112, @ChangeAmount=0, @ReceiptText=N'SALES INVOICE 1', @CustomerEmail=N' Juan@Example.com ',
        @Items=@i, @Payments=@p;
    INSERT @r SELECT 'E1 a sale with the customer''s email queues a copy to that address',
        CASE WHEN COUNT(*) = 1 AND MAX(ToAddress) = N'Juan@Example.com' AND MAX(CAST(ToRepository AS INT)) = 0
              AND MAX(Status) = 'Pending' THEN 1 ELSE 0 END, MAX(ToAddress)
    FROM dbo.InvoiceEmails WHERE Kind = 'SALE' AND RefUid = @s1;
    INSERT @r SELECT 'E1b the email is kept on the sale (trimmed)',
        CASE WHEN CustomerEmail = N'Juan@Example.com' THEN 1 ELSE 0 END, CustomerEmail FROM dbo.Sales WHERE SaleUid = @s1;

    SET @n = @si + 2;
    EXEC dbo.sp_UpsertSale @SaleUid=@s2, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@n, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=100, @VatAmount=12, @ZeroRatedAmount=0, @NetAmount=112,
        @TenderedAmount=112, @ChangeAmount=0, @ReceiptText=N'SALES INVOICE 2', @Items=@i, @Payments=@p;
    INSERT @r SELECT 'E2 no customer email: the copy goes to the repository',
        CASE WHEN COUNT(*) = 1 AND MAX(ToAddress) = N'repo@test.local' AND MAX(CAST(ToRepository AS INT)) = 1 THEN 1 ELSE 0 END, MAX(ToAddress)
    FROM dbo.InvoiceEmails WHERE Kind = 'SALE' AND RefUid = @s2;

    /* the same sale synced again (a retry from the device) */
    SET @n = @si + 2;
    EXEC dbo.sp_UpsertSale @SaleUid=@s2, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@n, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=100, @VatAmount=12, @ZeroRatedAmount=0, @NetAmount=112,
        @TenderedAmount=112, @ChangeAmount=0, @ReceiptText=N'SALES INVOICE 2', @Items=@i, @Payments=@p;
    INSERT @r SELECT 'E3 syncing the same sale again doesn''t queue a second copy',
        CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END, CONCAT(COUNT(*), ' rows') FROM dbo.InvoiceEmails WHERE RefUid = @s2;

    SET @n = @si + 3;
    EXEC dbo.sp_UpsertSale @SaleUid=@s3, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@n, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=100, @VatAmount=12, @ZeroRatedAmount=0, @NetAmount=112,
        @TenderedAmount=112, @ChangeAmount=0, @Status='Voided', @CustomerEmail=N'juan@example.com', @Items=@i, @Payments=@p;
    INSERT @r SELECT 'E4 a sale voided before it ever synced gets no copy',
        CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.InvoiceEmails WHERE RefUid = @s3) THEN 1 ELSE 0 END, '';

    SET @n = @si + 4;
    EXEC dbo.sp_UpsertSale @SaleUid=@s4, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@n, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=100, @VatAmount=12, @ZeroRatedAmount=0, @NetAmount=112,
        @TenderedAmount=112, @ChangeAmount=0, @CustomerEmail=N'not an email', @Items=@i, @Payments=@p;
    INSERT @r SELECT 'E5 an address that isn''t one falls back to the repository',
        CASE WHEN MAX(ToAddress) = N'repo@test.local' AND MAX(CAST(ToRepository AS INT)) = 1 THEN 1 ELSE 0 END, MAX(ToAddress)
    FROM dbo.InvoiceEmails WHERE RefUid = @s4;

    UPDATE dbo.EmailConfig SET SendInvoices = 0 WHERE BranchCode IS NULL;
    SET @n = @si + 5;
    EXEC dbo.sp_UpsertSale @SaleUid=@s5, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@n, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=100, @VatAmount=12, @ZeroRatedAmount=0, @NetAmount=112,
        @TenderedAmount=112, @ChangeAmount=0, @CustomerEmail=N'juan@example.com', @Items=@i, @Payments=@p;
    INSERT @r SELECT 'E6 with e-invoice copies turned off nothing is queued',
        CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.InvoiceEmails WHERE RefUid = @s5) THEN 1 ELSE 0 END, '';
    UPDATE dbo.EmailConfig SET SendInvoices = 1 WHERE BranchCode IS NULL;

    /* A return on sale 1 goes to sale 1's customer */
    DECLARE @ret UNIQUEIDENTIFIER = NEWID(), @ri dbo.TVP_ReturnItem;
    INSERT @ri VALUES (1, 1);
    EXEC dbo.sp_ProcessReturn @ReturnUid=@ret, @OrigSaleUid=@s1, @ShiftUid=@shift, @CashierUserId=@user,
        @ApprovedByUserId=@user, @Reason=N'test', @Items=@ri, @ReturnDateTime=@now,
        @ReceiptText=N'RETURN ######', @Commit=1;
    INSERT @r SELECT 'E7 a return receipt is emailed to the original sale''s customer',
        CASE WHEN COUNT(*) = 1 AND MAX(ToAddress) = N'Juan@Example.com' THEN 1 ELSE 0 END, MAX(ToAddress)
    FROM dbo.InvoiceEmails WHERE Kind = 'RETURN' AND RefUid = @ret;

    /* "Email a copy" from Reprint: always queued, even next to the automatic one */
    EXEC dbo.sp_QueueInvoiceEmail @Kind='SALE', @RefUid=@s2, @BranchCode=@branch, @ToAddress=N' maria@example.ph ', @RequestedBy=@user;
    INSERT @r SELECT 'E8 a copy on request is queued to the address given',
        CASE WHEN EXISTS (SELECT 1 FROM dbo.InvoiceEmails WHERE RefUid = @s2 AND IsManual = 1 AND ToAddress = N'maria@example.ph' AND RequestedBy = @user)
              AND (SELECT COUNT(*) FROM dbo.InvoiceEmails WHERE RefUid = @s2) = 2 THEN 1 ELSE 0 END, '';
    DECLARE @err INT = 0;
    BEGIN TRY
        EXEC dbo.sp_QueueInvoiceEmail @Kind='SALE', @RefUid=@s2, @BranchCode=@branch, @ToAddress=N'maria at example', @RequestedBy=@user;
    END TRY
    BEGIN CATCH SET @err = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'E9 a copy on request to something that isn''t an email is refused (53201)',
        CASE WHEN @err = 53201 THEN 1 ELSE 0 END, CONCAT('error ', @err);

    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    DECLARE @e INT = ERROR_NUMBER(), @m NVARCHAR(400) = ERROR_MESSAGE(), @l INT = ERROR_LINE();
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'E batch' AS Test, 0 AS Pass, CONCAT(@e, ' ', @m, ' line ', @l) AS Detail;
END CATCH
GO
