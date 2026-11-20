/* =====================================================================
   39 — Open drawer without a sale (2026-11-20)
   The user: the cash drawer opens only when the printer prints, so with no transaction the cashier
   can't open it. The till now opens it on its own (PrintAgent's drawer kick, else a NO SALE slip),
   with a reason, and every opening is kept:
   - dbo.DrawerOpens: one row per opening (the till's own id, so an offline one sent again
     isn't counted twice): shift, terminal, who, the supervisor if one approved, reason, when.
   - PosSettings.OpenDrawerOverride (off) and OPEN_DRAWER in TerminalOverrides: an eighth action in
     Supervisor approvals, per branch with a terminal's own answer.
   - ZReads.DrawerOpens: the day's count on the Z-Read (the X-Read counts the shift's).
   Idempotent. Run, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.DrawerOpens', 'U') IS NULL
    CREATE TABLE dbo.DrawerOpens (
        DrawerOpenUid UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_DrawerOpens PRIMARY KEY,
        ShiftUid      UNIQUEIDENTIFIER NOT NULL,
        BranchCode    VARCHAR(10) NOT NULL,
        TerminalId    INT NOT NULL,
        UserId        INT NOT NULL,
        ApprovedBy    INT NULL,                 -- the supervisor, when the till asked for one
        Reason        NVARCHAR(60) NOT NULL,
        Note          NVARCHAR(200) NULL,
        OpenedAt      DATETIME2 NOT NULL,       -- at the till
        LoggedAt      DATETIME2 NOT NULL CONSTRAINT DF_DrawerOpens_LoggedAt DEFAULT SYSDATETIME(),
        Method        VARCHAR(10) NULL          -- KICK (drawer command) / SLIP (NO SALE slip printed)
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_DrawerOpens_Shift')
    CREATE INDEX IX_DrawerOpens_Shift ON dbo.DrawerOpens(ShiftUid);
GO

IF COL_LENGTH('dbo.PosSettings', 'OpenDrawerOverride') IS NULL
    ALTER TABLE dbo.PosSettings ADD OpenDrawerOverride BIT NOT NULL CONSTRAINT DF_PosSettings_OpenDrawerOverride DEFAULT 0;
GO

IF OBJECT_ID('dbo.TerminalOverrides', 'U') IS NOT NULL
   AND OBJECT_DEFINITION(OBJECT_ID('dbo.CK_TerminalOverrides_Func')) NOT LIKE '%OPEN_DRAWER%'
BEGIN
    ALTER TABLE dbo.TerminalOverrides DROP CONSTRAINT CK_TerminalOverrides_Func;
    ALTER TABLE dbo.TerminalOverrides ADD CONSTRAINT CK_TerminalOverrides_Func
        CHECK (Func IN ('CANCEL_LINE', 'VOID', 'RETURN', 'XREAD', 'REPRINT', 'DISCOUNT', 'PRICE_LEVEL', 'OPEN_DRAWER'));
END
GO

IF COL_LENGTH('dbo.ZReads', 'DrawerOpens') IS NULL
    ALTER TABLE dbo.ZReads ADD DrawerOpens INT NOT NULL CONSTRAINT DF_ZReads_DrawerOpens DEFAULT 0;
GO
