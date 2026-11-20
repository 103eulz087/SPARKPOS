using System.Data;
using Dapper;
using Microsoft.Data.SqlClient;

namespace PosApi.Services;

/// Step 4.1: sends queued sales and voids (dbo.ErpOutbox, filled by sp_UpsertSale and the void
/// endpoint for terminals with PostToErp = 1) to the CORECS ERP's dbo.spu_SparkPOS_PostSale /
/// spu_SparkPOS_VoidSale. Posting order is kept per terminal: when an entry has to be retried,
/// later entries of that terminal wait, so a void never reaches the ERP before its sale.
///   retry, no limit — ERP 61100 (sale to void not posted yet), 59800-59806 (stock engine),
///            deadlock 1205, timeouts and connection errors: they clear up by themselves
///   retry, then fail — any other unexpected error (e.g. 8152 string too long, 515, 547):
///            MaxOtherRetries tries with backoff (about an hour), then "needs attention", so a
///            permanent error never blocks the terminal's queue for good
///   failed — the ERP's other business errors (50000+, e.g. 61110-61120): listed in Admin as
///            "needs attention", with a Retry button once the cause is fixed
/// The ERP's buckets must add up exactly to what was paid, per line and per header, so the
/// VAT-exempt figure sent is the remainder (paid − VATable − VAT − zero-rated) — for an SC/PWD
/// line that's the amount after the discount, where SparkPOS's own BIR figure is the base
/// before it. The discount sent is gross − paid (the VAT removed included), per the ERP.
public class ErpPostingService(Db db, ErpDb erp, ILogger<ErpPostingService> log)
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private const int CallTimeoutSeconds = 60;
    private const int MaxOtherRetries = 10;

    /// Errors that clear up by themselves: retried for as long as it takes.
    private static readonly HashSet<int> Transient =
        [1205, -2, -1, 2, 53, 64, 121, 233, 4060, 10053, 10054, 10060, 11001, 40613, 61100, 61101, 61102];

    private class OutboxRow
    {
        public long OutboxId { get; set; }
        public string Kind { get; set; } = "";
        public Guid RefUid { get; set; }
        public int TerminalId { get; set; }
        public int Attempts { get; set; }
    }

    /// Thrown for problems found on our side before calling the ERP (nothing to retry).
    private class NotPostable(string message) : Exception(message);

    public async Task<int> RunOnceAsync(CancellationToken stop = default)
    {
        if (!erp.IsConfigured || !await Gate.WaitAsync(0, stop)) return 0;
        try
        {
            using var con = db.Open();
            var due = (await con.QueryAsync<OutboxRow>(
                @"SELECT TOP 200 OutboxId, Kind, RefUid, TerminalId, Attempts FROM dbo.ErpOutbox
                  WHERE Status = 'Pending' AND NextAttemptAt <= SYSDATETIME() ORDER BY OutboxId")).ToList();
            // Earlier entries still waiting for a retry hold back later ones of the same terminal.
            var held = (await con.QueryAsync<int>(
                @"SELECT DISTINCT TerminalId FROM dbo.ErpOutbox
                  WHERE Status = 'Pending' AND NextAttemptAt > SYSDATETIME()")).ToHashSet();
            var done = 0;
            foreach (var row in due)
            {
                if (stop.IsCancellationRequested || held.Contains(row.TerminalId)) continue;
                if (!await PostOneAsync(con, row)) held.Add(row.TerminalId);
                done++;
            }
            return done;
        }
        finally { Gate.Release(); }
    }

    /// Returns false when the entry has to be retried (the terminal's later entries wait).
    private async Task<bool> PostOneAsync(IDbConnection con, OutboxRow row)
    {
        try
        {
            dynamic result = row.Kind switch
            {
                "OPEN" => await PostOpenAsync(con, row.RefUid),
                "SALE" => await PostSaleAsync(con, row),
                "VOID" => await PostVoidAsync(con, row.RefUid),
                "RETURN" => await PostReturnAsync(con, row.RefUid),
                "CLOSE" => await PostCloseAsync(con, row.RefUid),
                "ZREAD" => await PostZReadAsync(con, row.RefUid),
                _ => throw new NotPostable($"Unknown queue entry kind {row.Kind}.")
            };
            await con.ExecuteAsync(
                @"UPDATE dbo.ErpOutbox SET Status = 'Posted', PostedAt = SYSDATETIME(), Attempts = Attempts + 1,
                    ErpResult = @r, ShortLines = @s, NeedsReview = @n, ErpMessage = @m, LastError = NULL, LastErrorNumber = NULL
                  WHERE OutboxId = @id",
                new { r = (string)result.Result, s = (int?)TryGet(result, "ShortLines"), n = (bool?)TryGet(result, "NeedsReview"),
                      m = (string?)TryGet(result, "Message"), id = row.OutboxId });
            return true;
        }
        catch (NotPostable ex) { await FailAsync(con, row, null, ex.Message); return true; }
        catch (SqlException ex) when (IsPermanent(ex.Number)
                                       || (!IsTransient(ex.Number) && row.Attempts + 1 >= MaxOtherRetries))
        {
            await FailAsync(con, row, ex.Number,
                IsPermanent(ex.Number) ? ex.Message : $"{ex.Message} (gave up after {row.Attempts + 1} tries)");
            return true;
        }
        catch (Exception ex)
        {
            var number = (ex as SqlException)?.Number;
            var wait = TimeSpan.FromSeconds(Math.Min(1800, 15 * Math.Pow(2, Math.Min(row.Attempts, 7))));
            await con.ExecuteAsync(
                @"UPDATE dbo.ErpOutbox SET Attempts = Attempts + 1, NextAttemptAt = DATEADD(SECOND, @w, SYSDATETIME()),
                    LastErrorNumber = @n, LastError = LEFT(@e, 1000) WHERE OutboxId = @id",
                new { w = (int)wait.TotalSeconds, n = number, e = ex.Message, id = row.OutboxId });
            log.LogWarning("ERP posting of {Kind} {Uid} will be retried in {Wait}: {Error}", row.Kind, row.RefUid, wait, ex.Message);
            return false;
        }
    }

    /// ERP business errors are permanent, except the ones the ERP says to retry.
    private static bool IsPermanent(int number) =>
        number >= 50000 && number is not (61100 or 61101 or 61102) && number is not (>= 59800 and <= 59806);

    private static bool IsTransient(int number) => Transient.Contains(number) || number is >= 59800 and <= 59806;

    private static object? TryGet(dynamic row, string name) =>
        ((IDictionary<string, object?>)row).TryGetValue(name, out var v) ? v : null;

    private Task FailAsync(IDbConnection con, OutboxRow row, int? number, string message)
    {
        log.LogWarning("ERP posting of {Kind} {Uid} needs attention: {Error}", row.Kind, row.RefUid, message);
        return con.ExecuteAsync(
            @"UPDATE dbo.ErpOutbox SET Status = 'Failed', Attempts = Attempts + 1, LastErrorNumber = @n,
                LastError = LEFT(@e, 1000) WHERE OutboxId = @id",
            new { n = number, e = message, id = row.OutboxId });
    }

    /// The ERP checks VAT = ROUND(VATable × 12%, 2) ± 0.01 per line. The till takes VAT as the
    /// remainder of a VAT-inclusive price (so the receipt adds up to the shelf price), which can
    /// rarely be a centavo further off — more on a pax-split line made of two parts. The total
    /// VATable + VAT stays exactly as sold; only the split between them moves by a centavo.
    private static (decimal vatable, decimal vat) ErpVatSplit(decimal vatable, decimal vat)
    {
        bool Ok(decimal n, decimal v) => Math.Abs(v - Math.Round(n * 0.12m, 2, MidpointRounding.AwayFromZero)) <= 0.01m;
        if (vatable <= 0 || Ok(vatable, vat)) return (vatable, vat);
        var total = vatable + vat;
        var start = Math.Round(total / 1.12m, 2, MidpointRounding.AwayFromZero);
        foreach (var k in new[] { 0, 1, -1, 2, -2 })
        {
            var n = start + k * 0.01m;
            if (Ok(n, total - n)) return (n, total - n);
        }
        return (vatable, vat);   // let the ERP say what's wrong
    }

    private static string UserRef(dynamic? erpUserId, dynamic? username) =>
        (string?)erpUserId ?? (string?)username ?? "";

    private async Task<dynamic> PostSaleAsync(IDbConnection con, OutboxRow row)
    {
        var saleUid = row.RefUid;
        // Discount codes as first sent (see LineDiscountCodes); worked out below on the first try.
        var savedCodesJson = await con.ExecuteScalarAsync<string?>(
            "SELECT LineDiscountCodes FROM dbo.ErpOutbox WHERE OutboxId = @id", new { id = row.OutboxId });
        var savedCodes = savedCodesJson == null ? null
            : System.Text.Json.JsonSerializer.Deserialize<Dictionary<int, string?>>(savedCodesJson);
        var codesSent = new Dictionary<int, string?>();
        var s = await con.QuerySingleOrDefaultAsync(
            @"SELECT s.*, t.ErpTerminalCode, t.MinNo, u.Username, u.ErpUserId, u.FullName,
                     COALESCE(t.PosType, ps.PosType, 'Retail') AS EffPosType
              FROM dbo.Sales s
              JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
              LEFT JOIN dbo.PosSettings ps ON ps.BranchCode = s.BranchCode
              LEFT JOIN dbo.Users u ON u.UserId = s.CashierUserId
              WHERE s.SaleUid = @saleUid", new { saleUid })
            ?? throw new NotPostable("The sale isn't in SparkPOS.");
        if (string.IsNullOrEmpty((string?)s.ErpTerminalCode) || string.IsNullOrEmpty((string?)s.MinNo))
            throw new NotPostable("The terminal has no ERP terminal code or MIN.");

        // The discount rate in effect for each line, in the till's order (store.js resolveDiscount):
        // this POS type + category, the category, this POS type, the type's default. The POS-type
        // rows exist from 32_discount_pos_type.sql on.
        var posTypeRates = await con.ExecuteScalarAsync<int>(
            "SELECT CASE WHEN OBJECT_ID('dbo.DiscountPosTypeRates', 'U') IS NULL THEN 0 ELSE 1 END") == 1;
        var lines = (await con.QueryAsync(
            $@"SELECT si.*, p.ErpProductCode, c.ErpCategoryId, ap.Username AS ApUsername, ap.ErpUserId AS ApErpUserId,
                     dr.Rate AS DiscRate, dr.IsVatExempt AS DiscExempt
              FROM dbo.SaleItems si
              LEFT JOIN dbo.Products p ON p.ProductId = si.ProductId
              LEFT JOIN dbo.Categories c ON c.CategoryId = si.CategoryId
              LEFT JOIN dbo.Users ap ON ap.UserId = si.PriceApprovedBy
              OUTER APPLY (SELECT TOP 1 x.Rate, x.IsVatExempt FROM (
                  {(posTypeRates ? @"SELECT 1 AS o, Rate, IsVatExempt FROM dbo.DiscountPosTypeRates
                     WHERE DiscountCode = @code AND PosType = @posType AND CategoryId = si.CategoryId UNION ALL " : "")}
                  SELECT 2 AS o, Rate, IsVatExempt FROM dbo.DiscountCategoryRates WHERE DiscountCode = @code AND CategoryId = si.CategoryId
                  {(posTypeRates ? @"UNION ALL SELECT 3, Rate, IsVatExempt FROM dbo.DiscountPosTypeRates
                     WHERE DiscountCode = @code AND PosType = @posType AND CategoryId IS NULL" : "")}
                  UNION ALL SELECT 4, Rate, IsVatExempt FROM dbo.DiscountTypes WHERE DiscountCode = @code) x
                  ORDER BY x.o) dr
              WHERE si.SaleUid = @saleUid ORDER BY si.[LineNo]",
            new { saleUid, code = (string?)s.DiscountCode, posType = (string)s.EffPosType })).ToList();
        if (lines.Count == 0) throw new NotPostable("The sale has no lines.");
        // 34_promos.sql: the lines with promo-free units
        var promoRows = await con.ExecuteScalarAsync<int>("SELECT CASE WHEN OBJECT_ID('dbo.SaleItemPromo', 'U') IS NULL THEN 0 ELSE 1 END") == 1
            ? (await con.QueryAsync("SELECT [LineNo], PromoName, FreeQty, RegularPrice, PromoAmount FROM dbo.SaleItemPromo WHERE SaleUid = @saleUid ORDER BY [LineNo]",
                new { saleUid })).ToList()
            : new List<dynamic>();
        var promoLines = promoRows.Select(p => (int)p.LineNo).ToHashSet();

        var lt = new DataTable();
        foreach (var (name, type) in new (string, Type)[] {
            ("LineNo", typeof(int)), ("ErpProductCode", typeof(string)), ("Barcode", typeof(string)),
            ("ProductName", typeof(string)), ("ErpCategoryId", typeof(int)), ("Qty", typeof(decimal)),
            ("UnitPrice", typeof(decimal)), ("OrigUnitPrice", typeof(decimal)), ("PriceApprovedBy", typeof(string)),
            ("LineTotal", typeof(decimal)), ("LineDiscount", typeof(decimal)), ("NetAmount", typeof(decimal)),
            ("VatableAmount", typeof(decimal)), ("VatAmount", typeof(decimal)), ("VatExemptAmount", typeof(decimal)),
            ("ZeroRatedAmount", typeof(decimal)), ("VatAdjustment", typeof(decimal)), ("IsVatable", typeof(bool)),
            ("IsDiscountable", typeof(bool)), ("DiscountCode", typeof(string)) })
            lt.Columns.Add(name, type);

        decimal gross = 0, net = 0, vatable = 0, vat = 0, exempt = 0, zero = 0, adj = 0;
        foreach (var l in lines)
        {
            var code = (string?)l.ErpProductCode
                ?? throw new NotPostable($"Line {(int)l.LineNo} ({(string)l.ProductName}) is a local product with no ERP code.");
            decimal lineTotal = l.LineTotal, lineNet = l.NetAmount, lVatable = l.VatableAmount, lVat = l.VatAmount,
                    lZero = l.ZeroRatedAmount;
            var lAdj = ErpVatAdjustment(lineTotal, lineNet, lVatable, lVat, (decimal)l.VatExemptAmount, lZero, (decimal)l.VatAdjustment,
                ExemptStyle(lineNet, lVatable, lVat, (decimal)l.VatExemptAmount, lZero));
            // A line from before the per-line figures were kept has them all at 0. A line given away
            // whole (every unit free in a mix-and-match or gift promo) is also 0, but its discount is
            // its whole amount: it posts, so the ERP still takes its stock out.
            if (lineTotal != 0 && lineNet == 0 && lVatable == 0 && lZero == 0 && (decimal)l.VatExemptAmount == 0
                && (decimal)l.LineDiscount != lineTotal)
                throw new NotPostable($"Line {(int)l.LineNo} has no per-line VAT figures (sold before they were kept).");
            decimal lExempt;
            (lVatable, lVat, lExempt, lZero) = ErpBuckets(lineNet, lVatable, lVat, lZero);
            var lineDiscount = lineTotal - lineNet;

            string? discCode = null;
            if (savedCodes != null) discCode = savedCodes.GetValueOrDefault((int)l.LineNo);
            // a line with promo-free units carries the promo, not an SC/PWD code (sent in @PromoLines)
            else if (promoLines.Contains((int)l.LineNo)) discCode = null;
            else if (lineDiscount > 0 && (bool)l.IsDiscountable && s.DiscountCode != null && l.DiscRate != null)
            {
                var pct = (decimal)l.DiscRate * 100m;
                if (pct != Math.Round(pct))
                    throw new NotPostable($"Discount rate {pct}% on line {(int)l.LineNo} isn't a whole percent; the ERP needs one.");
                discCode = $"{(string)s.DiscountCode}{(int)pct}{((bool)l.DiscExempt ? "E" : "N")}";
            }
            var approver = (decimal)l.UnitPrice != (decimal)l.OrigUnitPrice && l.PriceApprovedBy != null
                ? UserRef(l.ApErpUserId, l.ApUsername) : null;

            codesSent[(int)l.LineNo] = discCode;
            lt.Rows.Add((int)l.LineNo, code, (string?)l.Barcode, (string?)l.ProductName, (object?)l.ErpCategoryId ?? DBNull.Value,
                (decimal)l.Quantity, (decimal)l.UnitPrice, (decimal)l.OrigUnitPrice, (object?)approver ?? DBNull.Value,
                lineTotal, lineDiscount, lineNet, lVatable, lVat, lExempt, lZero, lAdj,
                (bool)l.IsVatable, (bool)l.IsDiscountable, (object?)discCode ?? DBNull.Value);
            gross += lineTotal; net += lineNet; vatable += lVatable; vat += lVat; exempt += lExempt; zero += lZero; adj += lAdj;
        }
        if (gross != (decimal)s.GrossAmount || net != (decimal)s.NetAmount)
            throw new NotPostable($"The sale's totals (gross {(decimal)s.GrossAmount:N2}, net {(decimal)s.NetAmount:N2}) don't match its lines ({gross:N2}, {net:N2}).");

        var pt = new DataTable();
        pt.Columns.Add("SeqNo", typeof(int)); pt.Columns.Add("PaymentType", typeof(string));
        pt.Columns.Add("Amount", typeof(decimal)); pt.Columns.Add("CardNo", typeof(string));
        pt.Columns.Add("CardBank", typeof(string)); pt.Columns.Add("CardRefNo", typeof(string));
        pt.Columns.Add("CardName", typeof(string));
        foreach (var p in await con.QueryAsync("SELECT * FROM dbo.SalePayments WHERE SaleUid = @saleUid ORDER BY SeqNo", new { saleUid }))
            pt.Rows.Add((int)p.SeqNo, (string)p.PaymentType, (decimal)p.Amount, (string?)p.CardNo, (string?)p.CardBank,
                (string?)p.CardRefNo, (string?)p.CardName);

        if (savedCodes == null)
            await con.ExecuteAsync("UPDATE dbo.ErpOutbox SET LineDiscountCodes = @j WHERE OutboxId = @id",
                new { j = System.Text.Json.JsonSerializer.Serialize(codesSent), id = row.OutboxId });

        // A sale that reached the server well after it was rung up was made offline.
        var wasOffline = ((DateTime)s.SyncedAt - (DateTime)s.SaleDateTime) > TimeSpan.FromMinutes(10);

        using var ec = erp.Open();
        var prm = new DynamicParameters(new
        {
            SaleUid = saleUid, ShiftUid = (Guid)s.ShiftUid, BranchCode = (string)s.BranchCode,
            TerminalCode = (string)s.ErpTerminalCode, MIN = (string)s.MinNo, ORNumber = (long)s.ORNumber,
            BusinessDate = (DateTime)s.BusinessDate, SaleDateTime = (DateTime)s.SaleDateTime,
            CashierUserID = UserRef(s.ErpUserId, s.Username), CashierName = (string?)s.FullName,
            GrossAmount = gross, DiscountAmount = gross - net, VatableAmount = vatable, VatAmount = vat,
            VatExemptAmount = exempt, ZeroRatedAmount = zero, VatAdjustment = adj, NetAmount = net,
            TenderedAmount = (decimal)s.TenderedAmount, ChangeAmount = (decimal)s.ChangeAmount,
            Lines = lt.AsTableValuedParameter("dbo.tt_SparkPOS_SaleLine"),
            Payments = pt.AsTableValuedParameter("dbo.tt_SparkPOS_Payment"),
            DiscountCode = (string?)s.DiscountCode, DiscountCtrlNo = (string?)s.DiscountCtrlNo,
            DiscountName = (string?)s.DiscountName, DinerCount = (int?)s.DinerCount, SeniorCount = (int?)s.SeniorCount,
            CustomerName = (string?)s.CustomerName, CustomerAddress = (string?)s.CustomerAddress,
            CustomerTin = (string?)s.CustomerTin, CustomerBusinessStyle = (string?)s.CustomerBusinessStyle,
            WasOffline = wasOffline
        });
        // A sale rung up at Price1..4 (31_price_levels.sql) tells the ERP which level, so its
        // PriceN counts as an ERP price (ERP [321]). Sent only when the ERP's proc takes it.
        var level = TryGet(s, "PriceLevel");
        if (level != null && await ec.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM sys.parameters WHERE object_id = OBJECT_ID('dbo.spu_SparkPOS_PostSale') AND name = '@PriceLevel'") == 1)
            prm.Add("PriceLevel", Convert.ToByte(level));
        // Lines with promo-free units (34_promos.sql), so the ERP sees why they carry a discount with
        // no SC/PWD code. Sent only when the ERP's proc takes them and the sale has any.
        if (promoRows.Count > 0 && await ec.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM sys.parameters WHERE object_id = OBJECT_ID('dbo.spu_SparkPOS_PostSale') AND name = '@PromoLines'") == 1)
            prm.Add("PromoLines", System.Text.Json.JsonSerializer.Serialize(promoRows.Select(p => new
            {
                lineNo = (int)p.LineNo, promoName = (string)p.PromoName, freeQty = (decimal)p.FreeQty,
                regularPrice = (decimal)p.RegularPrice, promoAmount = (decimal)p.PromoAmount
            })));
        // Lines sold at a wholesale price (33_wholesale.sql), so the ERP sees why the price is lower
        // than its own. Sent only when the ERP's proc takes them and the sale has any.
        if (await ec.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM sys.parameters WHERE object_id = OBJECT_ID('dbo.spu_SparkPOS_PostSale') AND name = '@WholesaleLines'") == 1
            && await con.ExecuteScalarAsync<int>("SELECT CASE WHEN OBJECT_ID('dbo.SaleItemWholesale', 'U') IS NULL THEN 0 ELSE 1 END") == 1)
        {
            // Only lines still charged at the wholesale price: a line a supervisor repriced, or a
            // zero-rated one (its price without the VAT), goes as a price change with its approver,
            // since the ERP checks UnitPrice = regularPrice - amountOff (ERP [322]).
            var wl = (await con.QueryAsync(
                @"SELECT w.[LineNo], w.RegularPrice, w.AmountOff, w.MinQty
                  FROM dbo.SaleItemWholesale w
                  JOIN dbo.SaleItems si ON si.SaleUid = w.SaleUid AND si.[LineNo] = w.[LineNo]
                  WHERE w.SaleUid = @saleUid AND si.UnitPrice = w.WholesalePrice AND si.LineDiscount = 0
                  ORDER BY w.[LineNo]",
                new { saleUid })).ToList();
            if (wl.Count > 0)
                prm.Add("WholesaleLines", System.Text.Json.JsonSerializer.Serialize(wl.Select(w => new
                {
                    lineNo = (int)w.LineNo, regularPrice = (decimal)w.RegularPrice,
                    amountOff = (decimal)w.AmountOff, minQty = (decimal)w.MinQty
                })));
        }
        return await ec.QuerySingleAsync("dbo.spu_SparkPOS_PostSale", prm,
            commandType: CommandType.StoredProcedure, commandTimeout: CallTimeoutSeconds);
    }

    private async Task<dynamic> PostVoidAsync(IDbConnection con, Guid saleUid)
    {
        var sale = await con.ExecuteScalarAsync<string?>(
            "SELECT Status FROM dbo.ErpOutbox WHERE Kind = 'SALE' AND RefUid = @saleUid", new { saleUid });
        if (sale == "Failed") throw new NotPostable("The sale itself couldn't be posted (see its entry), so its void can't be either.");

        var v = await con.QuerySingleOrDefaultAsync(
            @"SELECT s.VoidReason, s.VoidedAt, s.ShiftUid, u.Username, u.ErpUserId
              FROM dbo.Sales s LEFT JOIN dbo.Users u ON u.UserId = s.VoidedBy
              WHERE s.SaleUid = @saleUid AND s.Status = 'Voided'", new { saleUid })
            ?? throw new NotPostable("The sale isn't voided in SparkPOS.");
        using var ec = erp.Open();
        return await ec.QuerySingleAsync("dbo.spu_SparkPOS_VoidSale", new
        {
            SaleUid = saleUid,
            Reason = string.IsNullOrWhiteSpace((string?)v.VoidReason) ? "Voided at the till" : (string)v.VoidReason,
            VoidedBy = UserRef(v.ErpUserId, v.Username),
            VoidedAt = (DateTime?)v.VoidedAt ?? DateTime.Now,
            // the shift doing the void — always the sale's own (SalesController.Void allows no other)
            ShiftUid = (Guid)v.ShiftUid
        }, commandType: CommandType.StoredProcedure, commandTimeout: CallTimeoutSeconds);
    }

    /* ---------- step 4.2: shifts, returns, Z-Read ---------- */

    /// A line in the ERP's terms (lines and headers must add up exactly to what was paid):
    /// VAT-exempt = paid − VATable − VAT − zero-rated; discount = gross − paid. If the line had
    /// no VAT-exempt part to begin with (origHadExempt false), a centavo of rounding left over —
    /// a return line's buckets are each a rounded share — goes back into VAT (or zero-rated)
    /// instead of showing up as a stray exempt amount.
    private static (decimal vatable, decimal vat, decimal exempt, decimal zero) ErpBuckets(
        decimal net, decimal vatable, decimal vat, decimal zero, bool origHadExempt = true)
    {
        var exempt = net - vatable - vat - zero;
        if (!origHadExempt && exempt != 0 && Math.Abs(exempt) <= 0.02m)
        {
            if (vatable > 0) vat += exempt; else zero += exempt;
            exempt = 0;
        }
        (vatable, vat) = ErpVatSplit(vatable, vat);
        return (vatable, vat, exempt, zero);
    }

    /// The VAT part of a line's discount (gross − paid), which the ERP and the desktop POS keep
    /// apart in VatAdjustment (₱112 with SC 20%: discount 32 = 20 + VatAdjustment 12). It never
    /// changes the sums: the line's discount stays gross − paid. For a VAT-exempt discount
    /// (the SC/PWD standard case) SparkPOS's exempt bucket holds the PRE-discount base, so the
    /// removed VAT is gross − the four stored buckets; for a non-exempt one (5% prime
    /// commodities) the till's own VatAdjustment is already that figure. Worked out from the
    /// stored line alone (immutable), so a resend always sends the same.
    private static decimal ErpVatAdjustment(decimal lineTotal, decimal net, decimal vatable, decimal vat,
        decimal exempt, decimal zero, decimal tillAdj, bool exemptStyle) =>
        exemptStyle ? lineTotal - (vatable + vat + exempt + zero) : tillAdj;

    /// True when the (original) line's stored buckets add up to more than was paid, i.e. its
    /// exempt bucket is a pre-discount base — a VAT-exempt discount was given on it.
    private static bool ExemptStyle(decimal net, decimal vatable, decimal vat, decimal exempt, decimal zero) =>
        vatable + vat + exempt + zero > net;

    private async Task<dynamic> PostOpenAsync(IDbConnection con, Guid shiftUid)
    {
        var s = await con.QuerySingleOrDefaultAsync(
            @"SELECT s.*, t.ErpTerminalCode, t.MinNo, u.Username, u.ErpUserId, u.FullName
              FROM dbo.Shifts s JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
              LEFT JOIN dbo.Users u ON u.UserId = s.CashierUserId WHERE s.ShiftUid = @shiftUid", new { shiftUid })
            ?? throw new NotPostable("The shift isn't in SparkPOS.");
        if (string.IsNullOrEmpty((string?)s.ErpTerminalCode) || string.IsNullOrEmpty((string?)s.MinNo))
            throw new NotPostable("The terminal has no ERP terminal code or MIN.");
        using var ec = erp.Open();
        return await ec.QuerySingleAsync("dbo.spu_SparkPOS_OpenShift", new
        {
            ShiftUid = shiftUid, BranchCode = (string)s.BranchCode, TerminalCode = (string)s.ErpTerminalCode,
            MIN = (string)s.MinNo, BusinessDate = (DateTime)s.BusinessDate, OpenedAt = (DateTime)s.OpenedAt,
            CashierUserID = UserRef(s.ErpUserId, s.Username), CashierName = (string?)s.FullName,
            BeginningCash = (decimal)s.CashBegin
        }, commandType: CommandType.StoredProcedure, commandTimeout: CallTimeoutSeconds);
    }

    private async Task<dynamic> PostReturnAsync(IDbConnection con, Guid returnUid)
    {
        var r = await con.QuerySingleOrDefaultAsync(
            @"SELECT r.*, t.ErpTerminalCode, cu.Username AS CUsername, cu.ErpUserId AS CErpUserId,
                     au.Username AS AUsername, au.ErpUserId AS AErpUserId
              FROM dbo.SaleReturns r JOIN dbo.Terminals t ON t.TerminalId = r.TerminalId
              LEFT JOIN dbo.Users cu ON cu.UserId = r.CashierUserId
              LEFT JOIN dbo.Users au ON au.UserId = r.ApprovedByUserId
              WHERE r.ReturnUid = @returnUid", new { returnUid })
            ?? throw new NotPostable("The return isn't in SparkPOS.");
        var lines = (await con.QueryAsync(
            @"SELECT ri.*, p.ErpProductCode,
                     o.NetAmount AS ONet, o.VatableAmount AS OVatable, o.VatAmount AS OVat, o.ZeroRatedAmount AS OZero,
                     o.VatExemptAmount AS OExempt
              FROM dbo.SaleReturnItems ri
              LEFT JOIN dbo.Products p ON p.ProductId = ri.ProductId
              JOIN dbo.SaleItems o ON o.SaleUid = @orig AND o.[LineNo] = ri.[LineNo]
              WHERE ri.ReturnUid = @returnUid ORDER BY ri.[LineNo]",
            new { returnUid, orig = (Guid)r.OrigSaleUid })).ToList();

        var lt = new DataTable();
        foreach (var (name, type) in new (string, Type)[] {
            ("OrigLineNo", typeof(int)), ("ErpProductCode", typeof(string)), ("Qty", typeof(decimal)),
            ("UnitPrice", typeof(decimal)), ("LineTotal", typeof(decimal)), ("LineDiscount", typeof(decimal)),
            ("NetAmount", typeof(decimal)), ("VatableAmount", typeof(decimal)), ("VatAmount", typeof(decimal)),
            ("VatExemptAmount", typeof(decimal)), ("ZeroRatedAmount", typeof(decimal)), ("VatAdjustment", typeof(decimal)) })
            lt.Columns.Add(name, type);
        decimal gross = 0, net = 0, vatable = 0, vat = 0, exempt = 0, zero = 0, adj = 0;
        foreach (var l in lines)
        {
            var code = (string?)l.ErpProductCode ?? throw new NotPostable($"Line {(int)l.LineNo} is a local product with no ERP code.");
            decimal lt_ = l.LineTotal, n = l.NetAmount;
            var origHadExempt = (decimal)l.ONet - (decimal)l.OVatable - (decimal)l.OVat - (decimal)l.OZero != 0;
            var (bv, bt, be, bz) = ErpBuckets(n, (decimal)l.VatableAmount, (decimal)l.VatAmount, (decimal)l.ZeroRatedAmount, origHadExempt);
            // shares of the original line's buckets telescope, so the shares of this add up to its figure too
            var la = ErpVatAdjustment(lt_, n, (decimal)l.VatableAmount, (decimal)l.VatAmount, (decimal)l.VatExemptAmount,
                (decimal)l.ZeroRatedAmount, (decimal)l.VatAdjustment,
                ExemptStyle((decimal)l.ONet, (decimal)l.OVatable, (decimal)l.OVat, (decimal)l.OExempt, (decimal)l.OZero));
            lt.Rows.Add((int)l.LineNo, code, (decimal)l.Quantity, (decimal)l.UnitPrice, lt_, lt_ - n, n, bv, bt, be, bz, la);
            gross += lt_; net += n; vatable += bv; vat += bt; exempt += be; zero += bz; adj += la;
        }
        using var ec = erp.Open();
        return await ec.QuerySingleAsync("dbo.spu_SparkPOS_PostReturn", new
        {
            ReturnUid = returnUid, ShiftUid = (Guid)r.ShiftUid, BranchCode = (string)r.BranchCode,
            TerminalCode = (string)r.ErpTerminalCode, ReturnNo = (long)(int)r.ReturnNo,
            BusinessDate = (DateTime)r.BusinessDate, ReturnDateTime = (DateTime)r.ReturnDateTime,
            CashierUserID = UserRef(r.CErpUserId, r.CUsername), ApprovedBy = UserRef(r.AErpUserId, r.AUsername),
            Reason = (string)r.Reason, OrigSaleUid = (Guid)r.OrigSaleUid, OrigORNumber = (long)r.OrigORNumber,
            GrossAmount = gross, DiscountAmount = gross - net, VatableAmount = vatable, VatAmount = vat,
            VatExemptAmount = exempt, ZeroRatedAmount = zero, VatAdjustment = adj, NetAmount = net,
            Lines = lt.AsTableValuedParameter("dbo.tt_SparkPOS_ReturnLine")
        }, commandType: CommandType.StoredProcedure, commandTimeout: CallTimeoutSeconds);
    }

    /// The shift's own figures; the ERP recomputes them from what it received and refuses a
    /// mismatch (61126) — e.g. a sale of the shift that's still in "needs attention".
    private async Task<dynamic> PostCloseAsync(IDbConnection con, Guid shiftUid)
    {
        var c = await con.QuerySingleOrDefaultAsync(
            @"SELECT c.ClosedAt, c.DeclaredCash, c.ExpectedCash, c.ShortOver,
                (SELECT COUNT(*) FROM dbo.Sales x WHERE x.ShiftUid = @shiftUid) AS SaleCount,
                (SELECT COUNT(*) FROM dbo.Sales x WHERE x.ShiftUid = @shiftUid AND x.Status = 'Voided') AS VoidCount,
                ISNULL((SELECT SUM(x.NetAmount) FROM dbo.Sales x WHERE x.ShiftUid = @shiftUid AND x.Status = 'Completed'), 0) AS NetSales,
                ISNULL((SELECT SUM(p.Amount) FROM dbo.SalePayments p JOIN dbo.Sales x ON x.SaleUid = p.SaleUid
                        WHERE x.ShiftUid = @shiftUid AND x.Status = 'Completed' AND p.PaymentType = 'CASH'), 0)
                - ISNULL((SELECT SUM(x.ChangeAmount) FROM dbo.Sales x WHERE x.ShiftUid = @shiftUid AND x.Status = 'Completed'), 0) AS CashSales,
                ISNULL((SELECT SUM(p.Amount) FROM dbo.SalePayments p JOIN dbo.Sales x ON x.SaleUid = p.SaleUid
                        WHERE x.ShiftUid = @shiftUid AND x.Status = 'Completed' AND p.PaymentType = 'CARD'), 0) AS CardSales,
                (SELECT COUNT(*) FROM dbo.SaleReturns r WHERE r.ShiftUid = @shiftUid) AS ReturnCount,
                ISNULL((SELECT SUM(r.NetAmount) FROM dbo.SaleReturns r WHERE r.ShiftUid = @shiftUid), 0) AS CashRefunds
              FROM dbo.ShiftClosings c WHERE c.ShiftUid = @shiftUid", new { shiftUid })
            ?? throw new NotPostable("The shift hasn't been blind-closed in SparkPOS.");
        using var ec = erp.Open();
        return await ec.QuerySingleAsync("dbo.spu_SparkPOS_CloseShift", new
        {
            ShiftUid = shiftUid, ClosedAt = (DateTime)c.ClosedAt, DeclaredCash = (decimal)c.DeclaredCash,
            ExpectedCash = (decimal)c.ExpectedCash, ShortOver = (decimal)c.ShortOver,
            SaleCount = (int)c.SaleCount, VoidCount = (int)c.VoidCount, NetSales = (decimal)c.NetSales,
            CashSales = (decimal)c.CashSales, CardSales = (decimal)c.CardSales,
            ReturnCount = (int)c.ReturnCount, CashRefunds = (decimal)c.CashRefunds
        }, commandType: CommandType.StoredProcedure, commandTimeout: CallTimeoutSeconds);
    }

    /// SparkPOS's Z-Read, with the sales totals on the ERP's basis (the same converted lines the
    /// sales were sent with) so the ERP's comparison lines up. The BIR figures on the printed
    /// Z-Read stay SparkPOS's own.
    private async Task<dynamic> PostZReadAsync(IDbConnection con, Guid zreadUid)
    {
        var z = await con.QuerySingleOrDefaultAsync(
            @"SELECT z.*, t.ErpTerminalCode FROM dbo.ZReads z JOIN dbo.Terminals t ON t.TerminalId = z.TerminalId
              WHERE z.ZReadUid = @zreadUid", new { zreadUid })
            ?? throw new NotPostable("The Z-Read isn't in SparkPOS.");
        var lines = await con.QueryAsync(
            @"SELECT si.LineTotal, si.NetAmount, si.VatableAmount, si.VatAmount, si.ZeroRatedAmount, si.VatAdjustment,
                     si.VatExemptAmount
              FROM dbo.SaleItems si JOIN dbo.Sales s ON s.SaleUid = si.SaleUid
              WHERE s.TerminalId = @t AND s.BusinessDate = @d AND s.Status = 'Completed'",
            new { t = (int)z.TerminalId, d = (DateTime)z.BusinessDate });
        decimal gross = 0, net = 0, vatable = 0, vat = 0, exempt = 0, zero = 0, adj = 0;
        foreach (var l in lines)
        {
            var (bv, bt, be, bz) = ErpBuckets((decimal)l.NetAmount, (decimal)l.VatableAmount, (decimal)l.VatAmount, (decimal)l.ZeroRatedAmount);
            gross += (decimal)l.LineTotal; net += (decimal)l.NetAmount; vatable += bv; vat += bt; exempt += be; zero += bz;
            adj += ErpVatAdjustment((decimal)l.LineTotal, (decimal)l.NetAmount, (decimal)l.VatableAmount, (decimal)l.VatAmount,
                (decimal)l.VatExemptAmount, (decimal)l.ZeroRatedAmount, (decimal)l.VatAdjustment,
                ExemptStyle((decimal)l.NetAmount, (decimal)l.VatableAmount, (decimal)l.VatAmount, (decimal)l.VatExemptAmount, (decimal)l.ZeroRatedAmount));
        }
        var ret = await con.QuerySingleAsync(
            @"SELECT COUNT(*) AS N, ISNULL(SUM(NetAmount), 0) AS Amount, MIN(ReturnNo) AS Beg, MAX(ReturnNo) AS EndNo
              FROM dbo.SaleReturns WHERE TerminalId = @t AND BusinessDate = @d",
            new { t = (int)z.TerminalId, d = (DateTime)z.BusinessDate });
        using var ec = erp.Open();
        return await ec.QuerySingleAsync("dbo.spu_SparkPOS_PostZRead", new
        {
            ZReadUid = zreadUid, BranchCode = (string)z.BranchCode, TerminalCode = (string)z.ErpTerminalCode,
            BusinessDate = (DateTime)z.BusinessDate, ZCounter = (int)z.ZCounter, ExecutedAt = (DateTime)z.GeneratedAt,
            BegSI = (long?)z.BeginningOR, EndSI = (long?)z.EndingOR,
            BegReturnNo = (long?)(int?)ret.Beg, EndReturnNo = (long?)(int?)ret.EndNo,
            GrossAmount = gross, DiscountAmount = gross - net, NetAmount = net, VatableAmount = vatable, VatAmount = vat,
            VatExemptAmount = exempt, ZeroRatedAmount = zero, VatAdjustment = adj,
            VoidCount = (int)z.VoidCount, VoidAmount = (decimal)z.VoidAmount,
            ReturnCount = (int)ret.N, ReturnAmount = (decimal)ret.Amount,
            OldGrandTotal = (decimal)z.OldGrandTotal, NewGrandTotal = (decimal)z.NewGrandTotal
        }, commandType: CommandType.StoredProcedure, commandTimeout: CallTimeoutSeconds);
    }
}

/// Runs ErpPostingService every Erp:PostIntervalSeconds (default 15; 0 = off).
public class ErpPostingWorker(ErpPostingService posting, ErpDb erp, IConfiguration cfg, ILogger<ErpPostingWorker> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        var seconds = cfg.GetValue("Erp:PostIntervalSeconds", 15);
        if (seconds <= 0 || !erp.IsConfigured) return;
        await Task.Delay(TimeSpan.FromSeconds(20), stop);
        while (!stop.IsCancellationRequested)
        {
            try { await posting.RunOnceAsync(stop); }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "ERP posting round failed"); }
            await Task.Delay(TimeSpan.FromSeconds(seconds), stop);
        }
    }
}
