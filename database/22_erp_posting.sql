/* =====================================================================
   22 — Posting sales to the CORECS ERP (step 4.1), 2026-10-27
   A terminal with PostToErp = 1 sends each synced sale (and its void) to the ERP's
   dbo.spu_SparkPOS_PostSale / spu_SparkPOS_VoidSale through dbo.ErpOutbox, in order, with
   retries (Services/ErpPostingService.cs). PostToErp = 0 is shadow mode: it sells, nothing is
   sent. The ERP knows the terminal by ErpTerminalCode ('SP-…', at most 10 characters, unique
   in the branch) and its MIN. Idempotent. Run this, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('dbo.Terminals', 'ErpTerminalCode') IS NULL
    ALTER TABLE dbo.Terminals ADD
        ErpTerminalCode VARCHAR(10) NULL,   -- the ERP's name for this machine, e.g. 'SP-POS01'
        PostToErp       BIT NOT NULL CONSTRAINT DF_Terminals_PostToErp DEFAULT 0;
GO
IF OBJECT_ID('dbo.CK_Terminals_ErpTerminalCode', 'C') IS NULL
    ALTER TABLE dbo.Terminals ADD CONSTRAINT CK_Terminals_ErpTerminalCode
        CHECK (ErpTerminalCode IS NULL OR (ErpTerminalCode LIKE 'SP-_%' AND ErpTerminalCode = UPPER(ErpTerminalCode)));
GO
IF OBJECT_ID('dbo.CK_Terminals_PostToErp', 'C') IS NULL
    ALTER TABLE dbo.Terminals ADD CONSTRAINT CK_Terminals_PostToErp
        CHECK (PostToErp = 0 OR (ErpTerminalCode IS NOT NULL AND MinNo IS NOT NULL));
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_Terminals_ErpTerminalCode' AND object_id = OBJECT_ID('dbo.Terminals'))
    CREATE UNIQUE INDEX UQ_Terminals_ErpTerminalCode ON dbo.Terminals(BranchCode, ErpTerminalCode) WHERE ErpTerminalCode IS NOT NULL;
GO

IF OBJECT_ID('dbo.ErpOutbox', 'U') IS NULL
CREATE TABLE dbo.ErpOutbox (
    OutboxId        BIGINT IDENTITY(1,1) PRIMARY KEY,   -- posting order
    Kind            VARCHAR(10) NOT NULL CONSTRAINT CK_ErpOutbox_Kind
                    CHECK (Kind IN ('OPEN', 'SALE', 'VOID', 'RETURN', 'CLOSE', 'ZREAD')),
    RefUid          UNIQUEIDENTIFIER NOT NULL,          -- the SaleUid
    BranchCode      VARCHAR(10) NOT NULL,
    TerminalId      INT NOT NULL,
    BusinessDate    DATE NOT NULL,
    Status          VARCHAR(10) NOT NULL DEFAULT 'Pending' CHECK (Status IN ('Pending', 'Posted', 'Failed')),
    Attempts        INT NOT NULL DEFAULT 0,
    NextAttemptAt   DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    LastErrorNumber INT NULL,
    LastError       NVARCHAR(1000) NULL,
    ErpResult       VARCHAR(20) NULL,                   -- POSTED / DUPLICATE / VOIDED
    ShortLines      INT NULL,                           -- lines the branch didn't have enough stock for
    NeedsReview     BIT NULL,                           -- the ERP flagged it (e.g. a non-ERP approver)
    ErpMessage      NVARCHAR(1000) NULL,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    PostedAt        DATETIME2 NULL,
    CONSTRAINT UQ_ErpOutbox UNIQUE (Kind, RefUid)
);
GO
-- Each line's discount code (e.g. SENIOR20E) as first sent, so a retry sends exactly the same
-- sale even if the discount settings change in between (the ERP refuses changed content: 61122).
IF COL_LENGTH('dbo.ErpOutbox', 'LineDiscountCodes') IS NULL
    ALTER TABLE dbo.ErpOutbox ADD LineDiscountCodes NVARCHAR(MAX) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ErpOutbox_Due' AND object_id = OBJECT_ID('dbo.ErpOutbox'))
    CREATE INDEX IX_ErpOutbox_Due ON dbo.ErpOutbox(Status, NextAttemptAt) INCLUDE (TerminalId);
GO
