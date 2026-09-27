/* =====================================================================
   Makes End of Day's supervisor/admin credential requirement configurable
   per branch, matching how VoidOverride/PriceEditOverride/ReprintOverride
   already work. Defaults to 1 (required) to preserve existing behavior.
   Safe to run more than once.
   Run: sqlcmd -S <server> -U sa -P <pwd> -d TabletPOS -i 06_add_eod_override.sql
   ===================================================================== */
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.PosSettings') AND name = 'EodOverride'
)
    ALTER TABLE dbo.PosSettings ADD EodOverride BIT NOT NULL DEFAULT 1;
GO
