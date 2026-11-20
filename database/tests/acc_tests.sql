/* =====================================================================
   Accounting engine tests (Addendum B, build step 2 + 4).

   Every batch runs inside a transaction that is ROLLED BACK — nothing is left behind,
   so this is safe to run against any DB that has 16_accounting.sql + 02_procedures.sql
   applied. Results come back in table variables (which survive a rollback).
   Engine tests use a throwaway CompanyId 9001; the End of Day tests must use CompanyId 1
   (what sp_ProcessEndOfDay posts to) and fake sales dated 2099-01-15.

   Each batch prints rows of (Test, Pass, Detail). Every Pass must be 1.
   Run: sqlcmd -S <server> -U <user> -P <pwd> -d TabletPOS -i tests/acc_tests.sql
   ===================================================================== */
SET NOCOUNT ON;
GO

/* ---------- 1. Setup: accounts, system keys, posting rules ---------- */
DECLARE @r TABLE (Test NVARCHAR(100), Pass BIT, Detail NVARCHAR(400));
BEGIN TRAN;
EXEC acc.sp_SetupCompany @CompanyId = 9001, @TemplateCode = 'WATER', @StartDate = '2026-01-01';

DECLARE @missing NVARCHAR(400) = (SELECT STRING_AGG(k, ',') FROM (VALUES
    ('CASH_ON_HAND'),('CASH_IN_BANK'),('CARD_RECEIVABLE'),('AR'),('INVENTORY'),('AP'),('VAT_OUTPUT'),
    ('VAT_INPUT'),('EWT_PAYABLE'),('SALES_VATABLE'),('SALES_EXEMPT'),('SALES_ZERORATED'),('SCPWD_DISCOUNT'),
    ('COGS'),('CASH_SHORT_OVER'),('INVENTORY_LOSS'),('OWNER_CAPITAL'),('OWNER_DRAWINGS'),
    ('RETAINED_EARNINGS'),('ROUNDING')) v(k)
    WHERE NOT EXISTS (SELECT 1 FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND SystemKey = v.k AND IsSystem = 1));
INSERT @r VALUES ('setup: all 20 spec SystemKeys present', CASE WHEN @missing IS NULL THEN 1 ELSE 0 END, ISNULL(@missing, 'ok'));
INSERT @r SELECT 'setup: water template adds Container Deposit Liability',
    CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END, CONCAT(COUNT(*), ' row(s)')
    FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND SystemKey = 'CONTAINER_DEPOSIT' AND AccountType = 'Liability';
INSERT @r SELECT 'setup: 10 ZREAD posting rules (38: GC)', CASE WHEN COUNT(*) = 10 THEN 1 ELSE 0 END, CONCAT(COUNT(*), ' rules')
    FROM acc.PostingRules WHERE CompanyId = 9001 AND SourceType = 'ZREAD';
BEGIN TRY
    EXEC acc.sp_SetupCompany @CompanyId = 9001, @TemplateCode = 'WATER', @StartDate = '2026-01-01';
    INSERT @r VALUES ('setup: second setup rejected', 0, 'no error');
END TRY BEGIN CATCH
    INSERT @r VALUES ('setup: second setup rejected', CASE WHEN ERROR_NUMBER() = 52011 THEN 1 ELSE 0 END, ERROR_MESSAGE());
END CATCH
IF @@TRANCOUNT > 0 ROLLBACK;
SELECT * FROM @r;
GO

/* ---------- 2. Balanced post, numbering, idempotency, reports ---------- */
DECLARE @r TABLE (Test NVARCHAR(100), Pass BIT, Detail NVARCHAR(400));
BEGIN TRAN;
EXEC acc.sp_SetupCompany @CompanyId = 9001, @TemplateCode = 'RETAIL', @StartDate = '2026-01-01';
DECLARE @cash INT = (SELECT AccountId FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND SystemKey = 'CASH_ON_HAND');
DECLARE @cap  INT = (SELECT AccountId FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND SystemKey = 'OWNER_CAPITAL');
DECLARE @L acc.TVP_JournalLine;
INSERT @L (Seq, AccountId, Debit, Credit) VALUES (1, @cash, 5000, 0), (2, @cap, 0, 5000);

