/* =====================================================================
   24 — E-invoice copies by email (2026-10-27)
   Every sales invoice (and return receipt) can be emailed as an exact copy of what printed:
   to the customer's email when the cashier took one, otherwise to a common repository
   mailbox. Sales.CustomerEmail holds the address; dbo.InvoiceEmails is the send queue
   (InvoiceEmailService sends it in the background, with retries); EmailConfig gains the
   on/off switch and the repository address. Idempotent. Run this, then re-run 02_procedures.sql.
   ===================================================================== */
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

IF COL_LENGTH('dbo.Sales', 'CustomerEmail') IS NULL
    ALTER TABLE dbo.Sales ADD CustomerEmail NVARCHAR(254) NULL;
GO
IF COL_LENGTH('dbo.EmailConfig', 'SendInvoices') IS NULL
    ALTER TABLE dbo.EmailConfig ADD SendInvoices BIT NOT NULL CONSTRAINT DF_EmailConfig_SendInvoices DEFAULT 0;
GO
IF COL_LENGTH('dbo.EmailConfig', 'InvoiceRepository') IS NULL
    ALTER TABLE dbo.EmailConfig ADD InvoiceRepository NVARCHAR(254) NULL;
GO

IF OBJECT_ID('dbo.InvoiceEmails', 'U') IS NULL
CREATE TABLE dbo.InvoiceEmails (
    InvoiceEmailId  BIGINT IDENTITY(1,1) PRIMARY KEY,
    Kind            VARCHAR(10)   NOT NULL CONSTRAINT CK_InvoiceEmails_Kind CHECK (Kind IN ('SALE', 'RETURN')),
    RefUid          UNIQUEIDENTIFIER NOT NULL,          -- Sales.SaleUid / SaleReturns.ReturnUid
    BranchCode      VARCHAR(10)   NOT NULL,
    ToAddress       NVARCHAR(254) NOT NULL,
    ToRepository    BIT NOT NULL DEFAULT 0,             -- 1 = the customer gave no email
    IsManual        BIT NOT NULL DEFAULT 0,             -- 1 = "Email a copy" from Reprint
    RequestedBy     INT NULL,
    Status          VARCHAR(10)   NOT NULL DEFAULT 'Pending'
                    CONSTRAINT CK_InvoiceEmails_Status CHECK (Status IN ('Pending', 'Sent', 'Failed')),
    Attempts        INT NOT NULL DEFAULT 0,
    NextAttemptAt   DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    LastError       NVARCHAR(400) NULL,
    CreatedAt       DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    SentAt          DATETIME2 NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_InvoiceEmails_Due' AND object_id = OBJECT_ID('dbo.InvoiceEmails'))
    CREATE INDEX IX_InvoiceEmails_Due ON dbo.InvoiceEmails (Status, NextAttemptAt);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_InvoiceEmails_Ref' AND object_id = OBJECT_ID('dbo.InvoiceEmails'))
    CREATE INDEX IX_InvoiceEmails_Ref ON dbo.InvoiceEmails (Kind, RefUid);
GO
