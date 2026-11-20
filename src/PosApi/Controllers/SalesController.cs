using System.Data;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

[ApiController]
[Route("api/sales")]
[Authorize]
public class SalesController(Db db) : ApiControllerBase(db)
{
    /// Batch sync from the tablet's offline queue. Idempotent by SaleUid,
    /// so the client can retry the same batch forever without duplicating.
    [HttpPost("sync")]
    public async Task<IActionResult> Sync(SyncBatchRequest req)
    {
        var results = new List<object>();
        using var con = Db.Open();
        // Who rang each sale up: the cashier recorded on the sale (a queued sale can sync under
        // whoever signs in next on that device), if they're an active user of that branch;
        // otherwise the signed-in user, as before.
        var cashierOk = new Dictionary<(int, string), bool>();
        async Task<int> CashierFor(SaleDto s)
        {
            if (s.CashierUserId is not int id || id == UserId) return UserId;
            if (!cashierOk.TryGetValue((id, s.BranchCode), out var ok))
                cashierOk[(id, s.BranchCode)] = ok = await con.ExecuteScalarAsync<int>(
                    @"SELECT COUNT(*) FROM dbo.Users u WHERE u.UserId = @id AND u.IsActive = 1
                        AND (u.Role = 'Admin' OR EXISTS (SELECT 1 FROM dbo.UserBranches ub
                                                        WHERE ub.UserId = u.UserId AND ub.BranchCode = @b))",
                    new { id, b = s.BranchCode }) > 0;
            return ok ? id : UserId;
        }

        foreach (var s in req.Sales)
        {
            try
            {
                var items = NewItemTable();
                foreach (var i in s.Items)
                    items.Rows.Add(i.LineNo, i.ProductId, i.Barcode, i.ProductName, i.CategoryId,
                        i.Quantity, i.UnitPrice, i.OrigUnitPrice, i.LineDiscount, i.LineTotal,
                        i.IsVatable, i.IsDiscountable, i.NetAmount, i.VatableAmount, i.VatAmount,
                        i.VatExemptAmount, i.ZeroRatedAmount, i.VatAdjustment,
                        (object?)i.PriceApprovedBy ?? DBNull.Value);

                var pays = NewPaymentTable();
                foreach (var p in s.Payments)
                    pays.Rows.Add(p.SeqNo, p.PaymentType, p.Amount,
                        MaskCard(p.CardNo), p.CardBank, p.CardRefNo, p.CardName);

                var prm = new DynamicParameters(new
                {
                    s.SaleUid, s.ShiftUid, s.BranchCode, s.TerminalId, CashierUserId = await CashierFor(s),
                    s.ORNumber, s.BusinessDate, s.SaleDateTime, s.GrossAmount, s.DiscountAmount,
                    s.VatExemptAmount, s.VatableAmount, s.VatAmount, s.ZeroRatedAmount, s.NetAmount,
                    s.TenderedAmount, s.ChangeAmount, s.DiscountCode, s.DiscountCtrlNo, s.DiscountName,
                    s.VatAdjustment, s.DinerCount, s.SeniorCount,
                    s.Status, s.CustomerName, s.CustomerAddress, s.CustomerTin, s.CustomerBusinessStyle,
                    s.ReceiptText, s.CustomerEmail,
                    Items = items.AsTableValuedParameter("dbo.TVP_SaleItem"),
                    Payments = pays.AsTableValuedParameter("dbo.TVP_SalePayment")
                });
                // only with a suki card, so a DB without 26_loyalty.sql still takes ordinary sales
                if (!string.IsNullOrWhiteSpace(s.LoyaltyCardNo)) prm.Add("LoyaltyCardNo", s.LoyaltyCardNo.Trim());
                // only on a zero-rated sale, so a DB without 28_zero_rated_sales.sql still takes the others
                if (!string.IsNullOrWhiteSpace(s.ZeroRatedCertNo))
                {
                    prm.Add("ZeroRatedCertNo", s.ZeroRatedCertNo.Trim());
                    prm.Add("ZeroRatedApprovedBy", s.ZeroRatedApprovedBy);
                }
                // only on a regular/other discount, so a DB without 30_other_discount.sql takes the others
                if (s.DiscountCode == "OTHER") prm.Add("DiscountApprovedBy", s.DiscountApprovedBy);
                // 35: an SC/PWD discount a supervisor approved (the Discount switch)
                else if (s.DiscountApprovedBy != null && !string.IsNullOrEmpty(s.DiscountCode) && s.DiscountCap == null)
                    prm.Add("DiscountApprovedBy", s.DiscountApprovedBy);
                // 35: lines removed with a supervisor's approval, for the audit
                if (s.CancelledLines is { Count: > 0 })
                    prm.Add("CancelledLines", System.Text.Json.JsonSerializer.Serialize(s.CancelledLines.Take(200).Select(c => new
                    {
                        productId = c.ProductId, productName = c.ProductName, quantity = c.Quantity,
                        unitPrice = c.UnitPrice, approvedBy = c.ApprovedBy
                    })));
                // an SC/PWD discount on only the senior's own quantity of some lines, for the audit
                if (s.DiscountLines is { Count: > 0 } && !string.IsNullOrEmpty(s.DiscountCode) && s.DiscountCode != "OTHER")
                    prm.Add("DiscountLines", System.Text.Json.JsonSerializer.Serialize(s.DiscountLines.Take(200).Select(d => new
                    {
                        lineNo = d.LineNo, productName = d.ProductName, quantity = d.Quantity, discountQty = d.DiscountQty
                    })));
                // only on a sale at a price level, so a DB without 31_price_levels.sql takes the others
                if (s.PriceLevel is >= 1 and <= 4) prm.Add("PriceLevel", s.PriceLevel);
                // only with wholesale lines (or wholesale taken off), so a DB without 33 takes the others
                if (s.WholesaleLines is { Count: > 0 })
                    prm.Add("WholesaleLines", System.Text.Json.JsonSerializer.Serialize(s.WholesaleLines.Select(w => new
                    {
                        lineNo = w.LineNo, regularPrice = w.RegularPrice, amountOff = w.AmountOff,
                        minQty = w.MinQty, itemTotalQty = w.ItemTotalQty
                    })));
                if (s.WholesaleRemovedBy != null) prm.Add("WholesaleRemovedBy", s.WholesaleRemovedBy);
                // only with promo-free lines, so a DB without 34 takes the others
                if (s.PromoLines is { Count: > 0 })
                    prm.Add("PromoLines", System.Text.Json.JsonSerializer.Serialize(s.PromoLines.Select(p => new
                    {
                        lineNo = p.LineNo, promoId = p.PromoId, promoName = p.PromoName, freeQty = p.FreeQty,
                        regularPrice = p.RegularPrice, promoAmount = p.PromoAmount
                    })));
                // only on an SC/PWD discount limited to the weekly cap, so a DB without 32 takes the others
                if (s.DiscountCap != null && !string.IsNullOrEmpty(s.DiscountCode) && s.DiscountCode != "OTHER")
                {
                    prm.Add("DiscountCap", s.DiscountCap);
                    prm.Add("DiscountApprovedBy", s.DiscountApprovedBy);
                }
                // 38: only with a gift certificate, so a DB without 38 takes the others
                if (s.Payments.Any(p => p.PaymentType == "GC"))
                    prm.Add("GiftCerts", System.Text.Json.JsonSerializer.Serialize(s.Payments.Where(p => p.PaymentType == "GC").Select(p => new
                    {
                        seqNo = p.SeqNo, gcNo = p.GcNo, faceValue = p.GcValue ?? p.Amount
                    })));
                await con.ExecuteAsync("dbo.sp_UpsertSale", prm, commandType: CommandType.StoredProcedure);

                results.Add(new { saleUid = s.SaleUid, status = "synced" });
            }
            catch (Exception ex)
            {
                results.Add(new { saleUid = s.SaleUid, status = "error", message = ex.Message });
            }
        }
        return Ok(results);
    }

