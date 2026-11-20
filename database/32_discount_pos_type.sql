/* =====================================================================
   32 — SC/PWD rate per POS type, and a capped discount (2026-11-17)
   1. The user: a supermarket till gives seniors 5% on groceries (VAT stays), a restaurant till
      (VROSS's GRILLS) gives 20% VAT-exempt on food. The rate now follows the till's POS type
      (Terminals.PosType, else the branch's PosSettings.PosType). DiscountPosTypeRates holds a
      discount type's rate per POS type (CategoryId NULL) and, if needed, per POS type and
      category. The rule that applies to a line, first match wins:
        a. this POS type + the line's category   (DiscountPosTypeRates)
        b. the line's category, any POS type      (DiscountCategoryRates, unchanged)
        c. this POS type                           (DiscountPosTypeRates, CategoryId NULL)
        d. the discount type's own default        (DiscountTypes)
      DiscountCategoryRates isn't touched, so a build from before 32 reads it as it always did.
   2. The senior's weekly purchase cap (₱2,500 on basic necessities): when most of it is used,
      the cashier enters the discount the booklet still allows, with a supervisor's approval.
      Sales.DiscountCap keeps that amount; the approver goes in Sales.DiscountApprovedBy (30).
   Idempotent. Run this, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.DiscountPosTypeRates', 'U') IS NULL
CREATE TABLE dbo.DiscountPosTypeRates (
    RateId       INT IDENTITY(1,1) CONSTRAINT PK_DiscountPosTypeRates PRIMARY KEY,
    DiscountCode VARCHAR(10) NOT NULL REFERENCES dbo.DiscountTypes(DiscountCode),
    PosType      VARCHAR(20) NOT NULL CONSTRAINT CK_DiscountPosTypeRates_PosType CHECK (PosType IN ('Retail', 'Restaurant', 'Pharmacy')),
    CategoryId   INT NULL REFERENCES dbo.Categories(CategoryId),   -- NULL = every category at this POS type
    Rate         DECIMAL(5,4) NOT NULL CONSTRAINT CK_DiscountPosTypeRates_Rate CHECK (Rate BETWEEN 0 AND 1),
    IsVatExempt  BIT NOT NULL,
    UpdatedAt    DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    UpdatedBy    INT NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_DiscountPosTypeRates' AND object_id = OBJECT_ID('dbo.DiscountPosTypeRates'))
    CREATE UNIQUE INDEX UQ_DiscountPosTypeRates ON dbo.DiscountPosTypeRates (DiscountCode, PosType, CategoryId);
GO

IF COL_LENGTH('dbo.Sales', 'DiscountCap') IS NULL
    ALTER TABLE dbo.Sales ADD DiscountCap DECIMAL(18,2) NULL;   -- the SC/PWD discount the cashier limited it to
GO
