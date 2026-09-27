using System.Data;
using Microsoft.Data.SqlClient;

namespace PosApi.Services;

public class Db(IConfiguration cfg)
{
    private readonly string _cs = cfg.GetConnectionString("Default")!;
    public IDbConnection Open() => new SqlConnection(_cs);
}
