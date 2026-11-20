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
public class TerminalsController(Db db, PrintService printer, ReceiptBuilder receipts, ErpDb erp) : ApiControllerBase(db)
{
    [HttpGet]
    public async Task<IActionResult> Get([FromQuery] string? branchCode)
    {
        using var con = Db.Open();
        if (!await TerminalDevices.InstalledAsync(con))
            return Ok(await con.QueryAsync(
                @"SELECT t.*, b.BranchName,
                         (SELECT MAX(RangeEnd) FROM dbo.ORRanges r WHERE r.TerminalId = t.TerminalId) AS OrRangeEnd
                  FROM dbo.Terminals t JOIN dbo.Branches b ON b.BranchCode = t.BranchCode
                  WHERE (@branchCode IS NULL OR t.BranchCode = @branchCode)
                  ORDER BY t.BranchCode, t.TerminalCode", new { branchCode }));
        // DeviceIsThis = assigned to the device asking (its X-Device-Token); the hash never leaves here
        var h = TerminalDevices.HashOf(Request.Headers[TerminalDevices.Header]);
        return Ok(await con.QueryAsync(
            @"SELECT t.*, b.BranchName,
                     (SELECT MAX(RangeEnd) FROM dbo.ORRanges r WHERE r.TerminalId = t.TerminalId) AS OrRangeEnd,
                     CAST(CASE WHEN d.TerminalId IS NULL THEN 0 ELSE 1 END AS BIT) AS DeviceAssigned,
                     CAST(CASE WHEN @h IS NOT NULL AND d.TokenHash = @h THEN 1 ELSE 0 END AS BIT) AS DeviceIsThis,
                     d.DeviceLabel, d.AssignedAt AS DeviceAssignedAt, u.FullName AS DeviceAssignedBy
              FROM dbo.Terminals t JOIN dbo.Branches b ON b.BranchCode = t.BranchCode
              LEFT JOIN dbo.TerminalDevices d ON d.TerminalId = t.TerminalId
              LEFT JOIN dbo.Users u ON u.UserId = d.AssignedBy
              WHERE (@branchCode IS NULL OR t.BranchCode = @branchCode)
              ORDER BY t.BranchCode, t.TerminalCode", new { branchCode, h }));
    }

    /// "This device is POS-01": done once on the till itself. A Supervisor of the branch or an
    /// Admin signed in does it directly; a Cashier needs one's user ID and password. The device
    /// gets a new token (it keeps it in its browser); assigning again replaces the terminal's old
    /// device, and this device leaves any terminal it had before.
    [HttpPost("{id:int}/assign-device")]
    public async Task<IActionResult> AssignDevice(int id, AssignDeviceRequest req)
    {
        using var con = Db.Open();
        if (!await TerminalDevices.InstalledAsync(con))
            return BadRequest(new { message = "This server's database can't assign devices yet (migration 27_terminal_devices.sql)." });
        var t = await con.QuerySingleOrDefaultAsync(
            "SELECT BranchCode, TerminalCode, IsActive FROM dbo.Terminals WHERE TerminalId = @id", new { id });
        if (t == null) return NotFound();
        string branch = t.BranchCode, code = t.TerminalCode;
        if (!(bool)t.IsActive) return BadRequest(new { message = $"{code} is switched off in Admin → Terminals." });
        if (!CanActAt(branch)) return BadRequest(new { message = $"{code} belongs to branch {branch}. Sign in at that branch." });

        int approver;
        if (IsPrivileged) approver = UserId;
        else if (await VerifyApproverAsync(con, req.ApproverUsername, req.ApproverPassword, branch) is int a) approver = a;
        else return BadRequest(new { message = $"A supervisor of branch {branch} (or an Admin) approves this. Check the user ID and password." });

        var token = TerminalDevices.NewToken();
        var label = string.IsNullOrWhiteSpace(req.DeviceLabel) ? null : req.DeviceLabel.Trim()[..Math.Min(100, req.DeviceLabel.Trim().Length)];
        await con.ExecuteAsync(
            @"SET XACT_ABORT ON;
              BEGIN TRAN;
              DELETE FROM dbo.TerminalDevices WHERE TerminalId = @id OR (@old IS NOT NULL AND TokenHash = @old);
              INSERT INTO dbo.TerminalDevices (TerminalId, TokenHash, DeviceLabel, AssignedBy)
              VALUES (@id, @hash, @label, @approver);
              COMMIT;",
            new { id, old = TerminalDevices.HashOf(Request.Headers[TerminalDevices.Header]),
                  hash = TerminalDevices.HashOf(token), label, approver });
        var by = await con.QuerySingleAsync<string>("SELECT Username FROM dbo.Users WHERE UserId = @approver", new { approver });
        await AuditAsync(con, "DEVICE_ASSIGN", $"{branch}/{code} assigned to this device ({label ?? "no name"}), approved by {by}", branch, id);
        return Ok(new { deviceToken = token, terminalId = id, terminalCode = code });
    }

    /// Frees a terminal from its device (a PC replaced or wiped); any device can then be assigned.
    [HttpDelete("{id:int}/device")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> UnassignDevice(int id)
    {
        using var con = Db.Open();
        if (!await TerminalDevices.InstalledAsync(con)) return NotFound();
        var t = await con.QuerySingleOrDefaultAsync("SELECT BranchCode, TerminalCode FROM dbo.Terminals WHERE TerminalId = @id", new { id });
        if (t == null) return NotFound();
        if (await con.ExecuteAsync("DELETE FROM dbo.TerminalDevices WHERE TerminalId = @id", new { id }) > 0)
            await AuditAsync(con, "DEVICE_UNASSIGN", $"{(string)t.BranchCode}/{(string)t.TerminalCode} freed from its device", (string)t.BranchCode, id);
        return Ok();
    }

    /// The terminal's own POS type (29_terminal_pos_type.sql); null = the branch's. Skipped on a
    /// DB without the column, where every terminal follows its branch as before.
    private static Task<bool> PosTypeInstalledAsync(System.Data.IDbConnection con) =>
        con.ExecuteScalarAsync<bool>("SELECT CASE WHEN COL_LENGTH('dbo.Terminals', 'PosType') IS NULL THEN 0 ELSE 1 END");

    private static async Task SavePosTypeAsync(System.Data.IDbConnection con, int id, string? posType)
    {
        if (await PosTypeInstalledAsync(con))
            await con.ExecuteAsync("UPDATE dbo.Terminals SET PosType = @posType WHERE TerminalId = @id", new { posType, id });
    }

    private const string PosTypeNotInstalled = "A POS type per terminal needs migration 29_terminal_pos_type.sql on this database. Leave it on the branch default.";

    /// The till's screen (37_terminal_screen_layout.sql): 'Touch' is stored as NULL, and null (an
    /// older Admin sends none) leaves it as it is. Without the column only Touch can be saved.
    private static Task<bool> ScreenLayoutInstalledAsync(System.Data.IDbConnection con) =>
        con.ExecuteScalarAsync<bool>("SELECT CASE WHEN COL_LENGTH('dbo.Terminals', 'ScreenLayout') IS NULL THEN 0 ELSE 1 END");

    private static async Task<string?> CheckScreenLayoutAsync(System.Data.IDbConnection con, string? layout) =>
        layout is not (null or "Touch" or "Grocery") ? "Screen layout must be Touch or Grocery."
        : layout == "Grocery" && !await ScreenLayoutInstalledAsync(con) ? "The grocery lane screen needs migration 37_terminal_screen_layout.sql on this database."
        : null;

    private static async Task SaveScreenLayoutAsync(System.Data.IDbConnection con, int id, string? layout)
    {
        if (layout != null && await ScreenLayoutInstalledAsync(con))
            await con.ExecuteAsync(
                "EXEC sp_executesql N'UPDATE dbo.Terminals SET ScreenLayout = @l WHERE TerminalId = @id', N'@l VARCHAR(10), @id INT', @l, @id",
                new { l = layout == "Grocery" ? "Grocery" : null, id });
    }

    /// ERP posting fields: ErpTerminalCode is the ERP's name for the machine ('SP-' + up to 7,
    /// upper case, unique in the branch); PostToErp can only be turned on with a code and a MIN,
    /// and only at a branch the ERP lists in sp_SparkPOS_GetPostingBranches.
    private async Task<(TerminalDto t, string? error)> CheckErpFieldsAsync(TerminalDto t)
    {
        var posType = string.IsNullOrWhiteSpace(t.PosType) ? null : t.PosType.Trim();
        if (posType != null && posType is not ("Retail" or "Restaurant" or "Pharmacy"))
            return (t, "POS type must be Retail, Restaurant or Pharmacy, or blank to follow the branch.");
        t = t with { PosType = posType };
        var code = string.IsNullOrWhiteSpace(t.ErpTerminalCode) ? null : t.ErpTerminalCode.Trim().ToUpperInvariant();
        if (code != null && !System.Text.RegularExpressions.Regex.IsMatch(code, "^SP-[A-Z0-9-]{1,7}$"))
            return (t, "The ERP terminal code must start with SP- and be at most 10 letters/digits, e.g. SP-POS01.");
        t = t with { ErpTerminalCode = code };
        if (t.PermitValidUntil != null && t.PermitEffective != null && t.PermitValidUntil < t.PermitEffective)
            return (t, "The PTU's valid-until date is before its start date.");
        if (!t.PostToErp) return (t, null);
        if (MissingForErp(t) is { Count: > 0 } missing)
            return (t, $"A terminal that posts to the ERP needs its BIR details: {string.Join(", ", missing)}.");
        if (code == null || string.IsNullOrWhiteSpace(t.MinNo))
            return (t, "Posting to the ERP needs the ERP terminal code and the MIN.");
        if (t.MinNo.Trim().Length > 50)
            return (t, "The ERP takes a MIN of at most 50 characters.");
        if (!erp.IsConfigured) return (t, "The ERP connection isn't set up on this server.");
        try
        {
            using var ec = erp.Open();
            var allowed = (await ec.QueryAsync<string>("dbo.sp_SparkPOS_GetPostingBranches",
                commandType: CommandType.StoredProcedure)).Select(b => b.Trim()).ToList();
            if (!allowed.Contains(t.BranchCode))
                return (t, $"The ERP doesn't accept SparkPOS sales from branch {t.BranchCode} yet (its SPARKPOS_BRANCHES setting).");
        }
        catch (Microsoft.Data.SqlClient.SqlException ex)
        {
            return (t, $"Couldn't check with the ERP whether branch {t.BranchCode} may post: {ex.Message}");
        }
        return (t, null);
    }

    [HttpPost]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> Create(TerminalDto t)
    {
        var (checkedT, error) = await CheckErpFieldsAsync(t);
        if (error != null) return BadRequest(new { message = error });
        t = checkedT;
        using var con = Db.Open();
        if (t.PosType != null && !await PosTypeInstalledAsync(con)) return BadRequest(new { message = PosTypeNotInstalled });
        if (await CheckScreenLayoutAsync(con, t.ScreenLayout) is string bad) return BadRequest(new { message = bad });
        if (await DuplicateBirAsync(con, t, 0) is string dup) return BadRequest(new { message = dup });
        var id = await con.ExecuteScalarAsync<int>(
            @"INSERT INTO dbo.Terminals (BranchCode, TerminalCode, TerminalName, PrinterTarget, PaperWidth,
                PrintAgentKey, Tin, AccreditationNo, SerialNo, PermitNo, MinNo, PermitEffective, IsActive,
                ErpTerminalCode, PostToErp, AccreditationDate, PermitValidUntil, BirRegTransactionNo, BirApplicationDate)
              OUTPUT INSERTED.TerminalId
              VALUES (@BranchCode, @TerminalCode, @TerminalName, @PrinterTarget, @PaperWidth,
                @PrintAgentKey, @Tin, @AccreditationNo, @SerialNo, @PermitNo, @MinNo, @PermitEffective, @IsActive,
                @ErpTerminalCode, @PostToErp, @AccreditationDate, @PermitValidUntil, @BirRegTransactionNo, @BirApplicationDate)", t);
        await SavePosTypeAsync(con, id, t.PosType);
        await SaveScreenLayoutAsync(con, id, t.ScreenLayout);
        await AuditAsync(con, "TERMINAL_CREATE", $"{t.BranchCode}/{t.TerminalCode}", t.BranchCode, id);
        return Ok(new { terminalId = id, erp = await SendToErpAsync(con, id) });
    }

    [HttpPut("{id:int}")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> Update(int id, TerminalDto t)
    {
        var (checkedT, error) = await CheckErpFieldsAsync(t);
        if (error != null) return BadRequest(new { message = error });
        t = checkedT;
        using var con = Db.Open();
        // A MIN change while sales are still on their way to the ERP would send them under the new
        // MIN (the poster reads the terminal's MIN at send time), so it waits until all is sent.
        var old = await con.QuerySingleOrDefaultAsync("SELECT MinNo, ErpTerminalCode FROM dbo.Terminals WHERE TerminalId = @id", new { id });
        if (old == null) return NotFound();
        if (t.PosType != null && !await PosTypeInstalledAsync(con)) return BadRequest(new { message = PosTypeNotInstalled });
        if (await CheckScreenLayoutAsync(con, t.ScreenLayout) is string bad) return BadRequest(new { message = bad });
        if (await DuplicateBirAsync(con, t, id) is string dup) return BadRequest(new { message = dup });
        if (!string.IsNullOrWhiteSpace((string?)old.MinNo) && (string?)old.ErpTerminalCode != null
            && !string.Equals(((string)old.MinNo).Trim(), t.MinNo?.Trim(), StringComparison.Ordinal))
        {
            var busy = await con.QuerySingleAsync(
                @"SELECT (SELECT COUNT(*) FROM dbo.Shifts WHERE TerminalId = @id AND Status = 'Open') AS OpenShifts,
                         (SELECT COUNT(*) FROM dbo.ErpOutbox WHERE TerminalId = @id AND Status <> 'Posted') AS Unsent",
                new { id });
            if ((int)busy.OpenShifts > 0 || (int)busy.Unsent > 0)
                return BadRequest(new { message = "The MIN can't change while this terminal has an open shift or anything not yet sent to the ERP " +
                    $"({(int)busy.OpenShifts} open shift(s), {(int)busy.Unsent} unsent). Close the shift and clear the ERP queue first." });
        }
        await con.ExecuteAsync(
            @"UPDATE dbo.Terminals SET BranchCode=@BranchCode, TerminalCode=@TerminalCode,
                TerminalName=@TerminalName, PrinterTarget=@PrinterTarget, PaperWidth=@PaperWidth,
                PrintAgentKey=@PrintAgentKey, Tin=@Tin,
                AccreditationNo=@AccreditationNo, SerialNo=@SerialNo, PermitNo=@PermitNo,
                MinNo=@MinNo, PermitEffective=@PermitEffective, IsActive=@IsActive,
                ErpTerminalCode=@ErpTerminalCode, PostToErp=@PostToErp,
                AccreditationDate=@AccreditationDate, PermitValidUntil=@PermitValidUntil,
                BirRegTransactionNo=@BirRegTransactionNo, BirApplicationDate=@BirApplicationDate
              WHERE TerminalId=@id",
            new { t.BranchCode, t.TerminalCode, t.TerminalName, t.PrinterTarget, t.PaperWidth,
                  t.PrintAgentKey, t.Tin, t.AccreditationNo, t.SerialNo, t.PermitNo, t.MinNo, t.PermitEffective, t.IsActive,
                  t.ErpTerminalCode, t.PostToErp, t.AccreditationDate, t.PermitValidUntil, t.BirRegTransactionNo,
                  t.BirApplicationDate, id });
        await SavePosTypeAsync(con, id, t.PosType);
        await SaveScreenLayoutAsync(con, id, t.ScreenLayout);
        await AuditAsync(con, "TERMINAL_UPDATE", $"{t.BranchCode}/{t.TerminalCode}" +
            $" (POS type {t.PosType ?? "branch default"})" +
            (t.ScreenLayout != null ? $" (screen {t.ScreenLayout})" : "") +
            (t.ErpTerminalCode != null ? $" (ERP {t.ErpTerminalCode}, posting {(t.PostToErp ? "ON" : "off")})" : ""), t.BranchCode, id);
        return Ok(new { erp = await SendToErpAsync(con, id) });
    }

    /// "Send again": re-sends a terminal's details to the ERP (safe to repeat: the ERP answers UNCHANGED).
    [HttpPost("{id:int}/send-to-erp")]
    [Authorize(Roles = "Admin")]
    public async Task<IActionResult> SendToErp(int id)
    {
        using var con = Db.Open();
        if (await con.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM dbo.Terminals WHERE TerminalId = @id", new { id }) == 0) return NotFound();
        return Ok(new { erp = await SendToErpAsync(con, id) });
    }

    /// BIR: every machine has its own MIN, serial and PTU. Refuses one another active terminal
    /// (any branch) already uses; blanks are not compared.
    private static async Task<string?> DuplicateBirAsync(IDbConnection con, TerminalDto t, int id)
    {
        if (!t.IsActive) return null;
        foreach (var (label, col, value) in new[] { ("MIN", "MinNo", t.MinNo), ("serial no.", "SerialNo", t.SerialNo), ("PTU no.", "PermitNo", t.PermitNo) })
        {
            if (string.IsNullOrWhiteSpace(value)) continue;
            var other = await con.QuerySingleOrDefaultAsync<string?>(
                $@"SELECT TOP 1 BranchCode + '/' + TerminalCode FROM dbo.Terminals
                   WHERE TerminalId <> @id AND IsActive = 1 AND LTRIM(RTRIM({col})) = @v",
                new { id, v = value.Trim() });
            if (other != null) return $"Terminal {other} already has {label} {value.Trim()}. Each machine has its own MIN, serial and PTU.";
        }
        return null;
    }

    /// What the ERP needs before it takes a terminal ([238]); empty = complete.
    private static List<string> MissingForErp(TerminalDto t)
    {
        var m = new List<string>();
        if (string.IsNullOrWhiteSpace(t.MinNo)) m.Add("MIN");
        else if (t.MinNo.Trim().Length > 50) m.Add("a MIN of at most 50 characters");
        if (string.IsNullOrWhiteSpace(t.SerialNo)) m.Add("serial no.");
        if (string.IsNullOrWhiteSpace(t.PermitNo)) m.Add("PTU no.");
        if (t.PermitEffective == null) m.Add("PTU date");
        if (string.IsNullOrWhiteSpace(t.AccreditationNo)) m.Add("accreditation no.");
        if (t.AccreditationDate == null) m.Add("accreditation date");
        return m;
    }

    /// Head office enters a terminal once, here; this fills the ERP from it (spu_SparkPOS_SaveTerminalInfo:
    /// its SparkPOS terminal register + the desktop POS machine list behind its POS reports). Only for a
    /// terminal with an ERP terminal code. Never blocks the save: the outcome is kept on the terminal
    /// (ErpInfoStatus / ErpInfoError) and Admin offers "Send again".
    private async Task<object?> SendToErpAsync(IDbConnection con, int id)
    {
        var t = await con.QuerySingleAsync(
            @"SELECT t.*, ps.StoreHeader1, b.Address AS BranchAddress, b.Tin AS BranchTin
              FROM dbo.Terminals t JOIN dbo.Branches b ON b.BranchCode = t.BranchCode
              LEFT JOIN dbo.PosSettings ps ON ps.BranchCode = t.BranchCode WHERE t.TerminalId = @id", new { id });
        if ((string?)t.ErpTerminalCode == null) return null;

        string? result = null, error = null;
        var dto = new TerminalDto(id, (string)t.BranchCode, (string)t.TerminalCode, (string)t.TerminalName, null, 58, null,
            (string?)t.Tin, (string?)t.AccreditationNo, (string?)t.SerialNo, (string?)t.PermitNo, (string?)t.MinNo,
            (DateTime?)t.PermitEffective, (bool)t.IsActive, AccreditationDate: (DateTime?)t.AccreditationDate);
        var missing = MissingForErp(dto);
        if (missing.Count > 0) error = $"Not sent to the ERP: it needs {string.Join(", ", missing)}.";
        else if (!erp.IsConfigured) error = "Not sent: the ERP connection isn't set up on this server.";
        else
        {
            static string? Blank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
            var me = await con.QuerySingleOrDefaultAsync("SELECT ErpUserId, Username FROM dbo.Users WHERE UserId = @u", new { u = UserId });
            try
            {
                using var ec = erp.Open();
                var r = await ec.QuerySingleAsync("dbo.spu_SparkPOS_SaveTerminalInfo", new
                {
                    BranchCode = (string)t.BranchCode, TerminalCode = (string)t.ErpTerminalCode,
                    MIN = ((string)t.MinNo).Trim(), SerialNo = ((string)t.SerialNo).Trim(), PermitNumber = ((string)t.PermitNo).Trim(),
                    PermitDateStart = (DateTime)t.PermitEffective, PermitDateEnd = (DateTime?)t.PermitValidUntil,
                    AccreditationNo = ((string)t.AccreditationNo).Trim(), AccreditationDate = (DateTime)t.AccreditationDate,
                    RegTransactionNo = Blank((string?)t.BirRegTransactionNo), DateApplication = (DateTime?)t.BirApplicationDate,
                    BusinessName = Blank((string?)t.StoreHeader1), BusinessAddress = Blank((string?)t.BranchAddress),
                    Tin = Blank((string?)t.Tin) ?? Blank((string?)t.BranchTin),
                    IsActive = (bool)t.IsActive, User = (string?)me?.ErpUserId ?? (string?)me?.Username ?? Username
                }, commandType: CommandType.StoredProcedure, commandTimeout: 30);
                result = (string)r.Result;
            }
            catch (Microsoft.Data.SqlClient.SqlException ex)
            {
                error = ex.Number switch
                {
                    61101 => "The ERP was busy. Press Send again.",
                    >= 50000 => $"The ERP refused it ({ex.Number}): {ex.Message}",
                    _ => $"Couldn't reach the ERP: {ex.Message}"
                };
            }
            catch (Exception ex) when (ex is InvalidOperationException or TimeoutException) { error = $"Couldn't reach the ERP: {ex.Message}"; }
        }
        await con.ExecuteAsync(
            @"UPDATE dbo.Terminals SET ErpInfoStatus = @status, ErpInfoResult = @result, ErpInfoError = @error,
                ErpInfoSentAt = SYSDATETIME() WHERE TerminalId = @id",
            new { id, status = error == null ? "Sent" : "Failed", result, error = error?.Length > 400 ? error[..400] : error });
        if (error == null)
            await AuditAsync(con, "TERMINAL_ERP_SENT", $"{(string)t.BranchCode}/{(string)t.TerminalCode} → ERP {(string)t.ErpTerminalCode}: {result}",
                (string)t.BranchCode, id);
        return new { status = error == null ? "Sent" : "Failed", result, error };
    }

    [HttpPost("{id:int}/allocate-or-range")]
    public async Task<IActionResult> AllocateOrRange(int id, [FromQuery] int blockSize = 500, [FromQuery] long? from = null)
    {
        using var con = Db.Open();
        try
        {
            // Sales invoice numbers continue from this terminal's last one used (gap-free);
            // `from` is the device's own next number while it still holds unsynced sales.
            var r = await con.QuerySingleAsync("dbo.sp_AllocateORRange",
                new { TerminalId = id, BlockSize = blockSize, From = from }, commandType: CommandType.StoredProcedure);
            return Ok(r);
        }
        catch (Microsoft.Data.SqlClient.SqlException ex) when (ex.Number is 51020 or 51021)
        {
            return BadRequest(new { message = ex.Message });
        }
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
