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
        if (await TerminalDevices.RefusalAsync(con, req.TerminalId, Request.Headers[TerminalDevices.Header]) is string refused)
            return BadRequest(new { message = refused });
        // The shift is at the terminal's own branch, and (but for an Admin) the branch signed in at.
        var termBranch = await con.ExecuteScalarAsync<string?>(
            "SELECT BranchCode FROM dbo.Terminals WHERE TerminalId = @id AND IsActive = 1", new { id = req.TerminalId });
        if (termBranch == null) return BadRequest(new { message = "This terminal doesn't exist or is switched off." });
        if (!CanActAt(termBranch))
            return StatusCode(403, new { message = $"This terminal belongs to branch {termBranch}. You're signed in at branch {Branch}." });
        if (req.BranchCode != termBranch)
            return StatusCode(403, new { message = $"This terminal belongs to branch {termBranch}, not {req.BranchCode}. Reload Cash Begin and try again." });
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

    /// 39: the till opened the drawer with no sale (Pos → Open drawer). Logged once per DrawerOpenUid,
    /// counted on the X-Read and Z-Read, and in the audit log. The drawer is already open, so this
    /// never refuses a reason the till accepted; it only checks the shift is the caller's branch.
    [HttpPost("{shiftUid:guid}/drawer-open")]
    public async Task<IActionResult> DrawerOpen(Guid shiftUid, DrawerOpenRequest req)
    {
        var reason = (req.Reason ?? "").Trim();
        if (reason.Length == 0) return BadRequest(new { message = "Give a reason for opening the drawer." });
        using var con = Db.Open();
        if (await con.ExecuteScalarAsync<int>("SELECT CASE WHEN OBJECT_ID('dbo.DrawerOpens', 'U') IS NULL THEN 0 ELSE 1 END") == 0)
            return Ok(new { logged = false });   // a DB without 39: the till keeps working
        var shift = await con.QuerySingleOrDefaultAsync(
            "SELECT BranchCode, TerminalId FROM dbo.Shifts WHERE ShiftUid = @shiftUid", new { shiftUid });
        if (shift == null) return BadRequest(new { message = "Shift not found." });
        if (!CanActAt((string)shift.BranchCode)) return StatusCode(403, new { message = "That shift is at another branch." });
        string? note = string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim()[..Math.Min(req.Note.Trim().Length, 200)];
        var method = req.Method is "KICK" or "SLIP" ? req.Method : null;
        var added = await con.ExecuteAsync(
            @"INSERT INTO dbo.DrawerOpens (DrawerOpenUid, ShiftUid, BranchCode, TerminalId, UserId, ApprovedBy, Reason, Note, OpenedAt, Method)
              SELECT @uid, @shiftUid, @b, @t, @u, @a, @reason, @note, @at, @method
              WHERE NOT EXISTS (SELECT 1 FROM dbo.DrawerOpens WHERE DrawerOpenUid = @uid)",
            new { uid = req.DrawerOpenUid, shiftUid, b = (string)shift.BranchCode, t = (int)shift.TerminalId, u = UserId,
                  a = req.ApprovedBy, reason = reason[..Math.Min(reason.Length, 60)], note, at = req.OpenedAt, method });
        if (added > 0)
            await AuditAsync(con, "DRAWER_OPEN",
                $"Drawer opened, no sale: {reason}{(note != null ? $" ({note})" : "")}" +
                $"{(req.ApprovedBy != null ? $", approved by userId {req.ApprovedBy}" : "")}{(method == "SLIP" ? ", NO SALE slip" : "")}",
                (string)shift.BranchCode, (int)shift.TerminalId);
        return Ok(new { logged = true });
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
        // A Supervisor may only force-close shifts at their own branch; an Admin anywhere.
        var shiftBranch = await con.ExecuteScalarAsync<string?>(
            "SELECT BranchCode FROM dbo.Shifts WHERE ShiftUid = @shiftUid", new { shiftUid });
        if (shiftBranch == null) return NotFound(new { message = "Shift not found." });
        if (!CanActAt(shiftBranch)) return StatusCode(403, new { message = $"This shift belongs to branch {shiftBranch}." });
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
    public async Task<IActionResult> XRead(Guid shiftUid,
        [FromBody(EmptyBodyBehavior = Microsoft.AspNetCore.Mvc.ModelBinding.EmptyBodyBehavior.Allow)] XReadRequest? req = null)
    {
        using var con = Db.Open();
        // 35: a supervisor's approval when the branch (or this terminal) needs one
        var shift = await con.QuerySingleOrDefaultAsync(
            "SELECT BranchCode, TerminalId FROM dbo.Shifts WHERE ShiftUid = @shiftUid", new { shiftUid });
        if (shift == null) return NotFound();
        string shiftBranch = shift.BranchCode; int shiftTerminal = shift.TerminalId;
        string approvedBy = "";
        if (!IsPrivileged && await Approvals.RequiredAsync(con, shiftBranch, shiftTerminal, Approvals.XRead))
        {
            var id = await VerifyApproverAsync(con, req?.OverrideUsername, req?.OverridePassword, shiftBranch);
            if (id == null) return StatusCode(403, new { message = $"X-Read needs a supervisor of branch {shiftBranch} (or an admin).", needsApproval = true });
            approvedBy = await SalesController.ApprovedByText(con, id);
        }
        var x = await con.QuerySingleOrDefaultAsync("dbo.sp_rpt_XRead",
            new { ShiftUid = shiftUid }, commandType: CommandType.StoredProcedure);
        if (x == null) return NotFound();

        var t = await con.QuerySingleOrDefaultAsync<(string? PrinterTarget, int PaperWidth, string? PrintAgentKey)>(
            @"SELECT t.PrinterTarget, t.PaperWidth, t.PrintAgentKey FROM dbo.Shifts s
              JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId WHERE s.ShiftUid = @u", new { u = shiftUid });
        var text = receipts.XRead(x, t.PaperWidth);
        await printer.EnqueueAsync(con, text, t.PrinterTarget, t.PrintAgentKey);

        await AuditAsync(con, "XREAD", $"X-Read for shift {shiftUid}{approvedBy}");

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
