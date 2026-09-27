using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

/// Dine-in table management. Only meaningful for branches with
/// PosSettings.PosType = 'Restaurant' — the frontend gates the whole
/// dine-in flow on that, this controller doesn't need to know about it.
[ApiController]
[Route("api/tables")]
[Authorize]
public class TablesController(Db db) : ApiControllerBase(db)
{
    /// Each table paired with its currently open order, if any — the table grid's
    /// entire occupancy view comes from this one call. A table is only "occupied" once
    /// it actually has items on the tab: opening a table (or removing every item back
    /// down to zero) leaves an Open row with nothing on it, and showing that as occupied
    /// would just confuse whoever's looking at the grid over an empty table.
    [HttpGet]
    public async Task<IActionResult> Get([FromQuery] string branchCode)
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT t.TableId, t.BranchCode, t.TableNumber, t.Capacity, t.IsActive,
                     CASE WHEN ic.ItemCount > 0 THEN o.OpenOrderUid END AS OpenOrderUid,
                     CASE WHEN ic.ItemCount > 0 THEN o.OpenedAt END AS OpenedAt,
                     ISNULL(ic.ItemCount, 0) AS ItemCount
              FROM dbo.Tables t
              LEFT JOIN dbo.OpenOrders o ON o.TableId = t.TableId AND o.Status = 'Open'
              OUTER APPLY (
                  SELECT COUNT(*) AS ItemCount FROM dbo.OpenOrderItems i WHERE i.OpenOrderUid = o.OpenOrderUid
              ) ic
              WHERE t.BranchCode = @branchCode
              ORDER BY t.TableNumber", new { branchCode }));
    }

    [HttpPost]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Create(TableDto t)
    {
        using var con = Db.Open();
        var id = await con.ExecuteScalarAsync<int>(
            @"INSERT INTO dbo.Tables (BranchCode, TableNumber, Capacity, IsActive)
              OUTPUT INSERTED.TableId
              VALUES (@BranchCode, @TableNumber, @Capacity, @IsActive)", t);
        await AuditAsync(con, "TABLE_CREATE", $"Table {t.TableNumber} created", t.BranchCode);
        return Ok(new { tableId = id });
    }

    [HttpPut("{id:int}")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Update(int id, TableDto t)
    {
        using var con = Db.Open();

        var actualBranch = await con.ExecuteScalarAsync<string?>(
            "SELECT BranchCode FROM dbo.Tables WHERE TableId = @id", new { id });
        if (actualBranch == null) return NotFound(new { message = "Table not found." });

        if (!User.IsInRole("Admin"))
        {
            var hasAccess = await con.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM dbo.UserBranches WHERE UserId = @u AND BranchCode = @b",
                new { u = UserId, b = actualBranch });
            if (hasAccess == 0) return Forbid();
        }

        await con.ExecuteAsync(
            @"UPDATE dbo.Tables SET TableNumber=@TableNumber, Capacity=@Capacity, IsActive=@IsActive
              WHERE TableId=@id",
            new { t.TableNumber, t.Capacity, t.IsActive, id });
        await AuditAsync(con, "TABLE_UPDATE", $"Table {id} updated", actualBranch);
        return Ok();
    }
}
