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
        using var con = Db.Open();
        await con.ExecuteAsync(
            @"UPDATE dbo.PosSettings SET PosType=@PosType, VoidOverride=@VoidOverride,
                PriceEditOverride=@PriceEditOverride, ReprintOverride=@ReprintOverride,
                EodOverride=@EodOverride, EmailOnBlindClose=@EmailOnBlindClose,
                RefundEnabled=@RefundEnabled, BlockLoginAfterEod=@BlockLoginAfterEod,
                OrBlockSize=@OrBlockSize, OrLowWarning=@OrLowWarning,
                MaxDiscountPerTxn=@MaxDiscountPerTxn, StoreHeader1=@StoreHeader1,
                StoreHeader2=@StoreHeader2, ReceiptFooter=@ReceiptFooter
              WHERE BranchCode=@branchCode",
            new { s.PosType, s.VoidOverride, s.PriceEditOverride, s.ReprintOverride, s.EodOverride,
                  s.EmailOnBlindClose, s.RefundEnabled, s.BlockLoginAfterEod, s.OrBlockSize, s.OrLowWarning,
                  s.MaxDiscountPerTxn, s.StoreHeader1, s.StoreHeader2, s.ReceiptFooter, branchCode });
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
                     CASE WHEN SmtpPassword IS NOT NULL AND SmtpPassword <> '' THEN 1 ELSE 0 END AS HasPassword
              FROM dbo.EmailConfig WHERE BranchCode IS NULL");
        // Always return an object (never JSON null) so the frontend can tell "nothing saved
        // yet" apart from "still loading" without an extra loading flag.
        return Ok(c ?? new
        {
            SmtpHost = "", SmtpPort = 587, SmtpUser = "", FromAddress = "", ToAddresses = "",
            EnableSsl = true, SendOnEod = true, IsActive = true, HasPassword = false
        });
    }

    [HttpPut("email-config")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> SaveEmailConfig(EmailConfigDto c)
    {
        using var con = Db.Open();
        var exists = await con.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM dbo.EmailConfig WHERE BranchCode IS NULL");

        if (exists == 0)
        {
            if (string.IsNullOrWhiteSpace(c.SmtpPassword))
                return BadRequest(new { message = "SMTP password is required the first time you save." });
            await con.ExecuteAsync(
                @"INSERT INTO dbo.EmailConfig (BranchCode, SmtpHost, SmtpPort, SmtpUser, SmtpPassword,
                    FromAddress, ToAddresses, EnableSsl, SendOnEod, IsActive)
                  VALUES (NULL, @SmtpHost, @SmtpPort, @SmtpUser, @SmtpPassword,
                    @FromAddress, @ToAddresses, @EnableSsl, @SendOnEod, @IsActive)", c);
        }
        else if (string.IsNullOrWhiteSpace(c.SmtpPassword))
        {
            await con.ExecuteAsync(
                @"UPDATE dbo.EmailConfig SET SmtpHost=@SmtpHost, SmtpPort=@SmtpPort, SmtpUser=@SmtpUser,
                    FromAddress=@FromAddress, ToAddresses=@ToAddresses, EnableSsl=@EnableSsl,
                    SendOnEod=@SendOnEod, IsActive=@IsActive
                  WHERE BranchCode IS NULL", c);
        }
        else
        {
            await con.ExecuteAsync(
                @"UPDATE dbo.EmailConfig SET SmtpHost=@SmtpHost, SmtpPort=@SmtpPort, SmtpUser=@SmtpUser,
                    SmtpPassword=@SmtpPassword, FromAddress=@FromAddress, ToAddresses=@ToAddresses,
                    EnableSsl=@EnableSsl, SendOnEod=@SendOnEod, IsActive=@IsActive
                  WHERE BranchCode IS NULL", c);
        }

        await AuditAsync(con, "EMAIL_CONFIG_UPDATE", "Global email configuration updated");
        return Ok();
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
