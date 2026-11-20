/* =====================================================================
   Seed for a SparkPOS database that runs on the CORECS ERP (instead of 03_seed.sql).
   No demo branches, categories or products: Admin → Products → Sync from ERP brings the
   ERP's branches (888, 001…), categories, products and prices. Then, in Admin:
   create each branch's terminals (with their BIR MIN/permit) and assign users to branches.
   Starter logins (passwords fixed up by the API on first start, like 03_seed.sql):
     sparkpos-admin / admin123   ·   super / super123   ·   cashier / cashier123
   sparkpos-admin stays a LOCAL account on purpose: the break-glass Admin that doesn't depend
   on the ERP (the ERP's own 'Admin' user syncs in separately). Change its password before
   going live. super/cashier are for testing only — deactivate them once ERP users sync.
   ===================================================================== */

-- Head office, so an Admin can sign in before the first sync (login asks for a branch).
-- The sync fills in its real name and address and adds the other branches.
IF NOT EXISTS (SELECT 1 FROM dbo.Branches)
INSERT INTO dbo.Branches (BranchCode, BranchName) VALUES ('888', 'HEAD OFFICE');
IF NOT EXISTS (SELECT 1 FROM dbo.PosSettings WHERE BranchCode = '888')
INSERT INTO dbo.PosSettings (BranchCode, StoreHeader2, PriceEditOverride) VALUES ('888', 'HEAD OFFICE', 1);

IF NOT EXISTS (SELECT 1 FROM dbo.Users)
INSERT INTO dbo.Users (Username, PasswordHash, PasswordSalt, FullName, Role) VALUES
('sparkpos-admin', 'SEEDPWD', 'seedsaltadmin', 'SparkPOS Administrator (local)', 'Admin'),
('super',   'SEEDPWD', 'seedsaltsuper',   'Branch Supervisor',    'Supervisor'),
('cashier', 'SEEDPWD', 'seedsaltcashier', 'Branch Cashier',       'Cashier');

IF NOT EXISTS (SELECT 1 FROM dbo.DiscountTypes)
INSERT INTO dbo.DiscountTypes (DiscountCode, Description, Rate, IsVatExempt, LegalBasis) VALUES
('SENIOR', 'Senior Citizen',           0.2000, 1, 'RA 9994'),
('PWD',    'Person With Disability',   0.2000, 1, 'RA 10754'),
('NAAC',   'National Athlete / Coach', 0.2000, 1, 'RA 10699'),
('MOV',    'Medal of Valor',           0.2000, 1, 'RA 9049'),
('SOLO',   'Solo Parent',              0.1000, 1, 'RA 11861');

IF NOT EXISTS (SELECT 1 FROM dbo.EmailConfig)
INSERT INTO dbo.EmailConfig (BranchCode, SmtpHost, SmtpPort, SmtpUser, SmtpPassword,
    FromAddress, ToAddresses, SendOnEod, IsActive)
VALUES (NULL, 'smtp.gmail.com', 587, 'pos@example.com', 'CHANGE_ME',
    'pos@example.com', 'owner@example.com', 0, 0);
GO
