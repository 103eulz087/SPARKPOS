/* =====================================================================
   Open drawer tests (39_open_drawer.sql + 02_procedures.sql).
   Every batch is rolled back, so this is safe on any DB with the schema, a terminal and a user.
   Each result row must show Pass = 1. Business dates are in 2099.
   ===================================================================== */
SET NOCOUNT ON;
GO

/* D1. Drawer openings are counted per shift on the X-Read and per day on the Z-Read; a terminal
       can have its own Open drawer approval answer. */
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
    DECLARE @d DATE = '2099-06-01', @s1 UNIQUEIDENTIFIER = NEWID(), @s2 UNIQUEIDENTIFIER = NEWID(), @now DATETIME2 = SYSDATETIME();
    INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@s1, @branch, @term, @user, @d, 1000, @now);

    INSERT dbo.DrawerOpens (DrawerOpenUid, ShiftUid, BranchCode, TerminalId, UserId, ApprovedBy, Reason, OpenedAt, Method)
    VALUES (NEWID(), @s1, @branch, @term, @user, NULL, N'Change for a customer', @now, 'KICK'),
           (NEWID(), @s1, @branch, @term, @user, @user, N'Check the cash', @now, 'SLIP');
    DECLARE @xr TABLE (BranchCode VARCHAR(10), BranchName NVARCHAR(120), TerminalCode VARCHAR(20), Cashier NVARCHAR(200),
        BusinessDate DATE, CashBegin DECIMAL(18,2), OpenedAt DATETIME2, TxnCount INT, VoidCount INT,
        GrossSales DECIMAL(18,2), TotalDiscounts DECIMAL(18,2), NetSales DECIMAL(18,2), VatableAmount DECIMAL(18,2),
        VatAmount DECIMAL(18,2), VatExemptAmount DECIMAL(18,2), ZeroRatedAmount DECIMAL(18,2),
        DiscSenior DECIMAL(18,2), DiscPwd DECIMAL(18,2), DiscNaac DECIMAL(18,2), DiscMov DECIMAL(18,2), DiscSolo DECIMAL(18,2),
        DiscOther DECIMAL(18,2), DiscPromo DECIMAL(18,2), CashSales DECIMAL(18,2), CardSales DECIMAL(18,2), GcSales DECIMAL(18,2),
        DrawerOpens INT, ChangeGiven DECIMAL(18,2), VoidAmount DECIMAL(18,2),
        BeginningOR BIGINT, EndingOR BIGINT, ReturnCount INT, ReturnAmount DECIMAL(18,2), BeginningReturnNo INT, EndingReturnNo INT);
    INSERT @xr EXEC dbo.sp_rpt_XRead @ShiftUid = @s1;
    INSERT @r SELECT 'D1a X-Read counts the shift''s 2 drawer openings', CASE WHEN DrawerOpens = 2 THEN 1 ELSE 0 END,
        CONCAT(DrawerOpens, '') FROM @xr;

    EXEC dbo.sp_ProcessBlindClose @ShiftUid = @s1, @DeclaredCash = 1000, @DenominationsJson = N'{}';
    INSERT dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@s2, @branch, @term, @user, @d, 500, @now);
    INSERT dbo.DrawerOpens (DrawerOpenUid, ShiftUid, BranchCode, TerminalId, UserId, Reason, OpenedAt)
    VALUES (NEWID(), @s2, @branch, @term, @user, N'Other', @now);
    EXEC dbo.sp_ProcessBlindClose @ShiftUid = @s2, @DeclaredCash = 500, @DenominationsJson = N'{}';
    EXEC dbo.sp_ProcessEndOfDay @TerminalId = @term, @BusinessDate = @d, @ClosedByUserId = @user, @ApprovedByUserId = @user;
    INSERT @r SELECT 'D1b Z-Read counts the day''s 3 openings (both shifts)', CASE WHEN DrawerOpens = 3 THEN 1 ELSE 0 END,
        CONCAT(DrawerOpens, '') FROM dbo.ZReads WHERE TerminalId = @term AND BusinessDate = @d;

    INSERT dbo.TerminalOverrides (TerminalId, Func, Required) VALUES (@term, 'OPEN_DRAWER', 1);
    INSERT @r SELECT 'D1c a terminal can have its own Open drawer answer', CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END, ''
    FROM dbo.TerminalOverrides WHERE TerminalId = @term AND Func = 'OPEN_DRAWER';
    INSERT @r SELECT 'D1d the branch switch exists and is off by default',
        CASE WHEN COL_LENGTH('dbo.PosSettings', 'OpenDrawerOverride') IS NOT NULL
              AND (SELECT TOP 1 dc.definition FROM sys.default_constraints dc WHERE dc.name = 'DF_PosSettings_OpenDrawerOverride') LIKE '%0%'
             THEN 1 ELSE 0 END, '';

    SELECT Test, Pass, Detail FROM @r;
    ROLLBACK;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'D1 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' line ', ERROR_LINE(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO

/* D2. Nothing from these tests survived. */
SELECT 'D2 nothing left behind' AS Test,
    CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.Shifts WHERE BusinessDate = '2099-06-01') THEN 1 ELSE 0 END AS Pass, '' AS Detail;
GO
