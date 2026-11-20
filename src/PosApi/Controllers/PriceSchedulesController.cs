using System.Data;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Services;

namespace PosApi.Controllers;

/// A price level by time of day (database/40_price_schedules.sql): e.g. Price 1 from 7 PM to 11:59 PM.
/// Per terminal, per branch, or one for every branch: a till uses its own schedules if it has any,
/// else its branch's, else the every-branch ones (e.g. the GRILLS tills on their own). The till loads
/// its own with the POS screen (cached for offline) and applies them by its own
/// clock from the next sale (store.js scheduledLevel). Admin edits them.
[ApiController]
[Route("api/price-schedules")]
[Authorize]
public class PriceSchedulesController(Db db) : ApiControllerBase(db)
{
    private static async Task<bool> InstalledAsync(IDbConnection con) =>
        await con.ExecuteScalarAsync<int>("SELECT CASE WHEN OBJECT_ID('dbo.PriceLevelSchedules', 'U') IS NULL THEN 0 ELSE 1 END") == 1;

    private const string Cols =
        @"s.ScheduleId, s.BranchCode, s.TerminalId, t.TerminalCode, s.PriceLevel, l.LevelName, CONVERT(CHAR(5), s.StartTime, 108) AS StartTime,
          CONVERT(CHAR(5), s.EndTime, 108) AS EndTime, s.Days, s.IsActive, s.Note";

