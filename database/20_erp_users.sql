/* =====================================================================
   20 — ERP users (hybrid login), 2026-10-26
   The CORECS ERP is the master for users: dbo.sp_SparkPOS_GetUsers (ERP [226]) gives each
   user's role, assigned branch and PBKDF2 password hash. SparkPOS keeps a synced copy so
   login still works when the ERP can't be reached. Local (non-ERP) users keep working;
   the starter admin stays local as the break-glass login.
   Idempotent. Run this, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('dbo.Users', 'ErpUserId') IS NULL
    ALTER TABLE dbo.Users ADD
        ErpUserId             VARCHAR(50)   NULL,   -- ERP Users.UserID; NULL = local SparkPOS user
        ErpPasswordHash       VARBINARY(64) NULL,   -- ERP PBKDF2 hash/salt/iterations/version, copied as is
        ErpPasswordSalt       VARBINARY(64) NULL,
        ErpPasswordIterations INT           NULL,
        ErpPasswordAlgo       TINYINT       NULL,
        MustChangePassword    BIT NOT NULL CONSTRAINT DF_Users_MustChangePassword DEFAULT 0,
        ErpSyncedAt           DATETIME2     NULL,
        FailedLogins          INT NOT NULL CONSTRAINT DF_Users_FailedLogins DEFAULT 0,
        LockedUntil           DATETIME2     NULL;   -- SparkPOS's own lockout (the ERP's can't see our logins)
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_Users_ErpUserId' AND object_id = OBJECT_ID('dbo.Users'))
    CREATE UNIQUE INDEX UQ_Users_ErpUserId ON dbo.Users(ErpUserId) WHERE ErpUserId IS NOT NULL;
GO

/* Wider than the targets on purpose, like the other ERP TVPs. */
IF TYPE_ID('dbo.TVP_ErpUser') IS NULL
    CREATE TYPE dbo.TVP_ErpUser AS TABLE (
        UserID VARCHAR(100), FullName NVARCHAR(400), AssignedBranch VARCHAR(100), Role VARCHAR(40),
        MustChangePassword BIT, PasswordHash VARBINARY(64), PasswordSalt VARBINARY(64),
        PasswordIterations INT, PasswordAlgoVersion TINYINT
    );
GO
