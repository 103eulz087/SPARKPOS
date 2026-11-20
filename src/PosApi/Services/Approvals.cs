using System.Data;
using Dapper;

namespace PosApi.Services;

/// Which till actions need a supervisor's approval (35_approvals.sql): the branch's switch in
/// PosSettings, unless the terminal has its own answer in TerminalOverrides. A Supervisor or Admin
/// signed in never needs one (the callers check IsPrivileged). Safe before 35: the new switches
/// read as off and terminal answers as none.
public static class Approvals
{
    public const string CancelLine = "CANCEL_LINE", Void = "VOID", Return = "RETURN",
        XRead = "XREAD", Reprint = "REPRINT", Discount = "DISCOUNT", PriceLevel = "PRICE_LEVEL",
        OpenDrawer = "OPEN_DRAWER";

    /// In the order Admin shows them, with the PosSettings column and its default when missing.
    public static readonly (string Func, string Column, bool Default)[] Funcs =
    [
        (CancelLine, "CancelLineOverride", false),
        (Void, "VoidOverride", true),
        (Return, "ReturnOverride", true),
        (XRead, "XReadOverride", false),
        (Reprint, "ReprintOverride", false),
        (Discount, "DiscountOverride", false),
        (PriceLevel, "PriceLevelOverride", false),  // 36
        (OpenDrawer, "OpenDrawerOverride", false)   // 39
    ];

    public static async Task<bool> TerminalTableAsync(IDbConnection con) =>
        await con.ExecuteScalarAsync<int>("SELECT CASE WHEN OBJECT_ID('dbo.TerminalOverrides', 'U') IS NULL THEN 0 ELSE 1 END") == 1;

    /// The branch's switches: func → required.
    public static async Task<Dictionary<string, bool>> BranchAsync(IDbConnection con, string branchCode)
    {
        var row = (IDictionary<string, object>?)await con.QuerySingleOrDefaultAsync(
            "SELECT * FROM dbo.PosSettings WHERE BranchCode = @b", new { b = branchCode });
        return Funcs.ToDictionary(f => f.Func,
            f => row != null && row.TryGetValue(f.Column, out var v) && v != null ? Convert.ToBoolean(v) : f.Default);
    }

    /// For one terminal: func → (required, from the terminal or the branch).
    public static async Task<Dictionary<string, (bool Required, bool OwnSetting)>> TerminalAsync(
        IDbConnection con, string branchCode, int? terminalId)
    {
        var branch = await BranchAsync(con, branchCode);
        var own = terminalId != null && await TerminalTableAsync(con)
            ? (await con.QueryAsync<(string Func, bool Required)>(
                "SELECT Func, Required FROM dbo.TerminalOverrides WHERE TerminalId = @t", new { t = terminalId }))
                .ToDictionary(r => r.Func, r => r.Required)
            : new Dictionary<string, bool>();
        return Funcs.ToDictionary(f => f.Func,
            f => own.TryGetValue(f.Func, out var r) ? (r, true) : (branch[f.Func], false));
    }

    public static async Task<bool> RequiredAsync(IDbConnection con, string branchCode, int? terminalId, string func) =>
        (await TerminalAsync(con, branchCode, terminalId))[func].Required;
}
