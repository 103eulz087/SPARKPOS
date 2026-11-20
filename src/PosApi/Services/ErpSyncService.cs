using System.Data;
using Dapper;
using Microsoft.Data.SqlClient;

namespace PosApi.Services;

/// The ERP couldn't be read (down, unreachable, login refused). Nothing was changed locally.
public class ErpUnavailableException(string message, Exception inner) : Exception(message, inner);

/// CORECS ERP master-data sync: reads the ERP's categories, products, branches and per-branch
/// SellingPrice (dbo.sp_SparkPOS_Get* on the ERP's server) and applies them here through
/// dbo.sp_ErpSyncMasterData. Used by Admin → Sync from ERP and by ErpAutoSync's timer.
public class ErpSyncService(Db db, ErpDb erp, ILogger<ErpSyncService> log)
{
    private const int ErpTimeoutSeconds = 60;
    // Applying a big ERP (VROSS: ~250k branch price rows) to our own DB takes longer than a read.
    private const int ApplyTimeoutSeconds = 600;
    private static readonly SemaphoreSlim Gate = new(1, 1);

    // Settable properties, not positional records: Dapper maps those by name and ignores
    // extra columns.
    private class ErpCategory { public int? ErpCategoryId { get; set; } public string? CategoryName { get; set; } }
    private class ErpProduct
    {
        public string? ErpProductCode { get; set; }
        public string? Barcode { get; set; }
        public string? ProductName { get; set; }
        public int? ErpCategoryId { get; set; }
        public string? Unit { get; set; }
        public bool? IsVatable { get; set; }
        public bool? IsDiscountable { get; set; }
        public decimal? Cost { get; set; }
        public decimal? Price { get; set; }   // the branch's SellingPrice once the ERP returns it
        public bool? IsActive { get; set; }
    }
    private class ErpBranch { public string? BranchCode { get; set; } public string? BranchName { get; set; } public string? Address { get; set; } }
    private class ErpPrice
    {
        public string? BranchCode { get; set; }
        public string? ErpProductCode { get; set; }
        public decimal? SellingPrice { get; set; }
        public decimal? Price1 { get; set; }   // price levels (31_price_levels.sql), once the ERP sends them
        public decimal? Price2 { get; set; }
        public decimal? Price3 { get; set; }
        public decimal? Price4 { get; set; }
    }
    private class ErpUser
    {
        public string? UserID { get; set; }
        public string? FullName { get; set; }
        public string? AssignedBranch { get; set; }
        public string? Role { get; set; }   // computed by the ERP: Admin > Supervisor > Cashier
        public bool? MustChangePassword { get; set; }
        public byte[]? PasswordHash { get; set; }
        public byte[]? PasswordSalt { get; set; }
        public int? PasswordIterations { get; set; }
        public byte? PasswordAlgoVersion { get; set; }
    }

    public enum RefreshResult { Updated, NotInErp, Unreachable, NotConfigured }

    public record Result(object Received, dynamic Summary, List<dynamic> Issues, List<string> Notes, dynamic? Users);

    /// userId: the Admin who pressed the button, or null for the automatic sync.
    public async Task<Result> RunAsync(int? userId)
    {
        // One sync per API process at a time (the proc's applock covers other servers).
        await Gate.WaitAsync();
        try { return await RunCoreAsync(userId); }
        finally { Gate.Release(); }
    }

