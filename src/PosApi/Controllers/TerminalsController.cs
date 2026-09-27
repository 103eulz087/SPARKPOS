using System.Data;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

[ApiController]
[Route("api/terminals")]
[Authorize]
public class TerminalsController(Db db, PrintService printer, ReceiptBuilder receipts) : ApiControllerBase(db)
{
    [HttpGet]
    public async Task<IActionResult> Get([FromQuery] string? branchCode)
    {
        using var con = Db.Open();
        return Ok(await con.QueryAsync(
            @"SELECT t.*, b.BranchName,
                     (SELECT MAX(RangeEnd) FROM dbo.ORRanges r WHERE r.TerminalId = t.TerminalId) AS OrRangeEnd
              FROM dbo.Terminals t JOIN dbo.Branches b ON b.BranchCode = t.BranchCode
              WHERE (@branchCode IS NULL OR t.BranchCode = @branchCode)
              ORDER BY t.BranchCode, t.TerminalCode", new { branchCode }));
    }

    [HttpPost]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> Create(TerminalDto t)
    {
        using var con = Db.Open();
        var id = await con.ExecuteScalarAsync<int>(
            @"INSERT INTO dbo.Terminals (BranchCode, TerminalCode, TerminalName, PrinterTarget, PaperWidth,
                PrintAgentKey, Tin, AccreditationNo, SerialNo, PermitNo, MinNo, PermitEffective, IsActive)
              OUTPUT INSERTED.TerminalId
              VALUES (@BranchCode, @TerminalCode, @TerminalName, @PrinterTarget, @PaperWidth,
                @PrintAgentKey, @Tin, @AccreditationNo, @SerialNo, @PermitNo, @MinNo, @PermitEffective, @IsActive)", t);
        await AuditAsync(con, "TERMINAL_CREATE", $"{t.BranchCode}/{t.TerminalCode}", t.BranchCode, id);
        return Ok(new { terminalId = id });
    }

    [HttpPut("{id:int}")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> Update(int id, TerminalDto t)
    {
        using var con = Db.Open();
        await con.ExecuteAsync(
            @"UPDATE dbo.Terminals SET BranchCode=@BranchCode, TerminalCode=@TerminalCode,
                TerminalName=@TerminalName, PrinterTarget=@PrinterTarget, PaperWidth=@PaperWidth,
                PrintAgentKey=@PrintAgentKey, Tin=@Tin,
                AccreditationNo=@AccreditationNo, SerialNo=@SerialNo, PermitNo=@PermitNo,
                MinNo=@MinNo, PermitEffective=@PermitEffective, IsActive=@IsActive
              WHERE TerminalId=@id",
            new { t.BranchCode, t.TerminalCode, t.TerminalName, t.PrinterTarget, t.PaperWidth,
                  t.PrintAgentKey, t.Tin, t.AccreditationNo, t.SerialNo, t.PermitNo, t.MinNo, t.PermitEffective, t.IsActive, id });
        await AuditAsync(con, "TERMINAL_UPDATE", $"{t.BranchCode}/{t.TerminalCode}", t.BranchCode, id);
        return Ok();
    }

    [HttpPost("{id:int}/allocate-or-range")]
    public async Task<IActionResult> AllocateOrRange(int id, [FromQuery] int blockSize = 500)
    {
        using var con = Db.Open();
        var r = await con.QuerySingleAsync("dbo.sp_AllocateORRange",
            new { TerminalId = id, BlockSize = blockSize }, commandType: CommandType.StoredProcedure);
        return Ok(r);
    }

    /// Drives login gating: open | eodPending | eodDone
    [HttpGet("{id:int}/day-state")]
    public async Task<IActionResult> DayState(int id, [FromQuery] DateTime? businessDate)
    {
        using var con = Db.Open();
        var s = await con.QuerySingleAsync("dbo.sp_GetTerminalDayState",
            new { TerminalId = id, BusinessDate = businessDate ?? DateTime.Today },
            commandType: CommandType.StoredProcedure);
        return Ok(s);
    }

    [HttpPost("{id:int}/test-print")]
    [Authorize(Roles = "Admin,Supervisor")]
    public async Task<IActionResult> TestPrint(int id)
    {
        using var con = Db.Open();
        var t = await con.QuerySingleOrDefaultAsync<dynamic>(
            "SELECT BranchCode, TerminalCode, PrinterTarget, PaperWidth, PrintAgentKey FROM dbo.Terminals WHERE TerminalId=@id", new { id });
        if (t == null) return NotFound();
        await printer.EnqueueAsync(con,
            receipts.TestPrint($"{t.BranchCode}/{t.TerminalCode}", (int)t.PaperWidth),
            (string?)t.PrinterTarget, (string?)t.PrintAgentKey);
        return Ok(new { queued = true });
    }
}
