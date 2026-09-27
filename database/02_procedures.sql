/* =====================================================================
   TabletPOS v2 — Stored Procedures
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

/* ---------- Effective price list for a branch (base ?? override) ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_GetPriceList
    @BranchCode VARCHAR(10)
AS
BEGIN
    SET NOCOUNT ON;
    SELECT p.ProductId, p.Barcode, p.ProductName, p.CategoryId, c.CategoryName, p.Unit,
           p.BasePrice, COALESCE(pp.Price, p.BasePrice) AS Price,
           CAST(CASE WHEN pp.Price IS NULL THEN 0 ELSE 1 END AS BIT) AS HasOverride,
           p.IsVatable, p.IsDiscountable, p.AllowPriceEdit, p.IsActive, p.ImageUrl
    FROM dbo.Products p
    JOIN dbo.Categories c ON c.CategoryId = p.CategoryId
    LEFT JOIN dbo.ProductPrices pp
           ON pp.ProductId = p.ProductId AND pp.BranchCode = @BranchCode
    WHERE p.IsActive = 1
    ORDER BY c.CategoryName, p.ProductName;
END
GO

/* ---------- Save branch overrides for one product (replace set) ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_SaveProductPrices
    @ProductId INT, @UpdatedBy INT, @Prices dbo.TVP_BranchPrice READONLY
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    BEGIN TRAN;
        DELETE pp FROM dbo.ProductPrices pp
        WHERE pp.ProductId = @ProductId
          AND NOT EXISTS (SELECT 1 FROM @Prices x WHERE x.BranchCode = pp.BranchCode);

        MERGE dbo.ProductPrices AS t
        USING (SELECT BranchCode, Price FROM @Prices) AS s
           ON t.ProductId = @ProductId AND t.BranchCode = s.BranchCode
        WHEN MATCHED AND t.Price <> s.Price
            THEN UPDATE SET Price = s.Price, UpdatedBy = @UpdatedBy, UpdatedAt = SYSDATETIME()
        WHEN NOT MATCHED BY TARGET
            THEN INSERT (ProductId, BranchCode, Price, UpdatedBy)
                 VALUES (@ProductId, s.BranchCode, s.Price, @UpdatedBy);

        UPDATE dbo.Products SET RowVersionTs = SYSDATETIME() WHERE ProductId = @ProductId;
    COMMIT;
END
GO

/* ---------- Bulk price adjustment ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_BulkPriceUpdate
    @BranchCode VARCHAR(10),      -- NULL = adjust BasePrice for all branches
    @CategoryId INT = NULL,
    @Mode VARCHAR(20),            -- PERCENT | AMOUNT | SETBASE
    @Value DECIMAL(18,4) = 0,
    @UpdatedBy INT
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    BEGIN TRAN;
    IF @BranchCode IS NULL
    BEGIN
        UPDATE p SET BasePrice = CASE
                WHEN @Mode = 'PERCENT' THEN ROUND(p.BasePrice * (1 + @Value / 100.0), 2)
                WHEN @Mode = 'AMOUNT'  THEN ROUND(p.BasePrice + @Value, 2)
                ELSE p.BasePrice END,
            RowVersionTs = SYSDATETIME()
        FROM dbo.Products p
        WHERE p.IsActive = 1 AND (@CategoryId IS NULL OR p.CategoryId = @CategoryId);
    END
    ELSE IF @Mode = 'SETBASE'
    BEGIN
        DELETE pp FROM dbo.ProductPrices pp
        JOIN dbo.Products p ON p.ProductId = pp.ProductId
        WHERE pp.BranchCode = @BranchCode AND (@CategoryId IS NULL OR p.CategoryId = @CategoryId);
    END
    ELSE
    BEGIN
        MERGE dbo.ProductPrices AS t
        USING (SELECT p.ProductId,
                      CASE WHEN @Mode = 'PERCENT'
                           THEN ROUND(COALESCE(pp.Price, p.BasePrice) * (1 + @Value / 100.0), 2)
                           ELSE ROUND(COALESCE(pp.Price, p.BasePrice) + @Value, 2) END AS NewPrice
               FROM dbo.Products p
               LEFT JOIN dbo.ProductPrices pp
                      ON pp.ProductId = p.ProductId AND pp.BranchCode = @BranchCode
               WHERE p.IsActive = 1 AND (@CategoryId IS NULL OR p.CategoryId = @CategoryId)) AS s
           ON t.ProductId = s.ProductId AND t.BranchCode = @BranchCode
        WHEN MATCHED THEN UPDATE SET Price = s.NewPrice, UpdatedBy = @UpdatedBy, UpdatedAt = SYSDATETIME()
        WHEN NOT MATCHED BY TARGET THEN
            INSERT (ProductId, BranchCode, Price, UpdatedBy)
            VALUES (s.ProductId, @BranchCode, s.NewPrice, @UpdatedBy);
    END
    DECLARE @rows INT = @@ROWCOUNT;
    COMMIT;
    SELECT @rows AS RowsAffected;
END
GO

/* ---------- Copy one branch's price list onto another ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_CopyBranchPrices
    @FromBranch VARCHAR(10), @ToBranch VARCHAR(10), @UpdatedBy INT
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    BEGIN TRAN;
        DELETE FROM dbo.ProductPrices WHERE BranchCode = @ToBranch;
        INSERT INTO dbo.ProductPrices (ProductId, BranchCode, Price, UpdatedBy)
        SELECT ProductId, @ToBranch, Price, @UpdatedBy
        FROM dbo.ProductPrices WHERE BranchCode = @FromBranch;
    COMMIT;
END
GO

/* ---------- OR number blocks ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_AllocateORRange
    @TerminalId INT, @BlockSize INT = 500
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    BEGIN TRAN;
        DECLARE @Branch VARCHAR(10) = (SELECT BranchCode FROM dbo.Terminals WHERE TerminalId = @TerminalId);
        DECLARE @maxEnd BIGINT = ISNULL(
            (SELECT MAX(RangeEnd) FROM dbo.ORRanges WITH (UPDLOCK, HOLDLOCK) WHERE TerminalId = @TerminalId),
            (SELECT ISNULL(MAX(RangeEnd), 100000) FROM dbo.ORRanges WITH (UPDLOCK, HOLDLOCK) WHERE BranchCode = @Branch));
        INSERT INTO dbo.ORRanges (BranchCode, TerminalId, RangeStart, RangeEnd)
        VALUES (@Branch, @TerminalId, @maxEnd + 1, @maxEnd + @BlockSize);
        SELECT RangeStart, RangeEnd FROM dbo.ORRanges WHERE ORRangeId = SCOPE_IDENTITY();
    COMMIT;
END
GO

/* ---------- Shifts ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_OpenShift
    @ShiftUid UNIQUEIDENTIFIER, @BranchCode VARCHAR(10), @TerminalId INT,
    @CashierUserId INT, @BusinessDate DATE, @CashBegin DECIMAL(18,2), @OpenedAt DATETIME2
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM dbo.Shifts WHERE ShiftUid = @ShiftUid) RETURN;
    IF EXISTS (SELECT 1 FROM dbo.ZReads WHERE TerminalId = @TerminalId AND BusinessDate = @BusinessDate)
        THROW 51010, 'End of Day already processed for this terminal and date.', 1;
    IF EXISTS (SELECT 1 FROM dbo.Shifts WHERE TerminalId = @TerminalId AND Status = 'Open')
        THROW 51000, 'Terminal already has an open shift.', 1;
    INSERT INTO dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@ShiftUid, @BranchCode, @TerminalId, @CashierUserId, @BusinessDate, @CashBegin, @OpenedAt);
END
GO

/* ---------- Idempotent sale upsert (offline queue replay-safe) ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_UpsertSale
    @SaleUid UNIQUEIDENTIFIER, @ShiftUid UNIQUEIDENTIFIER, @BranchCode VARCHAR(10),
    @TerminalId INT, @CashierUserId INT, @ORNumber BIGINT, @BusinessDate DATE,
    @SaleDateTime DATETIME2, @GrossAmount DECIMAL(18,2), @DiscountAmount DECIMAL(18,2),
    @VatExemptAmount DECIMAL(18,2), @VatableAmount DECIMAL(18,2), @VatAmount DECIMAL(18,2),
    @ZeroRatedAmount DECIMAL(18,2), @NetAmount DECIMAL(18,2), @TenderedAmount DECIMAL(18,2),
    @ChangeAmount DECIMAL(18,2), @DiscountCode VARCHAR(10) = NULL,
    @DiscountCtrlNo NVARCHAR(60) = NULL, @DiscountName NVARCHAR(120) = NULL,
    @VatAdjustment DECIMAL(18,2) = 0, @DinerCount INT = NULL, @SeniorCount INT = NULL,
    @Status VARCHAR(12) = 'Completed',
    @Items dbo.TVP_SaleItem READONLY, @Payments dbo.TVP_SalePayment READONLY
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    BEGIN TRAN;
        IF EXISTS (SELECT 1 FROM dbo.ZReads WHERE TerminalId = @TerminalId AND BusinessDate = @BusinessDate)
        BEGIN
            ROLLBACK;
            THROW 51011, 'Business date already closed by End of Day. Sale rejected.', 1;
        END

        IF EXISTS (SELECT 1 FROM dbo.Sales WHERE SaleUid = @SaleUid)
        BEGIN
            UPDATE dbo.Sales SET Status = @Status
            WHERE SaleUid = @SaleUid AND Status = 'Completed' AND @Status <> 'Completed';
            COMMIT; RETURN;
        END

        INSERT INTO dbo.Sales (SaleUid, ShiftUid, BranchCode, TerminalId, CashierUserId, ORNumber,
            BusinessDate, SaleDateTime, GrossAmount, DiscountAmount, VatExemptAmount, VatableAmount,
            VatAmount, ZeroRatedAmount, NetAmount, TenderedAmount, ChangeAmount,
            DiscountCode, DiscountCtrlNo, DiscountName, VatAdjustment, DinerCount, SeniorCount, Status)
        VALUES (@SaleUid, @ShiftUid, @BranchCode, @TerminalId, @CashierUserId, @ORNumber,
            @BusinessDate, @SaleDateTime, @GrossAmount, @DiscountAmount, @VatExemptAmount, @VatableAmount,
            @VatAmount, @ZeroRatedAmount, @NetAmount, @TenderedAmount, @ChangeAmount,
            @DiscountCode, @DiscountCtrlNo, @DiscountName, @VatAdjustment, @DinerCount, @SeniorCount, @Status);

        INSERT INTO dbo.SaleItems (SaleUid, BranchCode, [LineNo], ProductId, Barcode, ProductName,
            CategoryId, Quantity, UnitPrice, OrigUnitPrice, LineDiscount, LineTotal, IsVatable, IsDiscountable)
        SELECT @SaleUid, @BranchCode, [LineNo], ProductId, Barcode, ProductName, CategoryId,
               Quantity, UnitPrice, OrigUnitPrice, LineDiscount, LineTotal, IsVatable, IsDiscountable
        FROM @Items;

        INSERT INTO dbo.SalePayments (SaleUid, BranchCode, SeqNo, PaymentType, Amount,
            CardNo, CardBank, CardRefNo, CardName)
        SELECT @SaleUid, @BranchCode, SeqNo, PaymentType, Amount,
               CardNo, CardBank, CardRefNo, CardName
        FROM @Payments;
    COMMIT;
END
GO

/* ---------- BLIND CLOSE: computes Short/Over server-side, returns nothing ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_ProcessBlindClose
    @ShiftUid UNIQUEIDENTIFIER, @DeclaredCash DECIMAL(18,2), @DenominationsJson NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    BEGIN TRAN;
        DECLARE @CashBegin DECIMAL(18,2), @Status VARCHAR(15), @Branch VARCHAR(10);
        SELECT @CashBegin = CashBegin, @Status = Status, @Branch = BranchCode
        FROM dbo.Shifts WITH (UPDLOCK) WHERE ShiftUid = @ShiftUid;

        IF @CashBegin IS NULL THROW 51001, 'Shift not found.', 1;
        IF @Status <> 'Open'  THROW 51002, 'Shift is not open.', 1;

        /* Only CASH tenders count toward the drawer. Card sales are excluded. */
        DECLARE @CashSales DECIMAL(18,2) = ISNULL((
            SELECT SUM(sp.Amount) FROM dbo.SalePayments sp
            JOIN dbo.Sales s ON s.SaleUid = sp.SaleUid
            WHERE s.ShiftUid = @ShiftUid AND s.Status = 'Completed' AND sp.PaymentType = 'CASH'), 0);
        DECLARE @CardSales DECIMAL(18,2) = ISNULL((
            SELECT SUM(sp.Amount) FROM dbo.SalePayments sp
            JOIN dbo.Sales s ON s.SaleUid = sp.SaleUid
            WHERE s.ShiftUid = @ShiftUid AND s.Status = 'Completed' AND sp.PaymentType = 'CARD'), 0);
        DECLARE @Change DECIMAL(18,2) = ISNULL((
            SELECT SUM(ChangeAmount) FROM dbo.Sales
            WHERE ShiftUid = @ShiftUid AND Status = 'Completed'), 0);

        DECLARE @Expected DECIMAL(18,2) = @CashBegin + @CashSales - @Change;

        INSERT INTO dbo.ShiftClosings (ShiftUid, BranchCode, DeclaredCash, ExpectedCash,
            CashSales, CardSales, ShortOver, DenominationsJson)
        VALUES (@ShiftUid, @Branch, @DeclaredCash, @Expected,
            @CashSales, @CardSales, @DeclaredCash - @Expected, @DenominationsJson);

        UPDATE dbo.Shifts SET Status = 'BlindClosed', ClosedAt = SYSDATETIME() WHERE ShiftUid = @ShiftUid;
    COMMIT;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_GetShiftVariance   /* Supervisor/Admin only */
    @ShiftUid UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.ShiftUid, s.BranchCode, t.TerminalCode, u.FullName AS Cashier, s.BusinessDate,
           s.CashBegin, c.CashSales, c.CardSales, c.DeclaredCash, c.ExpectedCash, c.ShortOver,
           c.DenominationsJson, c.ClosedAt
    FROM dbo.ShiftClosings c
    JOIN dbo.Shifts s ON s.ShiftUid = c.ShiftUid
    JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    JOIN dbo.Users u ON u.UserId = s.CashierUserId
    WHERE c.ShiftUid = @ShiftUid;
