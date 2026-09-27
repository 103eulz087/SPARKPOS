using System.Data;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

/// End of Day / Z-Read.
/// Three callers, one endpoint and one rule: an approver credential is ALWAYS
/// required, even when an Admin is the one signed in.
///   1. Cashier at the terminal, straight after blind close
///   2. The same cashier signing back in later (EOD-only screen)
///   3. Admin closing the day remotely for a terminal that never ran it
[ApiController]
[Route("api/eod")]
[Authorize]
public class EndOfDayController(Db db, PrintService printer, ReceiptBuilder receipts, EmailService email)
    : ApiControllerBase(db)
{
    [HttpPost("process")]
    public async Task<IActionResult> Process(EndOfDayRequest req)
    {
        using var con = Db.Open();

        var branchCode = await con.ExecuteScalarAsync<string?>(
            "SELECT BranchCode FROM dbo.Terminals WHERE TerminalId = @t", new { t = req.TerminalId });
        if (branchCode == null) return NotFound(new { message = "Terminal not found." });

        // Matches the Void/PriceEdit/Reprint override pattern: a privileged user running
        // it themselves never needs a separate credential, and the setting can turn the
        // requirement off entirely for cashiers too.
        var needsOverride = await con.ExecuteScalarAsync<bool>(
            "SELECT EodOverride FROM dbo.PosSettings WHERE BranchCode = @b", new { b = branchCode });

        var approverId = UserId;
        if (needsOverride && !IsPrivileged)
        {
            var id = await VerifyApproverAsync(con, req.ApproverUsername, req.ApproverPassword);
            if (id == null)
                return StatusCode(403, new { message = "End of Day requires a valid Supervisor or Admin credential." });
            approverId = id.Value;
        }

        dynamic z;
        try
        {
            z = await con.QuerySingleAsync("dbo.sp_ProcessEndOfDay", new
            {
                req.TerminalId,
                req.BusinessDate,
                ClosedByUserId = UserId,
                ApprovedByUserId = approverId,
                req.Remarks
            }, commandType: CommandType.StoredProcedure);
        }
        catch (Exception ex) { return BadRequest(new { message = ex.Message }); }

        var t = await con.QuerySingleOrDefaultAsync<(string? PrinterTarget, int PaperWidth, string? PrintAgentKey)>(
            "SELECT PrinterTarget, PaperWidth, PrintAgentKey FROM dbo.Terminals WHERE TerminalId = @t", new { t = req.TerminalId });
        var text = receipts.ZRead(z, t.PaperWidth);
        await printer.EnqueueAsync(con, text, t.PrinterTarget, t.PrintAgentKey);

        // The printed receipt stays as just the plain-text Z-Read (a 32-column roll has no
        // room for a table); the email gets the richer HTML version with the item summary.
        var items = await con.QueryAsync("dbo.sp_rpt_GroupItemsByTerminalDate",
            new { req.TerminalId, req.BusinessDate }, commandType: CommandType.StoredProcedure);
        var emailBody = receipts.ZReadEmailHtml(z, items);
        var emailed = await email.SendZReadAsync((string)z.BranchCode,
            $"Z-Read {z.BranchCode}/{z.TerminalCode} Z#{z.ZCounter} - {((DateTime)z.BusinessDate):yyyy-MM-dd}", emailBody);

        await AuditAsync(con, "EOD",
            $"End of Day Z#{z.ZCounter} for {z.BranchCode}/{z.TerminalCode} {((DateTime)z.BusinessDate):yyyy-MM-dd}. " +
            $"Net {(decimal)z.NetSales:N2}. Approved by userId {approverId}. Remarks: {req.Remarks ?? "none"}",
            (string)z.BranchCode, req.TerminalId);

        return Ok(new { printed = true, emailed, zread = z, receiptText = text });
    }

    /// Terminals whose day is blind-closed but never Z-Read. Admin recovery list.
    [HttpGet("pending")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Pending()
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync("dbo.sp_GetPendingEod", commandType: CommandType.StoredProcedure));
    }

    /// What the signed-in cashier is allowed to do on this terminal right now.
    /// canSell=false + canRunEod=true is the EOD-only state.
    [HttpGet("terminal-state/{terminalId:int}")]
    public async Task<IActionResult> TerminalState(int terminalId, [FromQuery] DateTime? businessDate)
    {
        using var con = Db.Open();
        var s = await con.QuerySingleAsync<dynamic>("dbo.sp_GetTerminalDayState",
            new { TerminalId = terminalId, BusinessDate = businessDate ?? DateTime.Today },
            commandType: CommandType.StoredProcedure);

        var state = (string)s.DayState;
        return Ok(new
        {
            dayState = state,
            openShifts = (int)s.OpenShifts,
            closedShifts = (int)s.ClosedShifts,
            lastCashier = (string?)s.LastCashier,
            canSell = state != "eodDone",
            canRunEod = state == "eodPending" || (state == "open" && (int)s.OpenShifts == 0 && (int)s.ClosedShifts > 0)
        });
    }

    [HttpGet("zreads")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> ZReads([FromQuery] DateTime dateFrom, [FromQuery] DateTime dateTo,
        [FromQuery] string? branchCode)
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT z.*, t.TerminalCode, b.BranchName,
                     cu.FullName AS ClosedByName, au.FullName AS ApprovedByName
              FROM dbo.ZReads z
              JOIN dbo.Terminals t ON t.TerminalId = z.TerminalId
              JOIN dbo.Branches b ON b.BranchCode = z.BranchCode
              JOIN dbo.Users cu ON cu.UserId = z.ClosedByUserId
              JOIN dbo.Users au ON au.UserId = z.ApprovedByUserId
              WHERE z.BusinessDate BETWEEN @dateFrom AND @dateTo
                AND (@branchCode IS NULL OR z.BranchCode = @branchCode)
              ORDER BY z.BusinessDate DESC, z.BranchCode", new { dateFrom, dateTo, branchCode }));
    }

    /// Reprint an existing Z-Read without re-running the close.
    [HttpPost("zreads/{zreadId:int}/reprint")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Reprint(int zreadId)
    {
        using var con = Db.Open();
        var z = await con.QuerySingleOrDefaultAsync(
            @"SELECT z.*, t.TerminalCode, t.PrinterTarget, t.PaperWidth, t.PrintAgentKey, b.BranchName,
                     cu.FullName AS ClosedByName, au.FullName AS ApprovedByName
              FROM dbo.ZReads z
              JOIN dbo.Terminals t ON t.TerminalId = z.TerminalId
              JOIN dbo.Branches b ON b.BranchCode = z.BranchCode
              JOIN dbo.Users cu ON cu.UserId = z.ClosedByUserId
              JOIN dbo.Users au ON au.UserId = z.ApprovedByUserId
              WHERE z.ZReadId = @zreadId", new { zreadId });
        if (z == null) return NotFound();

        var text = receipts.ZRead(z, (int)z.PaperWidth);
        await printer.EnqueueAsync(con, text, (string?)z.PrinterTarget, (string?)z.PrintAgentKey);
        await AuditAsync(con, "ZREAD_REPRINT", $"Z-Read {zreadId} reprinted");
        return Ok(new { printed = true, receiptText = text });
    }
}