DECLARE @e1 UNIQUEIDENTIFIER, @e2 UNIQUEIDENTIFIER, @e3 UNIQUEIDENTIFIER;
EXEC acc.sp_PostJournalEntry @CompanyId = 9001, @BranchCode = 'MAIN', @EntryDate = '2026-03-05', @Memo = 'Capital',
    @Lines = @L, @EntryUid = @e1 OUTPUT;
EXEC acc.sp_PostJournalEntry @CompanyId = 9001, @BranchCode = 'MAIN', @EntryDate = '2026-03-06',
    @SourceType = 'TEST', @SourceUid = 'abc', @Lines = @L, @EntryUid = @e2 OUTPUT;
EXEC acc.sp_PostJournalEntry @CompanyId = 9001, @BranchCode = 'MAIN', @EntryDate = '2026-03-06',
    @SourceType = 'TEST', @SourceUid = 'abc', @Lines = @L, @EntryUid = @e3 OUTPUT;

INSERT @r SELECT 'post: entry numbers are 1,2 (gapless, idempotent retry takes no number)',
    CASE WHEN STRING_AGG(CAST(EntryNo AS VARCHAR), ',') WITHIN GROUP (ORDER BY EntryNo) = '1,2' THEN 1 ELSE 0 END,
    STRING_AGG(CAST(EntryNo AS VARCHAR), ',') WITHIN GROUP (ORDER BY EntryNo)
    FROM acc.JournalEntries WHERE CompanyId = 9001;
INSERT @r VALUES ('post: same SourceType+SourceUid returns the existing entry',
    CASE WHEN @e2 = @e3 THEN 1 ELSE 0 END, CONCAT(@e2, ' / ', @e3));
INSERT @r SELECT 'post: lines copied with header branch and [LineNo] 1..n',
    CASE WHEN COUNT(*) = 2 AND MIN(BranchCode) = 'MAIN' AND MAX([LineNo]) = 2 THEN 1 ELSE 0 END, CONCAT(COUNT(*), ' lines')
    FROM acc.JournalLines WHERE EntryUid = @e1;
INSERT @r SELECT 'post: period row auto-created as Open',
    CASE WHEN Status = 'Open' THEN 1 ELSE 0 END, Status
    FROM acc.Periods WHERE CompanyId = 9001 AND PeriodYear = 2026 AND PeriodMonth = 3;

DECLARE @tb TABLE (AccountId INT, AccountCode VARCHAR(20), AccountName NVARCHAR(120), PlainName NVARCHAR(120),
    AccountType VARCHAR(10), TotalDebit DECIMAL(18,2), TotalCredit DECIMAL(18,2), Debit DECIMAL(18,2), Credit DECIMAL(18,2));
INSERT @tb EXEC acc.sp_rpt_TrialBalance @CompanyId = 9001, @AsOf = '2026-12-31';
INSERT @r SELECT 'trial balance: debits = credits = 10000',
    CASE WHEN SUM(Debit) = SUM(Credit) AND SUM(Debit) = 10000 THEN 1 ELSE 0 END, CONCAT(SUM(Debit), ' / ', SUM(Credit)) FROM @tb;
DELETE @tb;
INSERT @tb EXEC acc.sp_rpt_TrialBalance @CompanyId = 9001, @AsOf = '2026-03-05';
INSERT @r SELECT 'trial balance: AsOf excludes later entries',
    CASE WHEN SUM(Debit) = 5000 THEN 1 ELSE 0 END, CONCAT(SUM(Debit), '') FROM @tb;
DELETE @tb;
INSERT @tb EXEC acc.sp_rpt_TrialBalance @CompanyId = 9001, @AsOf = '2026-12-31', @BranchCode = 'LAP';
INSERT @r SELECT 'trial balance: branch filter', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END, CONCAT(COUNT(*), ' rows') FROM @tb;

DECLARE @gl TABLE (EntryUid UNIQUEIDENTIFIER, EntryNo BIGINT, EntryDate DATE, EntryType VARCHAR(12), SourceType VARCHAR(20),
    SourceUid VARCHAR(50), EntryMemo NVARCHAR(300), [LineNo] INT, BranchCode VARCHAR(10), Debit DECIMAL(18,2),
    Credit DECIMAL(18,2), Memo NVARCHAR(200), Balance DECIMAL(18,2));
