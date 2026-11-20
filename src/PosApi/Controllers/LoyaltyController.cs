using System.Data;
using System.Text.RegularExpressions;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

/// Suki / reward cards (database/26_loyalty.sql). The till looks a card up (tap, typed card
/// number or mobile number) to show the balance and ring the sale up with it; the points
/// themselves are earned and taken back by the procs at sync / void / return, never here.
/// Cards are registered by head office or a branch supervisor; the earning rule and manual
/// adjustments are Admin-only. Phase 1: no redeeming.
[ApiController]
[Route("api/loyalty")]
[Authorize]
public class LoyaltyController(Db db) : ApiControllerBase(db)
{
    /// Philippine mobile numbers are kept as their last 10 digits (9171234567), so
    /// 0917 123 4567, +63 917 123 4567 and 917-123-4567 are the same number.
    internal static string? NormalizeMobile(string? m)
    {
        var d = Regex.Replace(m ?? "", @"\D", "");
        return d.Length >= 10 ? d[^10..] : null;
    }

    [HttpGet("settings")]
    public async Task<IActionResult> Settings()
    {
        using var con = Db.Open();
        return Ok(await con.QuerySingleOrDefaultAsync(
            "SELECT IsEnabled, AmountPerPoint, ProgramName, UpdatedAt FROM dbo.LoyaltySettings WHERE SettingsId = 1"));
    }

