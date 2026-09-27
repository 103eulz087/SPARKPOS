using Dapper;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

[ApiController]
[Route("api/auth")]
public class AuthController(Db db, TokenService tokens) : ApiControllerBase(db)
{
    [HttpPost("login")]
    public async Task<IActionResult> Login(LoginRequest req)
    {
        using var con = Db.Open();
        var u = await con.QuerySingleOrDefaultAsync<dynamic>(
            @"SELECT UserId, Username, PasswordHash, PasswordSalt, FullName, Role
              FROM dbo.Users WHERE Username = @u AND IsActive = 1", new { u = req.Username });

        if (u == null || !PasswordHasher.Verify((string)u.PasswordSalt, req.Password, (string)u.PasswordHash))
            return Unauthorized(new { message = "Invalid username or password." });

        var role = (string)u.Role;
        var userId = (int)u.UserId;

        // Branch access: Admin may enter any branch; others need a UserBranches row.
        if (role != "Admin")
        {
            var allowed = await con.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM dbo.UserBranches WHERE UserId = @id AND BranchCode = @b",
                new { id = userId, b = req.BranchCode });
            if (allowed == 0)
                return StatusCode(403, new { message = $"You do not have access to branch {req.BranchCode}." });
        }

        var branches = (await con.QueryAsync<string>(
            role == "Admin"
                ? "SELECT BranchCode FROM dbo.Branches WHERE IsActive = 1"
                : "SELECT BranchCode FROM dbo.UserBranches WHERE UserId = @id",
            new { id = userId })).ToList();

        await con.ExecuteAsync(
            "INSERT INTO dbo.AuditLogs (BranchCode, UserId, Action, Detail) VALUES (@b, @id, 'LOGIN', @d)",
            new { b = req.BranchCode, id = userId, d = $"{req.Username} signed in" });

        return Ok(new
        {
            token = tokens.Create(userId, (string)u.Username, (string)u.FullName, role, req.BranchCode),
            userId,
            username = (string)u.Username,
            fullName = (string)u.FullName,
            role,
            branchCode = req.BranchCode,
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
}