/* sp_rpt_GeneralLedger returns two result sets; INSERT...EXEC can't take that, so check the running balance directly. */
INSERT @gl
SELECT e.EntryUid, e.EntryNo, e.EntryDate, e.EntryType, e.SourceType, e.SourceUid, e.Memo, l.[LineNo], l.BranchCode,
       l.Debit, l.Credit, l.Memo, SUM(l.Debit - l.Credit) OVER (ORDER BY e.EntryDate, e.EntryNo, l.[LineNo] ROWS UNBOUNDED PRECEDING)
FROM acc.JournalLines l JOIN acc.JournalEntries e ON e.EntryUid = l.EntryUid WHERE l.AccountId = @cash;
INSERT @r SELECT 'ledger: cash running balance ends at 10000',
    CASE WHEN MAX(Balance) = 10000 THEN 1 ELSE 0 END, CONCAT(MAX(Balance), '') FROM @gl;
IF @@TRANCOUNT > 0 ROLLBACK;
SELECT * FROM @r;
GO

/* ---------- 3. Validation failures (each in its own rolled-back transaction) ---------- */
DECLARE @r TABLE (Test NVARCHAR(100), Pass BIT, Detail NVARCHAR(400));
DECLARE @case INT = 1, @expect INT, @name NVARCHAR(100);
WHILE @case <= 6
BEGIN
    BEGIN TRAN;
    EXEC acc.sp_SetupCompany @CompanyId = 9001, @TemplateCode = 'RETAIL', @StartDate = '2026-01-01';
    DECLARE @cash INT = (SELECT AccountId FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND SystemKey = 'CASH_ON_HAND');
    DECLARE @cap  INT = (SELECT AccountId FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND SystemKey = 'OWNER_CAPITAL');
    DECLARE @misc INT = (SELECT AccountId FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND AccountCode = '6900');
    DECLARE @L acc.TVP_JournalLine;
    DELETE @L;
    DECLARE @co INT = 9001;
    IF @case = 1 BEGIN SET @name = 'reject: unbalanced entry';        SET @expect = 52005;
        INSERT @L (Seq, AccountId, Debit, Credit) VALUES (1, @cash, 100, 0), (2, @cap, 0, 99.99); END
    IF @case = 2 BEGIN SET @name = 'reject: single line';             SET @expect = 52002;
        INSERT @L (Seq, AccountId, Debit, Credit) VALUES (1, @cash, 100, 0); END
    IF @case = 3 BEGIN SET @name = 'reject: line with both sides';    SET @expect = 52003;
        INSERT @L (Seq, AccountId, Debit, Credit) VALUES (1, @cash, 100, 100), (2, @cap, 0, 0); END
    IF @case = 4 BEGIN SET @name = 'reject: negative amount';         SET @expect = 52003;
        INSERT @L (Seq, AccountId, Debit, Credit) VALUES (1, @cash, -100, 0), (2, @cap, -100, 0); END
    IF @case = 5 BEGIN SET @name = 'reject: inactive account';        SET @expect = 52004;
        UPDATE acc.ChartOfAccounts SET IsActive = 0 WHERE AccountId = @misc;
        INSERT @L (Seq, AccountId, Debit, Credit) VALUES (1, @misc, 100, 0), (2, @cap, 0, 100); END
    IF @case = 6 BEGIN SET @name = 'reject: company without accounting'; SET @expect = 52001; SET @co = 9002;
        INSERT @L (Seq, AccountId, Debit, Credit) VALUES (1, @cash, 100, 0), (2, @cap, 0, 100); END
    BEGIN TRY
        EXEC acc.sp_PostJournalEntry @CompanyId = @co, @EntryDate = '2026-03-05', @Lines = @L;
        INSERT @r VALUES (@name, 0, 'no error');
    END TRY BEGIN CATCH
        INSERT @r VALUES (@name, CASE WHEN ERROR_NUMBER() = @expect THEN 1 ELSE 0 END, ERROR_MESSAGE());
    END CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SET @case += 1;
END
SELECT * FROM @r;
GO

