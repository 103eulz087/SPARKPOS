using Dapper;

namespace PosApi.Services;

public static class DbBootstrap
{
    /// Waits for SQL Server to accept connections, then replaces the seed
    /// placeholder hashes with real ones. Idempotent and safe to run every start.
    public static async Task RunAsync(Db db, ILogger logger)
    {
        for (var attempt = 1; attempt <= 30; attempt++)
        {
            try
            {
                using var con = db.Open();
                var rows = (await con.QueryAsync<SeedUser>(
                    "SELECT UserId, Username, PasswordSalt FROM dbo.Users WHERE PasswordHash = 'SEEDPWD'")).ToList();

                foreach (var r in rows)
                {
                    var pwd = r.Username switch
                    {
                        "admin" => "admin123",
                        "super" => "super123",
                        _ => "cashier123"
                    };
                    await con.ExecuteAsync("UPDATE dbo.Users SET PasswordHash = @h WHERE UserId = @id",
                        new { h = PasswordHasher.Hash(r.PasswordSalt, pwd), id = r.UserId });
                }
                if (rows.Count > 0) logger.LogInformation("Seed passwords initialised for {n} user(s).", rows.Count);
                return;
            }
            catch (Exception ex)
            {
                logger.LogWarning("Database not ready (attempt {a}/30): {m}", attempt, ex.Message);
                await Task.Delay(2000);
            }
        }
        logger.LogError("Could not reach the database after 30 attempts. Check ConnectionStrings:Default.");
    }

    private record SeedUser(int UserId, string Username, string PasswordSalt);
}
