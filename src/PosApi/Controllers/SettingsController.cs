using System.Data;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

[ApiController]
[Route("api/settings")]
[Authorize]
public class SettingsController(Db db, EmailService email) : ApiControllerBase(db)
{
    [HttpGet("{branchCode}")]
    public async Task<IActionResult> Get(string branchCode)
    {
        using var con = Db.Open();
        var s = await con.QuerySingleOrDefaultAsync(
            "SELECT * FROM dbo.PosSettings WHERE BranchCode = @b", new { b = branchCode });
        return s == null ? NotFound(new { message = "No settings for that branch." }) : Ok(s);
    }

    [HttpPut("{branchCode}")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> Update(string branchCode, PosSettingsDto s)
    {
        if (!string.IsNullOrWhiteSpace(s.ScaleBarcodePrefix)
            && (s.ScaleBarcodePrefix.Split(',').Any(p => !p.Trim().All(char.IsDigit) || p.Trim().Length is 0 or > 3)
                || s.ScaleCodeLength is < 1 or > 10 || s.ScaleQtyLength is < 1 or > 8
                || s.ScaleQtyDecimals < 0 || s.ScaleQtyDecimals > s.ScaleQtyLength))
            return BadRequest(new { message = "Scale barcode layout: prefixes are 1-3 digits (comma-separated), code 1-10 digits, weight 1-8 digits, decimals no more than the weight digits." });
        using var con = Db.Open();
        await con.ExecuteAsync(
            @"UPDATE dbo.PosSettings SET PosType=@PosType, VoidOverride=@VoidOverride,
                PriceEditOverride=@PriceEditOverride, ReprintOverride=@ReprintOverride,
                EodOverride=@EodOverride, EmailOnBlindClose=@EmailOnBlindClose,
                RefundEnabled=@RefundEnabled, ReturnOverride=@ReturnOverride, BlockLoginAfterEod=@BlockLoginAfterEod,
                OrBlockSize=@OrBlockSize, OrLowWarning=@OrLowWarning,
                MaxDiscountPerTxn=@MaxDiscountPerTxn, StoreHeader1=@StoreHeader1,
                StoreHeader2=@StoreHeader2, ReceiptFooter=@ReceiptFooter,
                ScaleBarcodePrefix=NULLIF(LTRIM(RTRIM(@ScaleBarcodePrefix)), ''),
                ScaleCodeLength=@ScaleCodeLength, ScaleQtyLength=@ScaleQtyLength, ScaleQtyDecimals=@ScaleQtyDecimals
              WHERE BranchCode=@branchCode",
            new { s.PosType, s.VoidOverride, s.PriceEditOverride, s.ReprintOverride, s.EodOverride,
                  s.EmailOnBlindClose, s.RefundEnabled, s.ReturnOverride, s.BlockLoginAfterEod, s.OrBlockSize, s.OrLowWarning,
                  s.MaxDiscountPerTxn, s.StoreHeader1, s.StoreHeader2, s.ReceiptFooter,
                  s.ScaleBarcodePrefix, s.ScaleCodeLength, s.ScaleQtyLength, s.ScaleQtyDecimals, branchCode });
        // 35: the new approval switches, only when sent and installed (an older Admin sends none)
        if (s.PriceLevelOverride != null)   // 36
            await con.ExecuteAsync(
                @"IF COL_LENGTH('dbo.PosSettings', 'PriceLevelOverride') IS NOT NULL
                    EXEC sp_executesql N'UPDATE dbo.PosSettings SET PriceLevelOverride = @p WHERE BranchCode = @b',
                      N'@p BIT, @b VARCHAR(10)', @p, @b",
                new { p = s.PriceLevelOverride, b = branchCode });
        if (s.GiftCertOn != null)   // 38
        {
            if (s.GiftCertOn == true && await con.ExecuteScalarAsync<int>(
                    "SELECT CASE WHEN COL_LENGTH('dbo.PosSettings', 'GiftCertOn') IS NULL THEN 0 ELSE 1 END") == 0)
                return BadRequest(new { message = "Gift certificates need database/38_gift_certificates.sql on this server first." });
            // The ERP doesn't take a GC payment yet (asked 2026-11-20): a GC sale at a posting
            // till would fail there and hold up that till's queue.
            if (s.GiftCertOn == true && await con.ExecuteScalarAsync<int>(
                    "SELECT COUNT(*) FROM dbo.Terminals WHERE BranchCode = @b AND IsActive = 1 AND PostToErp = 1",
                    new { b = branchCode }) > 0)
                return BadRequest(new { message = "This branch's tills post to the ERP, which doesn't take gift certificate payments yet. Gift certificates can be switched on here once the ERP side is ready." });
            await con.ExecuteAsync(
                @"IF COL_LENGTH('dbo.PosSettings', 'GiftCertOn') IS NOT NULL
                    EXEC sp_executesql N'UPDATE dbo.PosSettings SET GiftCertOn = @g WHERE BranchCode = @b',
                      N'@g BIT, @b VARCHAR(10)', @g, @b",
                new { g = s.GiftCertOn, b = branchCode });
        }
        if (s.OpenDrawerOverride != null)   // 39
            await con.ExecuteAsync(
                @"IF COL_LENGTH('dbo.PosSettings', 'OpenDrawerOverride') IS NOT NULL
                    EXEC sp_executesql N'UPDATE dbo.PosSettings SET OpenDrawerOverride = @o WHERE BranchCode = @b',
                      N'@o BIT, @b VARCHAR(10)', @o, @b",
                new { o = s.OpenDrawerOverride, b = branchCode });
        if (s.CancelLineOverride != null || s.XReadOverride != null || s.DiscountOverride != null)
            await con.ExecuteAsync(
                @"IF COL_LENGTH('dbo.PosSettings', 'DiscountOverride') IS NOT NULL
                    EXEC sp_executesql N'UPDATE dbo.PosSettings SET
                        CancelLineOverride = ISNULL(@c, CancelLineOverride), XReadOverride = ISNULL(@x, XReadOverride),
                        DiscountOverride = ISNULL(@d, DiscountOverride) WHERE BranchCode = @b',
                      N'@c BIT, @x BIT, @d BIT, @b VARCHAR(10)', @c, @x, @d, @b",
                new { c = s.CancelLineOverride, x = s.XReadOverride, d = s.DiscountOverride, b = branchCode });
        await AuditAsync(con, "SETTINGS_UPDATE", $"POS settings updated for {branchCode}", branchCode);
        return Ok();
    }

    /// Single global SMTP config (BranchCode IS NULL). The password is never returned —
    /// only whether one is already set, so the UI can offer "blank keeps current".
    [HttpGet("email-config")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> GetEmailConfig()
    {
        using var con = Db.Open();
        var c = await con.QuerySingleOrDefaultAsync(
            @"SELECT SmtpHost, SmtpPort, SmtpUser, FromAddress, ToAddresses, EnableSsl, SendOnEod, IsActive,
                     SendInvoices, InvoiceRepository,
                     CASE WHEN SmtpPassword IS NOT NULL AND SmtpPassword <> '' THEN 1 ELSE 0 END AS HasPassword
              FROM dbo.EmailConfig WHERE BranchCode IS NULL");
        // Always return an object (never JSON null) so the frontend can tell "nothing saved
        // yet" apart from "still loading" without an extra loading flag.
        return Ok(c ?? new
        {
            SmtpHost = "", SmtpPort = 587, SmtpUser = "", FromAddress = "", ToAddresses = "",
            EnableSsl = true, SendOnEod = true, IsActive = true, HasPassword = false,
            SendInvoices = false, InvoiceRepository = (string?)null
        });
    }

    [HttpPut("email-config")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> SaveEmailConfig(EmailConfigDto c)
    {
        var repo = string.IsNullOrWhiteSpace(c.InvoiceRepository) ? null : c.InvoiceRepository.Trim();
        if (repo != null && !InvoiceEmailService.LooksLikeEmail(repo))
            return BadRequest(new { message = "The repository email doesn't look like an email address." });
        if (c.SendInvoices && !c.IsActive)
            return BadRequest(new { message = "Tick Active too: e-invoice copies are only sent while email is active." });
        if (c.SendInvoices && repo == null)
            return BadRequest(new { message = "Enter the repository email: invoices of customers who give no email go there." });
        c = c with { InvoiceRepository = repo };
        using var con = Db.Open();
        var exists = await con.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM dbo.EmailConfig WHERE BranchCode IS NULL");

        if (exists == 0)
        {
            if (string.IsNullOrWhiteSpace(c.SmtpPassword))
                return BadRequest(new { message = "SMTP password is required the first time you save." });
            await con.ExecuteAsync(
                @"INSERT INTO dbo.EmailConfig (BranchCode, SmtpHost, SmtpPort, SmtpUser, SmtpPassword,
                    FromAddress, ToAddresses, EnableSsl, SendOnEod, IsActive, SendInvoices, InvoiceRepository)
                  VALUES (NULL, @SmtpHost, @SmtpPort, @SmtpUser, @SmtpPassword,
                    @FromAddress, @ToAddresses, @EnableSsl, @SendOnEod, @IsActive, @SendInvoices, @InvoiceRepository)", c);
        }
        else if (string.IsNullOrWhiteSpace(c.SmtpPassword))
        {
            await con.ExecuteAsync(
                @"UPDATE dbo.EmailConfig SET SmtpHost=@SmtpHost, SmtpPort=@SmtpPort, SmtpUser=@SmtpUser,
                    FromAddress=@FromAddress, ToAddresses=@ToAddresses, EnableSsl=@EnableSsl,
                    SendOnEod=@SendOnEod, IsActive=@IsActive,
                    SendInvoices=@SendInvoices, InvoiceRepository=@InvoiceRepository
                  WHERE BranchCode IS NULL", c);
        }
        else
        {
            await con.ExecuteAsync(
                @"UPDATE dbo.EmailConfig SET SmtpHost=@SmtpHost, SmtpPort=@SmtpPort, SmtpUser=@SmtpUser,
                    SmtpPassword=@SmtpPassword, FromAddress=@FromAddress, ToAddresses=@ToAddresses,
                    EnableSsl=@EnableSsl, SendOnEod=@SendOnEod, IsActive=@IsActive,
                    SendInvoices=@SendInvoices, InvoiceRepository=@InvoiceRepository
                  WHERE BranchCode IS NULL", c);
        }

        await AuditAsync(con, "EMAIL_CONFIG_UPDATE", "Global email configuration updated");
        return Ok();
    }

    /// E-invoice copies: counts by status, plus the latest that failed or are still waiting.
    [HttpGet("invoice-emails")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> InvoiceEmails([FromQuery] string? branchCode)
    {
        using var con = Db.Open();
        var counts = await con.QueryAsync(
            @"SELECT Status, COUNT(*) AS N FROM dbo.InvoiceEmails
              WHERE (@branchCode IS NULL OR BranchCode = @branchCode) GROUP BY Status", new { branchCode });
        var recent = await con.QueryAsync(
            @"SELECT TOP 100 e.InvoiceEmailId, e.Kind, e.BranchCode, t.TerminalCode, e.ToAddress, e.ToRepository,
                     e.IsManual, e.Status, e.Attempts, e.LastError, e.CreatedAt, e.SentAt,
                     COALESCE(s.ORNumber, os.ORNumber) AS ORNumber, r.ReturnNo
              FROM dbo.InvoiceEmails e
              LEFT JOIN dbo.Sales s ON e.Kind = 'SALE' AND s.SaleUid = e.RefUid
              LEFT JOIN dbo.SaleReturns r ON e.Kind = 'RETURN' AND r.ReturnUid = e.RefUid
              LEFT JOIN dbo.Sales os ON os.SaleUid = r.OrigSaleUid
              LEFT JOIN dbo.Terminals t ON t.TerminalId = COALESCE(s.TerminalId, r.TerminalId)
              WHERE (@branchCode IS NULL OR e.BranchCode = @branchCode)
              ORDER BY CASE e.Status WHEN 'Failed' THEN 0 WHEN 'Pending' THEN 1 ELSE 2 END, e.InvoiceEmailId DESC",
            new { branchCode });
        return Ok(new { counts = counts.ToDictionary(c => (string)c.Status, c => (int)c.N), recent });
    }

    /// Puts every failed e-invoice email back in the queue (e.g. after fixing the SMTP settings).
    [HttpPost("invoice-emails/retry")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> RetryInvoiceEmails()
    {
        using var con = Db.Open();
        var n = await con.ExecuteAsync(
            @"UPDATE dbo.InvoiceEmails SET Status = 'Pending', Attempts = 0, NextAttemptAt = SYSDATETIME()
              WHERE Status = 'Failed'");
        await AuditAsync(con, "INVOICE_EMAIL_RETRY", $"{n} failed e-invoice email(s) queued again");
        return Ok(new { requeued = n });
    }

    [HttpPost("email-config/test")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> TestEmailConfig()
    {
        var (sent, error) = await email.SendTestAsync();
        return Ok(new { sent, message = error });
    }

    [HttpGet("discount-types")]
    public async Task<IActionResult> DiscountTypes()
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            "SELECT DiscountCode, Description, Rate, IsVatExempt, LegalBasis FROM dbo.DiscountTypes WHERE IsActive = 1"));
    }

    /// Price levels Price1..4 (31_price_levels.sql): their names and which are on. Any signed-in
    /// user (the till caches them with its context); empty on a DB without 31.
    [HttpGet("price-levels")]
    public async Task<IActionResult> PriceLevels()
    {
        using var con = Db.Open();
        if (await con.ExecuteScalarAsync<int>("SELECT CASE WHEN OBJECT_ID('dbo.PriceLevels', 'U') IS NULL THEN 0 ELSE 1 END") == 0)
            return Ok(Array.Empty<object>());
        return Ok(await con.QueryAsync("SELECT PriceLevel, LevelName, IsActive FROM dbo.PriceLevels ORDER BY PriceLevel"));
    }

    [HttpPut("price-levels")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> SavePriceLevels(List<PriceLevelDto> levels)
    {
        if (levels.Count != 4 || levels.Select(l => l.PriceLevel).Distinct().Count() != 4 || levels.Any(l => l.PriceLevel is < 1 or > 4))
            return BadRequest(new { message = "Send all four price levels (1 to 4)." });
        var names = levels.Select(l => (l.LevelName ?? "").Trim()).ToList();
        if (names.Any(n => n.Length is 0 or > 30))
            return BadRequest(new { message = "Give every price level a name of up to 30 characters (e.g. Wholesale)." });
        if (names.Distinct(StringComparer.OrdinalIgnoreCase).Count() != 4)
            return BadRequest(new { message = "Each price level needs its own name." });
        using var con = Db.Open();
        foreach (var l in levels)
            await con.ExecuteAsync(
                @"UPDATE dbo.PriceLevels SET LevelName = @name, IsActive = @IsActive, UpdatedAt = SYSDATETIME(), UpdatedBy = @uid
                  WHERE PriceLevel = @PriceLevel",
                new { name = l.LevelName!.Trim(), l.IsActive, l.PriceLevel, uid = UserId });
        await AuditAsync(con, "PRICE_LEVELS", string.Join(", ",
            levels.OrderBy(l => l.PriceLevel).Select(l => $"{l.PriceLevel} {l.LevelName!.Trim()} {(l.IsActive ? "on" : "off")}")));
        return Ok();
    }

    /// Every category-rate override, for every discount type — downloaded in full and
    /// cached client-side (like discount-types itself) so discount computation keeps
    /// working offline. Global, not branch-scoped: these rates are legally mandated
    /// (RA 9994 etc.), not a per-branch business choice.
    [HttpGet("discount-category-rates")]
    public async Task<IActionResult> DiscountCategoryRates()
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT r.DiscountCode, r.CategoryId, c.CategoryName, r.Rate, r.IsVatExempt
              FROM dbo.DiscountCategoryRates r JOIN dbo.Categories c ON c.CategoryId = r.CategoryId
              ORDER BY r.DiscountCode, c.CategoryName"));
    }

    /// A discount type's rate per POS type, and per POS type + category (32_discount_pos_type.sql).
    /// Downloaded in full and cached by the till like the category rates. Empty on a DB without 32.
    [HttpGet("discount-pos-type-rates")]
    public async Task<IActionResult> DiscountPosTypeRates()
    {
        using var con = Db.Open();
        if (!await PosTypeRatesInstalledAsync(con)) return Ok(Array.Empty<object>());
        return Ok(await con.QueryAsync(
            @"SELECT r.DiscountCode, r.PosType, r.CategoryId, c.CategoryName, r.Rate, r.IsVatExempt
              FROM dbo.DiscountPosTypeRates r LEFT JOIN dbo.Categories c ON c.CategoryId = r.CategoryId
              ORDER BY r.DiscountCode, r.PosType, c.CategoryName"));
    }

    /// categoryId omitted = the rate for every category at that POS type.
    [HttpPut("discount-pos-type-rates/{discountCode}/{posType}")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> SetDiscountPosTypeRate(string discountCode, string posType, [FromQuery] int? categoryId, DiscountRateDto req)
    {
        if (!PosTypes.Contains(posType)) return BadRequest(new { message = "POS type must be Retail, Restaurant or Pharmacy." });
        if (req.Rate is < 0 or > 1) return BadRequest(new { message = "The rate must be between 0% and 100%." });
        using var con = Db.Open();
        if (!await PosTypeRatesInstalledAsync(con)) return BadRequest(new { message = "Rates per POS type need database update 32 (32_discount_pos_type.sql)." });
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM dbo.DiscountTypes WHERE DiscountCode = @discountCode", new { discountCode }) == 0)
            return NotFound(new { message = "No such discount type." });
        await con.ExecuteAsync(
            @"UPDATE dbo.DiscountPosTypeRates SET Rate = @Rate, IsVatExempt = @IsVatExempt, UpdatedAt = SYSDATETIME(), UpdatedBy = @uid
              WHERE DiscountCode = @discountCode AND PosType = @posType AND (CategoryId = @categoryId OR (CategoryId IS NULL AND @categoryId IS NULL));
              IF @@ROWCOUNT = 0
                  INSERT INTO dbo.DiscountPosTypeRates (DiscountCode, PosType, CategoryId, Rate, IsVatExempt, UpdatedBy)
                  VALUES (@discountCode, @posType, @categoryId, @Rate, @IsVatExempt, @uid);",
            new { discountCode, posType, categoryId, req.Rate, req.IsVatExempt, uid = UserId });
        await AuditAsync(con, "DISCOUNT_POSTYPE_RATE_SET",
            $"{discountCode}/{posType}/{(categoryId == null ? "every category" : $"category {categoryId}")}: {req.Rate:P0}, VAT-exempt={req.IsVatExempt}");
        return Ok();
    }

    [HttpDelete("discount-pos-type-rates/{discountCode}/{posType}")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> ClearDiscountPosTypeRate(string discountCode, string posType, [FromQuery] int? categoryId)
    {
        using var con = Db.Open();
        if (!await PosTypeRatesInstalledAsync(con)) return Ok();
        await con.ExecuteAsync(
            @"DELETE FROM dbo.DiscountPosTypeRates WHERE DiscountCode = @discountCode AND PosType = @posType
              AND (CategoryId = @categoryId OR (CategoryId IS NULL AND @categoryId IS NULL))",
            new { discountCode, posType, categoryId });
        await AuditAsync(con, "DISCOUNT_POSTYPE_RATE_CLEAR",
            $"{discountCode}/{posType}/{(categoryId == null ? "every category" : $"category {categoryId}")} cleared");
        return Ok();
    }

    private static readonly string[] PosTypes = ["Retail", "Restaurant", "Pharmacy"];
    private static async Task<bool> PosTypeRatesInstalledAsync(IDbConnection con) =>
        await con.ExecuteScalarAsync<int>("SELECT CASE WHEN OBJECT_ID('dbo.DiscountPosTypeRates', 'U') IS NULL THEN 0 ELSE 1 END") == 1;

    [HttpPut("discount-category-rates/{discountCode}/{categoryId:int}")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> SetDiscountCategoryRate(string discountCode, int categoryId, DiscountCategoryRateDto req)
    {
        using var con = Db.Open();
        await con.ExecuteAsync(
            @"MERGE dbo.DiscountCategoryRates AS tgt
              USING (SELECT @discountCode AS DiscountCode, @categoryId AS CategoryId) AS src
              ON tgt.DiscountCode = src.DiscountCode AND tgt.CategoryId = src.CategoryId
              WHEN MATCHED THEN UPDATE SET Rate = @Rate, IsVatExempt = @IsVatExempt
              WHEN NOT MATCHED THEN INSERT (DiscountCode, CategoryId, Rate, IsVatExempt)
                VALUES (@discountCode, @categoryId, @Rate, @IsVatExempt);",
            new { discountCode, categoryId, req.Rate, req.IsVatExempt });
        await AuditAsync(con, "DISCOUNT_CATEGORY_RATE_SET",
            $"{discountCode}/category {categoryId}: {req.Rate:P0}, VAT-exempt={req.IsVatExempt}");
        return Ok();
    }

    [HttpDelete("discount-category-rates/{discountCode}/{categoryId:int}")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> ClearDiscountCategoryRate(string discountCode, int categoryId)
    {
        using var con = Db.Open();
        await con.ExecuteAsync(
            "DELETE FROM dbo.DiscountCategoryRates WHERE DiscountCode=@discountCode AND CategoryId=@categoryId",
            new { discountCode, categoryId });
        await AuditAsync(con, "DISCOUNT_CATEGORY_RATE_CLEAR", $"{discountCode}/category {categoryId} override cleared");
        return Ok();
    }
}