/* ---------- 4. Periods: closed rejects, reopen works, locked is final ---------- */
DECLARE @r TABLE (Test NVARCHAR(100), Pass BIT, Detail NVARCHAR(400));
BEGIN TRAN;
EXEC acc.sp_SetupCompany @CompanyId = 9001, @TemplateCode = 'RETAIL', @StartDate = '2026-01-01';
DECLARE @cash INT = (SELECT AccountId FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND SystemKey = 'CASH_ON_HAND');
DECLARE @cap  INT = (SELECT AccountId FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND SystemKey = 'OWNER_CAPITAL');
DECLARE @L acc.TVP_JournalLine;
INSERT @L (Seq, AccountId, Debit, Credit) VALUES (1, @cash, 100, 0), (2, @cap, 0, 100);
EXEC acc.sp_SetPeriodStatus @CompanyId = 9001, @PeriodYear = 2026, @PeriodMonth = 2, @Status = 'Closed';
EXEC acc.sp_SetPeriodStatus @CompanyId = 9001, @PeriodYear = 2026, @PeriodMonth = 2, @Status = 'Open';
EXEC acc.sp_PostJournalEntry @CompanyId = 9001, @EntryDate = '2026-02-10', @Lines = @L;
INSERT @r SELECT 'period: reopened period accepts posting', CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END, CONCAT(COUNT(*), ' entries')
    FROM acc.JournalEntries WHERE CompanyId = 9001;
IF @@TRANCOUNT > 0 ROLLBACK;

BEGIN TRAN;
EXEC acc.sp_SetupCompany @CompanyId = 9001, @TemplateCode = 'RETAIL', @StartDate = '2026-01-01';
SET @cash = (SELECT AccountId FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND SystemKey = 'CASH_ON_HAND');
SET @cap  = (SELECT AccountId FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND SystemKey = 'OWNER_CAPITAL');
DELETE @L; INSERT @L (Seq, AccountId, Debit, Credit) VALUES (1, @cash, 100, 0), (2, @cap, 0, 100);
EXEC acc.sp_SetPeriodStatus @CompanyId = 9001, @PeriodYear = 2026, @PeriodMonth = 2, @Status = 'Closed';
BEGIN TRY
    EXEC acc.sp_PostJournalEntry @CompanyId = 9001, @EntryDate = '2026-02-10', @Lines = @L;
    INSERT @r VALUES ('period: closed period rejects posting', 0, 'no error');
END TRY BEGIN CATCH
    INSERT @r VALUES ('period: closed period rejects posting', CASE WHEN ERROR_NUMBER() = 52006 THEN 1 ELSE 0 END, ERROR_MESSAGE());
END CATCH
IF @@TRANCOUNT > 0 ROLLBACK;

BEGIN TRAN;
EXEC acc.sp_SetupCompany @CompanyId = 9001, @TemplateCode = 'RETAIL', @StartDate = '2026-01-01';
EXEC acc.sp_SetPeriodStatus @CompanyId = 9001, @PeriodYear = 2026, @PeriodMonth = 2, @Status = 'Locked';
BEGIN TRY
    EXEC acc.sp_SetPeriodStatus @CompanyId = 9001, @PeriodYear = 2026, @PeriodMonth = 2, @Status = 'Open';
    INSERT @r VALUES ('period: locked period cannot be reopened', 0, 'no error');
END TRY BEGIN CATCH
    INSERT @r VALUES ('period: locked period cannot be reopened', CASE WHEN ERROR_NUMBER() = 52031 THEN 1 ELSE 0 END, ERROR_MESSAGE());
END CATCH
IF @@TRANCOUNT > 0 ROLLBACK;
SELECT * FROM @r;
GO

