/* =====================================================================
   36 — Supervisor approval for a price level (2026-11-19)
   The user, after trying 35: "add override also by switching those price levels". A seventh action
   in the approvals: PosSettings.PriceLevelOverride (off), and PRICE_LEVEL allowed in
   TerminalOverrides. When on, a cashier needs a supervisor to put an item (Edit price) or the
   whole sale at Price 1..4; going back to the regular price needs none.
   Idempotent. Run after 35_approvals.sql, then re-run 02_procedures.sql (no proc changes).
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('dbo.PosSettings', 'PriceLevelOverride') IS NULL
    ALTER TABLE dbo.PosSettings ADD PriceLevelOverride BIT NOT NULL CONSTRAINT DF_PosSettings_PriceLevelOverride DEFAULT 0;
GO

IF OBJECT_ID('dbo.TerminalOverrides', 'U') IS NOT NULL
   AND OBJECT_DEFINITION(OBJECT_ID('dbo.CK_TerminalOverrides_Func')) NOT LIKE '%PRICE_LEVEL%'
BEGIN
    ALTER TABLE dbo.TerminalOverrides DROP CONSTRAINT CK_TerminalOverrides_Func;
    ALTER TABLE dbo.TerminalOverrides ADD CONSTRAINT CK_TerminalOverrides_Func
        CHECK (Func IN ('CANCEL_LINE', 'VOID', 'RETURN', 'XREAD', 'REPRINT', 'DISCOUNT', 'PRICE_LEVEL'));
END
GO
