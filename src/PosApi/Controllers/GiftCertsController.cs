using System.Data;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Services;

namespace PosApi.Controllers;

/// Gift certificates (database/38_gift_certificates.sql): SparkPOS's own register. Head office
/// registers them (a number or a numbered batch, face value, branch, expiry); the till looks one
/// up before taking it as payment, and the sale's sync redeems it (sp_UpsertSale). One use each;
/// no change on a GC (the excess is forfeited). The till only accepts GCs: they're sold elsewhere.
[ApiController]
[Route("api/giftcerts")]
[Authorize]
public class GiftCertsController(Db db) : ApiControllerBase(db)
{
    private static async Task<bool> InstalledAsync(IDbConnection con) =>
        await con.ExecuteScalarAsync<int>("SELECT CASE WHEN OBJECT_ID('dbo.GiftCertificates', 'U') IS NULL THEN 0 ELSE 1 END") == 1;

    private static DateTime Today => LocalTime.FromUtc(DateTime.UtcNow).Date;

    /// The till's check before it takes a GC: { found, ok, problem, gcNo, faceValue, expiryDate }.
    /// `problem` is the reason it can't be taken (the cashier asks for another payment). Any
    /// signed-in user; the branch is the one signed in at.
    [HttpGet("lookup")]
    public async Task<IActionResult> Lookup([FromQuery] string no, [FromQuery] string? branchCode)
    {
        var gcNo = (no ?? "").Trim();
        if (gcNo.Length is 0 or > 30) return BadRequest(new { message = "Enter the gift certificate's number." });
        using var con = Db.Open();
        if (!await InstalledAsync(con)) return BadRequest(new { message = "Gift certificates aren't set up on this server yet." });
        var g = await con.QuerySingleOrDefaultAsync(
            @"SELECT g.GcNo, g.FaceValue, g.BranchCode, g.ExpiryDate, g.Status, g.RedeemedAt, g.RedeemedBranch, s.ORNumber AS RedeemedSi
              FROM dbo.GiftCertificates g LEFT JOIN dbo.Sales s ON s.SaleUid = g.RedeemedSaleUid
              WHERE g.GcNo = @gcNo", new { gcNo });
        if (g == null) return Ok(new { found = false, ok = false, gcNo, problem = $"Gift certificate {gcNo} isn't in the list. Check the number." });
        var branch = string.IsNullOrWhiteSpace(branchCode) ? Branch : branchCode.Trim();
        string? problem = (string)g.Status switch
        {
            "Cancelled" => "This gift certificate was cancelled by head office.",
            "Redeemed" => $"Already used{(g.RedeemedAt != null ? $" on {(DateTime)g.RedeemedAt:yyyy-MM-dd HH:mm}" : "")}"
                          + $"{(g.RedeemedBranch != null ? $" at branch {g.RedeemedBranch}" : "")}"
                          + $"{(g.RedeemedSi != null ? $", SI {(long)g.RedeemedSi}" : "")}.",
            _ when g.ExpiryDate != null && (DateTime)g.ExpiryDate < Today => $"Expired on {(DateTime)g.ExpiryDate:yyyy-MM-dd}.",
            _ when g.BranchCode != null && (string)g.BranchCode != branch => $"Good at branch {g.BranchCode} only.",
            _ => null
        };
        return Ok(new { found = true, ok = problem == null, problem, gcNo = (string)g.GcNo, faceValue = (decimal)g.FaceValue,
                        expiryDate = (DateTime?)g.ExpiryDate, status = (string)g.Status });
    }

    /// The register for Admin: newest first, at most 500; `q` matches the number or who it went to.
    [HttpGet]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> List([FromQuery] string? status, [FromQuery] string? q)
    {
        using var con = Db.Open();
        if (!await InstalledAsync(con)) return Ok(Array.Empty<object>());
        return Ok(await con.QueryAsync(
            @"SELECT TOP 500 g.GcId, g.GcNo, g.FaceValue, g.BranchCode, g.IssuedDate, g.ExpiryDate, g.IssuedTo, g.Note,
                     g.Status, g.RedeemedAt, g.RedeemedBranch, s.ORNumber AS RedeemedSi, t.TerminalCode AS RedeemedTerminal,
                     g.CreatedAt, cu.FullName AS CreatedByName, g.CancelledAt, xu.FullName AS CancelledByName, g.CancelReason
              FROM dbo.GiftCertificates g
              LEFT JOIN dbo.Sales s ON s.SaleUid = g.RedeemedSaleUid
              LEFT JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId
              LEFT JOIN dbo.Users cu ON cu.UserId = g.CreatedBy
              LEFT JOIN dbo.Users xu ON xu.UserId = g.CancelledBy
              WHERE (@status IS NULL OR g.Status = @status)
                AND (@q IS NULL OR g.GcNo LIKE '%' + @q + '%' OR g.IssuedTo LIKE '%' + @q + '%')
              ORDER BY g.GcId DESC",
            new { status = string.IsNullOrWhiteSpace(status) ? null : status, q = string.IsNullOrWhiteSpace(q) ? null : q.Trim() }));
    }

    /// Register GCs: one number (Prefix + Start, Count 1), or a numbered batch: Prefix + Start ..
    /// Start + Count − 1, zero-padded to Digits (e.g. "GC-", 1, 100, 5 → GC-00001 .. GC-00100).
    /// All or none: a number already in the list refuses the whole batch.
    [HttpPost]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> Create(GiftCertBatchDto r)
    {
        var prefix = (r.Prefix ?? "").Trim();
        if (r.Count is < 1 or > 1000) return BadRequest(new { message = "Register 1 to 1,000 gift certificates at a time." });
        if (r.Start < 0 || r.Digits is < 0 or > 12) return BadRequest(new { message = "The starting number and its digits don't look right." });
        if (r.FaceValue is <= 0 or > 1_000_000) return BadRequest(new { message = "Enter the face value, more than ₱0." });
        if (r.ExpiryDate != null && r.ExpiryDate.Value.Date < r.IssuedDate.Date)
            return BadRequest(new { message = "The expiry date is before the issue date." });
        var numbers = Enumerable.Range(0, r.Count)
            .Select(i => prefix + (r.Start + i).ToString().PadLeft(r.Digits, '0')).ToList();
        if (r.Count == 1 && r.Digits == 0 && r.Start == 0) numbers = [prefix];   // a single number typed whole
        if (numbers.Any(n => n.Length is 0 or > 30)) return BadRequest(new { message = "A gift certificate number is 1 to 30 characters." });
        var branch = string.IsNullOrWhiteSpace(r.BranchCode) ? null : r.BranchCode.Trim();

        using var con = Db.Open();
        if (!await InstalledAsync(con)) return BadRequest(new { message = "Run database/38_gift_certificates.sql on this server first." });
        if (branch != null && await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM dbo.Branches WHERE BranchCode = @branch", new { branch }) == 0)
            return BadRequest(new { message = $"No branch {branch}." });
        var taken = (await con.QueryAsync<string>(
            "SELECT GcNo FROM dbo.GiftCertificates WHERE GcNo IN @numbers", new { numbers })).ToList();
        if (taken.Count > 0)
            return BadRequest(new { message = $"Already in the list: {string.Join(", ", taken.Take(5))}{(taken.Count > 5 ? $" and {taken.Count - 5} more" : "")}. Nothing was added." });

        con.Open();   // Db.Open() leaves it closed (Dapper opens per call); a transaction needs it open
        using var tx = con.BeginTransaction();
        await con.ExecuteAsync(
            @"INSERT INTO dbo.GiftCertificates (GcNo, FaceValue, BranchCode, IssuedDate, ExpiryDate, IssuedTo, Note, CreatedBy)
              VALUES (@GcNo, @FaceValue, @branch, @IssuedDate, @ExpiryDate, @IssuedTo, @Note, @by)",
            numbers.Select(n => new
            {
                GcNo = n, r.FaceValue, branch, IssuedDate = r.IssuedDate.Date, ExpiryDate = r.ExpiryDate?.Date,
                IssuedTo = Clip(r.IssuedTo, 120), Note = Clip(r.Note, 200), by = UserId
            }), tx);
        await con.ExecuteAsync(
            @"INSERT INTO dbo.AuditLogs (BranchCode, UserId, Action, Detail) VALUES (@b, @u, 'GC_CREATE', @d)",
            new { b = branch ?? Branch, u = UserId,
                  d = $"{numbers.Count} gift certificate(s) {numbers[0]}{(numbers.Count > 1 ? $" .. {numbers[^1]}" : "")} at {r.FaceValue:N2}" +
                      $"{(branch != null ? $", branch {branch}" : ", every branch")}{(r.ExpiryDate != null ? $", until {r.ExpiryDate:yyyy-MM-dd}" : "")}" },
            tx);
        tx.Commit();
        return Ok(new { added = numbers.Count, first = numbers[0], last = numbers[^1] });
    }

    /// Cancel a GC that hasn't been used (lost, stolen, issued by mistake). A reason is required.
    [HttpPost("{id:int}/cancel")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> Cancel(int id, GiftCertCancelDto r)
    {
        var reason = (r.Reason ?? "").Trim();
        if (reason.Length == 0) return BadRequest(new { message = "Give a reason for cancelling it." });
        using var con = Db.Open();
        var gcNo = await con.QuerySingleOrDefaultAsync<string>(
            @"UPDATE dbo.GiftCertificates SET Status = 'Cancelled', CancelledAt = SYSDATETIME(), CancelledBy = @u, CancelReason = @reason
              OUTPUT inserted.GcNo WHERE GcId = @id AND Status = 'Active'",
            new { id, u = UserId, reason = Clip(reason, 200) });
        if (gcNo == null) return BadRequest(new { message = "Only an unused (active) gift certificate can be cancelled." });
        await AuditAsync(con, "GC_CANCEL", $"Gift certificate {gcNo} cancelled: {Clip(reason, 200)}");
        return Ok();
    }

    private static string? Clip(string? s, int max) =>
        string.IsNullOrWhiteSpace(s) ? null : s.Trim().Length > max ? s.Trim()[..max] : s.Trim();
}

public record GiftCertBatchDto(string? Prefix, long Start, int Count, int Digits, decimal FaceValue,
    DateTime IssuedDate, DateTime? ExpiryDate, string? BranchCode, string? IssuedTo, string? Note);

public record GiftCertCancelDto(string? Reason);