    /// Void a synced sale. Whether an override is required comes from PosSettings.
    [HttpPost("void")]
    public async Task<IActionResult> Void(VoidRequest req)
    {
        using var con = Db.Open();

        var sale = await con.QuerySingleOrDefaultAsync<dynamic>(
            @"SELECT s.BranchCode, s.TerminalId, s.BusinessDate, s.NetAmount, s.Status, sh.Status AS ShiftStatus
              FROM dbo.Sales s LEFT JOIN dbo.Shifts sh ON sh.ShiftUid = s.ShiftUid WHERE s.SaleUid = @u",
            new { u = req.SaleUid });
        if (sale == null) return NotFound(new { message = "Sale not found." });
        if ((string)sale.Status != "Completed") return BadRequest(new { message = "Sale is already voided or returned." });
        // Only while the shift that made the sale is still open: its cash is in that drawer, and a
        // blind-closed shift's expected cash already counted it. Later, the customer's money goes
        // back through a return (the ERP refuses such a void too: 61125).
        if ((string?)sale.ShiftStatus != "Open")
            return BadRequest(new { message = "The shift that made this sale is already closed, so it can't be voided. Process a return instead." });
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM dbo.SaleReturns WHERE OrigSaleUid = @u", new { u = req.SaleUid }) > 0)
            return BadRequest(new { message = "Items on this invoice were already returned, so it can't be voided." });

        var locked = await con.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM dbo.ZReads WHERE TerminalId = @t AND BusinessDate = @d",
            new { t = (int)sale.TerminalId, d = (DateTime)sale.BusinessDate });
        if (locked > 0) return BadRequest(new { message = "Business date already closed by End of Day." });

