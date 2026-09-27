using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

/// Kitchen/beverage-style print stations (Restaurant PosType only — the frontend gates
/// the whole feature on that, this controller doesn't need to know about it). Each area
/// has its own network printer target, printed to server-side via PrintService, never
/// via RawBT (that only bridges to the handheld's own paired printer).
[ApiController]
[Route("api/print-areas")]
[Authorize]
public class PrintAreasController(Db db) : ApiControllerBase(db)
{
    [HttpGet]
    public async Task<IActionResult> Get([FromQuery] string branchCode)
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            "SELECT * FROM dbo.PrintAreas WHERE BranchCode = @branchCode ORDER BY AreaName", new { branchCode }));
    }

    [HttpPost]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Create(PrintAreaDto a)
    {
        using var con = Db.Open();
        var id = await con.ExecuteScalarAsync<int>(
            @"INSERT INTO dbo.PrintAreas (BranchCode, AreaName, PrinterTarget, PaperWidth, PrintAgentKey, IsActive)
              OUTPUT INSERTED.AreaId
              VALUES (@BranchCode, @AreaName, @PrinterTarget, @PaperWidth, @PrintAgentKey, @IsActive)", a);
        await AuditAsync(con, "PRINT_AREA_CREATE", $"Print area {a.AreaName} created", a.BranchCode);
        return Ok(new { areaId = id });
    }

    [HttpPut("{id:int}")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Update(int id, PrintAreaDto a)
    {
        using var con = Db.Open();

        var actualBranch = await con.ExecuteScalarAsync<string?>(
            "SELECT BranchCode FROM dbo.PrintAreas WHERE AreaId = @id", new { id });
        if (actualBranch == null) return NotFound(new { message = "Print area not found." });

        if (!User.IsInRole("Admin"))
        {
            var hasAccess = await con.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM dbo.UserBranches WHERE UserId = @u AND BranchCode = @b",
                new { u = UserId, b = actualBranch });
            if (hasAccess == 0) return Forbid();
        }

        await con.ExecuteAsync(
            @"UPDATE dbo.PrintAreas SET AreaName=@AreaName, PrinterTarget=@PrinterTarget,
                PaperWidth=@PaperWidth, PrintAgentKey=@PrintAgentKey, IsActive=@IsActive
              WHERE AreaId=@id",
            new { a.AreaName, a.PrinterTarget, a.PaperWidth, a.PrintAgentKey, a.IsActive, id });
        await AuditAsync(con, "PRINT_AREA_UPDATE", $"Print area {id} updated", actualBranch);
        return Ok();
    }
}