    [HttpPut("settings")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> SaveSettings(LoyaltySettingsDto s)
    {
        if (s.AmountPerPoint < 1) return BadRequest(new { message = "The amount per point must be at least ₱1." });
        var name = (s.ProgramName ?? "").Trim();
        if (name.Length is 0 or > 40) return BadRequest(new { message = "Give the program a name of up to 40 characters (e.g. Suki card)." });
        using var con = Db.Open();
        await con.ExecuteAsync(
            @"UPDATE dbo.LoyaltySettings SET IsEnabled = @IsEnabled, AmountPerPoint = @AmountPerPoint,
                ProgramName = @name, UpdatedAt = SYSDATETIME(), UpdatedBy = @uid WHERE SettingsId = 1",
            new { s.IsEnabled, s.AmountPerPoint, name, uid = UserId });
        await AuditAsync(con, "LOYALTY_SETTINGS",
            $"{name}: {(s.IsEnabled ? "on" : "off")}, ₱{s.AmountPerPoint:N2} per point");
        return Ok();
    }

    /// The till's lookup: card number first, then mobile number. Any signed-in user.
    [HttpGet("lookup")]
    public async Task<IActionResult> Lookup([FromQuery] string code)
    {
        var c = (code ?? "").Trim();
        if (c.Length == 0) return BadRequest(new { message = "Tap the card or type its number." });
        using var con = Db.Open();
        var card = await con.QueryFirstOrDefaultAsync(
            @"SELECT TOP 1 CardId, CardNo, CustomerName, Points, IsActive FROM dbo.LoyaltyCards
              WHERE CardNo = @c OR (@m IS NOT NULL AND Mobile = @m)
              ORDER BY CASE WHEN CardNo = @c THEN 0 ELSE 1 END", new { c, m = NormalizeMobile(c) });
        var s = await con.QuerySingleAsync("SELECT IsEnabled, AmountPerPoint, ProgramName FROM dbo.LoyaltySettings WHERE SettingsId = 1");
        if (card == null) return NotFound(new { message = "No card with that number or mobile number." });
        return Ok(new
        {
            cardNo = (string)card.CardNo, customerName = (string)card.CustomerName, points = (int)card.Points,
            isActive = (bool)card.IsActive, enabled = (bool)s.IsEnabled,
            amountPerPoint = (decimal)s.AmountPerPoint, programName = (string)s.ProgramName
        });
    }

    [HttpGet("cards")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Cards([FromQuery] string? q)
    {
        var term = (q ?? "").Trim();
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT TOP 200 CardId, CardNo, CustomerName, Mobile, Email, Points, IsActive, IssuedBranch, CreatedAt
              FROM dbo.LoyaltyCards
              WHERE @t = '' OR CardNo LIKE @like OR CustomerName LIKE @like OR (@m IS NOT NULL AND Mobile = @m)
              ORDER BY CASE WHEN @t = '' THEN CardId END DESC, CustomerName",
            new { t = term, like = $"%{term}%", m = NormalizeMobile(term) }));
    }

    [HttpPost("cards")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Create(LoyaltyCardDto c)
    {
        var (ok, error, mobile) = Check(c);
        if (!ok) return BadRequest(new { message = error });
        using var con = Db.Open();
        if (await DuplicateAsync(con, c.CardNo.Trim(), mobile, 0) is string dup) return BadRequest(new { message = dup });
        var id = await con.ExecuteScalarAsync<int>(
            @"INSERT INTO dbo.LoyaltyCards (CardNo, CustomerName, Mobile, Email, IsActive, IssuedBranch, CreatedBy)
              OUTPUT INSERTED.CardId VALUES (@no, @name, @mobile, @email, 1, @branch, @uid)",
            new { no = c.CardNo.Trim(), name = c.CustomerName.Trim(), mobile,
                  email = string.IsNullOrWhiteSpace(c.Email) ? null : c.Email.Trim(), branch = Branch, uid = UserId });
        await AuditAsync(con, "LOYALTY_CARD", $"Card {c.CardNo.Trim()} registered for {c.CustomerName.Trim()}", Branch);
        return Ok(new { cardId = id });
    }

    /// Name, mobile, email and on/off. The card number and the points don't change here
    /// (a replacement card is a new card plus an adjustment).
    [HttpPut("cards/{id:int}")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Update(int id, LoyaltyCardDto c)
    {
        var (ok, error, mobile) = Check(c);
        if (!ok) return BadRequest(new { message = error });
        using var con = Db.Open();
        if (await DuplicateAsync(con, null, mobile, id) is string dup) return BadRequest(new { message = dup });
        var n = await con.ExecuteAsync(
            @"UPDATE dbo.LoyaltyCards SET CustomerName = @name, Mobile = @mobile, Email = @email,
                IsActive = @active, UpdatedAt = SYSDATETIME() WHERE CardId = @id",
            new { id, name = c.CustomerName.Trim(), mobile,
                  email = string.IsNullOrWhiteSpace(c.Email) ? null : c.Email.Trim(), active = c.IsActive });
        if (n == 0) return NotFound();
        await AuditAsync(con, "LOYALTY_CARD", $"Card {id} updated ({(c.IsActive ? "active" : "switched off")})", Branch);
        return Ok();
    }

    [HttpGet("cards/{id:int}/history")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> History(int id)
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT TOP 300 l.EntryId, l.Kind, l.Points, l.Amount, l.AmountPerPoint, l.BranchCode, l.Note, l.CreatedAt,
                     s.ORNumber, t.TerminalCode, r.ReturnNo, u.FullName AS ByName
              FROM dbo.LoyaltyLedger l
              LEFT JOIN dbo.Sales s ON s.SaleUid = l.SaleUid
              LEFT JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
              LEFT JOIN dbo.SaleReturns r ON l.Kind = 'RETURN' AND r.ReturnUid = l.RefUid
              LEFT JOIN dbo.Users u ON u.UserId = l.CreatedBy
              WHERE l.CardId = @id ORDER BY l.EntryId DESC", new { id }));
    }

    [HttpPost("cards/{id:int}/adjust")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> Adjust(int id, LoyaltyAdjustDto a)
    {
        using var con = Db.Open();
        try
        {
            var points = await con.ExecuteScalarAsync<int>("dbo.sp_LoyaltyAdjust",
                new { CardId = id, a.Points, a.Note, UserId, BranchCode = Branch }, commandType: CommandType.StoredProcedure);
            await AuditAsync(con, "LOYALTY_ADJUST", $"Card {id}: {a.Points:+#;-#} points. {a.Note}", Branch);
            return Ok(new { points });
        }
        catch (Microsoft.Data.SqlClient.SqlException ex) when (ex.Number is >= 51301 and <= 51304)
        {
            return BadRequest(new { message = ex.Message });
        }
    }

    static (bool ok, string? error, string? mobile) Check(LoyaltyCardDto c)
    {
        if (string.IsNullOrWhiteSpace(c.CardNo) || c.CardNo.Trim().Length > 50)
            return (false, "Tap the card on the reader (or type its number, up to 50 characters).", null);
        if (string.IsNullOrWhiteSpace(c.CustomerName) || c.CustomerName.Trim().Length > 150)
            return (false, "Enter the customer's name.", null);
        string? mobile = null;
        if (!string.IsNullOrWhiteSpace(c.Mobile))
        {
            mobile = NormalizeMobile(c.Mobile);
            if (mobile == null) return (false, "The mobile number needs at least 10 digits (e.g. 0917 123 4567).", null);
        }
        if (!string.IsNullOrWhiteSpace(c.Email) && (c.Email.Trim().Length > 254 || !c.Email.Contains('@')))
            return (false, "That email address doesn't look right.", null);
        return (true, null, mobile);
    }

    static async Task<string?> DuplicateAsync(IDbConnection con, string? cardNo, string? mobile, int exceptId)
    {
        if (cardNo != null && await con.ExecuteScalarAsync<int>(
                "SELECT COUNT(*) FROM dbo.LoyaltyCards WHERE CardNo = @cardNo", new { cardNo }) > 0)
            return "That card is already registered.";
        if (mobile != null)
        {
            var other = await con.QueryFirstOrDefaultAsync<string>(
                "SELECT CustomerName FROM dbo.LoyaltyCards WHERE Mobile = @mobile AND CardId <> @exceptId",
                new { mobile, exceptId });
            if (other != null) return $"That mobile number is already on {other}'s card.";
        }
        return null;
    }
}
