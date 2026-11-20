/* =====================================================================
   Branch guard tests (sp_OpenShift, 02_procedures.sql): a shift opens only at the terminal's
   own branch, by a user assigned to that branch (an Admin works at every branch).
   Every batch is rolled back, and it makes its own branches, terminals and users, so it is
   safe on any DB with the schema. Each result row must show Pass = 1. Dates are in 2099.
   ===================================================================== */
SET NOCOUNT ON;
GO

/* B1. Who may open a shift where. */
BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    INSERT dbo.Branches (BranchCode, BranchName) VALUES ('ZZ1', N'ZZTEST Branch One'), ('ZZ2', N'ZZTEST Branch Two');
    INSERT dbo.Terminals (BranchCode, TerminalCode, TerminalName)
    VALUES ('ZZ1', 'ZZ-T1', N'ZZTEST 1'), ('ZZ1', 'ZZ-T2', N'ZZTEST 2'), ('ZZ1', 'ZZ-T3', N'ZZTEST 3');
    DECLARE @t1 INT = (SELECT TerminalId FROM dbo.Terminals WHERE BranchCode = 'ZZ1' AND TerminalCode = 'ZZ-T1'),
            @t2 INT = (SELECT TerminalId FROM dbo.Terminals WHERE BranchCode = 'ZZ1' AND TerminalCode = 'ZZ-T2'),
            @t3 INT = (SELECT TerminalId FROM dbo.Terminals WHERE BranchCode = 'ZZ1' AND TerminalCode = 'ZZ-T3');
    INSERT dbo.Users (Username, PasswordHash, PasswordSalt, FullName, Role, IsActive)
    VALUES ('zzbt.cash1', 'x', 'x', N'ZZTEST Cashier One', 'Cashier', 1),
           ('zzbt.cash2', 'x', 'x', N'ZZTEST Cashier Two', 'Cashier', 1),
           ('zzbt.sup2',  'x', 'x', N'ZZTEST Supervisor Two', 'Supervisor', 1),
           ('zzbt.admin', 'x', 'x', N'ZZTEST Admin', 'Admin', 1),
           ('zzbt.gone1', 'x', 'x', N'ZZTEST Inactive One', 'Cashier', 0);
    DECLARE @c1 INT = (SELECT UserId FROM dbo.Users WHERE Username = 'zzbt.cash1'),
            @c2 INT = (SELECT UserId FROM dbo.Users WHERE Username = 'zzbt.cash2'),
            @s2 INT = (SELECT UserId FROM dbo.Users WHERE Username = 'zzbt.sup2'),
            @ad INT = (SELECT UserId FROM dbo.Users WHERE Username = 'zzbt.admin'),
            @g1 INT = (SELECT UserId FROM dbo.Users WHERE Username = 'zzbt.gone1');
    INSERT dbo.UserBranches (UserId, BranchCode) VALUES (@c1, 'ZZ1'), (@c2, 'ZZ2'), (@s2, 'ZZ2'), (@g1, 'ZZ1');
    DECLARE @d DATE = '2099-05-01', @now DATETIME2 = SYSDATETIME(), @e INT, @u UNIQUEIDENTIFIER;

    /* a cashier of the branch, at its terminal: opens */
    SET @u = NEWID(); SET @e = 0;
    BEGIN TRY EXEC dbo.sp_OpenShift @ShiftUid=@u, @BranchCode='ZZ1', @TerminalId=@t1, @CashierUserId=@c1,
        @BusinessDate=@d, @CashBegin=1000, @OpenedAt=@now; END TRY BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'B1a a cashier of the branch opens a shift at its terminal',
        CASE WHEN @e = 0 AND EXISTS (SELECT 1 FROM dbo.Shifts WHERE ShiftUid = @u AND BranchCode = 'ZZ1') THEN 1 ELSE 0 END, CONCAT(@e, '');

    /* the branch sent doesn't match the terminal's */
    SET @u = NEWID(); SET @e = 0;
    BEGIN TRY EXEC dbo.sp_OpenShift @ShiftUid=@u, @BranchCode='ZZ2', @TerminalId=@t2, @CashierUserId=@c2,
        @BusinessDate=@d, @CashBegin=1000, @OpenedAt=@now; END TRY BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'B1b refused when the branch isn''t the terminal''s own (51014)', CASE WHEN @e = 51014 THEN 1 ELSE 0 END, CONCAT(@e, '');

    /* a cashier of another branch, at this branch's terminal */
    SET @u = NEWID(); SET @e = 0;
    BEGIN TRY EXEC dbo.sp_OpenShift @ShiftUid=@u, @BranchCode='ZZ1', @TerminalId=@t2, @CashierUserId=@c2,
        @BusinessDate=@d, @CashBegin=1000, @OpenedAt=@now; END TRY BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'B1c a cashier of another branch is refused (51015)', CASE WHEN @e = 51015 THEN 1 ELSE 0 END, CONCAT(@e, '');

    /* a supervisor of another branch */
    SET @u = NEWID(); SET @e = 0;
    BEGIN TRY EXEC dbo.sp_OpenShift @ShiftUid=@u, @BranchCode='ZZ1', @TerminalId=@t2, @CashierUserId=@s2,
        @BusinessDate=@d, @CashBegin=1000, @OpenedAt=@now; END TRY BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'B1d a supervisor of another branch is refused (51015)', CASE WHEN @e = 51015 THEN 1 ELSE 0 END, CONCAT(@e, '');

    /* a switched-off user of the branch */
    SET @u = NEWID(); SET @e = 0;
    BEGIN TRY EXEC dbo.sp_OpenShift @ShiftUid=@u, @BranchCode='ZZ1', @TerminalId=@t3, @CashierUserId=@g1,
        @BusinessDate=@d, @CashBegin=1000, @OpenedAt=@now; END TRY BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'B1e an inactive user is refused (51015)', CASE WHEN @e = 51015 THEN 1 ELSE 0 END, CONCAT(@e, '');

    /* an Admin (no branch listed = every branch) */
    SET @u = NEWID(); SET @e = 0;
    BEGIN TRY EXEC dbo.sp_OpenShift @ShiftUid=@u, @BranchCode='ZZ1', @TerminalId=@t2, @CashierUserId=@ad,
        @BusinessDate=@d, @CashBegin=1000, @OpenedAt=@now; END TRY BEGIN CATCH SET @e = ERROR_NUMBER(); END CATCH
    INSERT @r SELECT 'B1f an Admin opens a shift at any branch',
        CASE WHEN @e = 0 AND EXISTS (SELECT 1 FROM dbo.Shifts WHERE ShiftUid = @u) THEN 1 ELSE 0 END, CONCAT(@e, '');

    INSERT @r SELECT 'B1g only the two allowed shifts were written',
        CASE WHEN COUNT(*) = 2 THEN 1 ELSE 0 END, CONCAT(COUNT(*), ' shifts')
    FROM dbo.Shifts WHERE TerminalId IN (@t1, @t2, @t3);

    SELECT Test, Pass, Detail FROM @r;
    ROLLBACK;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'B1 batch failed' AS Test, 0 AS Pass, CONCAT(ERROR_NUMBER(), ' ', ERROR_MESSAGE()) AS Detail;
END CATCH
GO

/* B2. Nothing from these tests survived. */
SELECT 'B2 nothing left behind' AS Test,
    CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.Branches WHERE BranchCode IN ('ZZ1', 'ZZ2'))
          AND NOT EXISTS (SELECT 1 FROM dbo.Users WHERE Username LIKE 'zzbt.%' AND FullName LIKE N'ZZTEST%') THEN 1 ELSE 0 END AS Pass, '' AS Detail;
GO