    private async Task<Result> RunCoreAsync(int? userId)
    {
        var notes = new List<string>();
        List<ErpCategory> cats; List<ErpProduct> prods; List<ErpBranch> branches; List<ErpPrice> prices;
        var levelsSent = false;
        try
        {
            using var ec = erp.Open();
            cats = (await ec.QueryAsync<ErpCategory>("dbo.sp_SparkPOS_GetCategories",
                commandType: CommandType.StoredProcedure, commandTimeout: ErpTimeoutSeconds)).ToList();
            prods = (await ec.QueryAsync<ErpProduct>("dbo.sp_SparkPOS_GetProducts",
                new { BranchCode = erp.ProductBranch },
                commandType: CommandType.StoredProcedure, commandTimeout: ErpTimeoutSeconds)).ToList();
            branches = (await ec.QueryAsync<ErpBranch>("dbo.sp_SparkPOS_GetBranches",
                commandType: CommandType.StoredProcedure, commandTimeout: ErpTimeoutSeconds)).ToList();
            try
            {
                prices = (await ec.QueryAsync<ErpPrice>("dbo.sp_SparkPOS_GetPrices",
                    commandType: CommandType.StoredProcedure, commandTimeout: ErpTimeoutSeconds)).ToList();
                // Price1..4 are mirrored only when the ERP's list has the columns: an older proc
                // without them must not clear the levels already here.
                levelsSent = await ec.ExecuteScalarAsync<int>(
                    @"SELECT COUNT(*) FROM sys.dm_exec_describe_first_result_set(N'EXEC dbo.sp_SparkPOS_GetPrices', NULL, 0)
                      WHERE name IN ('Price1', 'Price2', 'Price3', 'Price4')", commandTimeout: ErpTimeoutSeconds) == 4;
            }
            catch (SqlException ex) when (ex.Number is 2812 or 229)   // not deployed yet / no EXECUTE grant
            {
                // Until the ERP has its all-branches price procedure, head office's price from the
                // product list (if the ERP fills it) is the only price there is.
                prices = prods.Where(p => p.Price != null)
                    .Select(p => new ErpPrice { BranchCode = erp.ProductBranch, ErpProductCode = p.ErpProductCode, SellingPrice = p.Price })
                    .ToList();
                notes.Add(prices.Count > 0
                    ? $"Branch prices aren't available from the ERP yet (sp_SparkPOS_GetPrices). Head office ({erp.ProductBranch}) prices were applied to every branch."
                    : "The ERP isn't sending prices yet, so prices were left as they are.");
            }
        }
        catch (SqlException ex)
        {
            throw new ErpUnavailableException($"Couldn't read from the ERP: {ex.Message}", ex);
        }

        var catTvp = new DataTable();
        catTvp.Columns.Add("ErpCategoryId", typeof(int));
        catTvp.Columns.Add("CategoryName", typeof(string));
        foreach (var c in cats) catTvp.Rows.Add((object?)c.ErpCategoryId ?? DBNull.Value, (object?)c.CategoryName ?? DBNull.Value);

        var prodTvp = new DataTable();
        prodTvp.Columns.Add("ErpProductCode", typeof(string));
        prodTvp.Columns.Add("Barcode", typeof(string));
        prodTvp.Columns.Add("ProductName", typeof(string));
        prodTvp.Columns.Add("ErpCategoryId", typeof(int));
        prodTvp.Columns.Add("Unit", typeof(string));
        prodTvp.Columns.Add("IsVatable", typeof(bool));
        prodTvp.Columns.Add("IsDiscountable", typeof(bool));
        prodTvp.Columns.Add("Cost", typeof(decimal));
        prodTvp.Columns.Add("IsActive", typeof(bool));
        foreach (var p in prods)
            prodTvp.Rows.Add((object?)p.ErpProductCode ?? DBNull.Value, (object?)p.Barcode ?? DBNull.Value,
                (object?)p.ProductName ?? DBNull.Value, (object?)p.ErpCategoryId ?? DBNull.Value,
                (object?)p.Unit ?? DBNull.Value, (object?)p.IsVatable ?? DBNull.Value,
                (object?)p.IsDiscountable ?? DBNull.Value, (object?)p.Cost ?? DBNull.Value,
                (object?)p.IsActive ?? DBNull.Value);

        var brTvp = new DataTable();
        brTvp.Columns.Add("BranchCode", typeof(string));
        brTvp.Columns.Add("BranchName", typeof(string));
        brTvp.Columns.Add("Address", typeof(string));
        foreach (var b in branches)
            brTvp.Rows.Add((object?)b.BranchCode ?? DBNull.Value, (object?)b.BranchName ?? DBNull.Value,
                (object?)b.Address ?? DBNull.Value);

        var priceTvp = new DataTable();
        priceTvp.Columns.Add("BranchCode", typeof(string));
        priceTvp.Columns.Add("ErpProductCode", typeof(string));
        priceTvp.Columns.Add("Price", typeof(decimal));
        foreach (var p in prices)
            priceTvp.Rows.Add((object?)p.BranchCode ?? DBNull.Value, (object?)p.ErpProductCode ?? DBNull.Value,
                (object?)p.SellingPrice ?? DBNull.Value);

        using var con = db.Open();
        var prm = new DynamicParameters(new
        {
            Categories = catTvp.AsTableValuedParameter("dbo.TVP_ErpCategory"),
            Products = prodTvp.AsTableValuedParameter("dbo.TVP_ErpProduct"),
            Branches = brTvp.AsTableValuedParameter("dbo.TVP_ErpBranch"),
            Prices = priceTvp.AsTableValuedParameter("dbo.TVP_ErpPrice"),
            PriceBranch = erp.ProductBranch
        });
        // Price1..4 (31_price_levels.sql) in their own list: only when the ERP sent them and this
        // database has migration 31.
        if (levelsSent && await con.ExecuteScalarAsync<int>("SELECT CASE WHEN TYPE_ID('dbo.TVP_ErpPriceLevel') IS NULL THEN 0 ELSE 1 END") == 1)
        {
            var levelTvp = new DataTable();
            levelTvp.Columns.Add("BranchCode", typeof(string));
            levelTvp.Columns.Add("ErpProductCode", typeof(string));
            foreach (var n in new[] { "Price1", "Price2", "Price3", "Price4" }) levelTvp.Columns.Add(n, typeof(decimal));
            foreach (var p in prices)
                levelTvp.Rows.Add((object?)p.BranchCode ?? DBNull.Value, (object?)p.ErpProductCode ?? DBNull.Value,
                    (object?)p.Price1 ?? DBNull.Value, (object?)p.Price2 ?? DBNull.Value,
                    (object?)p.Price3 ?? DBNull.Value, (object?)p.Price4 ?? DBNull.Value);
            prm.Add("PriceLevels", levelTvp.AsTableValuedParameter("dbo.TVP_ErpPriceLevel"));
            prm.Add("LevelsSent", true);
        }
        dynamic summary; List<dynamic> issues;
        using (var multi = await con.QueryMultipleAsync("dbo.sp_ErpSyncMasterData", prm,
            commandType: CommandType.StoredProcedure, commandTimeout: ApplyTimeoutSeconds))
        {
            summary = await multi.ReadSingleAsync();
            issues = (await multi.ReadAsync()).ToList();
        }

        // Users last: their branches must exist first. A failed or missing users call changes
        // nobody (sp_ErpSyncUsers also refuses to deactivate on an empty or partial list).
        dynamic? userSummary = null;
        try
        {
            List<ErpUser> users;
            using (var ec = erp.Open())
                users = (await ec.QueryAsync<ErpUser>("dbo.sp_SparkPOS_GetUsers",
                    commandType: CommandType.StoredProcedure, commandTimeout: ErpTimeoutSeconds)).ToList();
            var (us, ui) = await ApplyUsersAsync(con, users, fullPull: true);
            userSummary = us; issues.AddRange(ui);
        }
        catch (SqlException ex) when (ex.Number is 2812 or 229)
        {
            notes.Add("Users aren't available from the ERP yet (sp_SparkPOS_GetUsers), so users were left as they are.");
        }
        catch (SqlException ex) when (ex.Number is not (>= 50000 and < 60000))
        {
            notes.Add($"Couldn't read users from the ERP ({ex.Message}). Users were left as they are.");
        }

        var detail =
            $"{(userId == null ? "Automatic sync" : "From ERP")} ({cats.Count} categories, {prods.Count} products, " +
            $"{branches.Count} branches, {prices.Count} prices): " +
            $"products +{summary.ProductsAdded} / {summary.ProductsUpdated} updated / {summary.ProductsLinked} linked / " +
            $"{summary.ProductsDeactivated} deactivated; categories +{summary.CategoriesAdded} / " +
            $"{summary.CategoriesUpdated} updated / {summary.CategoriesLinked} linked / {summary.CategoriesDeactivated} deactivated; " +
            $"branches +{summary.BranchesAdded} / {summary.BranchesUpdated} updated; " +
            $"prices: {summary.BasePricesUpdated} base / {summary.BranchPricesChanged} branch changed; " +
            $"{issues.Count} issues; {summary.ProductsNeedPrice} without a price" +
            (userSummary == null ? "" : $"; users +{userSummary.UsersAdded} / {userSummary.UsersUpdated} updated / " +
                $"{userSummary.UsersDeactivated} deactivated / {userSummary.UsersKeptForSafety} kept for safety");
        await con.ExecuteAsync(
            "INSERT INTO dbo.AuditLogs (BranchCode, UserId, Action, Detail) VALUES (NULL, @u, 'ERP_SYNC', @d)",
            new { u = userId, d = detail });
        log.LogInformation("ERP sync: {Detail}", detail);

        return new Result(
            new { categories = cats.Count, products = prods.Count, branches = branches.Count, prices = prices.Count },
            summary, issues, notes, userSummary);
    }

    private static async Task<(dynamic summary, List<dynamic> issues)> ApplyUsersAsync(
        IDbConnection con, List<ErpUser> users, bool fullPull)
    {
        var t = new DataTable();
        t.Columns.Add("UserID", typeof(string));
        t.Columns.Add("FullName", typeof(string));
        t.Columns.Add("AssignedBranch", typeof(string));
        t.Columns.Add("Role", typeof(string));
        t.Columns.Add("MustChangePassword", typeof(bool));
        t.Columns.Add("PasswordHash", typeof(byte[]));
        t.Columns.Add("PasswordSalt", typeof(byte[]));
        t.Columns.Add("PasswordIterations", typeof(int));
        t.Columns.Add("PasswordAlgoVersion", typeof(byte));
        foreach (var u in users)
            t.Rows.Add((object?)u.UserID ?? DBNull.Value, (object?)u.FullName ?? DBNull.Value,
                (object?)u.AssignedBranch ?? DBNull.Value, (object?)u.Role ?? DBNull.Value,
                (object?)u.MustChangePassword ?? DBNull.Value, (object?)u.PasswordHash ?? DBNull.Value,
                (object?)u.PasswordSalt ?? DBNull.Value, (object?)u.PasswordIterations ?? DBNull.Value,
                (object?)u.PasswordAlgoVersion ?? DBNull.Value);
        using var multi = await con.QueryMultipleAsync("dbo.sp_ErpSyncUsers",
            new { Users = t.AsTableValuedParameter("dbo.TVP_ErpUser"), FullPull = fullPull },
            commandType: CommandType.StoredProcedure, commandTimeout: ErpTimeoutSeconds);
        var summary = await multi.ReadSingleAsync();
        var issues = (await multi.ReadAsync()).ToList();
        return (summary, issues);
    }

    /// At login: re-reads this one user from the ERP (a password changed there works at once)
    /// and updates SparkPOS's copy. A short timeout, because the till is waiting; if the ERP
    /// can't be reached, login carries on with the copy SparkPOS already has. Never deactivates
    /// anyone (NotInErp just tells the caller to refuse this login).
    public async Task<RefreshResult> RefreshUserAsync(string username)
    {
        if (!erp.IsConfigured) return RefreshResult.NotConfigured;
        List<ErpUser> users;
        try
        {
            using var ec = erp.Open();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(6));
            users = (await ec.QueryAsync<ErpUser>(new CommandDefinition("dbo.sp_SparkPOS_GetUsers",
                new { UserID = username.Trim() }, commandType: CommandType.StoredProcedure,
                commandTimeout: 6, cancellationToken: cts.Token))).ToList();
        }
        catch (Exception ex) when (ex is SqlException or OperationCanceledException or InvalidOperationException)
        {
            log.LogWarning("ERP unreachable for login refresh of {User}: {Message}", username, ex.Message);
            return RefreshResult.Unreachable;
        }
        if (users.Count == 0) return RefreshResult.NotInErp;
        using var con = db.Open();
        await ApplyUsersAsync(con, users, fullPull: false);
        return RefreshResult.Updated;
    }
}

/// Runs the ERP sync on a timer (Erp:AutoSyncMinutes, default 30; 0 turns it off) so
/// head office's price and product changes reach SparkPOS without anyone pressing the
/// button. Terminals pick them up at their next Cash Begin, as with any price change.
public class ErpAutoSync(IServiceProvider services, ErpDb erp, ILogger<ErpAutoSync> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        var minutes = erp.AutoSyncMinutes;
        if (minutes <= 0 || !erp.IsConfigured) return;

        await Task.Delay(TimeSpan.FromMinutes(1), stop);   // let the API finish starting
        while (!stop.IsCancellationRequested)
        {
            try
            {
                using var scope = services.CreateScope();
                await scope.ServiceProvider.GetRequiredService<ErpSyncService>().RunAsync(null);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Automatic ERP sync failed; will retry in {Minutes} minutes", minutes);
            }
            await Task.Delay(TimeSpan.FromMinutes(minutes), stop);
        }
    }
}
