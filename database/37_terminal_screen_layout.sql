/* =====================================================================
   37 — Screen layout per terminal (2026-11-19)
   The till's screen: NULL = Touch (the product grid with the sale beside it, as before);
   'Grocery' = the grocery lane (the sale as a wide list, the totals and amount due on the
   right, function keys F1-F12 at the bottom), for retail tills where the cashier scans.
   A screen narrower than 1024 px (the handheld) always shows Touch.
   Idempotent. No procedure changes.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('dbo.Terminals', 'ScreenLayout') IS NULL
    ALTER TABLE dbo.Terminals ADD ScreenLayout VARCHAR(10) NULL
        CONSTRAINT CK_Terminals_ScreenLayout CHECK (ScreenLayout IS NULL OR ScreenLayout IN ('Grocery'));
GO
