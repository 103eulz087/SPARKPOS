/* =====================================================================
   29 — POS type per terminal (2026-11-14)
   PosSettings.PosType is per branch, so switching a branch to Restaurant switched every
   terminal there. Terminals.PosType lets one terminal be Restaurant (dine-in tables) while the
   others stay Retail. NULL = follow the branch's PosSettings.PosType (every existing terminal).
   Idempotent. No procedure changes.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('dbo.Terminals', 'PosType') IS NULL
    ALTER TABLE dbo.Terminals ADD PosType VARCHAR(20) NULL
        CONSTRAINT CK_Terminals_PosType CHECK (PosType IS NULL OR PosType IN ('Retail','Restaurant','Pharmacy'));
GO
