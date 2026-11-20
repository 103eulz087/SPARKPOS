/* =====================================================================
   28 — Zero-rated sales (2026-11-13)
   Before this, the till reported every item without a VAT flag (fresh meat, fish, vegetables)
   as Zero-Rated Sales. Those are VAT-EXEMPT (fixed in the till, web/src/lib/store.js).
   Zero-rated is now a choice for the whole sale, for a zero-rated buyer (a PEZA / ecozone
   enterprise, a diplomat…): VAT-able items sell at their price without the VAT; a supervisor
   approves; the buyer's name, TIN and address and their certificate / ID no. are required.
   - Sales.ZeroRatedCertNo: the buyer's certificate / ID no., printed on the invoice.
   - Sales.ZeroRatedApprovedBy: the supervisor (also on each repriced line, PriceApprovedBy).
   Idempotent. Run this, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('dbo.Sales', 'ZeroRatedCertNo') IS NULL
    ALTER TABLE dbo.Sales ADD ZeroRatedCertNo NVARCHAR(50) NULL;
GO
IF COL_LENGTH('dbo.Sales', 'ZeroRatedApprovedBy') IS NULL
    ALTER TABLE dbo.Sales ADD ZeroRatedApprovedBy INT NULL;
GO
