using System.Data;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

/// Promos: Buy N Take M (database/34_promos.sql). SAME: every N + M of an item, M are free;
/// GROUP (mix and match): the qualifying items count together and the cheapest M of every N + M
/// are free; GIFT: every N qualifying items bought, M of the gift item are free. Each runs between
/// two dates at chosen branches (none = all). Admin edits them; the till downloads its branch's at
/// Cash Begin and applies them itself (store.js applyPromos).
[ApiController]
[Route("api/promos")]
[Authorize]
public class PromosController(Db db) : ApiControllerBase(db)
{
    private static readonly string[] Kinds = ["SAME", "GROUP", "GIFT"];

    private static async Task<bool> InstalledAsync(IDbConnection con) =>
        await con.ExecuteScalarAsync<int>("SELECT CASE WHEN OBJECT_ID('dbo.Promos', 'U') IS NULL THEN 0 ELSE 1 END") == 1;

    /// The promos a branch's tills use, with the items that qualify. Any signed-in user; empty
    /// on a DB without 34.
    [HttpGet("branch/{branchCode}")]
    public async Task<IActionResult> ForBranch(string branchCode)
    {
        using var con = Db.Open();
        if (!await InstalledAsync(con)) return Ok(new { promos = Array.Empty<object>(), items = Array.Empty<object>() });
        using var multi = await con.QueryMultipleAsync("dbo.sp_GetPromos", new { BranchCode = branchCode },
            commandType: CommandType.StoredProcedure);
        return Ok(new { promos = (await multi.ReadAsync()).ToList(), items = (await multi.ReadAsync()).ToList() });
    }