/* ---------- 5. Reversal ---------- */
DECLARE @r TABLE (Test NVARCHAR(100), Pass BIT, Detail NVARCHAR(400));
DECLARE @step INT = 1;
WHILE @step <= 3
BEGIN
    BEGIN TRAN;
    EXEC acc.sp_SetupCompany @CompanyId = 9001, @TemplateCode = 'RETAIL', @StartDate = '2026-01-01';
    DECLARE @cash INT = (SELECT AccountId FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND SystemKey = 'CASH_ON_HAND');
    DECLARE @cap  INT = (SELECT AccountId FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND SystemKey = 'OWNER_CAPITAL');
    DECLARE @L acc.TVP_JournalLine; DELETE @L;
    INSERT @L (Seq, AccountId, Debit, Credit) VALUES (1, @cash, 250, 0), (2, @cap, 0, 250);
    DECLARE @orig UNIQUEIDENTIFIER, @rev UNIQUEIDENTIFIER, @again UNIQUEIDENTIFIER;
    EXEC acc.sp_PostJournalEntry @CompanyId = 9001, @EntryDate = '2026-03-05', @SourceType = 'TEST', @SourceUid = 'r1',
        @Lines = @L, @EntryUid = @orig OUTPUT;
    EXEC acc.sp_ReverseJournalEntry @CompanyId = 9001, @EntryUid = @orig, @ReversalDate = '2026-03-07', @NewEntryUid = @rev OUTPUT;
    IF @step = 1
    BEGIN
        INSERT @r SELECT 'reverse: mirror lines (debits and credits swapped)',
            CASE WHEN SUM(CASE WHEN AccountId = @cash THEN Credit ELSE 0 END) = 250
                  AND SUM(CASE WHEN AccountId = @cap THEN Debit ELSE 0 END) = 250 THEN 1 ELSE 0 END, 'checked'
            FROM acc.JournalLines WHERE EntryUid = @rev;
        INSERT @r SELECT 'reverse: original stamped ReversedByUid', CASE WHEN ReversedByUid = @rev THEN 1 ELSE 0 END, 'checked'
            FROM acc.JournalEntries WHERE EntryUid = @orig;
        INSERT @r SELECT 'reverse: account nets to zero', CASE WHEN SUM(Debit - Credit) = 0 THEN 1 ELSE 0 END, CONCAT(SUM(Debit - Credit), '')
            FROM acc.JournalLines WHERE AccountId = @cash;
        EXEC acc.sp_PostJournalEntry @CompanyId = 9001, @EntryDate = '2026-03-08', @SourceType = 'TEST', @SourceUid = 'r1',
            @Lines = @L, @EntryUid = @again OUTPUT;
        INSERT @r VALUES ('reverse: source can be re-posted after reversal',
            CASE WHEN @again IS NOT NULL AND @again <> @orig THEN 1 ELSE 0 END, CONCAT(@again, ''));
    END
    BEGIN TRY
        IF @step = 2 EXEC acc.sp_ReverseJournalEntry @CompanyId = 9001, @EntryUid = @orig;
        IF @step = 3 EXEC acc.sp_ReverseJournalEntry @CompanyId = 9001, @EntryUid = @rev;
        IF @step > 1 INSERT @r VALUES (CASE @step WHEN 2 THEN 'reverse: twice rejected' ELSE 'reverse: reversing a reversal rejected' END, 0, 'no error');
    END TRY BEGIN CATCH
        INSERT @r VALUES (CASE @step WHEN 2 THEN 'reverse: twice rejected' ELSE 'reverse: reversing a reversal rejected' END,
            CASE WHEN ERROR_NUMBER() = CASE @step WHEN 2 THEN 52021 ELSE 52022 END THEN 1 ELSE 0 END, ERROR_MESSAGE());
    END CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SET @step += 1;
END
SELECT * FROM @r;
GO

/* ---------- 6. Immutability triggers ---------- */
DECLARE @r TABLE (Test NVARCHAR(100), Pass BIT, Detail NVARCHAR(400));
DECLARE @step INT = 1;
WHILE @step <= 4
BEGIN
    BEGIN TRAN;
    EXEC acc.sp_SetupCompany @CompanyId = 9001, @TemplateCode = 'RETAIL', @StartDate = '2026-01-01';
    DECLARE @cash INT = (SELECT AccountId FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND SystemKey = 'CASH_ON_HAND');
    DECLARE @cap  INT = (SELECT AccountId FROM acc.ChartOfAccounts WHERE CompanyId = 9001 AND SystemKey = 'OWNER_CAPITAL');
    DECLARE @L acc.TVP_JournalLine; DELETE @L;
    INSERT @L (Seq, AccountId, Debit, Credit) VALUES (1, @cash, 10, 0), (2, @cap, 0, 10);
    DECLARE @e UNIQUEIDENTIFIER;
    EXEC acc.sp_PostJournalEntry @CompanyId = 9001, @EntryDate = '2026-03-05', @Lines = @L, @EntryUid = @e OUTPUT;
    DECLARE @name NVARCHAR(100) = CASE @step WHEN 1 THEN 'guard: journal line cannot be edited'
        WHEN 2 THEN 'guard: journal entry cannot be deleted' WHEN 3 THEN 'guard: journal entry cannot be edited'
        ELSE 'guard: system account cannot be deleted' END;
    DECLARE @expect INT = CASE @step WHEN 1 THEN 52103 WHEN 2 THEN 52104 WHEN 3 THEN 52105 ELSE 52101 END;
    BEGIN TRY
        IF @step = 1 UPDATE acc.JournalLines SET Debit = 11 WHERE EntryUid = @e AND Debit > 0;
        IF @step = 2 DELETE acc.JournalEntries WHERE EntryUid = @e;
        IF @step = 3 UPDATE acc.JournalEntries SET EntryDate = '2026-03-06' WHERE EntryUid = @e;
        IF @step = 4 BEGIN
            DELETE acc.PostingRules WHERE CompanyId = 9001;
            DELETE acc.ChartOfAccounts WHERE AccountId = (SELECT AccountId FROM acc.ChartOfAccounts
                WHERE CompanyId = 9001 AND SystemKey = 'SALES_EXEMPT');
        END
        INSERT @r VALUES (@name, 0, 'no error');
    END TRY BEGIN CATCH
        /* Deleting an entry is stopped by the FK from its (undeletable) lines before the
           trigger even runs — either guard is a pass. */
        INSERT @r VALUES (@name, CASE WHEN ERROR_NUMBER() = @expect OR (@step = 2 AND ERROR_NUMBER() = 547)
                                      THEN 1 ELSE 0 END, ERROR_MESSAGE());
    END CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    SET @step += 1;
