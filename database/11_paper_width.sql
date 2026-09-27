/* =====================================================================
   Adds configurable receipt paper width — 58mm (32 columns, the original
   handheld-terminal default) or 80mm (48 columns, the most common fixed
   thermal printer size). Applies to both regular terminals and dine-in
   kitchen/beverage print areas, since either kind of printer can be either size.
   Safe to run more than once.
   Run: sqlcmd -S <server> -U sa -P <pwd> -d TabletPOS -i 11_paper_width.sql
   ===================================================================== */
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Terminals') AND name = 'PaperWidth')
BEGIN
    ALTER TABLE dbo.Terminals ADD PaperWidth INT NOT NULL DEFAULT 58;
END
GO

IF OBJECT_ID('dbo.PrintAreas', 'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.PrintAreas') AND name = 'PaperWidth')
BEGIN
    ALTER TABLE dbo.PrintAreas ADD PaperWidth INT NOT NULL DEFAULT 58;
END
GO
