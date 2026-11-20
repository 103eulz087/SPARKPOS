using System.Data;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

/// Return transactions (BIR sworn statement): a receipt tagged RETURN TRANSACTION that quotes
/// the original Ref SI No., numbered by the terminal's own 6-digit non-resettable counter.
/// Online-only, like Void: the number is taken inside dbo.sp_ProcessReturn's transaction so the
/// sequence has no gaps. Refunds are cash, out of the current shift's drawer.
[ApiController]
[Route("api/returns")]
[Authorize]
public class ReturnsController(Db db) : ApiControllerBase(db)
{
    /// What the return would refund, line by line. Writes nothing, takes no number.
    [HttpPost("preview")]
    public async Task<IActionResult> Preview(ReturnRequest req)
    {
        using var con = Db.Open();
        var gate = await CheckAllowedAsync(con, req.OrigSaleUid);
        if (gate != null) return gate;
        try
        {
            using var multi = await con.QueryMultipleAsync("dbo.sp_ProcessReturn",
                Params(req, UserId, UserId, commit: false), commandType: CommandType.StoredProcedure);
            var header = await multi.ReadSingleAsync();
            var items = (await multi.ReadAsync()).ToList();
            return Ok(new { header, items });
        }
        catch (SqlException ex) when (ex.Number is >= 51200 and < 51300) { return BadRequest(new { message = ex.Message }); }
    }

    [HttpPost]
    public async Task<IActionResult> Create(ReturnRequest req)
    {
        using var con = Db.Open();
        var gate = await CheckAllowedAsync(con, req.OrigSaleUid);
        if (gate != null) return gate;
        if (string.IsNullOrWhiteSpace(req.ReceiptText) || !req.ReceiptText.Contains("######"))
            return BadRequest(new { message = "The return receipt is missing its number placeholder." });

        var branch = await con.ExecuteScalarAsync<string>(
            "SELECT BranchCode FROM dbo.Sales WHERE SaleUid = @u", new { u = req.OrigSaleUid });
        if (!CanActAt(branch!))
            return StatusCode(403, new { message = $"This invoice belongs to branch {branch}." });
        // the branch's switch, or the returning terminal's own answer (35_approvals.sql)
        var terminalId = await con.ExecuteScalarAsync<int?>(
            "SELECT TerminalId FROM dbo.Shifts WHERE ShiftUid = @u", new { u = req.ShiftUid });
        var needsOverride = await Approvals.RequiredAsync(con, branch!, terminalId, Approvals.Return);

        int approverId = UserId;
        if (needsOverride && !IsPrivileged)
        {
            var id = await VerifyApproverAsync(con, req.OverrideUsername, req.OverridePassword, branch);
            if (id == null) return StatusCode(403, new { message = $"Not verified: needs a supervisor of branch {branch} (or an admin)." });
            approverId = id.Value;
        }

        dynamic header; List<dynamic> items;
        try
        {
            using var multi = await con.QueryMultipleAsync("dbo.sp_ProcessReturn",
                Params(req, UserId, approverId, commit: true), commandType: CommandType.StoredProcedure);
            header = await multi.ReadSingleAsync();
            items = (await multi.ReadAsync()).ToList();
        }
        catch (SqlException ex) when (ex.Number is >= 51200 and < 51300) { return BadRequest(new { message = ex.Message }); }

        await AuditAsync(con, "RETURN",
            $"Return {ReceiptBuilder.Rtn(header.ReturnNo)} on SI {ReceiptBuilder.Si(header.OrigORNumber)}: " +
            $"{(decimal)header.NetAmount:N2} refunded. Reason: {req.Reason}. Approved by userId {approverId}",
            (string)header.BranchCode, (int)header.TerminalId);
        return Ok(new { header, items });
    }

