/* =====================================================================
   Gift certificate tests (38_gift_certificates.sql + 02_procedures.sql).
   Every batch is rolled back, so this is safe on any DB with the schema and a terminal, user
   and product. Each result row must show Pass = 1. Business dates are in 2099; GC numbers ZZGC-*.
   ===================================================================== */
SET NOCOUNT ON;
GO

/* G1. A GC pays part of a sale: checked, redeemed, no change on it, the excess forfeited; a GC
       used again (offline) still saves the sale but is flagged; unknown / expired / other branch
       / cancelled are flagged; a void gives the GC back; X-Read, Blind Close, Z-Read and the
       ledger count GC apart from cash. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    DECLARE @term INT, @branch VARCHAR(10), @user INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId);
    SET @term = NULL;
    SELECT TOP 1 @term = TerminalId, @branch = BranchCode FROM dbo.Terminals t
    WHERE NOT EXISTS (SELECT 1 FROM dbo.Shifts s WHERE s.TerminalId = t.TerminalId
        AND NOT EXISTS (SELECT 1 FROM dbo.ZReads z WHERE z.TerminalId = s.TerminalId AND z.BusinessDate = s.BusinessDate))
    ORDER BY TerminalId;
    IF @term IS NULL
    BEGIN
        SELECT TOP 1 @branch = BranchCode FROM dbo.Branches WHERE IsActive = 1 ORDER BY BranchCode;
        INSERT dbo.Terminals (BranchCode, TerminalCode, TerminalName) VALUES (@branch, 'ZZ-TEST', N'ZZTEST terminal');
        SET @term = SCOPE_IDENTITY();
    END
    UPDATE dbo.Terminals SET PostToErp = 0 WHERE TerminalId = @term;   -- nothing queued for the ERP
    DECLARE @other VARCHAR(10) = (SELECT TOP 1 BranchCode FROM dbo.Branches WHERE BranchCode <> @branch ORDER BY BranchCode);
    DECLARE @prod INT, @cat INT; SELECT TOP 1 @prod = ProductId, @cat = CategoryId FROM dbo.Products ORDER BY ProductId;
    DECLARE @d DATE = '2099-05-01', @shift UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
    INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@shift, @branch, @term, @user, @d, 1000, @now);
    DECLARE @si BIGINT = ISNULL((SELECT MAX(ORNumber) FROM dbo.Sales WHERE TerminalId = @term), 0);

    INSERT dbo.GiftCertificates (GcNo, FaceValue, BranchCode, IssuedDate, ExpiryDate, Status, CancelReason) VALUES
        (N'ZZGC-001', 500, NULL,    '2099-01-01', '2099-12-31', 'Active', NULL),
        (N'ZZGC-002', 100, NULL,    '2099-01-01', '2099-04-30', 'Active', NULL),      -- expired on the day
        (N'ZZGC-003', 100, @other,  '2099-01-01', NULL,         'Active', NULL),      -- another branch's
        (N'ZZGC-004', 100, NULL,    '2099-01-01', NULL,         'Cancelled', N'lost');

    /* Sale A: 376.40 on GC 500 (pays 376.40, 123.60 forfeited) */
    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @a UNIQUEIDENTIFIER = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatExemptAmount)
    VALUES (1, @prod, 'B1', 'Test item', @cat, 1, 376.40, 376.40, 0, 376.40, 0, 1, 376.40, 376.40);
    INSERT @p VALUES (1, 'GC', 376.40, NULL, NULL, NULL, NULL);
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@a, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=376.40, @DiscountAmount=0,
        @VatExemptAmount=376.40, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=376.40,
        @TenderedAmount=376.40, @ChangeAmount=0, @Items=@i, @Payments=@p,
        @GiftCerts=N'[{"seqNo":1,"gcNo":" ZZGC-001 ","faceValue":500}]';
    INSERT @r SELECT 'G1a the GC payment keeps its number (trimmed), face value, and checks OK',
        CASE WHEN PaymentType = 'GC' AND GcNo = N'ZZGC-001' AND GcValue = 500 AND Amount = 376.40 AND GcCheck = 'OK' THEN 1 ELSE 0 END,
        CONCAT(GcNo, ' / ', GcValue, ' / ', Amount, ' / ', GcCheck)
    FROM dbo.SalePayments WHERE SaleUid = @a;
    INSERT @r SELECT 'G1b the GC is redeemed by that sale',
        CASE WHEN Status = 'Redeemed' AND RedeemedSaleUid = @a AND RedeemedBranch = @branch THEN 1 ELSE 0 END, Status
    FROM dbo.GiftCertificates WHERE GcNo = N'ZZGC-001';
    /* the till sends it again */
    EXEC dbo.sp_UpsertSale @SaleUid=@a, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=376.40, @DiscountAmount=0,
        @VatExemptAmount=376.40, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=376.40,
        @TenderedAmount=376.40, @ChangeAmount=0, @Items=@i, @Payments=@p,
        @GiftCerts=N'[{"seqNo":1,"gcNo":"ZZGC-001","faceValue":500}]';
    INSERT @r SELECT 'G1c a re-sync changes nothing (one payment, no review row)',
        CASE WHEN (SELECT COUNT(*) FROM dbo.SalePayments WHERE SaleUid = @a) = 1
              AND NOT EXISTS (SELECT 1 FROM dbo.AuditLogs WHERE Action = 'GC_REVIEW' AND Detail LIKE '%ZZGC-001%') THEN 1 ELSE 0 END, '';

    /* Sale B: the same GC again (rung up offline elsewhere) + cash with change from the cash */
    DECLARE @b UNIQUEIDENTIFIER = NEWID();
    DELETE @i; INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatExemptAmount)
    VALUES (1, @prod, 'B1', 'Test item', @cat, 1, 650, 650, 0, 650, 0, 1, 650, 650);
    DELETE @p; INSERT @p VALUES (1, 'GC', 500, NULL, NULL, NULL, NULL), (2, 'CASH', 200, NULL, NULL, NULL, NULL);
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@b, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=650, @DiscountAmount=0,
        @VatExemptAmount=650, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=650,
        @TenderedAmount=700, @ChangeAmount=50, @Items=@i, @Payments=@p,
        @GiftCerts=N'[{"seqNo":1,"gcNo":"ZZGC-001","faceValue":500}]';
    INSERT @r SELECT 'G1d a GC already used: the sale is saved, the payment flagged USED and audited',
        CASE WHEN p.GcCheck = 'USED' AND s.Status = 'Completed'
              AND EXISTS (SELECT 1 FROM dbo.AuditLogs WHERE Action = 'GC_REVIEW' AND Detail LIKE CONCAT(N'SI ', @si, N':%ZZGC-001 USED%'))
              AND (SELECT RedeemedSaleUid FROM dbo.GiftCertificates WHERE GcNo = N'ZZGC-001') = @a THEN 1 ELSE 0 END,
        p.GcCheck
    FROM dbo.SalePayments p JOIN dbo.Sales s ON s.SaleUid = p.SaleUid WHERE p.SaleUid = @b AND p.SeqNo = 1;

    /* Sale C: four GCs that aren't good: unknown, expired, another branch's, cancelled */
    DECLARE @c UNIQUEIDENTIFIER = NEWID();
    DELETE @i; INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatExemptAmount)
    VALUES (1, @prod, 'B1', 'Test item', @cat, 1, 400, 400, 0, 400, 0, 1, 400, 400);
    DELETE @p; INSERT @p VALUES (1, 'GC', 100, NULL, NULL, NULL, NULL), (2, 'GC', 100, NULL, NULL, NULL, NULL),
                                (3, 'GC', 100, NULL, NULL, NULL, NULL), (4, 'GC', 100, NULL, NULL, NULL, NULL);
    SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@c, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=400, @DiscountAmount=0,
        @VatExemptAmount=400, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=400,
        @TenderedAmount=400, @ChangeAmount=0, @Items=@i, @Payments=@p,
        @GiftCerts=N'[{"seqNo":1,"gcNo":"ZZGC-999","faceValue":100},{"seqNo":2,"gcNo":"ZZGC-002","faceValue":100},
                      {"seqNo":3,"gcNo":"ZZGC-003","faceValue":100},{"seqNo":4,"gcNo":"ZZGC-004","faceValue":100}]';
    INSERT @r SELECT 'G1e unknown / expired / other branch / cancelled are each flagged',
        CASE WHEN STRING_AGG(GcCheck, ',') WITHIN GROUP (ORDER BY SeqNo) = 'UNKNOWN,EXPIRED,BRANCH,CANCELLED' THEN 1 ELSE 0 END,
        STRING_AGG(GcCheck, ',') WITHIN GROUP (ORDER BY SeqNo)
    FROM dbo.SalePayments WHERE SaleUid = @c;
    INSERT @r SELECT 'G1f the expired and other-branch GCs were taken in (redeemed); the cancelled one stays cancelled',
        CASE WHEN STRING_AGG(Status, ',') WITHIN GROUP (ORDER BY GcNo) = 'Redeemed,Redeemed,Cancelled' THEN 1 ELSE 0 END,
        STRING_AGG(Status, ',') WITHIN GROUP (ORDER BY GcNo)
    FROM dbo.GiftCertificates WHERE GcNo IN (N'ZZGC-002', N'ZZGC-003', N'ZZGC-004');

    /* X-Read and Blind Close: the GC is not cash. Cash in: 200 - 50 change. */
    INSERT @r SELECT 'G1g X-Read: GC payments on their own line',
        CASE WHEN SUM(CASE WHEN p.PaymentType = 'GC' THEN p.Amount END) = 1276.40 THEN 1 ELSE 0 END,
        CONCAT('GC ', SUM(CASE WHEN p.PaymentType = 'GC' THEN p.Amount END))
    FROM dbo.SalePayments p JOIN dbo.Sales s ON s.SaleUid = p.SaleUid WHERE s.ShiftUid = @shift AND s.Status = 'Completed';
    EXEC dbo.sp_ProcessBlindClose @ShiftUid = @shift, @DeclaredCash = 1150, @DenominationsJson = N'{}';
    INSERT @r SELECT 'G1h blind close: expected cash leaves GCs out (1000 + 200 - 50)',
        CASE WHEN ExpectedCash = 1150 AND ShortOver = 0 THEN 1 ELSE 0 END, CONCAT('expected ', ExpectedCash)
    FROM dbo.ShiftClosings WHERE ShiftUid = @shift;

    /* End of Day (with accounting on, if this DB has it) */
    DECLARE @accOn BIT = 0;
    IF OBJECT_ID('acc.sp_SetupCompany', 'P') IS NOT NULL
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM acc.Settings WHERE CompanyId = 1)
            EXEC acc.sp_SetupCompany @CompanyId = 1, @TemplateCode = 'RETAIL', @StartDate = '2026-01-01';
        UPDATE acc.Settings SET IsEnabled = 1 WHERE CompanyId = 1;
        SET @accOn = 1;
    END
    EXEC dbo.sp_ProcessEndOfDay @TerminalId = @term, @BusinessDate = @d, @ClosedByUserId = @user, @ApprovedByUserId = @user;
    INSERT @r SELECT 'G1i Z-Read: GcSales = what the GCs paid; cash + card + GC - change = net',
        CASE WHEN GcSales = 1276.40 AND CashSales = 200 AND NetSales = 1426.40
              AND CashSales - 50 + CardSales + GcSales = NetSales THEN 1 ELSE 0 END,
        CONCAT('GC ', GcSales, ' cash ', CashSales, ' net ', NetSales)
    FROM dbo.ZReads WHERE TerminalId = @term AND BusinessDate = @d;
    IF @accOn = 1
        INSERT @r SELECT 'G1j ledger: the GCs go to Gift Certificates Outstanding, nothing to rounding',
            CASE WHEN SUM(CASE WHEN a.SystemKey = 'GIFT_CERT' THEN l.Debit END) = 1276.40
                  AND ISNULL(SUM(CASE WHEN a.SystemKey = 'ROUNDING' THEN l.Debit + l.Credit END), 0) = 0
                  AND SUM(l.Debit) = SUM(l.Credit) THEN 1 ELSE 0 END,
            CONCAT('GC dr ', SUM(CASE WHEN a.SystemKey = 'GIFT_CERT' THEN l.Debit END),
                   ' rounding ', ISNULL(SUM(CASE WHEN a.SystemKey = 'ROUNDING' THEN l.Debit + l.Credit END), 0))
        FROM acc.JournalEntries e JOIN acc.JournalLines l ON l.EntryUid = e.EntryUid
        JOIN acc.ChartOfAccounts a ON a.AccountId = l.AccountId
        WHERE e.SourceType = 'ZREAD'
          AND e.SourceUid = CONVERT(VARCHAR(50), (SELECT ZReadId FROM dbo.ZReads WHERE TerminalId = @term AND BusinessDate = @d));

    SELECT Test, Pass, Detail FROM @r;
    ROLLBACK;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'G1 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' line ', ERROR_LINE(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO

