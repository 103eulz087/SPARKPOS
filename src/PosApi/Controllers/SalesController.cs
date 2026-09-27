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

        foreach (var s in req.Sales)
        {
            try
            {
                var items = NewItemTable();
                foreach (var i in s.Items)
                    items.Rows.Add(i.LineNo, i.ProductId, i.Barcode, i.ProductName, i.CategoryId,
                        i.Quantity, i.UnitPrice, i.OrigUnitPrice, i.LineDiscount, i.LineTotal,
                        i.IsVatable, i.IsDiscountable);

                var pays = NewPaymentTable();
                foreach (var p in s.Payments)
                    pays.Rows.Add(p.SeqNo, p.PaymentType, p.Amount,
                        MaskCard(p.CardNo), p.CardBank, p.CardRefNo, p.CardName);

                await con.ExecuteAsync("dbo.sp_UpsertSale", new
                {
                    s.SaleUid, s.ShiftUid, s.BranchCode, s.TerminalId, CashierUserId = UserId,
                    s.ORNumber, s.BusinessDate, s.SaleDateTime, s.GrossAmount, s.DiscountAmount,
                    s.VatExemptAmount, s.VatableAmount, s.VatAmount, s.ZeroRatedAmount, s.NetAmount,
                    s.TenderedAmount, s.ChangeAmount, s.DiscountCode, s.DiscountCtrlNo, s.DiscountName,
                    s.VatAdjustment, s.DinerCount, s.SeniorCount,
                    s.Status,
                    Items = items.AsTableValuedParameter("dbo.TVP_SaleItem"),
                    Payments = pays.AsTableValuedParameter("dbo.TVP_SalePayment")
                }, commandType: CommandType.StoredProcedure);

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
            "SELECT BranchCode, TerminalId, BusinessDate, NetAmount, Status FROM dbo.Sales WHERE SaleUid = @u",
            new { u = req.SaleUid });
        if (sale == null) return NotFound(new { message = "Sale not found." });
        if ((string)sale.Status != "Completed") return BadRequest(new { message = "Sale is already voided or returned." });

        var locked = await con.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM dbo.ZReads WHERE TerminalId = @t AND BusinessDate = @d",
            new { t = (int)sale.TerminalId, d = (DateTime)sale.BusinessDate });
        if (locked > 0) return BadRequest(new { message = "Business date already closed by End of Day." });

        var needsOverride = await con.ExecuteScalarAsync<bool>(
            "SELECT VoidOverride FROM dbo.PosSettings WHERE BranchCode = @b", new { b = (string)sale.BranchCode });

        int approverId = UserId;
        if (needsOverride && !IsPrivileged)
        {
            var id = await VerifyApproverAsync(con, req.OverrideUsername, req.OverridePassword);
            if (id == null) return StatusCode(403, new { message = "Supervisor override required and not verified." });
            approverId = id.Value;
        }

        await con.ExecuteAsync(
            @"UPDATE dbo.Sales SET Status='Voided', VoidedBy=@by, VoidedAt=SYSDATETIME(), VoidReason=@r
              WHERE SaleUid=@u AND Status='Completed'",
            new { by = approverId, r = req.Reason, u = req.SaleUid });

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
}
