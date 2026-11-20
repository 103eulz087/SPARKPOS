using System.Data;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using PosApi.Services;

namespace PosApi.Controllers;

/// CORECS ERP integration: master data and prices. The work is in ErpSyncService (shared
/// with the ErpAutoSync timer); this is the Admin → Sync from ERP button and its status.
[ApiController]
[Route("api/erp")]
[Authorize(Roles = "Admin")]
public class ErpController(Db db, ErpDb erp, ErpSyncService sync, ErpPostingService posting) : ApiControllerBase(db)
{
    [HttpGet("status")]
    public async Task<IActionResult> Status()
    {
        using var con = Db.Open();
        var last = await con.QuerySingleOrDefaultAsync(
            @"SELECT TOP 1 a.CreatedAt, a.Detail, u.FullName
              FROM dbo.AuditLogs a LEFT JOIN dbo.Users u ON u.UserId = a.UserId
              WHERE a.Action = 'ERP_SYNC' ORDER BY a.AuditId DESC");
        return Ok(new { configured = erp.IsConfigured, productBranch = erp.ProductBranch,
                        autoSyncMinutes = erp.IsConfigured ? erp.AutoSyncMinutes : 0, lastSync = last });
    }

    [HttpPost("sync-master-data")]
    public async Task<IActionResult> SyncMasterData()
    {
        if (!erp.IsConfigured)
            return BadRequest(new { message = "The ERP connection isn't set up on this server (ConnectionStrings:Erp in appsettings.json)." });
        try
        {
            var r = await sync.RunAsync(UserId);
            return Ok(new { received = r.Received, summary = r.Summary, issues = r.Issues, notes = r.Notes, users = r.Users });
        }
        catch (ErpUnavailableException ex) { return StatusCode(502, new { message = ex.Message }); }
        catch (SqlException ex) { return BadRequest(new { message = ex.Message }); }
    }

    /* ---------- step 4.1: posting sales to the ERP ---------- */

    /// The queue: counts by status, plus everything that needs a look (failed, flagged by the
    /// ERP for review, or with stock shortfalls), newest first.
    [HttpGet("posting")]
    public async Task<IActionResult> Posting([FromQuery] string? branchCode)
    {
        using var con = Db.Open();
        var counts = await con.QuerySingleAsync(
            @"SELECT SUM(CASE WHEN Status = 'Pending' THEN 1 ELSE 0 END) AS Pending,
                     SUM(CASE WHEN Status = 'Pending' AND Attempts > 0 THEN 1 ELSE 0 END) AS Retrying,
                     SUM(CASE WHEN Status = 'Posted' THEN 1 ELSE 0 END) AS Posted,
                     SUM(CASE WHEN Status = 'Failed' THEN 1 ELSE 0 END) AS Failed,
                     SUM(CASE WHEN NeedsReview = 1 THEN 1 ELSE 0 END) AS NeedsReview,
                     SUM(CASE WHEN ShortLines > 0 THEN 1 ELSE 0 END) AS WithShortfalls
              FROM dbo.ErpOutbox WHERE @b IS NULL OR BranchCode = @b", new { b = branchCode });
        var attention = await con.QueryAsync(
            @"SELECT TOP 200 o.OutboxId, o.Kind, o.Status, o.BranchCode, t.TerminalCode, t.ErpTerminalCode, o.BusinessDate,
                     s.ORNumber, s.NetAmount, o.Attempts, o.NextAttemptAt, o.LastErrorNumber, o.LastError,
                     o.ErpResult, o.ShortLines, o.NeedsReview, o.ErpMessage, o.CreatedAt, o.PostedAt
              FROM dbo.ErpOutbox o
              JOIN dbo.Terminals t ON t.TerminalId = o.TerminalId
              LEFT JOIN dbo.Sales s ON s.SaleUid = o.RefUid
              WHERE (@b IS NULL OR o.BranchCode = @b)
                AND (o.Status = 'Failed' OR (o.Status = 'Pending' AND o.Attempts > 0) OR o.NeedsReview = 1 OR o.ShortLines > 0)
              ORDER BY o.OutboxId DESC", new { b = branchCode });
        return Ok(new { configured = erp.IsConfigured, counts, attention });
    }

    /// Everything sent (or waiting) for one ERP terminal, in posting order.
    [HttpGet("posting-log")]
    public async Task<IActionResult> PostingLog([FromQuery] string terminalCode, [FromQuery] DateTime? businessDate)
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT TOP 500 o.OutboxId, o.Kind, o.Status, o.BusinessDate, o.Attempts, o.LastErrorNumber, o.LastError,
                     o.ErpResult, o.ShortLines, o.NeedsReview, o.ErpMessage, o.CreatedAt, o.PostedAt
              FROM dbo.ErpOutbox o JOIN dbo.Terminals t ON t.TerminalId = o.TerminalId
              WHERE t.ErpTerminalCode = @terminalCode AND (@businessDate IS NULL OR o.BusinessDate = @businessDate)
              ORDER BY o.OutboxId", new { terminalCode = terminalCode.Trim().ToUpperInvariant(), businessDate }));
    }

    /// Puts a failed entry back in the queue (after fixing the cause in SparkPOS or the ERP).
    [HttpPost("posting/{id:long}/retry")]
    public async Task<IActionResult> Retry(long id)
    {
        using var con = Db.Open();
        var n = await con.ExecuteAsync(
            @"UPDATE dbo.ErpOutbox SET Status = 'Pending', NextAttemptAt = SYSDATETIME(), Attempts = 0
              WHERE OutboxId = @id AND Status IN ('Failed', 'Pending')", new { id });
        if (n == 0) return NotFound();
        await AuditAsync(con, "ERP_POST_RETRY", $"Outbox entry {id} queued again");
        return Ok();
    }

    /// Sends what's due now instead of waiting for the next round.
    [HttpPost("posting/run")]
    public async Task<IActionResult> RunPosting() => Ok(new { processed = await posting.RunOnceAsync() });

    /// Branches whose SparkPOS terminals the ERP accepts sales from (its SPARKPOS_BRANCHES setting).
    [HttpGet("posting-branches")]
    public async Task<IActionResult> PostingBranches()
    {
        if (!erp.IsConfigured) return Ok(Array.Empty<object>());
        try
        {
            using var ec = erp.Open();
            return Ok(await ec.QueryAsync("dbo.sp_SparkPOS_GetPostingBranches", commandType: CommandType.StoredProcedure));
        }
        catch (SqlException ex) { return StatusCode(502, new { message = ex.Message }); }
    }

    /// Lines the branch didn't have enough stock for, as the ERP recorded them.
    [HttpGet("shortfalls")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> Shortfalls([FromQuery] string branchCode, [FromQuery] DateTime businessDate)
    {
        if (!CanActAt(branchCode)) return StatusCode(403, new { message = $"Branch {branchCode} isn't yours." });
        try
        {
            using var ec = erp.Open();
            return Ok(await ec.QueryAsync("dbo.sp_SparkPOS_GetStockShortfalls",
                new { BranchCode = branchCode, BusinessDate = businessDate.Date }, commandType: CommandType.StoredProcedure));
        }
        catch (SqlException ex) { return StatusCode(502, new { message = ex.Message }); }
    }
}