/* G2. A void gives the GC back (offline void re-synced, and the release proc the void endpoint calls). */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    DECLARE @term INT, @branch VARCHAR(10), @user INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId);
    SET @term = NULL;
    SELECT TOP 1 @term = TerminalId, @branch = BranchCode FROM dbo.Terminals t
    WHERE NOT EXISTS (SELECT 1 FROM dbo.Shifts s WHERE s.TerminalId = t.TerminalId
        AND NOT EXISTS (SELECT 1 FROM dbo.ZReads z WHERE z.TerminalId = s.TerminalId AND z.BusinessDate = s.BusinessDate))
    ORDER BY TerminalId;
    IF @term IS NULL
    BEGIN
        SELECT TOP 1 @branch = BranchCode FROM dbo.Branches WHERE IsActive = 1 ORDER BY BranchCode;
        INSERT dbo.Terminals (BranchCode, TerminalCode, TerminalName) VALUES (@branch, 'ZZ-TEST', N'ZZTEST terminal');
        SET @term = SCOPE_IDENTITY();
    END
    UPDATE dbo.Terminals SET PostToErp = 0 WHERE TerminalId = @term;
    DECLARE @prod INT, @cat INT; SELECT TOP 1 @prod = ProductId, @cat = CategoryId FROM dbo.Products ORDER BY ProductId;
    DECLARE @d DATE = '2099-05-02', @shift UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
    INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@shift, @branch, @term, @user, @d, 1000, @now);
    DECLARE @si BIGINT = ISNULL((SELECT MAX(ORNumber) FROM dbo.Sales WHERE TerminalId = @term), 0) + 1;
    INSERT dbo.GiftCertificates (GcNo, FaceValue, IssuedDate) VALUES (N'ZZGC-101', 200, '2099-01-01');

    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @a UNIQUEIDENTIFIER = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice,
               LineDiscount, LineTotal, IsVatable, IsDiscountable, NetAmount, VatExemptAmount)
    VALUES (1, @prod, 'B1', 'Test item', @cat, 1, 150, 150, 0, 150, 0, 1, 150, 150);
    INSERT @p VALUES (1, 'GC', 150, NULL, NULL, NULL, NULL);
    EXEC dbo.sp_UpsertSale @SaleUid=@a, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=150, @DiscountAmount=0,
        @VatExemptAmount=150, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=150,
        @TenderedAmount=150, @ChangeAmount=0, @Items=@i, @Payments=@p,
        @GiftCerts=N'[{"seqNo":1,"gcNo":"ZZGC-101","faceValue":200}]';
    /* voided offline, re-synced */
    EXEC dbo.sp_UpsertSale @SaleUid=@a, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=150, @DiscountAmount=0,
        @VatExemptAmount=150, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=150,
        @TenderedAmount=150, @ChangeAmount=0, @Status='Voided', @Items=@i, @Payments=@p,
        @GiftCerts=N'[{"seqNo":1,"gcNo":"ZZGC-101","faceValue":200}]';
    INSERT @r SELECT 'G2a a sale voided offline gives its GC back (Active, audited)',
        CASE WHEN Status = 'Active' AND RedeemedSaleUid IS NULL
              AND EXISTS (SELECT 1 FROM dbo.AuditLogs WHERE Action = 'GC_RELEASED' AND Detail LIKE '%ZZGC-101%') THEN 1 ELSE 0 END, Status
    FROM dbo.GiftCertificates WHERE GcNo = N'ZZGC-101';

    /* a sale voided before it ever synced never redeems it */
    DECLARE @b UNIQUEIDENTIFIER = NEWID(); SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@b, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=150, @DiscountAmount=0,
        @VatExemptAmount=150, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=150,
        @TenderedAmount=150, @ChangeAmount=0, @Status='Voided', @Items=@i, @Payments=@p,
        @GiftCerts=N'[{"seqNo":1,"gcNo":"ZZGC-101","faceValue":200}]';
    INSERT @r SELECT 'G2b a sale voided before it synced leaves the GC Active',
        CASE WHEN Status = 'Active' THEN 1 ELSE 0 END, Status FROM dbo.GiftCertificates WHERE GcNo = N'ZZGC-101';

    /* the online void: the endpoint sets Voided, then calls the release proc */
    DECLARE @c UNIQUEIDENTIFIER = NEWID(); SET @si += 1;
    EXEC dbo.sp_UpsertSale @SaleUid=@c, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=@si, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=150, @DiscountAmount=0,
        @VatExemptAmount=150, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=150,
        @TenderedAmount=150, @ChangeAmount=0, @Items=@i, @Payments=@p,
        @GiftCerts=N'[{"seqNo":1,"gcNo":"ZZGC-101","faceValue":200}]';
    INSERT @r SELECT 'G2c the GC can be used again after the void',
        CASE WHEN Status = 'Redeemed' AND RedeemedSaleUid = @c THEN 1 ELSE 0 END, Status
    FROM dbo.GiftCertificates WHERE GcNo = N'ZZGC-101';
    UPDATE dbo.Sales SET Status = 'Voided', VoidedBy = @user, VoidedAt = SYSDATETIME() WHERE SaleUid = @c;
    EXEC dbo.sp_GiftCertRelease @SaleUid = @c, @UserId = @user;
    INSERT @r SELECT 'G2d the release proc puts it back',
        CASE WHEN Status = 'Active' THEN 1 ELSE 0 END, Status FROM dbo.GiftCertificates WHERE GcNo = N'ZZGC-101';

    /* only CASH, CARD and GC are payment types */
    BEGIN TRY
        INSERT dbo.SalePayments (SaleUid, BranchCode, SeqNo, PaymentType, Amount) VALUES (@c, @branch, 9, 'XX', 1);
        INSERT @r VALUES ('G2e an unknown payment type is refused', 0, 'inserted');
    END TRY
    BEGIN CATCH
        INSERT @r VALUES ('G2e an unknown payment type is refused', CASE WHEN ERROR_NUMBER() = 547 THEN 1 ELSE 0 END, ERROR_MESSAGE());
    END CATCH

    SELECT Test, Pass, Detail FROM @r;
    ROLLBACK;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'G2 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' line ', ERROR_LINE(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO

/* G3. Nothing from these tests survived. */
SELECT 'G3 nothing left behind' AS Test,
    CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.Sales WHERE BusinessDate IN ('2099-05-01', '2099-05-02'))
          AND NOT EXISTS (SELECT 1 FROM dbo.GiftCertificates WHERE GcNo LIKE N'ZZGC-%') THEN 1 ELSE 0 END AS Pass, '' AS Detail;
GO
