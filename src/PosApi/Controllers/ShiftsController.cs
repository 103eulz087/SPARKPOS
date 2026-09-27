using System.Data;
using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

[ApiController]
[Route("api/shifts")]
[Authorize]
public class ShiftsController(Db db, PrintService printer, ReceiptBuilder receipts, EmailService email)
    : ApiControllerBase(db)
{
    [HttpPost("open")]
    public async Task<IActionResult> Open(OpenShiftRequest req)
    {
        using var con = Db.Open();
        try
        {
            await con.ExecuteAsync("dbo.sp_OpenShift", new
            {
                req.ShiftUid, req.BranchCode, req.TerminalId, CashierUserId = UserId,
                req.BusinessDate, req.CashBegin, req.OpenedAt
            }, commandType: CommandType.StoredProcedure);
        }
        catch (Exception ex) { return BadRequest(new { message = ex.Message }); }

        await AuditAsync(con, "SHIFT_OPEN", $"Cash begin {req.CashBegin:N2}", req.BranchCode, req.TerminalId);
        return Ok(new { status = "opened", shiftUid = req.ShiftUid });
    }

    [HttpGet("current")]
    public async Task<IActionResult> Current([FromQuery] int terminalId)
    {
        using var con = Db.Open();
        var s = await con.QuerySingleOrDefaultAsync(
            @"SELECT s.ShiftUid, s.BranchCode, s.TerminalId, t.TerminalCode, s.CashierUserId,
                     u.FullName AS Cashier, s.BusinessDate, s.CashBegin, s.OpenedAt, s.Status
              FROM dbo.Shifts s
              JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
              JOIN dbo.Users u ON u.UserId = s.CashierUserId
              WHERE s.TerminalId = @terminalId AND s.Status = 'Open'", new { terminalId });
        return Ok(s);
    }

    /// BLIND CLOSE — accepts denominations only and returns no figures.
    /// Short/Over is computed in sp_ProcessBlindClose and printed server-side.
    [HttpPost("blind-close")]
    public async Task<IActionResult> BlindClose(BlindCloseRequest req)
    {
        var declared = req.Denominations.Sum(d => decimal.Parse(d.Key) * d.Value);
        var denomsJson = JsonSerializer.Serialize(req.Denominations);

        using var con = Db.Open();
        try
        {
            await con.ExecuteAsync("dbo.sp_ProcessBlindClose",
                new { req.ShiftUid, DeclaredCash = declared, DenominationsJson = denomsJson },
                commandType: CommandType.StoredProcedure);
        }
        catch (Exception ex) { return BadRequest(new { message = ex.Message }); }

        await AuditAsync(con, "BLIND_CLOSE", $"Shift {req.ShiftUid} closed, declared {declared:N2}");

        // Print the variance report without ever returning it to the cashier's client.
        var v = await con.QuerySingleOrDefaultAsync("dbo.sp_GetShiftVariance",
            new { req.ShiftUid }, commandType: CommandType.StoredProcedure);
        if (v != null)
        {
            var t = await con.QuerySingleOrDefaultAsync<(string? PrinterTarget, int PaperWidth, string? PrintAgentKey)>(
                @"SELECT t.PrinterTarget, t.PaperWidth, t.PrintAgentKey FROM dbo.Shifts s
                  JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId WHERE s.ShiftUid = @u",
                new { u = req.ShiftUid });
            await printer.EnqueueAsync(con, receipts.BlindClose(v, t.PaperWidth), t.PrinterTarget, t.PrintAgentKey);
        }

        // Optional emailed shift report (X-Read + item summary + hourly breakdown) — same
        // no-peek guarantee as the printed variance report: the cashier never sees any of
        // this, it only ever goes to the admin recipients configured for email.
        var branchCode = await con.ExecuteScalarAsync<string?>(
            "SELECT BranchCode FROM dbo.Shifts WHERE ShiftUid = @u", new { u = req.ShiftUid });
        var emailOn = branchCode != null && await con.ExecuteScalarAsync<bool>(
            "SELECT EmailOnBlindClose FROM dbo.PosSettings WHERE BranchCode = @b", new { b = branchCode });
        if (emailOn)
        {
            var x = await con.QuerySingleOrDefaultAsync("dbo.sp_rpt_XRead",
                new { ShiftUid = req.ShiftUid }, commandType: CommandType.StoredProcedure);
            if (x != null)
            {
                var items = await con.QueryAsync("dbo.sp_rpt_GroupItemsByShift",
                    new { ShiftUid = req.ShiftUid }, commandType: CommandType.StoredProcedure);
                var hourly = await con.QueryAsync("dbo.sp_rpt_HourlyByShift",
                    new { ShiftUid = req.ShiftUid }, commandType: CommandType.StoredProcedure);
                var body = receipts.XReadEmailHtml(x, items, hourly);
                await email.SendReportAsync(branchCode!,
                    $"Shift Close Report {x.BranchCode}/{x.TerminalCode} - {x.Cashier} - " +
                    $"{((DateTime)x.BusinessDate):yyyy-MM-dd}", body);
            }
        }

        return Ok(new { status = "submitted" });   // the only thing the cashier sees
    }

    /// Every terminal currently stuck with a shift the cashier never blind-closed.
    /// Admin recovery list — separate from sp_GetPendingEod, which only covers
    /// shifts that already made it to BlindClosed.
    [HttpGet("open")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> OpenShifts()
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT s.ShiftUid, s.BranchCode, b.BranchName, s.TerminalId, t.TerminalCode,
                     u.FullName AS Cashier, s.BusinessDate, s.CashBegin, s.OpenedAt
              FROM dbo.Shifts s
              JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
              JOIN dbo.Branches b ON b.BranchCode = s.BranchCode
              JOIN dbo.Users u ON u.UserId = s.CashierUserId
              WHERE s.Status = 'Open'
              ORDER BY s.OpenedAt"));
    }

    /// Closes a shift on behalf of a cashier who never ran their own Blind Close —
    /// the drawer count entered here must come from a physical count on-site, since
    /// it plays the exact role the cashier's own blind close would have.
    [HttpPost("{shiftUid:guid}/force-blind-close")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> ForceBlindClose(Guid shiftUid, ForceBlindCloseRequest req)
    {
        var declared = req.Denominations.Sum(d => decimal.Parse(d.Key) * d.Value);
        var denomsJson = JsonSerializer.Serialize(req.Denominations);

        using var con = Db.Open();
        try
        {
            await con.ExecuteAsync("dbo.sp_ProcessBlindClose",
                new { ShiftUid = shiftUid, DeclaredCash = declared, DenominationsJson = denomsJson },
                commandType: CommandType.StoredProcedure);
        }
        catch (Exception ex) { return BadRequest(new { message = ex.Message }); }

        await AuditAsync(con, "ADMIN_FORCE_BLIND_CLOSE",
            $"Shift {shiftUid} force-closed by {Username}, declared {declared:N2}. Reason: {req.Remark}");

        var v = await con.QuerySingleOrDefaultAsync("dbo.sp_GetShiftVariance",
            new { ShiftUid = shiftUid }, commandType: CommandType.StoredProcedure);
        if (v != null)
        {
            var t = await con.QuerySingleOrDefaultAsync<(string? PrinterTarget, int PaperWidth, string? PrintAgentKey)>(
                @"SELECT t.PrinterTarget, t.PaperWidth, t.PrintAgentKey FROM dbo.Shifts s
                  JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId WHERE s.ShiftUid = @u",
                new { u = shiftUid });
            await printer.EnqueueAsync(con, receipts.BlindClose(v, t.PaperWidth), t.PrinterTarget, t.PrintAgentKey);
        }

        return Ok(new { status = "closed", variance = (object?)v });
    }

    [HttpPost("{shiftUid:guid}/xread")]
    public async Task<IActionResult> XRead(Guid shiftUid)
    {
        using var con = Db.Open();
        var x = await con.QuerySingleOrDefaultAsync("dbo.sp_rpt_XRead",
            new { ShiftUid = shiftUid }, commandType: CommandType.StoredProcedure);
        if (x == null) return NotFound();

        var t = await con.QuerySingleOrDefaultAsync<(string? PrinterTarget, int PaperWidth, string? PrintAgentKey)>(
            @"SELECT t.PrinterTarget, t.PaperWidth, t.PrintAgentKey FROM dbo.Shifts s
              JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId WHERE s.ShiftUid = @u", new { u = shiftUid });
        var text = receipts.XRead(x, t.PaperWidth);
        await printer.EnqueueAsync(con, text, t.PrinterTarget, t.PrintAgentKey);

        await AuditAsync(con, "XREAD", $"X-Read for shift {shiftUid}");

        // Cashiers get counts only on screen; supervisors and admins get the figures.
        // receiptText is returned regardless of role — it's the same paper slip a
        // cashier legitimately ends up holding once it prints, just needed client-side
        // now too so a terminal on RawBT (no server-reachable printer) can print it itself.
        // "printed" really means "queued" now (PrintAgent polls, doesn't get pushed to) —
        // same level of honesty as RawBT already has elsewhere: a handoff, not a confirmation.
        return Ok(IsPrivileged
            ? new { printed = true, data = (object)x, receiptText = text }
            : new { printed = true, data = (object)new { x.TxnCount, x.VoidCount }, receiptText = text });
    }

    [HttpGet("{shiftUid:guid}/variance")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Variance(Guid shiftUid)
    {
        using var con = Db.Open();
        var v = await con.QuerySingleOrDefaultAsync("dbo.sp_GetShiftVariance",
            new { ShiftUid = shiftUid }, commandType: CommandType.StoredProcedure);
        return v == null ? NotFound() : Ok(v);
    }

    [HttpGet("closings")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Closings([FromQuery] DateTime dateFrom, [FromQuery] DateTime dateTo,
        [FromQuery] string? branchCode)
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT c.ShiftUid, s.BranchCode, t.TerminalCode, u.FullName AS Cashier, s.BusinessDate,
                     s.CashBegin, c.CashSales, c.CardSales, c.DeclaredCash, c.ExpectedCash,
                     c.ShortOver, c.DenominationsJson, c.ClosedAt
              FROM dbo.ShiftClosings c
              JOIN dbo.Shifts s ON s.ShiftUid = c.ShiftUid
              JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
              JOIN dbo.Users u ON u.UserId = s.CashierUserId
              WHERE s.BusinessDate BETWEEN @dateFrom AND @dateTo
                AND (@branchCode IS NULL OR s.BranchCode = @branchCode)
              ORDER BY c.ClosedAt DESC", new { dateFrom, dateTo, branchCode }));
    }
}