        if (!CanActAt((string)sale.BranchCode))
            return StatusCode(403, new { message = $"This sale belongs to branch {(string)sale.BranchCode}." });
        // the branch's switch, or the terminal's own answer (35_approvals.sql)
        var needsOverride = await Approvals.RequiredAsync(con, (string)sale.BranchCode, (int)sale.TerminalId, Approvals.Void);

        int approverId = UserId;
        if (needsOverride && !IsPrivileged)
        {
            var id = await VerifyApproverAsync(con, req.OverrideUsername, req.OverridePassword, (string)sale.BranchCode);
            if (id == null) return StatusCode(403, new { message = $"Not verified: needs a supervisor of branch {(string)sale.BranchCode} (or an admin)." });
            approverId = id.Value;
        }

        await con.ExecuteAsync(
            @"UPDATE dbo.Sales SET Status='Voided', VoidedBy=@by, VoidedAt=SYSDATETIME(), VoidReason=@r
              WHERE SaleUid=@u AND Status='Completed'",
            new { by = approverId, r = req.Reason, u = req.SaleUid });

        // Its suki card points go back too.
        await con.ExecuteAsync(
            @"IF OBJECT_ID('dbo.sp_LoyaltyTakeBack', 'P') IS NOT NULL
                EXEC dbo.sp_LoyaltyTakeBack @SaleUid = @u, @Kind = 'VOID', @RefUid = @u, @UserId = @by",
            new { u = req.SaleUid, by = approverId });

        // 38: and its gift certificates can be used again
        await con.ExecuteAsync(
            @"IF OBJECT_ID('dbo.sp_GiftCertRelease', 'P') IS NOT NULL
                EXEC dbo.sp_GiftCertRelease @SaleUid = @u, @UserId = @by",
            new { u = req.SaleUid, by = approverId });

