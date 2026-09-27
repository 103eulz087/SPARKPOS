using System.Data;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

[ApiController]
[Route("api/products")]
[Authorize]
public class ProductsController(Db db) : ApiControllerBase(db)
{
    /// Effective price list for a branch — this is what the POS downloads.
    [HttpGet("pricelist/{branchCode}")]
    public async Task<IActionResult> PriceList(string branchCode)
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync("dbo.sp_GetPriceList",
            new { BranchCode = branchCode }, commandType: CommandType.StoredProcedure));
    }

    /// Admin grid: base price plus a count of branch overrides.
    [HttpGet]
    public async Task<IActionResult> Get()
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT p.ProductId, p.Barcode, p.ProductName, p.CategoryId, c.CategoryName, p.Unit,
                     p.BasePrice, p.Cost, p.IsVatable, p.IsDiscountable, p.AllowPriceEdit, p.IsActive,
                     p.ImageUrl,
                     (SELECT COUNT(*) FROM dbo.ProductPrices pp WHERE pp.ProductId = p.ProductId) AS OverrideCount
              FROM dbo.Products p JOIN dbo.Categories c ON c.CategoryId = p.CategoryId
              ORDER BY p.ProductName"));
    }

    [HttpGet("{id:int}/prices")]
    public async Task<IActionResult> Prices(int id)
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT pp.BranchCode, b.BranchName, pp.Price FROM dbo.ProductPrices pp
              JOIN dbo.Branches b ON b.BranchCode = pp.BranchCode
              WHERE pp.ProductId = @id ORDER BY pp.BranchCode", new { id }));
    }

    [HttpPut("{id:int}/prices")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> SavePrices(int id, SaveProductPricesRequest req)
    {
        var tvp = new DataTable();
        tvp.Columns.Add("BranchCode", typeof(string));
        tvp.Columns.Add("Price", typeof(decimal));
        foreach (var p in req.Prices) tvp.Rows.Add(p.BranchCode, p.Price);

        using var con = Db.Open();
        await con.ExecuteAsync("dbo.sp_SaveProductPrices",
            new { ProductId = id, UpdatedBy = UserId, Prices = tvp.AsTableValuedParameter("dbo.TVP_BranchPrice") },
            commandType: CommandType.StoredProcedure);
        await AuditAsync(con, "PRICE_OVERRIDE", $"Product {id}: {req.Prices.Count} branch override(s) saved");
        return Ok();
    }

    [HttpPost]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Create(ProductDto p)
    {
        using var con = Db.Open();
        var id = await con.ExecuteScalarAsync<int>(
            @"INSERT INTO dbo.Products (Barcode, ProductName, CategoryId, Unit, BasePrice, Cost,
                IsVatable, IsDiscountable, AllowPriceEdit, IsActive, ImageUrl)
              OUTPUT INSERTED.ProductId
              VALUES (@Barcode, @ProductName, @CategoryId, @Unit, @BasePrice, @Cost,
                @IsVatable, @IsDiscountable, @AllowPriceEdit, @IsActive, @ImageUrl)", p);
        await AuditAsync(con, "PRODUCT_CREATE", $"{p.Barcode} {p.ProductName}");
        return Ok(new { productId = id });
    }

    [HttpPut("{id:int}")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Update(int id, ProductDto p)
    {
        using var con = Db.Open();
        await con.ExecuteAsync(
            @"UPDATE dbo.Products SET Barcode=@Barcode, ProductName=@ProductName, CategoryId=@CategoryId,
                Unit=@Unit, BasePrice=@BasePrice, Cost=@Cost, IsVatable=@IsVatable,
                IsDiscountable=@IsDiscountable, AllowPriceEdit=@AllowPriceEdit, IsActive=@IsActive,
                ImageUrl=@ImageUrl, RowVersionTs=SYSDATETIME()
              WHERE ProductId=@id",
            new { p.Barcode, p.ProductName, p.CategoryId, p.Unit, p.BasePrice, p.Cost,
                  p.IsVatable, p.IsDiscountable, p.AllowPriceEdit, p.IsActive, p.ImageUrl, id });
        await AuditAsync(con, "PRODUCT_UPDATE", $"{p.Barcode} {p.ProductName}");
        return Ok();
    }

    /// Uploads a product thumbnail and returns its public URL. Called before Create/Update
    /// so the returned ImageUrl can be included in the product's save payload.
    [HttpPost("image")]
    [Authorize(Roles = "Admin,Supervisor")]
    [RequestSizeLimit(2_100_000)]
    public async Task<IActionResult> UploadImage(IFormFile? file)
    {
        if (file == null || file.Length == 0) return BadRequest(new { message = "No file uploaded" });
        if (file.Length > 2_000_000) return BadRequest(new { message = "Image must be 2MB or smaller" });

        var allowed = new Dictionary<string, string>
        {
            [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg",
            [".png"] = "image/png", [".webp"] = "image/webp"
        };
        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        if (!allowed.TryGetValue(ext, out var mime) || file.ContentType != mime)
            return BadRequest(new { message = "Only JPG, PNG or WEBP images are allowed" });

        var dir = Path.Combine(AppContext.BaseDirectory, "wwwroot", "images", "products");
        Directory.CreateDirectory(dir);
        var name = $"{Guid.NewGuid():N}{ext}";
        await using (var stream = System.IO.File.Create(Path.Combine(dir, name)))
            await file.CopyToAsync(stream);

        return Ok(new { imageUrl = $"/images/products/{name}" });
    }

    [HttpPost("bulk-price")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> BulkPrice(BulkPriceRequest req)
    {
        using var con = Db.Open();
        var n = await con.QuerySingleAsync<int>("dbo.sp_BulkPriceUpdate",
            new { req.BranchCode, req.CategoryId, req.Mode, req.Value, UpdatedBy = UserId },
            commandType: CommandType.StoredProcedure);
        await AuditAsync(con, "BULK_PRICE",
            $"{req.Mode} {req.Value} on {req.BranchCode ?? "base prices"} (category {req.CategoryId?.ToString() ?? "all"})");
        return Ok(new { rowsAffected = n });
    }

    [HttpPost("copy-prices")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> CopyPrices(CopyPricesRequest req)
    {
        using var con = Db.Open();
        await con.ExecuteAsync("dbo.sp_CopyBranchPrices",
            new { req.FromBranch, req.ToBranch, UpdatedBy = UserId },
            commandType: CommandType.StoredProcedure);
        await AuditAsync(con, "COPY_PRICES", $"{req.FromBranch} -> {req.ToBranch}");
        return Ok();
    }

    [HttpGet("categories")]
    public async Task<IActionResult> Categories()
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT c.CategoryId, c.CategoryName, c.IsActive,
                     (SELECT COUNT(*) FROM dbo.Products p WHERE p.CategoryId = c.CategoryId) AS ProductCount
              FROM dbo.Categories c ORDER BY c.CategoryName"));
    }

    [HttpPost("categories")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> AddCategory([FromBody] Dictionary<string, string> body)
    {
        using var con = Db.Open();
        var id = await con.ExecuteScalarAsync<int>(
            "INSERT INTO dbo.Categories (CategoryName) OUTPUT INSERTED.CategoryId VALUES (@n)",
            new { n = body["categoryName"] });
        return Ok(new { categoryId = id });
    }

    /// Category -> print area routing for one branch (Restaurant PosType's kitchen/
    /// beverage printing). Categories are global; the mapping is per branch since a
    /// printer is physical hardware at one location — see dbo.CategoryPrintAreas.
    [HttpGet("categories/print-areas")]
    public async Task<IActionResult> CategoryPrintAreas([FromQuery] string branchCode)
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT c.CategoryId, c.CategoryName, cpa.AreaId, pa.AreaName
              FROM dbo.Categories c
              LEFT JOIN dbo.CategoryPrintAreas cpa ON cpa.CategoryId = c.CategoryId AND cpa.BranchCode = @branchCode
              LEFT JOIN dbo.PrintAreas pa ON pa.AreaId = cpa.AreaId
              WHERE c.IsActive = 1
              ORDER BY c.CategoryName", new { branchCode }));
    }

    [HttpPut("categories/{id:int}/print-area")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> SetCategoryPrintArea(int id, SetCategoryPrintAreaRequest req)
    {
        using var con = Db.Open();
        if (req.AreaId == null)
        {
            await con.ExecuteAsync(
                "DELETE FROM dbo.CategoryPrintAreas WHERE BranchCode=@b AND CategoryId=@id",
                new { b = req.BranchCode, id });
        }
        else
        {
            await con.ExecuteAsync(
                @"MERGE dbo.CategoryPrintAreas AS tgt
                  USING (SELECT @b AS BranchCode, @id AS CategoryId) AS src
                  ON tgt.BranchCode = src.BranchCode AND tgt.CategoryId = src.CategoryId
                  WHEN MATCHED THEN UPDATE SET AreaId = @a
                  WHEN NOT MATCHED THEN INSERT (BranchCode, CategoryId, AreaId) VALUES (@b, @id, @a);",
                new { b = req.BranchCode, id, a = req.AreaId });
        }
        await AuditAsync(con, "CATEGORY_PRINT_AREA", $"Category {id} print area set", req.BranchCode);
        return Ok();
    }
}
