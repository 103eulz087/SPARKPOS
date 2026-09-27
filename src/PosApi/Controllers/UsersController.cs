using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

[ApiController]
[Route("api/users")]
[Authorize(Roles = "Admin")]
public class UsersController(Db db) : ApiControllerBase(db)
{
    [HttpGet]
    public async Task<IActionResult> Get()
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT u.UserId, u.Username, u.FullName, u.Role, u.IsActive,
                     STUFF((SELECT ', ' + ub.BranchCode FROM dbo.UserBranches ub
                            WHERE ub.UserId = u.UserId FOR XML PATH('')), 1, 2, '') AS Branches
              FROM dbo.Users u ORDER BY u.Username"));
    }

    [HttpPost]
    public async Task<IActionResult> Create(UserDto u)
    {
        var salt = PasswordHasher.NewSalt();
        using var con = Db.Open();
        var id = await con.ExecuteScalarAsync<int>(
            @"INSERT INTO dbo.Users (Username, PasswordHash, PasswordSalt, FullName, Role, IsActive)
              OUTPUT INSERTED.UserId VALUES (@Username, @hash, @salt, @FullName, @Role, @IsActive)",
            new { u.Username, hash = PasswordHasher.Hash(salt, u.Password ?? "changeme"), salt,
                  u.FullName, u.Role, u.IsActive });

        foreach (var b in u.Branches ?? [])
            await con.ExecuteAsync("INSERT INTO dbo.UserBranches (UserId, BranchCode) VALUES (@id, @b)",
                new { id, b });

        await AuditAsync(con, "USER_CREATE", $"{u.Username} ({u.Role})");
        return Ok(new { userId = id });
    }

    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, UserDto u)
    {
        using var con = Db.Open();
        await con.ExecuteAsync(
            "UPDATE dbo.Users SET FullName=@FullName, Role=@Role, IsActive=@IsActive WHERE UserId=@id",
            new { u.FullName, u.Role, u.IsActive, id });

        if (!string.IsNullOrEmpty(u.Password))
        {
            var salt = PasswordHasher.NewSalt();
            await con.ExecuteAsync(
                "UPDATE dbo.Users SET PasswordSalt=@salt, PasswordHash=@hash WHERE UserId=@id",
                new { salt, hash = PasswordHasher.Hash(salt, u.Password), id });
        }

        if (u.Branches != null)
        {
            await con.ExecuteAsync("DELETE FROM dbo.UserBranches WHERE UserId=@id", new { id });
            foreach (var b in u.Branches)
                await con.ExecuteAsync("INSERT INTO dbo.UserBranches (UserId, BranchCode) VALUES (@id, @b)",
                    new { id, b });
        }

        await AuditAsync(con, "USER_UPDATE", $"{u.Username} ({u.Role})");
        return Ok();
    }
}
