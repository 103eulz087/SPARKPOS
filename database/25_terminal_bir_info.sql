/* =====================================================================
   25 — Terminal BIR details, sent to the ERP (2026-10-27, ERP [238])
   Head office enters each terminal once, in Admin → Terminals; SparkPOS sends it to the ERP
   (dbo.spu_SparkPOS_SaveTerminalInfo), which fills its SparkPOS_Terminal and its desktop POS
   machine list (POSInfoDetails: report machine picker and X/Z-read BIR header). Adds the BIR
   fields the ERP needs that Terminals didn't hold, and where the last send stands. Idempotent.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('dbo.Terminals', 'AccreditationDate') IS NULL
    ALTER TABLE dbo.Terminals ADD
        AccreditationDate   DATE NULL,             -- required when sent to the ERP
        PermitValidUntil    DATE NULL,             -- PTU end (optional; none = open-ended)
        BirRegTransactionNo VARCHAR(60) NULL,      -- optional
        BirApplicationDate  DATE NULL,             -- optional
        ErpInfoStatus       VARCHAR(10) NULL,      -- Sent / Failed (NULL = never sent)
        ErpInfoResult       VARCHAR(20) NULL,      -- the ERP's answer: CREATED / UPDATED / UNCHANGED
        ErpInfoError        NVARCHAR(400) NULL,
        ErpInfoSentAt       DATETIME2 NULL;
GO
