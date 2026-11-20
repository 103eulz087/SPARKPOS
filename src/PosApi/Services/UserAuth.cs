using System.Data;
using System.Security.Cryptography;
using System.Text;
using Dapper;

namespace PosApi.Services;

/// One place that checks a user's password — for login and for supervisor overrides —
/// whether the user is local (PasswordHasher) or synced from the ERP (the ERP's own PBKDF2),
/// with SparkPOS's own lockout: the ERP counts failed sign-ins itself, but never sees ours.
public static class UserAuth
{
    public const int MaxFailedLogins = 5;
    public static readonly TimeSpan LockFor = TimeSpan.FromMinutes(15);

    public class UserRow
    {
        public int UserId { get; set; }
        public string Username { get; set; } = "";
        public string FullName { get; set; } = "";
        public string Role { get; set; } = "";
        public bool IsActive { get; set; }
        public string PasswordHash { get; set; } = "";
        public string PasswordSalt { get; set; } = "";
        public string? ErpUserId { get; set; }
        public byte[]? ErpPasswordHash { get; set; }
        public byte[]? ErpPasswordSalt { get; set; }
        public int? ErpPasswordIterations { get; set; }
        public byte? ErpPasswordAlgo { get; set; }
        public bool MustChangePassword { get; set; }
        public int FailedLogins { get; set; }
        public DateTime? LockedUntil { get; set; }
    }

    public static Task<UserRow?> FindAsync(IDbConnection con, string? username) =>
        con.QuerySingleOrDefaultAsync<UserRow>(
            @"SELECT UserId, Username, FullName, Role, IsActive, PasswordHash, PasswordSalt, ErpUserId,
                     ErpPasswordHash, ErpPasswordSalt, ErpPasswordIterations, ErpPasswordAlgo,
                     MustChangePassword, FailedLogins, LockedUntil
              FROM dbo.Users WHERE Username = @u", new { u = (username ?? "").Trim() });

    /// The ERP's algorithm (ERP SalesInventorySystem PasswordHasher, PasswordAlgoVersion 1):
    /// PBKDF2-HMAC-SHA1 over the UTF-8 password exactly as typed (not trimmed), with the stored
    /// salt and iteration count, as many bytes as the stored hash. Any other version is refused.
    public static bool ErpVerify(string password, byte[] hash, byte[] salt, int iterations, byte algo)
    {
        if (algo != 1 || hash.Length == 0 || iterations <= 0) return false;
        var derived = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, iterations,
            HashAlgorithmName.SHA1, hash.Length);
        return CryptographicOperations.FixedTimeEquals(derived, hash);
    }

    public enum Outcome { Ok, BadPassword, Locked, Inactive }

    /// Checks the password and keeps the failed-attempt count. Locked users are refused
    /// without even checking the password (so a guess can't confirm itself).
    public static async Task<Outcome> CheckAsync(IDbConnection con, UserRow u, string? password)
    {
        if (!u.IsActive) return Outcome.Inactive;
        if (u.LockedUntil > DateTime.Now) return Outcome.Locked;

        var ok = password != null && (u.ErpUserId != null
            ? u.ErpPasswordHash != null && u.ErpPasswordSalt != null && u.ErpPasswordIterations != null
              && u.ErpPasswordAlgo != null
              && ErpVerify(password, u.ErpPasswordHash, u.ErpPasswordSalt, u.ErpPasswordIterations.Value, u.ErpPasswordAlgo.Value)
            : PasswordHasher.Verify(u.PasswordSalt, password, u.PasswordHash));

        if (ok)
        {
            if (u.FailedLogins > 0 || u.LockedUntil != null)
                await con.ExecuteAsync("UPDATE dbo.Users SET FailedLogins = 0, LockedUntil = NULL WHERE UserId = @id", new { id = u.UserId });
            return Outcome.Ok;
        }

        var failed = u.FailedLogins + 1;
        var lockNow = failed >= MaxFailedLogins;
        await con.ExecuteAsync(
            "UPDATE dbo.Users SET FailedLogins = @f, LockedUntil = @l WHERE UserId = @id",
            new { f = lockNow ? 0 : failed, l = lockNow ? DateTime.Now.Add(LockFor) : (DateTime?)null, id = u.UserId });
        return lockNow ? Outcome.Locked : Outcome.BadPassword;
    }

    /// The branches a user may work at: an Admin has none listed (= every branch).
    public static async Task<List<string>> BranchesAsync(IDbConnection con, UserRow u) =>
        (await con.QueryAsync<string>(
            u.Role == "Admin"
                ? "SELECT BranchCode FROM dbo.Branches WHERE IsActive = 1 ORDER BY BranchCode"
                : "SELECT BranchCode FROM dbo.UserBranches WHERE UserId = @id ORDER BY BranchCode",
            new { id = u.UserId })).ToList();
}
