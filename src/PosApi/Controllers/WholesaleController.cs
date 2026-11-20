using System.Data;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

/// Wholesale prices by quantity (database/33_wholesale.sql): from a minimum quantity of an item
/// in one sale (e.g. 5 kg of Pork Belly), every unit is a set amount cheaper. A rule is for an
/// item or a whole category, for every branch or one; an item's own rules win over its
/// category's (an item rule switched off excludes it), and a branch can have wholesale off
/// altogether. Admin edits them; the till downloads its branch's tiers, resolved per item
/// (sp_GetWholesaleRules), at Cash Begin and works the price out itself (store.js).
[ApiController]
[Route("api/wholesale")]
[Authorize]
public class WholesaleController(Db db) : ApiControllerBase(db)
{
    private static async Task<bool> InstalledAsync(IDbConnection con) =>
        await con.ExecuteScalarAsync<int>("SELECT CASE WHEN OBJECT_ID('dbo.WholesaleRules', 'U') IS NULL THEN 0 ELSE 1 END") == 1;

    /// The tiers a branch's tills use. Any signed-in user; empty on a DB without 33.
    [HttpGet("branch/{branchCode}")]
    public async Task<IActionResult> ForBranch(string branchCode)
    {
        using var con = Db.Open();
        if (!await InstalledAsync(con)) return Ok(Array.Empty<object>());
        return Ok(await con.QueryAsync("dbo.sp_GetWholesaleRules", new { BranchCode = branchCode },
            commandType: CommandType.StoredProcedure));
    }

