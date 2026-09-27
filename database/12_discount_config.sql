/* =====================================================================
   Discount configuration: per-category overrides of a discount type's rate/VAT
   treatment (e.g. RA 9994 Senior Citizen is 20%+VAT-exempt on medicine, but only
   5%+still-VATable on groceries/prime commodities — same discount code, different
   category, different math). No override row for a category means "use
   DiscountTypes' own default Rate/IsVatExempt" unchanged.
   Also adds VatAdjustment (reporting-only VAT-forgone figure) and DinerCount/
   SeniorCount (Restaurant PosType pax split, captured at Generate Bill) to dbo.Sales.
   Safe to run more than once.
   Run: sqlcmd -S <server> -U sa -P <pwd> -d TabletPOS -i 12_discount_config.sql
   ===================================================================== */
IF OBJECT_ID('dbo.DiscountCategoryRates', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.DiscountCategoryRates (
        DiscountCode    VARCHAR(10) NOT NULL REFERENCES dbo.DiscountTypes(DiscountCode),
        CategoryId      INT NOT NULL REFERENCES dbo.Categories(CategoryId),
        Rate            DECIMAL(5,4) NOT NULL,
        IsVatExempt     BIT NOT NULL DEFAULT 1,
        CONSTRAINT PK_DiscountCategoryRates PRIMARY KEY (DiscountCode, CategoryId)
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Sales') AND name = 'VatAdjustment')
BEGIN
    ALTER TABLE dbo.Sales ADD VatAdjustment DECIMAL(18,2) NOT NULL DEFAULT 0;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Sales') AND name = 'DinerCount')
BEGIN
    ALTER TABLE dbo.Sales ADD DinerCount INT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Sales') AND name = 'SeniorCount')
BEGIN
    ALTER TABLE dbo.Sales ADD SeniorCount INT NULL;
END
GO
