/* =====================================================================
   Adds dine-in table/order support for PosSettings.PosType = 'Restaurant'.
   dbo.Tables (per-branch table list), dbo.OpenOrders (a dine-in tab - items
   added over possibly several rounds before Generate Bill hands them to the
   normal checkout flow), dbo.OpenOrderItems.
   Safe to run more than once.
   Run: sqlcmd -S <server> -U sa -P <pwd> -d TabletPOS -i 08_restaurant_tables.sql
   ===================================================================== */
IF OBJECT_ID('dbo.Tables', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Tables (
        TableId         INT IDENTITY(1,1) PRIMARY KEY,
        BranchCode      VARCHAR(10) NOT NULL REFERENCES dbo.Branches(BranchCode),
        TableNumber     NVARCHAR(20) NOT NULL,
        Capacity        INT NOT NULL DEFAULT 4,
        IsActive        BIT NOT NULL DEFAULT 1,
        CONSTRAINT UQ_Tables_Branch_Number UNIQUE (BranchCode, TableNumber)
    );
END
GO

IF OBJECT_ID('dbo.OpenOrders', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.OpenOrders (
        OpenOrderUid    UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        TableId         INT NOT NULL REFERENCES dbo.Tables(TableId),
        BranchCode      VARCHAR(10) NOT NULL,
        TerminalId      INT NOT NULL,
        ShiftUid        UNIQUEIDENTIFIER NOT NULL,
        OpenedByUserId  INT NOT NULL,
        OpenedAt        DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        Status          VARCHAR(12) NOT NULL DEFAULT 'Open' CHECK (Status IN ('Open','Billed','Voided')),
        ClosedAt        DATETIME2 NULL,
        SaleUid         UNIQUEIDENTIFIER NULL
    );
    CREATE INDEX IX_OpenOrders_Table ON dbo.OpenOrders(TableId, Status);
END
GO

/* Enforces "one open order per table" at the DB level - the app-level
   check-then-insert in OrdersController.Open() can otherwise race under
   concurrent taps on the same table. */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_OpenOrders_OneOpenPerTable')
BEGIN
    CREATE UNIQUE INDEX UQ_OpenOrders_OneOpenPerTable ON dbo.OpenOrders(TableId) WHERE Status = 'Open';
END
GO

IF OBJECT_ID('dbo.OpenOrderItems', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.OpenOrderItems (
        OpenOrderItemId BIGINT IDENTITY(1,1) PRIMARY KEY,
        OpenOrderUid    UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.OpenOrders(OpenOrderUid),
        LineNo          INT NOT NULL,
        ProductId       INT NOT NULL,
        Barcode         NVARCHAR(50) NOT NULL,
        ProductName     NVARCHAR(150) NOT NULL,
        CategoryId      INT NOT NULL,
        Quantity        DECIMAL(18,3) NOT NULL,
        UnitPrice       DECIMAL(18,2) NOT NULL,
        IsVatable       BIT NOT NULL DEFAULT 1,
        IsDiscountable  BIT NOT NULL DEFAULT 1,
        AddedAt         DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        CONSTRAINT UQ_OpenOrderItems UNIQUE (OpenOrderUid, LineNo)
    );
    CREATE INDEX IX_OpenOrderItems_Order ON dbo.OpenOrderItems(OpenOrderUid);
END
GO
