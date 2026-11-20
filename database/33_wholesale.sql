/* =====================================================================
   33 — Wholesale prices by quantity (2026-11-17)
   The user: some meat items are sold "wholesale": from a set quantity of the item in one sale
   (e.g. 5 kg of Pork Belly) every kg is ₱10 less; other items have their own (10 kg, ₱5).
   The settings change, and wholesale sales go on their own report for DTI.
   The user's calls: a lower price per kg (not a discount line); the item's total quantity in the
   sale counts (several stickers add up); a wholesale line gets no SC/PWD discount (a supervisor
   can take the wholesale off a sale so the discount applies instead); one rule set for every
   branch, which a branch can override. VROSS's memo (Finance, 2024-08-16) sets them by category
   ("all pork SKUs 5 kg up less 5 ...") with item exceptions (Pork Belly; Chop / Paa / Semi-paa
   excluded) and only at some branches, so rules can be for a category too.
   - WholesaleRules: an item OR a category, branch (NULL = every branch), minimum quantity, amount
     off per unit, on/off. Several minimums are tiers: the highest one reached applies. Which rows
     an item follows, first that has any: the item at this branch, the item at every branch, its
     category at this branch, its category at every branch. Only the active rows of that set
     count, so an item's rows all switched off = excluded from wholesale.
   - PosSettings.WholesaleOn: wholesale on or off for the whole branch (default on).
   - SaleItemWholesale: each sale line sold at a wholesale price (regular price, amount off,
     the minimum reached, the item's total quantity in the sale). The DTI report reads it.
   - Sales.WholesaleRemovedBy: the supervisor who took the wholesale price off a sale.
   The sale's lines go in a JSON parameter of sp_UpsertSale (not a TVP column), so a build from
   before 33 still sends TVP_SaleItem as it always did.
   Idempotent. Run this, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.WholesaleRules', 'U') IS NULL
CREATE TABLE dbo.WholesaleRules (
    RuleId      INT IDENTITY(1,1) CONSTRAINT PK_WholesaleRules PRIMARY KEY,
    ProductId   INT NULL REFERENCES dbo.Products(ProductId),       -- an item ...
    CategoryId  INT NULL REFERENCES dbo.Categories(CategoryId),    -- ... or every item of a category
    BranchCode  VARCHAR(10) NULL REFERENCES dbo.Branches(BranchCode),   -- NULL = every branch
    MinQty      DECIMAL(18,3) NOT NULL CONSTRAINT CK_WholesaleRules_MinQty CHECK (MinQty > 0),
    AmountOff   DECIMAL(18,2) NOT NULL CONSTRAINT CK_WholesaleRules_AmountOff CHECK (AmountOff > 0),   -- per unit (kg / pc)
    IsActive    BIT NOT NULL DEFAULT 1,
    UpdatedAt   DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    UpdatedBy   INT NULL,
    CONSTRAINT CK_WholesaleRules_Target CHECK ((ProductId IS NULL AND CategoryId IS NOT NULL) OR (ProductId IS NOT NULL AND CategoryId IS NULL))
);
GO
/* The first copy of this script (2026-11-17, on the test DBs only) had item rules only. */
IF COL_LENGTH('dbo.WholesaleRules', 'CategoryId') IS NULL
BEGIN
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_WholesaleRules' AND object_id = OBJECT_ID('dbo.WholesaleRules'))
        DROP INDEX UQ_WholesaleRules ON dbo.WholesaleRules;
    ALTER TABLE dbo.WholesaleRules ADD CategoryId INT NULL REFERENCES dbo.Categories(CategoryId);
    ALTER TABLE dbo.WholesaleRules ALTER COLUMN ProductId INT NULL;
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_WholesaleRules_Target')
    ALTER TABLE dbo.WholesaleRules ADD CONSTRAINT CK_WholesaleRules_Target
        CHECK ((ProductId IS NULL AND CategoryId IS NOT NULL) OR (ProductId IS NOT NULL AND CategoryId IS NULL));
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_WholesaleRules' AND object_id = OBJECT_ID('dbo.WholesaleRules'))
    CREATE UNIQUE INDEX UQ_WholesaleRules ON dbo.WholesaleRules (ProductId, CategoryId, BranchCode, MinQty);
GO
IF COL_LENGTH('dbo.PosSettings', 'WholesaleOn') IS NULL
    ALTER TABLE dbo.PosSettings ADD WholesaleOn BIT NOT NULL CONSTRAINT DF_PosSettings_WholesaleOn DEFAULT 1;
GO

IF OBJECT_ID('dbo.SaleItemWholesale', 'U') IS NULL
CREATE TABLE dbo.SaleItemWholesale (
    SaleUid        UNIQUEIDENTIFIER NOT NULL,
    [LineNo]       INT NOT NULL,
    ProductId      INT NOT NULL,
    Quantity       DECIMAL(18,3) NOT NULL,   -- this line's
    RegularPrice   DECIMAL(18,2) NOT NULL,   -- per unit before wholesale (the sale's price level, if any)
    AmountOff      DECIMAL(18,2) NOT NULL,   -- per unit
    WholesalePrice DECIMAL(18,2) NOT NULL,   -- per unit, as charged
    MinQty         DECIMAL(18,3) NOT NULL,   -- the minimum the sale reached
    ItemTotalQty   DECIMAL(18,3) NOT NULL,   -- the item's quantity across the sale's lines
    CONSTRAINT PK_SaleItemWholesale PRIMARY KEY (SaleUid, [LineNo])
);
GO
CREATE OR ALTER TRIGGER dbo.TR_SaleItemWholesale_Immutable ON dbo.SaleItemWholesale
AFTER UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (SELECT 1 FROM deleted)
        THROW 51104, 'Wholesale lines of a sales invoice cannot be changed or deleted.', 1;
END
GO

IF COL_LENGTH('dbo.Sales', 'WholesaleRemovedBy') IS NULL
    ALTER TABLE dbo.Sales ADD WholesaleRemovedBy INT NULL;   -- the supervisor who took the wholesale price off this sale
GO