    /// A return by its number on a terminal, for Reprint.
    [HttpGet("by-no/{terminalId:int}/{returnNo:int}")]
    public async Task<IActionResult> ByNumber(int terminalId, int returnNo)
    {
        using var con = Db.Open();
        var header = await con.QuerySingleOrDefaultAsync(
            "SELECT * FROM dbo.SaleReturns WHERE TerminalId = @terminalId AND ReturnNo = @returnNo",
            new { terminalId, returnNo });
        if (header == null)
            return NotFound(new { message = $"No return #{returnNo:D6} on this terminal." });
        var items = await con.QueryAsync(
            "SELECT * FROM dbo.SaleReturnItems WHERE ReturnUid = @u ORDER BY [LineNo]", new { u = (Guid)header.ReturnUid });
        return Ok(new { header, items });
    }

    [HttpPost("{returnUid:guid}/reprint-log")]
    public async Task<IActionResult> LogReprint(Guid returnUid,
        [FromBody(EmptyBodyBehavior = Microsoft.AspNetCore.Mvc.ModelBinding.EmptyBodyBehavior.Allow)] ReprintLogRequest? req = null)
    {
        using var con = Db.Open();
        var r = await con.QuerySingleOrDefaultAsync(
            "SELECT BranchCode, TerminalId, ReturnNo FROM dbo.SaleReturns WHERE ReturnUid = @returnUid", new { returnUid });
        if (r == null) return NotFound();
        await AuditAsync(con, "RETURN_REPRINT", $"Return {ReceiptBuilder.Rtn(r.ReturnNo)} reprinted" +
            await SalesController.ApprovedByText(con, req?.ApprovedBy),
            (string)r.BranchCode, (int)r.TerminalId);
        return Ok();
    }

    /// E-invoice: queue an emailed copy of this return receipt (as printed) to any address.
    [HttpPost("{returnUid:guid}/email")]
    public async Task<IActionResult> EmailCopy(Guid returnUid, EmailCopyRequest req)
    {
        using var con = Db.Open();
        var r = await con.QuerySingleOrDefaultAsync(
            "SELECT BranchCode, TerminalId, ReturnNo FROM dbo.SaleReturns WHERE ReturnUid = @returnUid", new { returnUid });
        if (r == null) return NotFound(new { message = "Return not found." });
        if (!CanActAt((string)r.BranchCode)) return StatusCode(403, new { message = $"This return belongs to branch {(string)r.BranchCode}." });
        try
        {
            await con.ExecuteAsync("dbo.sp_QueueInvoiceEmail",
                new { Kind = "RETURN", RefUid = returnUid, BranchCode = (string)r.BranchCode, ToAddress = req.To, RequestedBy = UserId },
                commandType: CommandType.StoredProcedure);
        }
        catch (SqlException ex) when (ex.Number == 53201) { return BadRequest(new { message = ex.Message }); }
        await AuditAsync(con, "INVOICE_EMAIL", $"Return {ReceiptBuilder.Rtn(r.ReturnNo)} emailed to {req.To.Trim()}",
            (string)r.BranchCode, (int)r.TerminalId);
        return Ok(new { status = "queued" });
    }

    /// The branch's "Allow refund / return" setting (PosSettings.RefundEnabled).
    private async Task<IActionResult?> CheckAllowedAsync(IDbConnection con, Guid origSaleUid)
    {
        var enabled = await con.ExecuteScalarAsync<bool?>(
            @"SELECT ps.RefundEnabled FROM dbo.Sales s JOIN dbo.PosSettings ps ON ps.BranchCode = s.BranchCode
              WHERE s.SaleUid = @u", new { u = origSaleUid });
        if (enabled == null) return NotFound(new { message = "The original sales invoice was not found." });
        return enabled.Value ? null : BadRequest(new { message = "Returns are turned off for this branch (Admin → POS Settings)." });
    }

    private static object Params(ReturnRequest req, int cashierId, int approverId, bool commit)
    {
        var items = new DataTable();
        items.Columns.Add("LineNo", typeof(int));
        items.Columns.Add("Quantity", typeof(decimal));
        foreach (var i in req.Items) items.Rows.Add(i.LineNo, i.Quantity);
        return new
        {
            req.ReturnUid, req.OrigSaleUid, req.ShiftUid,
            CashierUserId = cashierId, ApprovedByUserId = approverId, req.Reason,
            Items = items.AsTableValuedParameter("dbo.TVP_ReturnItem"),
            req.ReturnDateTime, req.ExpectedNet, req.ReceiptText, Commit = commit
        };
    }
}
