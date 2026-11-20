using System.Data;
using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Mvc;
using PosApi.Services;

namespace PosApi.Controllers;

public abstract class ApiControllerBase(Db db) : ControllerBase
{
    protected readonly Db Db = db;

    protected int UserId => int.Parse(User.FindFirstValue(ClaimTypes.NameIdentifier)!);
    protected string Username => User.FindFirstValue(ClaimTypes.Name) ?? "";
    protected string FullName => User.FindFirstValue("fullName") ?? "";
    protected string Branch => User.FindFirstValue("branch") ?? "";
    protected bool IsPrivileged => User.IsInRole("Admin") || User.IsInRole("Supervisor");

    /// Cashiers and Supervisors work only at the branch they signed in to (their own); an
    /// Admin anywhere. Guards actions on another branch's sales, terminals and days.
    protected bool CanActAt(string branchCode) => User.IsInRole("Admin") || Branch == branchCode;

    /// Verifies a Supervisor/Admin credential for override-gated actions (void, return, price
    /// change, End of Day) at branchCode: a Supervisor must belong to that branch, an Admin may
    /// approve anywhere. Local and ERP users alike (UserAuth), and wrong passwords count toward
    /// the same lockout as login. Returns the approver's UserId, or null.
    protected static async Task<int?> VerifyApproverAsync(IDbConnection con, string? username, string? password,
        string branchCode)
    {
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password)) return null;
        var u = await UserAuth.FindAsync(con, username);
        if (u == null || u.Role is not ("Supervisor" or "Admin")) return null;
        if (await UserAuth.CheckAsync(con, u, password) != UserAuth.Outcome.Ok) return null;
        if (u.Role == "Supervisor" && !(await UserAuth.BranchesAsync(con, u)).Contains(branchCode)) return null;
        return u.UserId;
    }

    protected async Task AuditAsync(IDbConnection con, string action, string detail,
        string? branchCode = null, int? terminalId = null)
    {
        await con.ExecuteAsync(
            @"INSERT INTO dbo.AuditLogs (BranchCode, UserId, TerminalId, Action, Detail)
              VALUES (@b, @u, @t, @a, @d)",
            new { b = branchCode ?? Branch, u = UserId, t = terminalId, a = action, d = detail });
    }
}
