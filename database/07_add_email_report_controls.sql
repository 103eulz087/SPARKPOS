/* =====================================================================
   Adds a per-branch control for emailing a shift-close (Blind Close)
   report, and the report queries it (and the enriched End of Day email)
   need: item sales summary and per-hour transactions, scoped to a shift
   or to a terminal/business date.
   Safe to run more than once.
   Run: sqlcmd -S <server> -U sa -P <pwd> -d TabletPOS -i 07_add_email_report_controls.sql
   ===================================================================== */
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.PosSettings') AND name = 'EmailOnBlindClose'
)
    ALTER TABLE dbo.PosSettings ADD EmailOnBlindClose BIT NOT NULL DEFAULT 0;
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_GroupItemsByShift
    @ShiftUid UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT si.Barcode, si.ProductName, c.CategoryName,
           SUM(si.Quantity) AS TotalQty, SUM(si.LineTotal) AS TotalAmount
    FROM dbo.SaleItems si
    JOIN dbo.Sales s ON s.SaleUid = si.SaleUid AND s.Status = 'Completed'
    JOIN dbo.Categories c ON c.CategoryId = si.CategoryId
    WHERE s.ShiftUid = @ShiftUid
    GROUP BY si.Barcode, si.ProductName, c.CategoryName
    ORDER BY TotalAmount DESC;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_GroupItemsByTerminalDate
    @TerminalId INT, @BusinessDate DATE
AS
BEGIN
    SET NOCOUNT ON;
    SELECT si.Barcode, si.ProductName, c.CategoryName,
           SUM(si.Quantity) AS TotalQty, SUM(si.LineTotal) AS TotalAmount
    FROM dbo.SaleItems si
    JOIN dbo.Sales s ON s.SaleUid = si.SaleUid AND s.Status = 'Completed'
    JOIN dbo.Categories c ON c.CategoryId = si.CategoryId
    WHERE s.TerminalId = @TerminalId AND s.BusinessDate = @BusinessDate
    GROUP BY si.Barcode, si.ProductName, c.CategoryName
    ORDER BY TotalAmount DESC;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_rpt_HourlyByShift
    @ShiftUid UNIQUEIDENTIFIER
AS
BEGIN
    SET NOCOUNT ON;
    SELECT DATEPART(HOUR, s.SaleDateTime) AS HourOfDay,
           COUNT(*) AS TxnCount,
           SUM(s.NetAmount) AS NetSales
    FROM dbo.Sales s
    WHERE s.ShiftUid = @ShiftUid AND s.Status = 'Completed'
    GROUP BY DATEPART(HOUR, s.SaleDateTime)
    ORDER BY HourOfDay;
END
GO