    [HttpGet("rules")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Rules()
    {
        using var con = Db.Open();
        if (!await InstalledAsync(con)) return Ok(Array.Empty<object>());
        return Ok(await con.QueryAsync(
            @"SELECT r.RuleId, r.ProductId, p.ErpProductCode, p.Barcode, p.ProductName, p.Unit, p.BasePrice,
                     r.CategoryId, c.CategoryName,
                     (SELECT COUNT(*) FROM dbo.Products x WHERE x.CategoryId = r.CategoryId AND x.IsActive = 1) AS CategoryItems,
                     r.BranchCode, b.BranchName, r.MinQty, r.AmountOff, r.IsActive, r.UpdatedAt, u.FullName AS UpdatedByName
              FROM dbo.WholesaleRules r
              LEFT JOIN dbo.Products p ON p.ProductId = r.ProductId
              LEFT JOIN dbo.Categories c ON c.CategoryId = r.CategoryId
              LEFT JOIN dbo.Branches b ON b.BranchCode = r.BranchCode
              LEFT JOIN dbo.Users u ON u.UserId = r.UpdatedBy
              ORDER BY CASE WHEN r.CategoryId IS NOT NULL THEN 0 ELSE 1 END, ISNULL(c.CategoryName, p.ProductName),
                       CASE WHEN r.BranchCode IS NULL THEN 0 ELSE 1 END, r.BranchCode, r.MinQty"));
    }

    [HttpPost("rules")]
    [Authorize(Roles = "Admin")]
    public Task<IActionResult> Create(WholesaleRuleDto req) => SaveAsync(null, req);

    [HttpPut("rules/{id:int}")]
    [Authorize(Roles = "Admin")]
    public Task<IActionResult> Update(int id, WholesaleRuleDto req) => SaveAsync(id, req);

    private async Task<IActionResult> SaveAsync(int? id, WholesaleRuleDto r)
    {
        var branch = string.IsNullOrWhiteSpace(r.BranchCode) ? null : r.BranchCode.Trim();
        if (r.MinQty <= 0) return BadRequest(new { message = "Enter the minimum quantity, more than 0 (e.g. 5 kg)." });
        if (r.AmountOff <= 0) return BadRequest(new { message = "Enter the amount off per unit, more than ₱0." });
        if (decimal.Round(r.MinQty, 3) != r.MinQty || decimal.Round(r.AmountOff, 2) != r.AmountOff)
            return BadRequest(new { message = "Up to 3 decimals for the quantity and 2 for the amount." });
        if ((r.ProductId == null) == (r.CategoryId == null)) return BadRequest(new { message = "Pick an item or a category." });
        using var con = Db.Open();
        if (!await InstalledAsync(con)) return BadRequest(new { message = "Wholesale needs database update 33 (33_wholesale.sql)." });
        var target = r.ProductId != null
            ? await con.ExecuteScalarAsync<string?>("SELECT ProductName FROM dbo.Products WHERE ProductId = @ProductId", new { r.ProductId })
            : await con.ExecuteScalarAsync<string?>("SELECT N'category ' + CategoryName FROM dbo.Categories WHERE CategoryId = @CategoryId", new { r.CategoryId });
        if (target == null) return BadRequest(new { message = r.ProductId != null ? "No such item." : "No such category." });
        if (branch != null && await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM dbo.Branches WHERE BranchCode = @branch", new { branch }) == 0)
            return BadRequest(new { message = "No such branch." });
        try
        {
            if (id == null)
                id = await con.ExecuteScalarAsync<int>(
                    @"INSERT INTO dbo.WholesaleRules (ProductId, CategoryId, BranchCode, MinQty, AmountOff, IsActive, UpdatedBy)
                      OUTPUT inserted.RuleId VALUES (@ProductId, @CategoryId, @branch, @MinQty, @AmountOff, @IsActive, @uid)",
                    new { r.ProductId, r.CategoryId, branch, r.MinQty, r.AmountOff, r.IsActive, uid = UserId });
            else if (await con.ExecuteAsync(
                    @"UPDATE dbo.WholesaleRules SET ProductId = @ProductId, CategoryId = @CategoryId, BranchCode = @branch,
                        MinQty = @MinQty, AmountOff = @AmountOff, IsActive = @IsActive, UpdatedAt = SYSDATETIME(), UpdatedBy = @uid
                      WHERE RuleId = @id",
                    new { id, r.ProductId, r.CategoryId, branch, r.MinQty, r.AmountOff, r.IsActive, uid = UserId }) == 0)
                return NotFound(new { message = "That rule no longer exists." });
        }
        catch (SqlException ex) when (ex.Number is 2601 or 2627)
        {
            return Conflict(new { message = $"{target} already has a rule from {r.MinQty:0.###} at {(branch ?? "every branch")}. Edit that one." });
        }
        await AuditAsync(con, "WHOLESALE_RULE_SAVE",
            $"#{id} {target}: from {r.MinQty:0.###}, ₱{r.AmountOff:N2} off each, {(branch ?? "every branch")}, {(r.IsActive ? "on" : "off")}");
        return Ok(new { ruleId = id });
    }

    /// Which branches have wholesale on (PosSettings.WholesaleOn).
    [HttpGet("branches")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Branches()
    {
        using var con = Db.Open();
        if (!await InstalledAsync(con)) return Ok(Array.Empty<object>());
        return Ok(await con.QueryAsync(
            @"SELECT b.BranchCode, b.BranchName, ISNULL(ps.WholesaleOn, 1) AS WholesaleOn,
                     (SELECT COUNT(*) FROM dbo.Terminals t WHERE t.BranchCode = b.BranchCode AND t.IsActive = 1) AS Terminals
              FROM dbo.Branches b LEFT JOIN dbo.PosSettings ps ON ps.BranchCode = b.BranchCode
              WHERE b.IsActive = 1 ORDER BY b.BranchCode"));
    }

    [HttpPut("branches/{branchCode}")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> SetBranch(string branchCode, WholesaleBranchDto req)
    {
        using var con = Db.Open();
        if (!await InstalledAsync(con)) return BadRequest(new { message = "Wholesale needs database update 33 (33_wholesale.sql)." });
        if (await con.ExecuteAsync("UPDATE dbo.PosSettings SET WholesaleOn = @on WHERE BranchCode = @branchCode",
                new { on = req.WholesaleOn, branchCode }) == 0)
            return NotFound(new { message = "That branch has no POS settings yet." });
        await AuditAsync(con, "WHOLESALE_BRANCH", $"{branchCode}: wholesale {(req.WholesaleOn ? "on" : "off")}");
        return Ok();
    }

    [HttpDelete("rules/{id:int}")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> Delete(int id)
    {
        using var con = Db.Open();
        if (!await InstalledAsync(con)) return Ok();
        var rule = await con.QuerySingleOrDefaultAsync(
            @"SELECT r.MinQty, r.AmountOff, r.BranchCode, ISNULL(p.ProductName, N'category ' + c.CategoryName) AS Target
              FROM dbo.WholesaleRules r
              LEFT JOIN dbo.Products p ON p.ProductId = r.ProductId
              LEFT JOIN dbo.Categories c ON c.CategoryId = r.CategoryId WHERE r.RuleId = @id", new { id });
        if (rule == null) return NotFound(new { message = "That rule no longer exists." });
        await con.ExecuteAsync("DELETE FROM dbo.WholesaleRules WHERE RuleId = @id", new { id });
        await AuditAsync(con, "WHOLESALE_RULE_DELETE",
            $"#{id} {(string)rule.Target}: from {(decimal)rule.MinQty:0.###}, ₱{(decimal)rule.AmountOff:N2} off, {((string?)rule.BranchCode ?? "every branch")}");
        return Ok();
    }
}
