/* =====================================================================
   21 — Weighing-scale barcode stickers (2026-10-26)
   A scale prints an EAN-13 sticker: prefix + product code + weight + check digit, e.g.
   2510015231232 = prefix 25, product 10015, weight 23.123, check digit 2. Scanned at the till,
   it adds that product with that weight as its quantity. The layout is per branch (POS
   settings); a blank prefix turns it off. Idempotent.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO
IF COL_LENGTH('dbo.PosSettings', 'ScaleBarcodePrefix') IS NULL
    ALTER TABLE dbo.PosSettings ADD
        ScaleBarcodePrefix VARCHAR(20) NULL,   -- e.g. '25', or several: '20,25'; NULL/blank = off
        ScaleCodeLength    INT NOT NULL CONSTRAINT DF_PosSettings_ScaleCodeLength DEFAULT 5,
        ScaleQtyLength     INT NOT NULL CONSTRAINT DF_PosSettings_ScaleQtyLength DEFAULT 5,
        ScaleQtyDecimals   INT NOT NULL CONSTRAINT DF_PosSettings_ScaleQtyDecimals DEFAULT 3;
GO
