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

    /// Verifies a Supervisor/Admin credential for override-gated actions
    /// (void, price edit, End of Day). Returns the approver's UserId, or null.
    protected static async Task<int?> VerifyApproverAsync(IDbConnection con, string? username, string? password)
    {
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password)) return null;
        var u = await con.QuerySingleOrDefaultAsync<dynamic>(
            @"SELECT UserId, PasswordHash, PasswordSalt, Role FROM dbo.Users
              WHERE Username = @u AND IsActive = 1 AND Role IN ('Supervisor','Admin')",
            new { u = username });
        if (u == null) return null;
        return PasswordHasher.Verify((string)u.PasswordSalt, password, (string)u.PasswordHash)
            ? (int)u.UserId : null;
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
