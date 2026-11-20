using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

[ApiController]
[Route("api/auth")]
public class AuthController(Db db, TokenService tokens, ErpSyncService erpSync) : ApiControllerBase(db)
{
    /// Sign in. The branch comes from the user: a Cashier/Supervisor works at the branch they're
    /// assigned to (for an ERP user, the ERP's AssignedBranch), so no picker. Someone who may
    /// work at several (an Admin, or a local user with several branches) gets
    /// needsBranch + the list back and signs in again with one picked.
    /// ERP users are re-read from the ERP first (a password changed there works at once);
    /// if the ERP can't be reached, SparkPOS's synced copy is used.
    [HttpPost("login")]
    public async Task<IActionResult> Login(LoginRequest req)
    {
        var username = (req.Username ?? "").Trim();
        var refresh = await erpSync.RefreshUserAsync(username);

        using var con = Db.Open();
        var u = await UserAuth.FindAsync(con, username);
        if (u == null) return Unauthorized(new { message = "Invalid username or password." });
        if (u.ErpUserId != null && refresh == ErpSyncService.RefreshResult.NotInErp)
            return StatusCode(403, new { message = "This user isn't set up for SparkPOS in the ERP (no POS role or password there). Ask head office." });

        switch (await UserAuth.CheckAsync(con, u, req.Password))
        {
            case UserAuth.Outcome.Inactive:
            case UserAuth.Outcome.BadPassword:
                return Unauthorized(new { message = "Invalid username or password." });
            case UserAuth.Outcome.Locked:
                return StatusCode(423, new { message = $"Too many wrong passwords. This user is locked for {UserAuth.LockFor.TotalMinutes:0} minutes." });
        }
        if (u.MustChangePassword)
            return StatusCode(403, new { message = "You must change your password in the ERP first, then sign in here." });

        var branches = await UserAuth.BranchesAsync(con, u);
        if (branches.Count == 0)
            return StatusCode(403, new { message = "You aren't assigned to a branch yet. Ask your administrator." });

        var branch = (req.BranchCode ?? "").Trim();
        // A till assigned to its terminal is at that terminal's branch: only that branch's own
        // users sign in on it, and an Admin signs in there without the branch picker.
        var till = await TerminalDevices.AssignedAsync(con, Request.Headers[TerminalDevices.Header]);
        if (till != null)
        {
            if (!branches.Contains(till.BranchCode))
            {
                await con.ExecuteAsync(
                    "INSERT INTO dbo.AuditLogs (BranchCode, UserId, TerminalId, Action, Detail) VALUES (@b, @id, @t, 'LOGIN_WRONG_BRANCH', @d)",
                    new { b = till.BranchCode, id = u.UserId, t = till.TerminalId,
                          d = $"{u.Username} (branch {string.Join(",", branches)}) refused on {till.BranchCode} {till.TerminalCode}" });
                return StatusCode(403, new { message =
                    $"This till is {till.TerminalCode} of branch {till.BranchCode} {till.BranchName}. " +
                    $"You're assigned to branch {string.Join(", ", branches)}, so sign in at your own branch's till." });
            }
            if (branch.Length > 0 && branch != till.BranchCode)
                return StatusCode(403, new { message = $"This till is at branch {till.BranchCode}; sign in for that branch." });
            branch = till.BranchCode;
        }
        if (branch.Length == 0)
        {
            if (branches.Count > 1)
            {
                var list = await con.QueryAsync(
                    "SELECT BranchCode, BranchName FROM dbo.Branches WHERE BranchCode IN @b ORDER BY BranchCode",
                    new { b = branches });
                return Ok(new { needsBranch = true, branches = list });
            }
            branch = branches[0];
        }
        else if (!branches.Contains(branch))
            return StatusCode(403, new { message = $"You do not have access to branch {branch}." });

        await con.ExecuteAsync(
            "INSERT INTO dbo.AuditLogs (BranchCode, UserId, Action, Detail) VALUES (@b, @id, 'LOGIN', @d)",
            new { b = branch, id = u.UserId,
                  d = $"{u.Username} signed in" + (refresh == ErpSyncService.RefreshResult.Unreachable ? " (ERP unreachable — synced copy used)" : "") });

        return Ok(new
        {
            token = tokens.Create(u.UserId, u.Username, u.FullName, u.Role, branch),
            userId = u.UserId,
            username = u.Username,
            fullName = u.FullName,
            role = u.Role,
            branchCode = branch,
            branches
        });
    }

    /// Public: the login screen needs the branch list before anyone is authenticated.
    [HttpGet("branches")]
    public async Task<IActionResult> PublicBranches()
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            "SELECT BranchCode, BranchName FROM dbo.Branches WHERE IsActive = 1 ORDER BY BranchCode"));
    }

    /// Public: the till this device is assigned to, so the sign-in page can say where it is.
    /// Only the device holding the token learns it; an unassigned device gets null.
    [HttpGet("device")]
    public async Task<IActionResult> Device()
    {
        using var con = Db.Open();
        var t = await TerminalDevices.AssignedAsync(con, Request.Headers[TerminalDevices.Header]);
        return Ok(t == null ? null : new { t.TerminalCode, t.BranchCode, t.BranchName });
    }

    /// Supervisor override at the till for something that isn't on the server yet (a price
    /// change on a line in the cart). Returns who approved, so the sale line can carry it.
    [HttpPost("verify-approver")]
    [Authorize]
    public async Task<IActionResult> VerifyApprover(ApproverCheckRequest req)
    {
        using var con = Db.Open();
        var id = await VerifyApproverAsync(con, req.Username, req.Password, Branch);
        if (id == null) return StatusCode(403, new { message = $"Not verified: needs a supervisor of branch {Branch} (or an admin)." });
        var a = await con.QuerySingleAsync("SELECT FullName, Role FROM dbo.Users WHERE UserId = @id", new { id });
        return Ok(new { userId = id.Value, fullName = (string)a.FullName, role = (string)a.Role });
    }
}
