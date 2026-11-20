using System.Data;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

/// Accounting module (Addendum B). The ledger rules — balanced entries, reversal-only
/// corrections, period locks, gapless numbering — live in the acc.* stored procedures;
/// this controller only reads reports and forwards the few owner actions (turn on,
/// close/reopen a month). Journal entries themselves are posted by End of Day
/// (dbo.sp_ProcessEndOfDay → acc.sp_PostZReadToLedger), never from here.
[ApiController]
[Route("api/accounting")]
[Authorize(Roles = "Admin")]
public class AccountingController(Db db) : ApiControllerBase(db)
{
    /// One client per deployment today (see CLAUDE.md "Provisioning a new client"), so
    /// every acc.* call uses company 1. The column exists for the multi-tenant model.
    private const int CompanyId = 1;

    private static readonly object[] Templates =
    [
        new { code = "RETAIL", name = "Retail store" },
        new { code = "RESTAURANT", name = "Restaurant" },
        new { code = "PHARMACY", name = "Pharmacy" },
        new { code = "WATER", name = "Water refilling station" }
    ];

    [HttpGet("status")]
    public async Task<IActionResult> Status()
    {
        using var con = Db.Open();
        var s = await con.QuerySingleOrDefaultAsync(
            @"SELECT s.IsEnabled, s.TemplateCode, s.StartDate, s.EnabledAt, u.FullName AS EnabledBy
              FROM acc.Settings s LEFT JOIN dbo.Users u ON u.UserId = s.EnabledByUserId
              WHERE s.CompanyId = @CompanyId", new { CompanyId });
        return Ok(new { settings = s, templates = Templates });
    }

    [HttpPost("setup")]
    public async Task<IActionResult> Setup(AccountingSetupRequest req)
    {
        using var con = Db.Open();
        try
        {
            await con.ExecuteAsync("acc.sp_SetupCompany",
                new { CompanyId, req.TemplateCode, StartDate = req.StartDate.Date, UserId },
                commandType: CommandType.StoredProcedure);
        }
        catch (Exception ex) { return BadRequest(new { message = ex.Message }); }
        await AuditAsync(con, "ACC_SETUP", $"Accounting turned on ({req.TemplateCode}, from {req.StartDate:yyyy-MM-dd})");
        return Ok();
    }

    [HttpGet("accounts")]
    public async Task<IActionResult> Accounts()
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT AccountId, AccountCode, AccountName, PlainName, AccountType, AccountSubType,
                     IsSystem, SystemKey, IsActive
              FROM acc.ChartOfAccounts WHERE CompanyId = @CompanyId ORDER BY AccountCode", new { CompanyId }));
    }

    [HttpGet("trial-balance")]
    public async Task<IActionResult> TrialBalance([FromQuery] DateTime asOf, [FromQuery] string? branchCode)
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync("acc.sp_rpt_TrialBalance",
            new { CompanyId, AsOf = asOf.Date, BranchCode = branchCode },
            commandType: CommandType.StoredProcedure));
    }

    [HttpGet("ledger")]
    public async Task<IActionResult> Ledger([FromQuery] int accountId, [FromQuery] DateTime dateFrom,
        [FromQuery] DateTime dateTo, [FromQuery] string? branchCode)
    {
        using var con = Db.Open();
        using var multi = await con.QueryMultipleAsync("acc.sp_rpt_GeneralLedger",
            new { CompanyId, AccountId = accountId, DateFrom = dateFrom.Date, DateTo = dateTo.Date, BranchCode = branchCode },
            commandType: CommandType.StoredProcedure);
        var account = await multi.ReadSingleOrDefaultAsync();
        if (account == null) return NotFound(new { message = "Account not found." });
        var lines = await multi.ReadAsync();
        return Ok(new { account, lines });
    }

    [HttpGet("journal")]
    public async Task<IActionResult> Journal([FromQuery] DateTime dateFrom, [FromQuery] DateTime dateTo,
        [FromQuery] string? branchCode)
    {
        using var con = Db.Open();
        using var multi = await con.QueryMultipleAsync("acc.sp_rpt_Journal",
            new { CompanyId, DateFrom = dateFrom.Date, DateTo = dateTo.Date, BranchCode = branchCode },
            commandType: CommandType.StoredProcedure);
        var entries = await multi.ReadAsync();
        var lines = await multi.ReadAsync();
        return Ok(new { entries, lines });
    }

    [HttpGet("periods")]
    public async Task<IActionResult> Periods()
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT p.PeriodYear, p.PeriodMonth, p.PeriodStart, p.PeriodEnd, p.Status, p.ClosedAt,
                     u.FullName AS ClosedBy,
                     (SELECT COUNT(*) FROM acc.JournalEntries e
                      WHERE e.CompanyId = p.CompanyId AND e.EntryDate BETWEEN p.PeriodStart AND p.PeriodEnd) AS EntryCount
              FROM acc.Periods p LEFT JOIN dbo.Users u ON u.UserId = p.ClosedByUserId
              WHERE p.CompanyId = @CompanyId ORDER BY p.PeriodYear DESC, p.PeriodMonth DESC", new { CompanyId }));
    }

    [HttpPost("periods/{year:int}/{month:int}/status")]
    public async Task<IActionResult> SetPeriodStatus(int year, int month, PeriodStatusRequest req)
    {
        using var con = Db.Open();
        try
        {
            await con.ExecuteAsync("acc.sp_SetPeriodStatus",
                new { CompanyId, PeriodYear = year, PeriodMonth = month, req.Status, UserId },
                commandType: CommandType.StoredProcedure);
        }
        catch (Exception ex) { return BadRequest(new { message = ex.Message }); }
        await AuditAsync(con, "ACC_PERIOD_STATUS", $"Period {year}-{month:00} set to {req.Status}");
        return Ok();
    }
}
