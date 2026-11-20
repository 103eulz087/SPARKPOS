/* =====================================================================
   19 — ERP prices + supervisor-approved price edits at the till (2026-10-26)
   The CORECS ERP becomes the master for price: head office sets SellingPrice per branch
   and every sync copies it (head office's price → Products.BasePrice, each branch's →
   ProductPrices). A cashier can still change a line's price for a special deal, with a
   supervisor's override; the approver is kept on the sale line.
   Idempotent. Run this, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

/* Wider than the targets on purpose, like the other ERP TVPs: bad values become "skipped"
   issues instead of a truncation error. */
IF TYPE_ID('dbo.TVP_ErpPrice') IS NULL
    CREATE TYPE dbo.TVP_ErpPrice AS TABLE (
        BranchCode VARCHAR(100), ErpProductCode VARCHAR(100), Price DECIMAL(19,4)
    );
GO

IF COL_LENGTH('dbo.SaleItems', 'PriceApprovedBy') IS NULL
    ALTER TABLE dbo.SaleItems ADD PriceApprovedBy INT NULL;   -- who OK'd a price change on this line
GO

/* TVP_SaleItem gains PriceApprovedBy (drop its one user, sp_UpsertSale, and recreate). */
IF TYPE_ID('dbo.TVP_SaleItem') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM sys.table_types tt JOIN sys.columns c ON c.object_id = tt.type_table_object_id
                   WHERE tt.name = 'TVP_SaleItem' AND c.name = 'PriceApprovedBy')
BEGIN
    IF OBJECT_ID('dbo.sp_UpsertSale', 'P') IS NOT NULL DROP PROCEDURE dbo.sp_UpsertSale;
    DROP TYPE dbo.TVP_SaleItem;
END
GO
IF TYPE_ID('dbo.TVP_SaleItem') IS NULL
    CREATE TYPE dbo.TVP_SaleItem AS TABLE (
        [LineNo] INT, ProductId INT, Barcode NVARCHAR(50), ProductName NVARCHAR(150),
        CategoryId INT, Quantity DECIMAL(18,3), UnitPrice DECIMAL(18,2),
        OrigUnitPrice DECIMAL(18,2), LineDiscount DECIMAL(18,2), LineTotal DECIMAL(18,2),
        IsVatable BIT, IsDiscountable BIT,
        NetAmount DECIMAL(18,2) DEFAULT 0, VatableAmount DECIMAL(18,2) DEFAULT 0,
        VatAmount DECIMAL(18,2) DEFAULT 0, VatExemptAmount DECIMAL(18,2) DEFAULT 0,
        ZeroRatedAmount DECIMAL(18,2) DEFAULT 0, VatAdjustment DECIMAL(18,2) DEFAULT 0,
        PriceApprovedBy INT NULL
    );
GO
