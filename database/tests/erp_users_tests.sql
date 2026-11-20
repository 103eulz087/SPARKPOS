/* =====================================================================
   ERP users sync tests (20_erp_users.sql + dbo.sp_ErpSyncUsers). Every batch is rolled back.
   Each result row must show Pass = 1. Uses its own branches Z01/Z02 and users ut.*.
   The hash is the ERP's published test vector (password SparkPOS-Test#1), not a real one.
   ===================================================================== */
SET NOCOUNT ON;
GO

BEGIN TRY
    BEGIN TRAN;
    DECLARE @r TABLE (Test NVARCHAR(120), Pass BIT, Detail NVARCHAR(400));
    INSERT dbo.Branches (BranchCode, BranchName) VALUES ('Z01', N'TEST 1'), ('Z02', N'TEST 2');
    IF NOT EXISTS (SELECT 1 FROM dbo.Users WHERE Username = 'ut.local')
        INSERT dbo.Users (Username, PasswordHash, PasswordSalt, FullName, Role) VALUES ('ut.local', 'x', 'x', N'Local user', 'Cashier');

    DECLARE @h VARBINARY(64) = 0xF0DBFE8E43F8FA2EC19CBF9E5D569F94D17DE6941E759B0AE07C1ED3A3A588E8,
            @s VARBINARY(64) = 0x000102030405060708090A0B0C0D0E0F;
    DECLARE @U dbo.TVP_ErpUser;
    INSERT @U VALUES
        ('ut.cash1 ', N'Cashier One',  'Z01', 'Cashier',    0, @h, @s, 100000, 1),
        ('ut.cash2',  N'Cashier Two',  'Z01', 'Cashier',    0, @h, @s, 100000, 1),
        ('ut.sup2',   N'Supervisor Two','Z02', 'Supervisor', 0, @h, @s, 100000, 1),
        ('ut.boss',   N'Head Admin',   '888', 'Admin',      0, @h, @s, 100000, 1),
        ('ut.nohash', N'No Hash',      'Z01', 'Cashier',    0, NULL, NULL, NULL, NULL),
        ('ut.algo2',  N'Algo Two',     'Z01', 'Cashier',    0, @h, @s, 100000, 2),
        ('ut.norole', N'No Role',      'Z01', 'Approver',   0, @h, @s, 100000, 1),
        ('ut.nobr',   N'No Branch',    'Z99', 'Cashier',    0, @h, @s, 100000, 1),
        ('ut.local',  N'Clash',        'Z01', 'Cashier',    0, @h, @s, 100000, 1);
    EXEC dbo.sp_ErpSyncUsers @Users = @U, @FullPull = 1;

    INSERT @r SELECT 'U1 four valid ERP users added (trimmed id, hash copied as is)',
        CASE WHEN COUNT(*) = 4 AND SUM(CASE WHEN ErpPasswordHash = @h AND ErpPasswordSalt = @s AND ErpPasswordIterations = 100000
                                             AND ErpPasswordAlgo = 1 AND PasswordHash = 'ERP' AND IsActive = 1 THEN 1 ELSE 0 END) = 4
             THEN 1 ELSE 0 END, CONCAT(COUNT(*), ' users')
    FROM dbo.Users WHERE ErpUserId IN ('ut.cash1', 'ut.cash2', 'ut.sup2', 'ut.boss');
    INSERT @r SELECT 'U2 no hash / unknown algorithm / non-POS role / unknown branch are skipped',
        CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.Users WHERE Username IN ('ut.nohash', 'ut.algo2', 'ut.norole', 'ut.nobr')) THEN 1 ELSE 0 END, '';
    INSERT @r SELECT 'U3 a local user with the same name is never adopted',
        CASE WHEN EXISTS (SELECT 1 FROM dbo.Users WHERE Username = 'ut.local' AND ErpUserId IS NULL AND PasswordHash = 'x') THEN 1 ELSE 0 END, '';
    INSERT @r SELECT 'U4 branch comes from the ERP; an Admin has none (= all branches)',
        CASE WHEN (SELECT COUNT(*) FROM dbo.UserBranches ub JOIN dbo.Users u ON u.UserId = ub.UserId WHERE u.ErpUserId = 'ut.cash1' AND ub.BranchCode = 'Z01') = 1
              AND (SELECT COUNT(*) FROM dbo.UserBranches ub JOIN dbo.Users u ON u.UserId = ub.UserId WHERE u.ErpUserId = 'ut.cash1') = 1
              AND NOT EXISTS (SELECT 1 FROM dbo.UserBranches ub JOIN dbo.Users u ON u.UserId = ub.UserId WHERE u.ErpUserId = 'ut.boss')
             THEN 1 ELSE 0 END, '';

    /* Lockout cleared by a new password; role and branch changes applied. */
    UPDATE dbo.Users SET FailedLogins = 4, LockedUntil = DATEADD(MINUTE, 10, SYSDATETIME()) WHERE ErpUserId = 'ut.cash2';
    UPDATE @U SET PasswordHash = 0x01 + SUBSTRING(@h, 2, 31) WHERE UserID = 'ut.cash2';
    UPDATE @U SET Role = 'Supervisor', AssignedBranch = 'Z02' WHERE UserID = 'ut.cash1 ';
    EXEC dbo.sp_ErpSyncUsers @Users = @U, @FullPull = 1;
    INSERT @r SELECT 'U5 a new ERP password clears SparkPOS''s lockout',
        CASE WHEN FailedLogins = 0 AND LockedUntil IS NULL THEN 1 ELSE 0 END, '' FROM dbo.Users WHERE ErpUserId = 'ut.cash2';
    INSERT @r SELECT 'U6 role and branch changes follow the ERP',
        CASE WHEN u.Role = 'Supervisor' AND (SELECT ub.BranchCode FROM dbo.UserBranches ub WHERE ub.UserId = u.UserId) = 'Z02' THEN 1 ELSE 0 END, ''
    FROM dbo.Users u WHERE u.ErpUserId = 'ut.cash1';

    /* ut.cash2 (Z01) disappears, but the list has nobody else for Z01 now → kept for safety.
       ut.sup2 (Z02) disappears while Z02 still has ut.cash1 → deactivated. */
    DELETE @U WHERE UserID IN ('ut.cash2', 'ut.sup2');
    EXEC dbo.sp_ErpSyncUsers @Users = @U, @FullPull = 1;
    INSERT @r SELECT 'U7 a user gone from a branch the ERP still lists is deactivated',
        CASE WHEN IsActive = 0 THEN 1 ELSE 0 END, '' FROM dbo.Users WHERE ErpUserId = 'ut.sup2';
    INSERT @r SELECT 'U8 a user whose whole branch came back empty is kept (could be a glitch)',
        CASE WHEN IsActive = 1 THEN 1 ELSE 0 END, '' FROM dbo.Users WHERE ErpUserId = 'ut.cash2';

    /* An empty list deactivates nobody; a one-user refresh (FullPull = 0) deactivates nobody. */
    DECLARE @Empty dbo.TVP_ErpUser;
    EXEC dbo.sp_ErpSyncUsers @Users = @Empty, @FullPull = 1;
    INSERT @r SELECT 'U9 an empty ERP list deactivates nobody',
        CASE WHEN (SELECT IsActive FROM dbo.Users WHERE ErpUserId = 'ut.cash1') = 1
              AND (SELECT IsActive FROM dbo.Users WHERE ErpUserId = 'ut.boss') = 1 THEN 1 ELSE 0 END, '';
    DECLARE @One dbo.TVP_ErpUser;
    INSERT @One SELECT * FROM @U WHERE UserID = 'ut.boss';
    EXEC dbo.sp_ErpSyncUsers @Users = @One, @FullPull = 0;
    INSERT @r SELECT 'U10 a one-user refresh deactivates nobody',
        CASE WHEN (SELECT IsActive FROM dbo.Users WHERE ErpUserId = 'ut.cash1') = 1 THEN 1 ELSE 0 END, '';

    ROLLBACK;
    SELECT * FROM @r;
END TRY
BEGIN CATCH
    DECLARE @e INT = ERROR_NUMBER(), @m NVARCHAR(400) = ERROR_MESSAGE(), @l INT = ERROR_LINE();
    IF @@TRANCOUNT > 0 ROLLBACK;
    SELECT 'U batch' AS Test, 0 AS Pass, CONCAT(@e, ' ', @m, ' line ', @l) AS Detail;
END CATCH
GO

SELECT 'U11 nothing left behind' AS Test,
    CASE WHEN NOT EXISTS (SELECT 1 FROM dbo.Users WHERE Username LIKE 'ut.%')
          AND NOT EXISTS (SELECT 1 FROM dbo.Branches WHERE BranchCode IN ('Z01', 'Z02')) THEN 1 ELSE 0 END AS Pass, '' AS Detail;
GO