        // A sale queued for the ERP gets its void queued right after it (ErpPostingService).
        await con.ExecuteAsync(
            @"INSERT INTO dbo.ErpOutbox (Kind, RefUid, BranchCode, TerminalId, BusinessDate)
              SELECT 'VOID', o.RefUid, o.BranchCode, o.TerminalId, o.BusinessDate FROM dbo.ErpOutbox o
              WHERE o.Kind = 'SALE' AND o.RefUid = @u
                AND NOT EXISTS (SELECT 1 FROM dbo.ErpOutbox x WHERE x.Kind = 'VOID' AND x.RefUid = @u)",
            new { u = req.SaleUid });

        await AuditAsync(con, "VOID",
            $"Sale {req.SaleUid} ({(decimal)sale.NetAmount:N2}) voided. Reason: {req.Reason}. Approved by userId {approverId}",
            (string)sale.BranchCode, (int)sale.TerminalId);

        return Ok(new { status = "voided" });
    }

    /// Full sale with items and payments — used for reprint and lookup.
    [HttpGet("{saleUid:guid}")]
    public async Task<IActionResult> Get(Guid saleUid)
    {
        using var con = Db.Open();
        var sale = await con.QuerySingleOrDefaultAsync(
            "SELECT * FROM dbo.Sales WHERE SaleUid = @saleUid", new { saleUid });
        if (sale == null) return NotFound();
        var items = await con.QueryAsync(
            "SELECT * FROM dbo.SaleItems WHERE SaleUid = @saleUid ORDER BY [LineNo]", new { saleUid });
        var payments = await con.QueryAsync(
            "SELECT * FROM dbo.SalePayments WHERE SaleUid = @saleUid ORDER BY SeqNo", new { saleUid });
        return Ok(new { sale, items, payments });
    }

    /// Looks up a sale by OR number for Void/Reprint's "enter an OR number" fields.
    /// Scoped to a terminal — OR numbers are only unique per terminal (UQ_Sales_OR),
    /// not globally.
    [HttpGet("by-or/{terminalId:int}/{orNumber:long}")]
    public async Task<IActionResult> ByOrNumber(int terminalId, long orNumber)
    {
        using var con = Db.Open();
        var saleUid = await con.ExecuteScalarAsync<Guid?>(
            "SELECT SaleUid FROM dbo.Sales WHERE TerminalId = @terminalId AND ORNumber = @orNumber",
            new { terminalId, orNumber });
        if (saleUid == null)
            return NotFound(new { message = $"No sale found with OR# {orNumber} on this terminal." });
        return await Get(saleUid.Value);
    }

    /// BIR: every reprint is logged. The reprint itself is printed by the terminal from the
    /// stored invoice text (Sales.ReceiptText) under a REPRINT label.
    [HttpPost("{saleUid:guid}/reprint-log")]
    public async Task<IActionResult> LogReprint(Guid saleUid,
        [FromBody(EmptyBodyBehavior = Microsoft.AspNetCore.Mvc.ModelBinding.EmptyBodyBehavior.Allow)] ReprintLogRequest? req = null)
    {
        using var con = Db.Open();
        var s = await con.QuerySingleOrDefaultAsync(
            "SELECT BranchCode, TerminalId, ORNumber FROM dbo.Sales WHERE SaleUid = @saleUid", new { saleUid });
        if (s == null) return NotFound();
        await AuditAsync(con, "REPRINT", $"Sales invoice {ReceiptBuilder.Si(s.ORNumber)} reprinted" +
            await ApprovedByText(con, req?.ApprovedBy), (string)s.BranchCode, (int)s.TerminalId);
        return Ok();
    }

    /// E-invoice: queue an emailed copy of this invoice (exactly as printed) to any address —
    /// for a customer who asks after the sale. Sent by InvoiceEmailService.
    [HttpPost("{saleUid:guid}/email")]
    public async Task<IActionResult> EmailCopy(Guid saleUid, EmailCopyRequest req)
    {
        using var con = Db.Open();
        var s = await con.QuerySingleOrDefaultAsync(
            "SELECT BranchCode, TerminalId, ORNumber, ReceiptText FROM dbo.Sales WHERE SaleUid = @saleUid", new { saleUid });
        if (s == null) return NotFound(new { message = "Sale not found (it may not have synced yet)." });
        if (!CanActAt((string)s.BranchCode)) return StatusCode(403, new { message = $"This sale belongs to branch {(string)s.BranchCode}." });
        if (s.ReceiptText == null) return BadRequest(new { message = "This invoice has no stored copy to send." });
        try
        {
            await con.ExecuteAsync("dbo.sp_QueueInvoiceEmail",
                new { Kind = "SALE", RefUid = saleUid, BranchCode = (string)s.BranchCode, ToAddress = req.To, RequestedBy = UserId },
                commandType: CommandType.StoredProcedure);
        }
        catch (Microsoft.Data.SqlClient.SqlException ex) when (ex.Number == 53201) { return BadRequest(new { message = ex.Message }); }
        await AuditAsync(con, "INVOICE_EMAIL", $"Sales invoice {ReceiptBuilder.Si(s.ORNumber)} emailed to {req.To.Trim()}",
            (string)s.BranchCode, (int)s.TerminalId);
        return Ok(new { status = "queued" });
    }

    /// Recent sales for the current shift (reprint picker).
    [HttpGet("by-shift/{shiftUid:guid}")]
    public async Task<IActionResult> ByShift(Guid shiftUid)
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT TOP 50 SaleUid, ORNumber, SaleDateTime, NetAmount, Status
              FROM dbo.Sales WHERE ShiftUid = @shiftUid ORDER BY SaleDateTime DESC", new { shiftUid }));
    }

    private static string? MaskCard(string? cardNo) =>
        string.IsNullOrWhiteSpace(cardNo) ? null
        : cardNo.Length <= 4 ? "****" + cardNo
        : "****" + cardNo[^4..];

    private static DataTable NewItemTable()
    {
        var t = new DataTable();
        t.Columns.Add("LineNo", typeof(int));
        t.Columns.Add("ProductId", typeof(int));
        t.Columns.Add("Barcode", typeof(string));
        t.Columns.Add("ProductName", typeof(string));
        t.Columns.Add("CategoryId", typeof(int));
        t.Columns.Add("Quantity", typeof(decimal));
        t.Columns.Add("UnitPrice", typeof(decimal));
        t.Columns.Add("OrigUnitPrice", typeof(decimal));
        t.Columns.Add("LineDiscount", typeof(decimal));
        t.Columns.Add("LineTotal", typeof(decimal));
        t.Columns.Add("IsVatable", typeof(bool));
        t.Columns.Add("IsDiscountable", typeof(bool));
        t.Columns.Add("NetAmount", typeof(decimal));
        t.Columns.Add("VatableAmount", typeof(decimal));
        t.Columns.Add("VatAmount", typeof(decimal));
        t.Columns.Add("VatExemptAmount", typeof(decimal));
        t.Columns.Add("ZeroRatedAmount", typeof(decimal));
        t.Columns.Add("VatAdjustment", typeof(decimal));
        t.Columns.Add("PriceApprovedBy", typeof(int));
        return t;
    }

    private static DataTable NewPaymentTable()
    {
        var t = new DataTable();
        t.Columns.Add("SeqNo", typeof(int));
        t.Columns.Add("PaymentType", typeof(string));
        t.Columns.Add("Amount", typeof(decimal));
        t.Columns.Add("CardNo", typeof(string));
        t.Columns.Add("CardBank", typeof(string));
        t.Columns.Add("CardRefNo", typeof(string));
        t.Columns.Add("CardName", typeof(string));
        return t;
    }

    /// ", approved by <name>" for an audit row when a supervisor approved it at the till (35).
    internal static async Task<string> ApprovedByText(System.Data.IDbConnection con, int? userId) =>
        userId == null ? "" : $", approved by {await con.ExecuteScalarAsync<string?>(
            "SELECT Username FROM dbo.Users WHERE UserId = @userId", new { userId }) ?? $"user {userId}"}";
}