END
GO

/* ---------- X-READ ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_rpt_XRead
    @ShiftUid UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BranchCode, b.BranchName, t.TerminalCode, u.FullName AS Cashier,
        s.BusinessDate, s.CashBegin, s.OpenedAt,
        COUNT(CASE WHEN sa.Status='Completed' THEN 1 END) AS TxnCount,
        COUNT(CASE WHEN sa.Status='Voided'    THEN 1 END) AS VoidCount,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.GrossAmount     END),0) AS GrossSales,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.DiscountAmount  END),0) AS TotalDiscounts,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.NetAmount       END),0) AS NetSales,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.VatableAmount   END),0) AS VatableAmount,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.VatAmount       END),0) AS VatAmount,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.VatExemptAmount END),0) AS VatExemptAmount,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' THEN sa.ZeroRatedAmount END),0) AS ZeroRatedAmount,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' AND sa.DiscountCode='SENIOR' THEN sa.DiscountAmount END),0) AS DiscSenior,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' AND sa.DiscountCode='PWD'    THEN sa.DiscountAmount END),0) AS DiscPwd,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' AND sa.DiscountCode='NAAC'   THEN sa.DiscountAmount END),0) AS DiscNaac,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' AND sa.DiscountCode='MOV'    THEN sa.DiscountAmount END),0) AS DiscMov,
        ISNULL(SUM(CASE WHEN sa.Status='Completed' AND sa.DiscountCode='SOLO'   THEN sa.DiscountAmount END),0) AS DiscSolo,
        ISNULL((SELECT SUM(p.Amount) FROM dbo.SalePayments p JOIN dbo.Sales x ON x.SaleUid=p.SaleUid
                WHERE x.ShiftUid=@ShiftUid AND x.Status='Completed' AND p.PaymentType='CASH'),0) AS CashSales,
        ISNULL((SELECT SUM(p.Amount) FROM dbo.SalePayments p JOIN dbo.Sales x ON x.SaleUid=p.SaleUid
                WHERE x.ShiftUid=@ShiftUid AND x.Status='Completed' AND p.PaymentType='CARD'),0) AS CardSales,
        MIN(CASE WHEN sa.Status='Completed' THEN sa.ORNumber END) AS BeginningOR,
        MAX(CASE WHEN sa.Status='Completed' THEN sa.ORNumber END) AS EndingOR
    FROM dbo.Shifts s
    JOIN dbo.Branches b ON b.BranchCode = s.BranchCode
    JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    JOIN dbo.Users u ON u.UserId = s.CashierUserId
    LEFT JOIN dbo.Sales sa ON sa.ShiftUid = s.ShiftUid
    WHERE s.ShiftUid = @ShiftUid
    GROUP BY s.BranchCode, b.BranchName, t.TerminalCode, u.FullName, s.BusinessDate, s.CashBegin, s.OpenedAt;
END
GO

/* ---------- END OF DAY / Z-READ ----------
   Callable by cashier (own terminal), by the same cashier signing back in,
   or by Admin remotely. Always requires an approver (enforced in the API). */
