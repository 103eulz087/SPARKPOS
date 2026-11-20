using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

/// Supervisor approvals (35_approvals.sql): which till actions need one, per branch with a
/// terminal's own answer on top. The branch's switches are saved with the POS settings
/// (SettingsController.Update); this saves the terminals' answers and tells a till its own.
[ApiController]
[Route("api/approvals")]
[Authorize]
public class ApprovalsController(Db db) : ApiControllerBase(db)
{
    /// A till's own answers, cached by the till for offline. Any signed-in user.
    [HttpGet("terminal/{terminalId:int}")]
    public async Task<IActionResult> ForTerminal(int terminalId)
    {
        using var con = Db.Open();
        var branch = await con.ExecuteScalarAsync<string?>(
            "SELECT BranchCode FROM dbo.Terminals WHERE TerminalId = @terminalId", new { terminalId });
        if (branch == null) return NotFound(new { message = "No such terminal." });
        var r = await Approvals.TerminalAsync(con, branch, terminalId);
        return Ok(Approvals.Funcs.Select(f => new { func = f.Func, required = r[f.Func].Required, own = r[f.Func].OwnSetting }));
    }

    /// Admin → POS Settings: the branch's switches and each of its terminals' own answers.
    [HttpGet("branch/{branchCode}")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> ForBranch(string branchCode)
    {
        using var con = Db.Open();
        var installed = await Approvals.TerminalTableAsync(con);
        var terminals = (await con.QueryAsync<(int TerminalId, string TerminalCode, bool IsActive)>(
            "SELECT TerminalId, TerminalCode, IsActive FROM dbo.Terminals WHERE BranchCode = @branchCode ORDER BY TerminalCode",
            new { branchCode })).ToList();
        var own = installed
            ? (await con.QueryAsync<(int TerminalId, string Func, bool Required)>(
                @"SELECT o.TerminalId, o.Func, o.Required FROM dbo.TerminalOverrides o
                  JOIN dbo.Terminals t ON t.TerminalId = o.TerminalId WHERE t.BranchCode = @branchCode", new { branchCode })).ToList()
            : [];
        return Ok(new
        {
            installed,
            branch = await Approvals.BranchAsync(con, branchCode),
            terminals = terminals.Select(t => new
            {
                terminalId = t.TerminalId, terminalCode = t.TerminalCode, isActive = t.IsActive,
                own = own.Where(o => o.TerminalId == t.TerminalId).ToDictionary(o => o.Func, o => o.Required)
            })
        });
    }

    /// Replaces the terminals' own answers at a branch. Each row: a terminal, a function and
    /// Required true / false; a terminal + function left out follows the branch.
    [HttpPut("branch/{branchCode}/terminals")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> SaveTerminals(string branchCode, List<TerminalApprovalDto> rows)
    {
        using var con = Db.Open();
        if (!await Approvals.TerminalTableAsync(con))
            return BadRequest(new { message = "Approvals per terminal need database update 35 (35_approvals.sql)." });
        var funcs = Approvals.Funcs.Select(f => f.Func).ToHashSet();
        if (rows.Any(r => !funcs.Contains(r.Func)))
            return BadRequest(new { message = "Unknown function." });
        var ids = (await con.QueryAsync<int>("SELECT TerminalId FROM dbo.Terminals WHERE BranchCode = @branchCode",
            new { branchCode })).ToHashSet();
        if (rows.Any(r => !ids.Contains(r.TerminalId)))
            return BadRequest(new { message = "A terminal isn't at this branch." });
        rows = rows.GroupBy(r => (r.TerminalId, r.Func)).Select(g => g.Last()).ToList();

        con.Open();   // Db.Open() leaves it closed (Dapper opens per call); a transaction needs it open
        using (var tx = con.BeginTransaction())
        {
            await con.ExecuteAsync(
                @"DELETE o FROM dbo.TerminalOverrides o JOIN dbo.Terminals t ON t.TerminalId = o.TerminalId
                  WHERE t.BranchCode = @branchCode", new { branchCode }, tx);
            foreach (var r in rows)
                await con.ExecuteAsync(
                    "INSERT INTO dbo.TerminalOverrides (TerminalId, Func, Required, UpdatedBy) VALUES (@TerminalId, @Func, @Required, @uid)",
                    new { r.TerminalId, r.Func, r.Required, uid = UserId }, tx);
            tx.Commit();
        }
        var codes = (await con.QueryAsync<(int TerminalId, string TerminalCode)>(
            "SELECT TerminalId, TerminalCode FROM dbo.Terminals WHERE BranchCode = @branchCode", new { branchCode }))
            .ToDictionary(t => t.TerminalId, t => t.TerminalCode);
        await AuditAsync(con, "APPROVALS_TERMINAL",
            rows.Count == 0 ? $"{branchCode}: every terminal follows the branch"
                : $"{branchCode}: " + string.Join(", ", rows.Select(r => $"{codes[r.TerminalId]} {r.Func} {(r.Required ? "required" : "not needed")}")),
            branchCode);
        return Ok();
    }
}