    [HttpGet]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> List()
    {
        using var con = Db.Open();
        if (!await InstalledAsync(con)) return Ok(Array.Empty<object>());
        var promos = (await con.QueryAsync(
            @"SELECT p.PromoId, p.PromoName, p.Kind, p.BuyQty, p.FreeQty, p.FreeProductId, fp.ProductName AS FreeProductName,
                     fp.ErpProductCode AS FreeProductCode, p.MaxFreePerSale, p.StartDate, p.EndDate, p.IsActive,
                     p.UpdatedAt, u.FullName AS UpdatedByName
              FROM dbo.Promos p
              LEFT JOIN dbo.Products fp ON fp.ProductId = p.FreeProductId
              LEFT JOIN dbo.Users u ON u.UserId = p.UpdatedBy
              ORDER BY p.IsActive DESC, p.EndDate DESC, p.PromoName")).ToList();
        var items = (await con.QueryAsync(
            @"SELECT i.PromoId, i.ProductId, p.ProductName, p.ErpProductCode, i.CategoryId, c.CategoryName
              FROM dbo.PromoItems i
              LEFT JOIN dbo.Products p ON p.ProductId = i.ProductId
              LEFT JOIN dbo.Categories c ON c.CategoryId = i.CategoryId")).ToList();
        var branches = (await con.QueryAsync("SELECT PromoId, BranchCode FROM dbo.PromoBranches")).ToList();
        return Ok(promos.Select(p => new
        {
            promo = p,
            items = items.Where(i => (int)i.PromoId == (int)p.PromoId),
            branches = branches.Where(b => (int)b.PromoId == (int)p.PromoId).Select(b => (string)b.BranchCode)
        }));
    }

    [HttpPost]
    [Authorize(Roles = "Admin")]
    public Task<IActionResult> Create(PromoDto req) => SaveAsync(null, req);

    [HttpPut("{id:int}")]
    [Authorize(Roles = "Admin")]
    public Task<IActionResult> Update(int id, PromoDto req) => SaveAsync(id, req);

    private async Task<IActionResult> SaveAsync(int? id, PromoDto r)
    {
        var name = (r.PromoName ?? "").Trim();
        var kind = (r.Kind ?? "").Trim().ToUpperInvariant();
        var productIds = (r.ProductIds ?? []).Distinct().ToList();
        var categoryIds = (r.CategoryIds ?? []).Distinct().ToList();
        var branches = (r.Branches ?? []).Select(b => b.Trim()).Where(b => b.Length > 0).Distinct().ToList();
        if (name.Length is 0 or > 40) return BadRequest(new { message = "Give the promo a name of up to 40 characters (it prints on the invoice), e.g. B1T1 Siomai." });
        if (!Kinds.Contains(kind)) return BadRequest(new { message = "Pick the kind: same item, mix and match, or a free gift item." });
        if (r.BuyQty is < 1 or > 99 || r.FreeQty is < 1 or > 99) return BadRequest(new { message = "Buy and take quantities must be 1 to 99." });
        if (productIds.Count + categoryIds.Count == 0) return BadRequest(new { message = "Add at least one item (type its name and click it in the list), or pick a whole category." });
        if (kind == "GIFT" && r.FreeProductId == null) return BadRequest(new { message = "Pick the free gift item." });
        if (r.MaxFreePerSale is <= 0) return BadRequest(new { message = "The limit of free items per sale must be more than 0, or blank." });
        if (r.EndDate.Date < r.StartDate.Date) return BadRequest(new { message = "The end date can't be before the start date." });

        using var con = Db.Open();
        if (!await InstalledAsync(con)) return BadRequest(new { message = "Promos need database update 34 (34_promos.sql)." });
        if (branches.Count > 0 && await con.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM dbo.Branches WHERE BranchCode IN @branches", new { branches }) != branches.Count)
            return BadRequest(new { message = "One of the branches doesn't exist." });
        if (productIds.Count > 0 && await con.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM dbo.Products WHERE ProductId IN @productIds", new { productIds }) != productIds.Count)
            return BadRequest(new { message = "One of the items doesn't exist." });
        if (categoryIds.Count > 0 && await con.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM dbo.Categories WHERE CategoryId IN @categoryIds", new { categoryIds }) != categoryIds.Count)
            return BadRequest(new { message = "One of the categories doesn't exist." });

        con.Open();   // Db.Open() leaves it closed (Dapper opens per call); a transaction needs it open
        using var tx = con.BeginTransaction();
        var prm = new
        {
            id, name, kind, r.BuyQty, r.FreeQty, freeProductId = kind == "GIFT" ? r.FreeProductId : null, r.MaxFreePerSale,
            start = r.StartDate.Date, end = r.EndDate.Date, r.IsActive, uid = UserId
        };
        if (id == null)
            id = await con.ExecuteScalarAsync<int>(
                @"INSERT INTO dbo.Promos (PromoName, Kind, BuyQty, FreeQty, FreeProductId, MaxFreePerSale, StartDate, EndDate, IsActive, UpdatedBy)
                  OUTPUT inserted.PromoId VALUES (@name, @kind, @BuyQty, @FreeQty, @freeProductId, @MaxFreePerSale, @start, @end, @IsActive, @uid)",
                prm, tx);
        else if (await con.ExecuteAsync(
                @"UPDATE dbo.Promos SET PromoName = @name, Kind = @kind, BuyQty = @BuyQty, FreeQty = @FreeQty, FreeProductId = @freeProductId,
                    MaxFreePerSale = @MaxFreePerSale, StartDate = @start, EndDate = @end, IsActive = @IsActive,
                    UpdatedAt = SYSDATETIME(), UpdatedBy = @uid
                  WHERE PromoId = @id", prm, tx) == 0)
            return NotFound(new { message = "That promo no longer exists." });
        await con.ExecuteAsync("DELETE FROM dbo.PromoItems WHERE PromoId = @id; DELETE FROM dbo.PromoBranches WHERE PromoId = @id", new { id }, tx);
        foreach (var p in productIds)
            await con.ExecuteAsync("INSERT INTO dbo.PromoItems (PromoId, ProductId) VALUES (@id, @p)", new { id, p }, tx);
        foreach (var c in categoryIds)
            await con.ExecuteAsync("INSERT INTO dbo.PromoItems (PromoId, CategoryId) VALUES (@id, @c)", new { id, c }, tx);
        foreach (var b in branches)
            await con.ExecuteAsync("INSERT INTO dbo.PromoBranches (PromoId, BranchCode) VALUES (@id, @b)", new { id, b }, tx);
        tx.Commit();
        await AuditAsync(con, "PROMO_SAVE",
            $"#{id} {name}: {kind} buy {r.BuyQty} take {r.FreeQty}, {r.StartDate:yyyy-MM-dd} to {r.EndDate:yyyy-MM-dd}, " +
            $"{productIds.Count} item(s) + {categoryIds.Count} categor(ies), {(branches.Count == 0 ? "every branch" : string.Join(",", branches))}, {(r.IsActive ? "on" : "off")}");
        return Ok(new { promoId = id });
    }

    /// A promo that was ever used on a sale is kept for the report: switch it off instead.
    [HttpDelete("{id:int}")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> Delete(int id)
    {
        using var con = Db.Open();
        if (!await InstalledAsync(con)) return Ok();
        var name = await con.ExecuteScalarAsync<string?>("SELECT PromoName FROM dbo.Promos WHERE PromoId = @id", new { id });
        if (name == null) return NotFound(new { message = "That promo no longer exists." });
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM dbo.SaleItemPromo WHERE PromoId = @id", new { id }) > 0)
            return Conflict(new { message = "This promo was used on sales, so it stays for the report. Switch it off instead." });
        await con.ExecuteAsync("DELETE FROM dbo.Promos WHERE PromoId = @id", new { id });
        await AuditAsync(con, "PROMO_DELETE", $"#{id} {name}");
        return Ok();
    }
}
