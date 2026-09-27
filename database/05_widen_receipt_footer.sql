/* =====================================================================
   Widens ReceiptFooter to hold a multi-line block (e.g. a full BIR
   accreditation/permit footer) instead of one short line.
   Safe to run more than once.
   Run: sqlcmd -S <server> -U sa -P <pwd> -d TabletPOS -i 05_widen_receipt_footer.sql
   ===================================================================== */
ALTER TABLE dbo.PosSettings ALTER COLUMN ReceiptFooter NVARCHAR(1000) NULL;
GO