END
SELECT * FROM @r;
GO

/* ---------- 7. End of Day → ledger (full path through sp_UpsertSale, blind close, EOD) ----------
   Four sales on 2099-01-15 exercising every bucket:
     A regular vatable 112, cash 200 / change 88   → vatable 100, VAT 12
     B SENIOR VAT-exempt 20% on 112, card 80       → exempt 100 (pre-discount), discount 20
     C 5% non-exempt discount on 112, cash 106.40  → vatable 95, VAT 11.40, discount 5
     D non-vatable 50, cash 50                     → zero-rated 50
     E voided 999 (must be ignored)
   Drawer declared 10 short. Expected entry:
     Dr Cash 268.40  Dr Card 80  Dr Discount 25  Dr Short/Over 10
     Cr Sales-Vatable 200 (195 + the 5 discount)  Cr VAT 23.40  Cr Exempt 100  Cr Zero 50  Cr Cash 10 */
DECLARE @r TABLE (Test NVARCHAR(100), Pass BIT, Detail NVARCHAR(400));
DECLARE @scenario INT = 1;
WHILE @scenario <= 3   -- 1: accounting on, happy path; 2: accounting off; 3: period closed
BEGIN
    BEGIN TRAN;
    DECLARE @term INT, @branch VARCHAR(10), @user INT = (SELECT TOP 1 UserId FROM dbo.Users ORDER BY UserId);
    -- End of Day refuses a day while an earlier one on the terminal is unclosed (51013), so use a
    -- terminal that has no real day left unclosed.
    SET @term = NULL;   -- a DECLARE inside a loop keeps the last value
    SELECT TOP 1 @term = TerminalId, @branch = BranchCode FROM dbo.Terminals t
    WHERE NOT EXISTS (SELECT 1 FROM dbo.Shifts s WHERE s.TerminalId = t.TerminalId
        AND NOT EXISTS (SELECT 1 FROM dbo.ZReads z WHERE z.TerminalId = s.TerminalId AND z.BusinessDate = s.BusinessDate))
    ORDER BY TerminalId;
    IF @term IS NULL   -- every real terminal has a day left open: use a throwaway one (rolled back)
    BEGIN
        SELECT TOP 1 @branch = BranchCode FROM dbo.Branches WHERE IsActive = 1 ORDER BY BranchCode;
        INSERT dbo.Terminals (BranchCode, TerminalCode, TerminalName) VALUES (@branch, 'ZZ-TEST', N'ZZTEST terminal');
        SET @term = SCOPE_IDENTITY();
    END
    DECLARE @d DATE = '2099-01-15', @shift UNIQUEIDENTIFIER = NEWID();
    DECLARE @prod INT, @cat INT;
    SELECT TOP 1 @prod = ProductId, @cat = CategoryId FROM dbo.Products ORDER BY ProductId;

    IF @scenario IN (1, 3) AND NOT EXISTS (SELECT 1 FROM acc.Settings WHERE CompanyId = 1)
        EXEC acc.sp_SetupCompany @CompanyId = 1, @TemplateCode = 'RETAIL', @StartDate = '2026-01-01';
    IF @scenario = 2 AND EXISTS (SELECT 1 FROM acc.Settings WHERE CompanyId = 1)
        UPDATE acc.Settings SET IsEnabled = 0 WHERE CompanyId = 1;
    IF @scenario = 3
        EXEC acc.sp_SetPeriodStatus @CompanyId = 1, @PeriodYear = 2099, @PeriodMonth = 1, @Status = 'Closed';

    INSERT INTO dbo.Shifts (ShiftUid, BranchCode, TerminalId, CashierUserId, BusinessDate, CashBegin, OpenedAt)
    VALUES (@shift, @branch, @term, @user, @d, 1000, SYSDATETIME());

    DECLARE @i dbo.TVP_SaleItem, @p dbo.TVP_SalePayment, @u UNIQUEIDENTIFIER, @now DATETIME2 = SYSDATETIME();
    DELETE @i; DELETE @p; SET @u = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice, LineDiscount, LineTotal, IsVatable, IsDiscountable) VALUES (1, @prod, 'T1', 'Test A', @cat, 1, 112, 112, 0, 112, 1, 1);
    INSERT @p VALUES (1, 'CASH', 200, NULL, NULL, NULL, NULL);
    EXEC dbo.sp_UpsertSale @SaleUid=@u, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=909000001, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=100, @VatAmount=12, @ZeroRatedAmount=0, @NetAmount=112,
        @TenderedAmount=200, @ChangeAmount=88, @Items=@i, @Payments=@p;

    DELETE @i; DELETE @p; SET @u = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice, LineDiscount, LineTotal, IsVatable, IsDiscountable) VALUES (1, @prod, 'T2', 'Test B', @cat, 1, 112, 112, 20, 80, 1, 1);
    INSERT @p VALUES (1, 'CARD', 80, '1234', 'BDO', 'REF', 'TEST');
    EXEC dbo.sp_UpsertSale @SaleUid=@u, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=909000002, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=20,
        @VatExemptAmount=100, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=0, @NetAmount=80,
        @TenderedAmount=80, @ChangeAmount=0, @DiscountCode='SENIOR', @Items=@i, @Payments=@p;

    DELETE @i; DELETE @p; SET @u = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice, LineDiscount, LineTotal, IsVatable, IsDiscountable) VALUES (1, @prod, 'T3', 'Test C', @cat, 1, 112, 112, 5, 106.40, 1, 1);
    INSERT @p VALUES (1, 'CASH', 106.40, NULL, NULL, NULL, NULL);
    EXEC dbo.sp_UpsertSale @SaleUid=@u, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=909000003, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=112, @DiscountAmount=5,
        @VatExemptAmount=0, @VatableAmount=95, @VatAmount=11.40, @ZeroRatedAmount=0, @NetAmount=106.40,
        @TenderedAmount=106.40, @ChangeAmount=0, @DiscountCode='SENIOR', @VatAdjustment=0.60, @Items=@i, @Payments=@p;

    DELETE @i; DELETE @p; SET @u = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice, LineDiscount, LineTotal, IsVatable, IsDiscountable) VALUES (1, @prod, 'T4', 'Test D', @cat, 1, 50, 50, 0, 50, 0, 0);
    INSERT @p VALUES (1, 'CASH', 50, NULL, NULL, NULL, NULL);
    EXEC dbo.sp_UpsertSale @SaleUid=@u, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=909000004, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=50, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=0, @VatAmount=0, @ZeroRatedAmount=50, @NetAmount=50,
        @TenderedAmount=50, @ChangeAmount=0, @Items=@i, @Payments=@p;

    DELETE @i; DELETE @p; SET @u = NEWID();
    INSERT @i ([LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice, OrigUnitPrice, LineDiscount, LineTotal, IsVatable, IsDiscountable) VALUES (1, @prod, 'T5', 'Test E', @cat, 1, 999, 999, 0, 999, 1, 1);
    INSERT @p VALUES (1, 'CASH', 999, NULL, NULL, NULL, NULL);
    EXEC dbo.sp_UpsertSale @SaleUid=@u, @ShiftUid=@shift, @BranchCode=@branch, @TerminalId=@term, @CashierUserId=@user,
        @ORNumber=909000005, @BusinessDate=@d, @SaleDateTime=@now, @GrossAmount=999, @DiscountAmount=0,
        @VatExemptAmount=0, @VatableAmount=891.96, @VatAmount=107.04, @ZeroRatedAmount=0, @NetAmount=999,
        @TenderedAmount=999, @ChangeAmount=0, @Status='Voided', @Items=@i, @Payments=@p;

    EXEC dbo.sp_ProcessBlindClose @ShiftUid=@shift, @DeclaredCash=1258.40, @DenominationsJson=N'{}';

    BEGIN TRY
        EXEC dbo.sp_ProcessEndOfDay @TerminalId=@term, @BusinessDate=@d, @ClosedByUserId=@user, @ApprovedByUserId=@user;
    END TRY BEGIN CATCH
        IF @scenario = 3
            INSERT @r VALUES ('eod: closed period blocks End of Day', CASE WHEN ERROR_NUMBER() = 52006 THEN 1 ELSE 0 END, ERROR_MESSAGE());
        ELSE
            INSERT @r VALUES (CONCAT('eod scenario ', @scenario, ': unexpected error'), 0, ERROR_MESSAGE());
    END CATCH

    IF XACT_STATE() = 1
    BEGIN
        DECLARE @zid VARCHAR(50) = (SELECT CONVERT(VARCHAR(50), ZReadId) FROM dbo.ZReads WHERE TerminalId=@term AND BusinessDate=@d);
        DECLARE @entry UNIQUEIDENTIFIER = (SELECT EntryUid FROM acc.JournalEntries
            WHERE CompanyId = 1 AND SourceType = 'ZREAD' AND SourceUid = @zid);
        IF @scenario = 1
        BEGIN
            DECLARE @got NVARCHAR(MAX) = (
                SELECT STRING_AGG(CONCAT(a.SystemKey, ':', CASE WHEN l.Debit > 0 THEN 'Dr' ELSE 'Cr' END,
                                         CAST(l.Debit + l.Credit AS VARCHAR(20))), ' ') WITHIN GROUP (ORDER BY l.[LineNo])
                FROM acc.JournalLines l JOIN acc.ChartOfAccounts a ON a.AccountId = l.AccountId WHERE l.EntryUid = @entry);
            DECLARE @want NVARCHAR(MAX) = 'CASH_ON_HAND:Dr268.40 CARD_RECEIVABLE:Dr80.00 SCPWD_DISCOUNT:Dr25.00 '
                + 'SALES_VATABLE:Cr200.00 VAT_OUTPUT:Cr23.40 SALES_EXEMPT:Cr100.00 SALES_ZERORATED:Cr50.00 '
                + 'CASH_SHORT_OVER:Dr10.00 CASH_ON_HAND:Cr10.00';
            INSERT @r VALUES ('eod: posts the expected summary entry', CASE WHEN @got = @want THEN 1 ELSE 0 END, ISNULL(@got, 'no entry'));
            INSERT @r SELECT 'eod: entry balances and is dated the business date',
                CASE WHEN TotalAmount = 383.40 AND EntryDate = @d AND EntryType = 'Auto' THEN 1 ELSE 0 END,
                CONCAT(TotalAmount, ' on ', EntryDate, ' — ', Memo)
                FROM acc.JournalEntries WHERE EntryUid = @entry;
            EXEC acc.sp_PostZReadToLedger @ZReadId = @zid;
            INSERT @r SELECT 'eod: re-posting the same Z-Read is a no-op', CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END, CONCAT(COUNT(*), ' entries')
                FROM acc.JournalEntries WHERE CompanyId = 1 AND SourceType = 'ZREAD' AND SourceUid = @zid;
        END
        IF @scenario = 2
            INSERT @r VALUES ('eod: accounting off -> EOD succeeds, nothing posted',
                CASE WHEN @zid IS NOT NULL AND @entry IS NULL THEN 1 ELSE 0 END, CONCAT('ZRead ', @zid));
        IF @scenario = 3
            INSERT @r VALUES ('eod: closed period blocks End of Day', 0, 'EOD succeeded');
    END
    IF @@TRANCOUNT > 0 ROLLBACK;
    SET @scenario += 1;
END
SELECT * FROM @r;
GO