    /// The schedules one till follows (switched-on ones only): its own if it has any, else its
    /// branch's, else the every-branch ones. Any signed-in user; empty on a DB without 40.
    [HttpGet("terminal/{terminalId:int}")]
    public async Task<IActionResult> ForTerminal(int terminalId)
    {
        using var con = Db.Open();
        if (!await InstalledAsync(con)) return Ok(Array.Empty<object>());
        return Ok(await con.QueryAsync(
            $@"DECLARE @b VARCHAR(10) = (SELECT BranchCode FROM dbo.Terminals WHERE TerminalId = @id);
               DECLARE @tier INT = CASE
                   WHEN EXISTS (SELECT 1 FROM dbo.PriceLevelSchedules WHERE IsActive = 1 AND TerminalId = @id) THEN 1
                   WHEN EXISTS (SELECT 1 FROM dbo.PriceLevelSchedules WHERE IsActive = 1 AND TerminalId IS NULL AND BranchCode = @b) THEN 2
                   ELSE 3 END;
               SELECT {Cols} FROM dbo.PriceLevelSchedules s
               LEFT JOIN dbo.PriceLevels l ON l.PriceLevel = s.PriceLevel
               LEFT JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
               WHERE s.IsActive = 1 AND CASE WHEN s.TerminalId = @id THEN 1
                                             WHEN s.TerminalId IS NULL AND s.BranchCode = @b THEN 2
                                             WHEN s.TerminalId IS NULL AND s.BranchCode IS NULL THEN 3 END = @tier
               ORDER BY s.StartTime", new { id = terminalId }));
    }

    [HttpGet]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> List()
    {
        using var con = Db.Open();
        if (!await InstalledAsync(con)) return Ok(Array.Empty<object>());
        return Ok(await con.QueryAsync(
            $@"SELECT {Cols}, s.UpdatedAt, u.FullName AS UpdatedByName
               FROM dbo.PriceLevelSchedules s
               LEFT JOIN dbo.PriceLevels l ON l.PriceLevel = s.PriceLevel
               LEFT JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
               LEFT JOIN dbo.Users u ON u.UserId = s.UpdatedBy
               ORDER BY CASE WHEN s.BranchCode IS NULL THEN 0 ELSE 1 END, s.BranchCode, t.TerminalCode, s.StartTime"));
    }

    [HttpPost]
    [Authorize(Roles = "Admin")]
    public Task<IActionResult> Create(PriceScheduleDto r) => SaveAsync(null, r);

    [HttpPut("{id:int}")]
    [Authorize(Roles = "Admin")]
    public Task<IActionResult> Update(int id, PriceScheduleDto r) => SaveAsync(id, r);

    private async Task<IActionResult> SaveAsync(int? id, PriceScheduleDto r)
    {
        if (r.PriceLevel is < 1 or > 4) return BadRequest(new { message = "Pick Price 1 to 4." });
        if (!TimeSpan.TryParse(r.StartTime, out var start) || !TimeSpan.TryParse(r.EndTime, out var end)
            || start < TimeSpan.Zero || start >= TimeSpan.FromDays(1) || end < TimeSpan.Zero || end >= TimeSpan.FromDays(1))
            return BadRequest(new { message = "Enter the start and end times, e.g. 19:00 and 23:59." });
        if (start == end) return BadRequest(new { message = "The start and end times are the same." });
        var days = (r.Days ?? "").Trim().ToUpperInvariant();
        if (days.Length != 7 || days.Any(c => c is not ('Y' or 'N')) || !days.Contains('Y'))
            return BadRequest(new { message = "Pick at least one day." });
        var branch = string.IsNullOrWhiteSpace(r.BranchCode) ? null : r.BranchCode.Trim();
        var note = string.IsNullOrWhiteSpace(r.Note) ? null : r.Note.Trim()[..Math.Min(r.Note.Trim().Length, 100)];

        using var con = Db.Open();
        if (!await InstalledAsync(con)) return BadRequest(new { message = "Run database/40_price_schedules.sql on this server first." });
        if (r.TerminalId != null)   // one till: it's at its own branch
        {
            branch = await con.ExecuteScalarAsync<string?>("SELECT BranchCode FROM dbo.Terminals WHERE TerminalId = @t", new { t = r.TerminalId });
            if (branch == null) return BadRequest(new { message = "That terminal doesn't exist." });
        }
        else if (branch != null && await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM dbo.Branches WHERE BranchCode = @branch", new { branch }) == 0)
            return BadRequest(new { message = $"No branch {branch}." });
        var p = new { id, branch, terminal = r.TerminalId, level = r.PriceLevel, start, end, days, active = r.IsActive, note, u = UserId };
        if (id == null)
            id = await con.ExecuteScalarAsync<int>(
                @"INSERT INTO dbo.PriceLevelSchedules (BranchCode, TerminalId, PriceLevel, StartTime, EndTime, Days, IsActive, Note, UpdatedBy)
                  OUTPUT inserted.ScheduleId VALUES (@branch, @terminal, @level, @start, @end, @days, @active, @note, @u)", p);
        else if (await con.ExecuteAsync(
                @"UPDATE dbo.PriceLevelSchedules SET BranchCode = @branch, TerminalId = @terminal, PriceLevel = @level, StartTime = @start, EndTime = @end,
                    Days = @days, IsActive = @active, Note = @note, UpdatedAt = SYSDATETIME(), UpdatedBy = @u
                  WHERE ScheduleId = @id", p) == 0)
            return NotFound(new { message = "That schedule no longer exists." });
        await AuditAsync(con, "PRICE_SCHEDULE_SAVE",
            $"Price {r.PriceLevel} {start:hh\\:mm}-{end:hh\\:mm} days {days} at {(r.TerminalId != null ? $"terminal {r.TerminalId} ({branch})" : branch ?? "every branch")}{(r.IsActive ? "" : " (off)")} (schedule {id})",
            branch);
        return Ok(new { scheduleId = id });
    }

    [HttpDelete("{id:int}")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> Delete(int id)
    {
        using var con = Db.Open();
        var branch = await con.QuerySingleOrDefaultAsync<string?>(
            "DELETE FROM dbo.PriceLevelSchedules OUTPUT deleted.BranchCode WHERE ScheduleId = @id", new { id });
        await AuditAsync(con, "PRICE_SCHEDULE_DELETE", $"Price level schedule {id} deleted", branch);
        return Ok();
    }
}

/// Days: 7 characters, Monday first, Y or N (e.g. "YYYYYNN" = weekdays). Times "HH:mm". TerminalId set =
/// that till only (its branch is taken from the terminal); else BranchCode, blank = every branch.
public record PriceScheduleDto(string? BranchCode, int PriceLevel, string StartTime, string EndTime, string Days,
    bool IsActive = true, string? Note = null, int? TerminalId = null);