CREATE OR ALTER PROCEDURE dbo.sp_ProcessEndOfDay
    @TerminalId INT, @BusinessDate DATE,
    @ClosedByUserId INT, @ApprovedByUserId INT, @Remarks NVARCHAR(200) = NULL
AS
BEGIN
    SET NOCOUNT ON; SET XACT_ABORT ON;
    BEGIN TRAN;
        IF EXISTS (SELECT 1 FROM dbo.ZReads WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate)
            THROW 51003, 'End of Day already processed for this terminal and date.', 1;
        IF EXISTS (SELECT 1 FROM dbo.Shifts WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate AND Status='Open')
            THROW 51004, 'An open shift exists. Blind-close all shifts first.', 1;

        DECLARE @Branch VARCHAR(10), @Old DECIMAL(18,2), @Z INT;
        SELECT @Branch = BranchCode, @Old = GrandTotalSales, @Z = LastZCounter + 1
        FROM dbo.Terminals WITH (UPDLOCK) WHERE TerminalId = @TerminalId;

        DECLARE @Net DECIMAL(18,2) = ISNULL((SELECT SUM(NetAmount) FROM dbo.Sales
            WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate AND Status='Completed'), 0);

        INSERT INTO dbo.ZReads (BranchCode, TerminalId, BusinessDate, ZCounter,
            GrossSales, TotalDiscounts, NetSales, VatableAmount, VatAmount, VatExemptAmount, ZeroRatedAmount,
            CashSales, CardSales, DiscSenior, DiscPwd, DiscNaac, DiscMov, DiscSolo,
            TxnCount, VoidCount, VoidAmount, BeginningOR, EndingOR,
            OldGrandTotal, NewGrandTotal, ClosedByUserId, ApprovedByUserId, Remarks)
        SELECT @Branch, @TerminalId, @BusinessDate, @Z,
            ISNULL(SUM(CASE WHEN Status='Completed' THEN GrossAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' THEN DiscountAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' THEN NetAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' THEN VatableAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' THEN VatAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' THEN VatExemptAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' THEN ZeroRatedAmount END),0),
            ISNULL((SELECT SUM(p.Amount) FROM dbo.SalePayments p JOIN dbo.Sales x ON x.SaleUid=p.SaleUid
                    WHERE x.TerminalId=@TerminalId AND x.BusinessDate=@BusinessDate
                      AND x.Status='Completed' AND p.PaymentType='CASH'),0),
            ISNULL((SELECT SUM(p.Amount) FROM dbo.SalePayments p JOIN dbo.Sales x ON x.SaleUid=p.SaleUid
                    WHERE x.TerminalId=@TerminalId AND x.BusinessDate=@BusinessDate
                      AND x.Status='Completed' AND p.PaymentType='CARD'),0),
            ISNULL(SUM(CASE WHEN Status='Completed' AND DiscountCode='SENIOR' THEN DiscountAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' AND DiscountCode='PWD'    THEN DiscountAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' AND DiscountCode='NAAC'   THEN DiscountAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' AND DiscountCode='MOV'    THEN DiscountAmount END),0),
            ISNULL(SUM(CASE WHEN Status='Completed' AND DiscountCode='SOLO'   THEN DiscountAmount END),0),
            COUNT(CASE WHEN Status='Completed' THEN 1 END),
            COUNT(CASE WHEN Status='Voided' THEN 1 END),
            ISNULL(SUM(CASE WHEN Status='Voided' THEN NetAmount END),0),
            MIN(CASE WHEN Status='Completed' THEN ORNumber END),
            MAX(CASE WHEN Status='Completed' THEN ORNumber END),
            @Old, @Old + @Net, @ClosedByUserId, @ApprovedByUserId, @Remarks
        FROM dbo.Sales WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate;

        UPDATE dbo.Terminals
        SET GrandTotalSales = @Old + @Net, LastZCounter = @Z
        WHERE TerminalId = @TerminalId;

        UPDATE dbo.Shifts SET Status='Locked'
        WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate;

        SELECT z.*, t.TerminalCode, b.BranchName,
               cu.FullName AS ClosedByName, au.FullName AS ApprovedByName
        FROM dbo.ZReads z
        JOIN dbo.Terminals t ON t.TerminalId = z.TerminalId
        JOIN dbo.Branches b ON b.BranchCode = z.BranchCode
        JOIN dbo.Users cu ON cu.UserId = z.ClosedByUserId
        JOIN dbo.Users au ON au.UserId = z.ApprovedByUserId
        WHERE z.TerminalId=@TerminalId AND z.BusinessDate=@BusinessDate;
    COMMIT;
END
GO

/* ---------- Terminal day state: drives login gating and the EOD-only screen ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_GetTerminalDayState
    @TerminalId INT, @BusinessDate DATE
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @openShifts INT = (SELECT COUNT(*) FROM dbo.Shifts
        WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate AND Status='Open');
    DECLARE @closedShifts INT = (SELECT COUNT(*) FROM dbo.Shifts
        WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate AND Status='BlindClosed');
    DECLARE @eod BIT = CASE WHEN EXISTS (SELECT 1 FROM dbo.ZReads
        WHERE TerminalId=@TerminalId AND BusinessDate=@BusinessDate) THEN 1 ELSE 0 END;

    SELECT
        CASE WHEN @eod = 1 THEN 'eodDone'
             WHEN @openShifts = 0 AND @closedShifts > 0 THEN 'eodPending'
             ELSE 'open' END AS DayState,
        @openShifts AS OpenShifts, @closedShifts AS ClosedShifts, @eod AS EodDone,
        (SELECT TOP 1 u.FullName FROM dbo.Shifts s JOIN dbo.Users u ON u.UserId=s.CashierUserId
         WHERE s.TerminalId=@TerminalId AND s.BusinessDate=@BusinessDate
         ORDER BY s.ClosedAt DESC) AS LastCashier;
END
GO

/* Terminals with a business date still awaiting EOD (admin recovery list) */
CREATE OR ALTER PROCEDURE dbo.sp_GetPendingEod
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BranchCode, t.TerminalId, t.TerminalCode, s.BusinessDate,
           COUNT(*) AS ShiftCount,
           MAX(u.FullName) AS LastCashier,
           MAX(s.ClosedAt) AS LastClosedAt
    FROM dbo.Shifts s
    JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    JOIN dbo.Users u ON u.UserId = s.CashierUserId
    WHERE s.Status = 'BlindClosed'
      AND NOT EXISTS (SELECT 1 FROM dbo.ZReads z
                      WHERE z.TerminalId = s.TerminalId AND z.BusinessDate = s.BusinessDate)
    GROUP BY s.BranchCode, t.TerminalId, t.TerminalCode, s.BusinessDate
    ORDER BY s.BusinessDate, s.BranchCode;
END
GO

/* ============================ REPORTS ============================ */

CREATE OR ALTER PROCEDURE dbo.sp_rpt_SalesSummary
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL, @TerminalId INT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BusinessDate, s.BranchCode, t.TerminalCode,
        COUNT(CASE WHEN s.Status='Completed' THEN 1 END) AS TxnCount,
        ISNULL(SUM(CASE WHEN s.Status='Completed' THEN s.GrossAmount END),0)    AS GrossSales,
        ISNULL(SUM(CASE WHEN s.Status='Completed' THEN s.DiscountAmount END),0) AS Discounts,
        ISNULL(SUM(CASE WHEN s.Status='Completed' THEN s.NetAmount END),0)      AS NetSales,
        ISNULL(SUM(CASE WHEN s.Status='Completed' THEN s.VatAmount END),0)      AS VatAmount
    FROM dbo.Sales s JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
      AND (@TerminalId IS NULL OR s.TerminalId = @TerminalId)
    GROUP BY s.BusinessDate, s.BranchCode, t.TerminalCode
    ORDER BY s.BusinessDate, s.BranchCode;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_BranchComparison
    @DateFrom DATE, @DateTo DATE
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BranchCode, b.BranchName,
        COUNT(CASE WHEN s.Status='Completed' THEN 1 END) AS TxnCount,
        ISNULL(SUM(CASE WHEN s.Status='Completed' THEN s.GrossAmount END),0)    AS GrossSales,
        ISNULL(SUM(CASE WHEN s.Status='Completed' THEN s.DiscountAmount END),0) AS Discounts,
        ISNULL(SUM(CASE WHEN s.Status='Completed' THEN s.NetAmount END),0)      AS NetSales,
        ISNULL(AVG(CASE WHEN s.Status='Completed' THEN s.NetAmount END),0)      AS AvgBasket
    FROM dbo.Sales s JOIN dbo.Branches b ON b.BranchCode = s.BranchCode
    WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo
    GROUP BY s.BranchCode, b.BranchName ORDER BY NetSales DESC;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_SalesDetails
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL, @TerminalId INT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BusinessDate, s.BranchCode, t.TerminalCode, s.ORNumber, s.SaleDateTime,
           u.FullName AS Cashier, s.GrossAmount, s.DiscountAmount, s.DiscountCode,
           s.NetAmount, s.Status,
           STUFF((SELECT ', ' + p.PaymentType FROM dbo.SalePayments p
                  WHERE p.SaleUid = s.SaleUid FOR XML PATH('')), 1, 2, '') AS Payments
    FROM dbo.Sales s
    JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    JOIN dbo.Users u ON u.UserId = s.CashierUserId
    WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
      AND (@TerminalId IS NULL OR s.TerminalId = @TerminalId)
    ORDER BY s.SaleDateTime;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_PaymentBreakdown
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BusinessDate, s.BranchCode,
        ISNULL(SUM(CASE WHEN p.PaymentType='CASH' THEN p.Amount END),0) AS CashAmount,
        ISNULL(SUM(CASE WHEN p.PaymentType='CARD' THEN p.Amount END),0) AS CardAmount,
        COUNT(CASE WHEN p.PaymentType='CARD' THEN 1 END) AS CardTxns,
        ISNULL(SUM(p.Amount),0) AS TotalTendered
    FROM dbo.SalePayments p JOIN dbo.Sales s ON s.SaleUid = p.SaleUid
    WHERE s.Status='Completed' AND s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
    GROUP BY s.BusinessDate, s.BranchCode ORDER BY s.BusinessDate;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_CardTransactions
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BusinessDate, s.BranchCode, s.ORNumber, p.CardBank, p.CardNo,
           p.CardName, p.CardRefNo, p.Amount
    FROM dbo.SalePayments p JOIN dbo.Sales s ON s.SaleUid = p.SaleUid
    WHERE p.PaymentType='CARD' AND s.Status='Completed'
      AND s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
    ORDER BY s.BusinessDate, s.ORNumber;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_Discounts
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BusinessDate, s.BranchCode, t.TerminalCode, s.ORNumber, s.DiscountCode,
           s.DiscountCtrlNo, s.DiscountName, s.GrossAmount, s.DiscountAmount, s.NetAmount
    FROM dbo.Sales s JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
    WHERE s.DiscountAmount > 0 AND s.Status='Completed'
      AND s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
    ORDER BY s.BusinessDate, s.ORNumber;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_GroupCategory
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT si.BranchCode, c.CategoryName,
           SUM(si.Quantity) AS TotalQty, SUM(si.LineTotal) AS TotalAmount
    FROM dbo.SaleItems si
    JOIN dbo.Sales s ON s.SaleUid = si.SaleUid AND s.Status='Completed'
    JOIN dbo.Categories c ON c.CategoryId = si.CategoryId
    WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR si.BranchCode = @BranchCode)
    GROUP BY si.BranchCode, c.CategoryName ORDER BY TotalAmount DESC;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_GroupItems
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT si.BranchCode, si.Barcode, si.ProductName, c.CategoryName,
           SUM(si.Quantity) AS TotalQty, SUM(si.LineTotal) AS TotalAmount
    FROM dbo.SaleItems si
    JOIN dbo.Sales s ON s.SaleUid = si.SaleUid AND s.Status='Completed'
    JOIN dbo.Categories c ON c.CategoryId = si.CategoryId
    WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR si.BranchCode = @BranchCode)
    GROUP BY si.BranchCode, si.Barcode, si.ProductName, c.CategoryName
    ORDER BY TotalAmount DESC;
