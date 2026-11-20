/* =====================================================================
   35 — Supervisor approvals per branch, overridable per terminal (2026-11-19)
   The user: put override control on cancel line, void, return, X-Read, reprint and discount,
   "dynamic". Their calls: a switch per branch, which a terminal can override; cancel line =
   removing a line from the cart; one Discount switch for every SC/PWD/NAAC/MOV/Solo type.
   - PosSettings: CancelLineOverride, XReadOverride, DiscountOverride (all off, so nothing
     changes until an Admin turns one on). Void, Return and Reprint keep their own columns
     (VoidOverride, ReturnOverride, ReprintOverride); ReprintOverride is now enforced.
   - TerminalOverrides: a terminal's own answer for a function, Required 1 or 0. No row = the
     branch's switch.
   A Supervisor or Admin signed in never needs a separate approval (as before).
   Idempotent. Run this, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('dbo.PosSettings', 'CancelLineOverride') IS NULL
    ALTER TABLE dbo.PosSettings ADD CancelLineOverride BIT NOT NULL CONSTRAINT DF_PosSettings_CancelLineOverride DEFAULT 0;
IF COL_LENGTH('dbo.PosSettings', 'XReadOverride') IS NULL
    ALTER TABLE dbo.PosSettings ADD XReadOverride BIT NOT NULL CONSTRAINT DF_PosSettings_XReadOverride DEFAULT 0;
IF COL_LENGTH('dbo.PosSettings', 'DiscountOverride') IS NULL
    ALTER TABLE dbo.PosSettings ADD DiscountOverride BIT NOT NULL CONSTRAINT DF_PosSettings_DiscountOverride DEFAULT 0;
GO

IF OBJECT_ID('dbo.TerminalOverrides', 'U') IS NULL
CREATE TABLE dbo.TerminalOverrides (
    TerminalId INT NOT NULL REFERENCES dbo.Terminals(TerminalId),
    Func       VARCHAR(20) NOT NULL CONSTRAINT CK_TerminalOverrides_Func
               CHECK (Func IN ('CANCEL_LINE', 'VOID', 'RETURN', 'XREAD', 'REPRINT', 'DISCOUNT')),
    Required   BIT NOT NULL,
    UpdatedAt  DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    UpdatedBy  INT NULL,
    CONSTRAINT PK_TerminalOverrides PRIMARY KEY (TerminalId, Func)
);
GO
