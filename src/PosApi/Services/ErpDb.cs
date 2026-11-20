using System.Data;
using Microsoft.Data.SqlClient;

namespace PosApi.Services;

/// Connection to the CORECS ERP's own SQL Server (ConnectionStrings:Erp). Its login is
/// EXECUTE-only on the dbo.sp_SparkPOS_* procedures, so everything here is a stored
/// procedure call — no table reads. Blank connection string = ERP integration is off.
public class ErpDb(IConfiguration cfg)
{
    private readonly string? _cs = cfg.GetConnectionString("Erp");

    /// ERP branch whose product list is the master copy (head office). The ERP returns
    /// the same list for every branch today, and head office's for an unknown one.
    public string ProductBranch { get; } = cfg["Erp:ProductBranch"] is { Length: > 0 } b ? b : "888";

    /// How often ErpAutoSync pulls products and prices; 0 = only the Admin button.
    public int AutoSyncMinutes { get; } = cfg.GetValue("Erp:AutoSyncMinutes", 30);

    // appsettings.Development.json ships with a <SET_PASSWORD_HERE> placeholder — not set up yet.
    public bool IsConfigured => !string.IsNullOrWhiteSpace(_cs) && !_cs.Contains("<SET_PASSWORD");

    public IDbConnection Open() => IsConfigured
        ? new SqlConnection(_cs)
        : throw new InvalidOperationException("The ERP connection isn't configured (ConnectionStrings:Erp).");
}
