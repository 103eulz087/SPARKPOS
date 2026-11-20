/* =====================================================================
   26 — Suki / reward cards (2026-11-12)
   A customer taps their card (an RFID/NFC reader types the card number like a scanner) or
   gives their mobile number; each sale earns 1 point per LoyaltySettings.AmountPerPoint of the
   amount paid, rounded down per sale. Voids and returns take the points back. Phase 1 is earn
   and check only: no redeeming yet. Cards and points are this client's, shared by its branches.
   - LoyaltySettings: one row (on/off, pesos per point, the program's name on screen/receipt).
   - LoyaltyCards: the cards head office registers; Points = the running balance.
   - LoyaltyLedger: every change to a balance (EARN, VOID, RETURN, ADJUST), one per sale /
     return, so a re-synced sale never earns twice.
   - Sales.LoyaltyCardId: the card a sale was rung up with.
   Idempotent. Run this, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.LoyaltySettings', 'U') IS NULL
CREATE TABLE dbo.LoyaltySettings (
    SettingsId      INT NOT NULL CONSTRAINT PK_LoyaltySettings PRIMARY KEY CONSTRAINT CK_LoyaltySettings_One CHECK (SettingsId = 1),
    IsEnabled       BIT NOT NULL DEFAULT 0,
    AmountPerPoint  DECIMAL(18,2) NOT NULL DEFAULT 200 CONSTRAINT CK_LoyaltySettings_Amount CHECK (AmountPerPoint >= 1),
    ProgramName     NVARCHAR(40) NOT NULL DEFAULT N'Suki card',
    UpdatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    UpdatedBy       INT NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM dbo.LoyaltySettings)
    INSERT INTO dbo.LoyaltySettings (SettingsId) VALUES (1);
GO

IF OBJECT_ID('dbo.LoyaltyCards', 'U') IS NULL
CREATE TABLE dbo.LoyaltyCards (
    CardId          INT IDENTITY(1,1) PRIMARY KEY,
    CardNo          NVARCHAR(50)  NOT NULL CONSTRAINT UQ_LoyaltyCards_CardNo UNIQUE,
    CustomerName    NVARCHAR(150) NOT NULL,
    Mobile          VARCHAR(20)   NULL,     -- digits only; lookup by mobile when the card is left at home
    Email           NVARCHAR(254) NULL,
    Points          INT NOT NULL DEFAULT 0 CONSTRAINT CK_LoyaltyCards_Points CHECK (Points >= 0),
    IsActive        BIT NOT NULL DEFAULT 1,
    IssuedBranch    VARCHAR(10)   NULL,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CreatedBy       INT NULL,
    UpdatedAt       DATETIME2 NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_LoyaltyCards_Mobile' AND object_id = OBJECT_ID('dbo.LoyaltyCards'))
    CREATE UNIQUE INDEX UQ_LoyaltyCards_Mobile ON dbo.LoyaltyCards (Mobile) WHERE Mobile IS NOT NULL;
GO

IF OBJECT_ID('dbo.LoyaltyLedger', 'U') IS NULL
CREATE TABLE dbo.LoyaltyLedger (
    EntryId         BIGINT IDENTITY(1,1) PRIMARY KEY,
    CardId          INT NOT NULL CONSTRAINT FK_LoyaltyLedger_Card REFERENCES dbo.LoyaltyCards (CardId),
    Kind            VARCHAR(10) NOT NULL CONSTRAINT CK_LoyaltyLedger_Kind CHECK (Kind IN ('EARN', 'VOID', 'RETURN', 'ADJUST')),
    Points          INT NOT NULL,                       -- + earned / added, - taken back
    SaleUid         UNIQUEIDENTIFIER NULL,              -- the sale behind EARN / VOID / RETURN
    RefUid          UNIQUEIDENTIFIER NULL,              -- SaleUid (EARN, VOID) or ReturnUid (RETURN)
    Amount          DECIMAL(18,2) NULL,                 -- the amount the points were worked out from
    AmountPerPoint  DECIMAL(18,2) NULL,                 -- the rate in effect (EARN), reused for its returns
    BranchCode      VARCHAR(10) NULL,
    Note            NVARCHAR(200) NULL,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CreatedBy       INT NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_LoyaltyLedger_Ref' AND object_id = OBJECT_ID('dbo.LoyaltyLedger'))
    CREATE UNIQUE INDEX UQ_LoyaltyLedger_Ref ON dbo.LoyaltyLedger (Kind, RefUid) WHERE RefUid IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_LoyaltyLedger_Card' AND object_id = OBJECT_ID('dbo.LoyaltyLedger'))
    CREATE INDEX IX_LoyaltyLedger_Card ON dbo.LoyaltyLedger (CardId, EntryId);
GO

IF COL_LENGTH('dbo.Sales', 'LoyaltyCardId') IS NULL
    ALTER TABLE dbo.Sales ADD LoyaltyCardId INT NULL;
GO

/* The ledger is the history: entries are never changed or deleted (a correction is an ADJUST). */
CREATE OR ALTER TRIGGER dbo.TR_LoyaltyLedger_Immutable ON dbo.LoyaltyLedger
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    THROW 51300, 'Points history cannot be changed or deleted. Add an adjustment instead.', 1;
END
GO
