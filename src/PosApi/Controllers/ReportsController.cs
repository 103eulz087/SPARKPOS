using System.Data;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Services;

namespace PosApi.Controllers;

[ApiController]
[Route("api/reports")]
[Authorize(Roles = "Admin,Supervisor")]
public class ReportsController(Db db) : ApiControllerBase(db)
{
    private async Task<IEnumerable<dynamic>> Exec(string sp, object p)
    {
        using var con = Db.Open();
        return await con.QueryAsync(sp, p, commandType: CommandType.StoredProcedure);
    }

    [HttpGet("dashboard")]
    public async Task<IActionResult> Dashboard([FromQuery] DateTime? businessDate, [FromQuery] string? branchCode)
    {
        using var con = Db.Open();
        using var multi = await con.QueryMultipleAsync("dbo.sp_rpt_Dashboard",
            new { BusinessDate = businessDate ?? DateTime.Today, BranchCode = branchCode },
            commandType: CommandType.StoredProcedure);
        return Ok(new
        {
            today = await multi.ReadSingleAsync(),
            byBranch = await multi.ReadAsync(),
            last7 = await multi.ReadAsync(),
            openShifts = await multi.ReadSingleAsync()
        });
    }

    [HttpGet("sales-summary")]
    public async Task<IActionResult> SalesSummary([FromQuery] DateTime dateFrom, [FromQuery] DateTime dateTo,
        [FromQuery] string? branchCode, [FromQuery] int? terminalId)
        => Ok(await Exec("dbo.sp_rpt_SalesSummary", new { DateFrom = dateFrom, DateTo = dateTo, BranchCode = branchCode, TerminalId = terminalId }));

    [HttpGet("branch-comparison")]
    public async Task<IActionResult> BranchComparison([FromQuery] DateTime dateFrom, [FromQuery] DateTime dateTo)
        => Ok(await Exec("dbo.sp_rpt_BranchComparison", new { DateFrom = dateFrom, DateTo = dateTo }));

    [HttpGet("sales-details")]
    public async Task<IActionResult> SalesDetails([FromQuery] DateTime dateFrom, [FromQuery] DateTime dateTo,
        [FromQuery] string? branchCode, [FromQuery] int? terminalId)
        => Ok(await Exec("dbo.sp_rpt_SalesDetails", new { DateFrom = dateFrom, DateTo = dateTo, BranchCode = branchCode, TerminalId = terminalId }));

    [HttpGet("payment-breakdown")]
    public async Task<IActionResult> PaymentBreakdown([FromQuery] DateTime dateFrom, [FromQuery] DateTime dateTo, [FromQuery] string? branchCode)
        => Ok(await Exec("dbo.sp_rpt_PaymentBreakdown", new { DateFrom = dateFrom, DateTo = dateTo, BranchCode = branchCode }));

    [HttpGet("card-transactions")]
    public async Task<IActionResult> CardTransactions([FromQuery] DateTime dateFrom, [FromQuery] DateTime dateTo, [FromQuery] string? branchCode)
        => Ok(await Exec("dbo.sp_rpt_CardTransactions", new { DateFrom = dateFrom, DateTo = dateTo, BranchCode = branchCode }));

    [HttpGet("discounts")]
    public async Task<IActionResult> Discounts([FromQuery] DateTime dateFrom, [FromQuery] DateTime dateTo, [FromQuery] string? branchCode)
        => Ok(await Exec("dbo.sp_rpt_Discounts", new { DateFrom = dateFrom, DateTo = dateTo, BranchCode = branchCode }));

    [HttpGet("group-category")]
    public async Task<IActionResult> GroupCategory([FromQuery] DateTime dateFrom, [FromQuery] DateTime dateTo, [FromQuery] string? branchCode)
        => Ok(await Exec("dbo.sp_rpt_GroupCategory", new { DateFrom = dateFrom, DateTo = dateTo, BranchCode = branchCode }));

    [HttpGet("group-items")]
    public async Task<IActionResult> GroupItems([FromQuery] DateTime dateFrom, [FromQuery] DateTime dateTo, [FromQuery] string? branchCode)
        => Ok(await Exec("dbo.sp_rpt_GroupItems", new { DateFrom = dateFrom, DateTo = dateTo, BranchCode = branchCode }));

    [HttpGet("void-return")]
    public async Task<IActionResult> VoidReturn([FromQuery] DateTime dateFrom, [FromQuery] DateTime dateTo, [FromQuery] string? branchCode)
        => Ok(await Exec("dbo.sp_rpt_VoidReturn", new { DateFrom = dateFrom, DateTo = dateTo, BranchCode = branchCode }));

    [HttpGet("cashier-performance")]
    public async Task<IActionResult> CashierPerformance([FromQuery] DateTime dateFrom, [FromQuery] DateTime dateTo, [FromQuery] string? branchCode)
        => Ok(await Exec("dbo.sp_rpt_CashierPerformance", new { DateFrom = dateFrom, DateTo = dateTo, BranchCode = branchCode }));

    [HttpGet("audit-logs")]
    public async Task<IActionResult> AuditLogs([FromQuery] DateTime dateFrom, [FromQuery] DateTime dateTo, [FromQuery] string? branchCode)
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT TOP 500 a.AuditId, a.BranchCode, u.Username, t.TerminalCode, a.Action, a.Detail, a.CreatedAt
              FROM dbo.AuditLogs a
              LEFT JOIN dbo.Users u ON u.UserId = a.UserId
              LEFT JOIN dbo.Terminals t ON t.TerminalId = a.TerminalId
              WHERE a.CreatedAt >= @dateFrom AND a.CreatedAt < DATEADD(DAY, 1, @dateTo)
                AND (@branchCode IS NULL OR a.BranchCode = @branchCode)
              ORDER BY a.CreatedAt DESC", new { dateFrom, dateTo, branchCode }));
    }
}
