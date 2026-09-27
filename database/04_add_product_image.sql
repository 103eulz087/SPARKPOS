/* =====================================================================
   Adds product thumbnail support to an existing database.
   Safe to run more than once.
   Run: sqlcmd -S <server> -U sa -P <pwd> -d TabletPOS -i 04_add_product_image.sql
   ===================================================================== */
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Products') AND name = 'ImageUrl'
)
    ALTER TABLE dbo.Products ADD ImageUrl NVARCHAR(255) NULL;
GO
