using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

[ApiController]
[Route("api/branches")]
[Authorize]
public class BranchesController(Db db) : ApiControllerBase(db)
{
    [HttpGet]
    public async Task<IActionResult> Get()
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT b.BranchCode, b.BranchName, b.Tin, b.BirBranchCode, b.Address, b.ContactNo, b.IsActive,
                     (SELECT COUNT(*) FROM dbo.Terminals t WHERE t.BranchCode = b.BranchCode) AS TerminalCount
              FROM dbo.Branches b ORDER BY b.BranchCode"));
    }

    [HttpPost]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> Create(BranchDto b)
    {
        using var con = Db.Open();
        await con.ExecuteAsync(
            @"INSERT INTO dbo.Branches (BranchCode, BranchName, Tin, BirBranchCode, Address, ContactNo, IsActive)
              VALUES (@BranchCode, @BranchName, @Tin, @BirBranchCode, @Address, @ContactNo, @IsActive);
              INSERT INTO dbo.PosSettings (BranchCode, StoreHeader2) VALUES (@BranchCode, @BranchName);", b);
        await AuditAsync(con, "BRANCH_CREATE", $"Branch {b.BranchCode} created", b.BranchCode);
        return Ok();
    }

    [HttpPut("{code}")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> Update(string code, BranchDto b)
    {
        using var con = Db.Open();
        await con.ExecuteAsync(
            @"UPDATE dbo.Branches SET BranchName=@BranchName, Tin=@Tin, BirBranchCode=@BirBranchCode,
              Address=@Address, ContactNo=@ContactNo, IsActive=@IsActive WHERE BranchCode=@code",
            new { b.BranchName, b.Tin, b.BirBranchCode, b.Address, b.ContactNo, b.IsActive, code });
        await AuditAsync(con, "BRANCH_UPDATE", $"Branch {code} updated", code);
        return Ok();
    }
}