END
GO

/* ---------- Email report support: Blind Close (per shift) and EOD (per terminal/day) ---------- */
CREATE OR ALTER PROCEDURE dbo.sp_rpt_GroupItemsByShift
    @ShiftUid UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT si.Barcode, si.ProductName, c.CategoryName,
           SUM(si.Quantity) AS TotalQty, SUM(si.LineTotal) AS TotalAmount
    FROM dbo.SaleItems si
    JOIN dbo.Sales s ON s.SaleUid = si.SaleUid AND s.Status = 'Completed'
    JOIN dbo.Categories c ON c.CategoryId = si.CategoryId
    WHERE s.ShiftUid = @ShiftUid
    GROUP BY si.Barcode, si.ProductName, c.CategoryName
    ORDER BY TotalAmount DESC;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_GroupItemsByTerminalDate
    @TerminalId INT, @BusinessDate DATE
AS
BEGIN
    SET NOCOUNT ON;
    SELECT si.Barcode, si.ProductName, c.CategoryName,
           SUM(si.Quantity) AS TotalQty, SUM(si.LineTotal) AS TotalAmount
    FROM dbo.SaleItems si
    JOIN dbo.Sales s ON s.SaleUid = si.SaleUid AND s.Status = 'Completed'
    JOIN dbo.Categories c ON c.CategoryId = si.CategoryId
    WHERE s.TerminalId = @TerminalId AND s.BusinessDate = @BusinessDate
    GROUP BY si.Barcode, si.ProductName, c.CategoryName
    ORDER BY TotalAmount DESC;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_HourlyByShift
    @ShiftUid UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT DATEPART(HOUR, s.SaleDateTime) AS HourOfDay,
           COUNT(*) AS TxnCount,
           SUM(s.NetAmount) AS NetSales
    FROM dbo.Sales s
    WHERE s.ShiftUid = @ShiftUid AND s.Status = 'Completed'
    GROUP BY DATEPART(HOUR, s.SaleDateTime)
    ORDER BY HourOfDay;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_VoidReturn
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT s.BusinessDate, s.BranchCode, s.ORNumber, u.FullName AS Cashier,
           v.FullName AS ApprovedBy, s.NetAmount, s.VoidReason, s.VoidedAt
    FROM dbo.Sales s
    JOIN dbo.Users u ON u.UserId = s.CashierUserId
    LEFT JOIN dbo.Users v ON v.UserId = s.VoidedBy
    WHERE s.Status IN ('Voided','Returned')
      AND s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
    ORDER BY s.VoidedAt DESC;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_CashierPerformance
    @DateFrom DATE, @DateTo DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SELECT u.FullName AS Cashier, s.BranchCode,
        COUNT(DISTINCT s.ShiftUid) AS Shifts,
        COUNT(CASE WHEN s.Status='Completed' THEN 1 END) AS TxnCount,
        ISNULL(SUM(CASE WHEN s.Status='Completed' THEN s.NetAmount END),0) AS NetSales,
        COUNT(CASE WHEN s.Status='Voided' THEN 1 END) AS Voids,
        ISNULL((SELECT SUM(c.ShortOver) FROM dbo.ShiftClosings c
                JOIN dbo.Shifts sh ON sh.ShiftUid=c.ShiftUid
                WHERE sh.CashierUserId=u.UserId AND sh.BusinessDate BETWEEN @DateFrom AND @DateTo),0) AS NetShortOver
    FROM dbo.Sales s JOIN dbo.Users u ON u.UserId = s.CashierUserId
    WHERE s.BusinessDate BETWEEN @DateFrom AND @DateTo
      AND (@BranchCode IS NULL OR s.BranchCode = @BranchCode)
    GROUP BY u.UserId, u.FullName, s.BranchCode ORDER BY NetSales DESC;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_Dashboard
    @BusinessDate DATE, @BranchCode VARCHAR(10) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    /* 1: today's headline numbers */
    SELECT ISNULL(SUM(CASE WHEN Status='Completed' THEN NetAmount END),0) AS NetSales,
           COUNT(CASE WHEN Status='Completed' THEN 1 END) AS TxnCount
    FROM dbo.Sales
    WHERE BusinessDate=@BusinessDate AND (@BranchCode IS NULL OR BranchCode=@BranchCode);

    /* 2: per branch today */
    SELECT s.BranchCode,
           COUNT(CASE WHEN s.Status='Completed' THEN 1 END) AS TxnCount,
           ISNULL(SUM(CASE WHEN s.Status='Completed' THEN s.NetAmount END),0) AS NetSales
    FROM dbo.Sales s WHERE s.BusinessDate=@BusinessDate
    GROUP BY s.BranchCode;

    /* 3: last 7 days */
    SELECT BusinessDate, ISNULL(SUM(CASE WHEN Status='Completed' THEN NetAmount END),0) AS NetSales
    FROM dbo.Sales
    WHERE BusinessDate BETWEEN DATEADD(DAY,-6,@BusinessDate) AND @BusinessDate
      AND (@BranchCode IS NULL OR BranchCode=@BranchCode)
    GROUP BY BusinessDate ORDER BY BusinessDate;

    /* 4: open shifts */
    SELECT COUNT(*) AS OpenShifts FROM dbo.Shifts WHERE Status='Open';
END
GO
