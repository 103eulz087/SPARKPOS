using System.Data;
using System.Security.Cryptography;
using System.Text;
using Dapper;

namespace PosApi.Services;

/// Each till device assigned to its own terminal (database/27_terminal_devices.sql). A device
/// keeps a random token in its browser and sends it as X-Device-Token on every request; the
/// server only ever stores the token's SHA-256. A terminal with no assigned device works from
/// any device, as before 27, so nothing changes until a supervisor assigns one.
public static class TerminalDevices
{
    public const string Header = "X-Device-Token";

    public static byte[]? HashOf(string? token) =>
        string.IsNullOrWhiteSpace(token) ? null : SHA256.HashData(Encoding.UTF8.GetBytes(token.Trim()));

    public static string NewToken() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));

    /// False on a database without migration 27: the server then behaves as before.
    public static async Task<bool> InstalledAsync(IDbConnection con) =>
        await con.ExecuteScalarAsync<int>("SELECT CASE WHEN OBJECT_ID('dbo.TerminalDevices', 'U') IS NULL THEN 0 ELSE 1 END") == 1;

    public record DeviceTerminal(int TerminalId, string TerminalCode, string BranchCode, string BranchName);

    /// The terminal this device is assigned to (so the branch it physically sits at), or null
    /// for a device that isn't assigned, or a database without 27.
    public static async Task<DeviceTerminal?> AssignedAsync(IDbConnection con, string? token)
    {
        var h = HashOf(token);
        if (h == null || !await InstalledAsync(con)) return null;
        return await con.QuerySingleOrDefaultAsync<DeviceTerminal>(
            @"SELECT t.TerminalId, t.TerminalCode, t.BranchCode, b.BranchName
              FROM dbo.TerminalDevices d
              JOIN dbo.Terminals t ON t.TerminalId = d.TerminalId
              JOIN dbo.Branches b ON b.BranchCode = t.BranchCode
              WHERE d.TokenHash = @h", new { h });
    }

    /// Why this device may not open a shift on the terminal, or null when it may.
    public static async Task<string?> RefusalAsync(IDbConnection con, int terminalId, string? token)
    {
        if (!await InstalledAsync(con)) return null;
        var stored = await con.QuerySingleOrDefaultAsync<byte[]?>(
            "SELECT TokenHash FROM dbo.TerminalDevices WHERE TerminalId = @terminalId", new { terminalId });
        if (stored == null) return null;
        var mine = HashOf(token);
        return mine != null && CryptographicOperations.FixedTimeEquals(stored, mine) ? null
            : "This terminal is assigned to another device. Use your own POS, or ask a supervisor to assign this device to it.";
    }
}
