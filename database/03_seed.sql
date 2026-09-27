/* =====================================================================
   TabletPOS v2 — Seed data
   Passwords are fixed up automatically by the API on first startup:
     admin / admin123   ·   super / super123   ·   cashier / cashier123
   ===================================================================== */

IF NOT EXISTS (SELECT 1 FROM dbo.Branches)
INSERT INTO dbo.Branches (BranchCode, BranchName, Tin, BirBranchCode, Address) VALUES
('MAIN', 'Main Branch - Cebu City', '123-456-789-0000', '0000', '123 Market St, Cebu City'),
('MDU',  'Mandaue Branch',          '123-456-789-0001', '0001', 'Ouano Ave, Mandaue City'),
('LAP',  'Lapu-Lapu Branch',        '123-456-789-0002', '0002', 'ML Quezon Ave, Lapu-Lapu City');

IF NOT EXISTS (SELECT 1 FROM dbo.Users)
INSERT INTO dbo.Users (Username, PasswordHash, PasswordSalt, FullName, Role) VALUES
('admin',   'SEEDPWD', 'seedsaltadmin',   'System Administrator', 'Admin'),
('super',   'SEEDPWD', 'seedsaltsuper',   'Roberto Lim',          'Supervisor'),
('cashier', 'SEEDPWD', 'seedsaltcashier', 'Maria Santos',         'Cashier');

IF NOT EXISTS (SELECT 1 FROM dbo.UserBranches)
INSERT INTO dbo.UserBranches (UserId, BranchCode)
SELECT u.UserId, b.BranchCode FROM dbo.Users u CROSS JOIN dbo.Branches b
WHERE u.Username IN ('super','cashier');

IF NOT EXISTS (SELECT 1 FROM dbo.DiscountTypes)
INSERT INTO dbo.DiscountTypes (DiscountCode, Description, Rate, IsVatExempt, LegalBasis) VALUES
('SENIOR', 'Senior Citizen',   0.2000, 1, 'RA 9994'),
('PWD',    'Person With Disability', 0.2000, 1, 'RA 10754'),
('NAAC',   'National Athlete / Coach', 0.2000, 1, 'RA 10699'),
('MOV',    'Medal of Valor',   0.2000, 1, 'RA 9049'),
('SOLO',   'Solo Parent',      0.1000, 1, 'RA 11861');

IF NOT EXISTS (SELECT 1 FROM dbo.Categories)
INSERT INTO dbo.Categories (CategoryName) VALUES
('Pork'), ('Beef'), ('Chicken'), ('Processed'), ('Others');

IF NOT EXISTS (SELECT 1 FROM dbo.Products)
INSERT INTO dbo.Products (Barcode, ProductName, CategoryId, Unit, BasePrice, Cost, IsVatable, IsDiscountable, AllowPriceEdit) VALUES
('4800001','Pork Belly (Liempo) 1kg', 1, 'kg',  380.00, 300.00, 1, 1, 1),
('4800002','Pork Chop 1kg',           1, 'kg',  320.00, 255.00, 1, 1, 1),
('4800003','Ground Pork 1kg',         1, 'kg',  300.00, 240.00, 1, 1, 0),
('4800004','Beef Brisket 1kg',        2, 'kg',  480.00, 390.00, 1, 1, 1),
('4800005','Beef Cubes 1kg',          2, 'kg',  450.00, 365.00, 1, 1, 0),
('4800006','Whole Chicken 1kg',       3, 'kg',  195.00, 155.00, 1, 1, 0),
('4800007','Chicken Breast 1kg',      3, 'kg',  240.00, 190.00, 1, 1, 0),
('4800008','Chicken Wings 1kg',       3, 'kg',  220.00, 175.00, 1, 1, 0),
('4800009','Hotdog Jumbo 1kg',        4, 'pack',185.00, 145.00, 1, 0, 0),
('4800010','Tocino 500g',             4, 'pack',145.00, 112.00, 1, 0, 0),
('4800011','Longganisa 500g',         4, 'pack',135.00, 105.00, 1, 0, 0),
('4800012','Bacon 250g',              4, 'pack',165.00, 128.00, 1, 0, 0),
('4800013','Chicharon 100g',          5, 'pack', 85.00,  62.00, 1, 0, 0),
('4800014','Ice 1kg',                 5, 'pack', 25.00,  15.00, 0, 0, 0);

/* Branch overrides: only where the price actually differs from base */
IF NOT EXISTS (SELECT 1 FROM dbo.ProductPrices)
INSERT INTO dbo.ProductPrices (ProductId, BranchCode, Price)
SELECT p.ProductId, v.BranchCode, v.Price
FROM (VALUES
    ('4800001','MDU',385.00), ('4800001','LAP',395.00),
    ('4800002','LAP',330.00),
    ('4800004','LAP',500.00),
    ('4800006','LAP',205.00),
    ('4800014','LAP',28.00)
) v(Barcode, BranchCode, Price)
JOIN dbo.Products p ON p.Barcode = v.Barcode;

IF NOT EXISTS (SELECT 1 FROM dbo.Terminals)
INSERT INTO dbo.Terminals (BranchCode, TerminalCode, TerminalName, PrinterTarget,
    Tin, AccreditationNo, SerialNo, PermitNo, MinNo, PermitEffective) VALUES
('MAIN','POS-01','Counter 1','tcp://127.0.0.1:9100',
 '123-456-789-0000','043-123456789-000012','M1-2026-0001','FP012026-001','08012026123456789','2026-01-08'),
('MAIN','POS-02','Counter 2', NULL,
 '123-456-789-0000','043-123456789-000013','M1-2026-0002','FP012026-002','08012026123456790','2026-01-08'),
('MDU','POS-01','Mandaue Counter 1','tcp://127.0.0.1:9100',
 '123-456-789-0001','043-123456789-000021','M2-2026-0001','FP012026-011','08012026123456791','2026-01-15');

IF NOT EXISTS (SELECT 1 FROM dbo.PosSettings)
INSERT INTO dbo.PosSettings (BranchCode, PosType, StoreHeader1, StoreHeader2, ReceiptFooter)
SELECT BranchCode, 'Retail', 'TABLETPOS MEAT SHOP', BranchName, 'Thank you! Please come again.'
FROM dbo.Branches;

IF NOT EXISTS (SELECT 1 FROM dbo.ORRanges)
INSERT INTO dbo.ORRanges (BranchCode, TerminalId, RangeStart, RangeEnd)
SELECT BranchCode, TerminalId,
       100000 + (ROW_NUMBER() OVER (ORDER BY TerminalId) - 1) * 1000 + 1,
       100000 + (ROW_NUMBER() OVER (ORDER BY TerminalId) - 1) * 1000 + 500
FROM dbo.Terminals;

IF NOT EXISTS (SELECT 1 FROM dbo.EmailConfig)
INSERT INTO dbo.EmailConfig (BranchCode, SmtpHost, SmtpPort, SmtpUser, SmtpPassword,
    FromAddress, ToAddresses, SendOnEod, IsActive)
VALUES (NULL, 'smtp.gmail.com', 587, 'pos@example.com', 'CHANGE_ME',
    'pos@example.com', 'owner@example.com', 0, 0);
GO
