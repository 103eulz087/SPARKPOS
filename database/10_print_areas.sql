/* =====================================================================
   Adds kitchen/beverage-style print-area routing for PosSettings.PosType = 'Restaurant'.
   dbo.PrintAreas (per-branch print station + its network printer target),
   dbo.CategoryPrintAreas (per-branch mapping of a global Category to a print area),
   plus OpenOrderItems.SentQuantity (tracks how much of a line has already been sent
   to the kitchen via "Send to Kitchen", so re-sending only prints what's new).
   Safe to run more than once.
   Run: sqlcmd -S <server> -U sa -P <pwd> -d TabletPOS -i 10_print_areas.sql
   ===================================================================== */
IF OBJECT_ID('dbo.PrintAreas', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.PrintAreas (
        AreaId          INT IDENTITY(1,1) PRIMARY KEY,
        BranchCode      VARCHAR(10) NOT NULL REFERENCES dbo.Branches(BranchCode),
        AreaName        NVARCHAR(50) NOT NULL,
        PrinterTarget   NVARCHAR(200) NOT NULL,
        IsActive        BIT NOT NULL DEFAULT 1,
        CONSTRAINT UQ_PrintAreas_Branch_Name UNIQUE (BranchCode, AreaName)
    );
END
GO

IF OBJECT_ID('dbo.CategoryPrintAreas', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.CategoryPrintAreas (
        BranchCode      VARCHAR(10) NOT NULL REFERENCES dbo.Branches(BranchCode),
        CategoryId      INT NOT NULL REFERENCES dbo.Categories(CategoryId),
        AreaId          INT NOT NULL REFERENCES dbo.PrintAreas(AreaId),
        CONSTRAINT PK_CategoryPrintAreas PRIMARY KEY (BranchCode, CategoryId)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.OpenOrderItems') AND name = 'SentQuantity')
BEGIN
    ALTER TABLE dbo.OpenOrderItems ADD SentQuantity DECIMAL(18,3) NOT NULL DEFAULT 0;
END
GO
