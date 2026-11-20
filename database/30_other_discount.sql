/* =====================================================================
   30 — Regular / other discount (2026-11-15)
   A peso amount off the whole sale for special cases or the company's discretion, entered at
   the till with a reason and a supervisor's approval. Its code on the sale is 'OTHER' (not a
   DiscountTypes row: it has no rate); DiscountName holds the reason. It never goes with a
   SC/PWD discount on the same sale. Unlike SC/PWD it is not VAT-exempt: VAT is on the price
   after the discount.
   - Sales.DiscountApprovedBy: the supervisor who approved it (an audit row OTHER_DISCOUNT too).
   - ZReads.DiscOther: the day's total, its own line in the Z-Read's discount breakdown.
   Idempotent. Run this, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('dbo.Sales', 'DiscountApprovedBy') IS NULL
    ALTER TABLE dbo.Sales ADD DiscountApprovedBy INT NULL;
GO
IF COL_LENGTH('dbo.ZReads', 'DiscOther') IS NULL
    ALTER TABLE dbo.ZReads ADD DiscOther DECIMAL(18,2) NOT NULL CONSTRAINT DF_ZReads_DiscOther DEFAULT 0;
GO
