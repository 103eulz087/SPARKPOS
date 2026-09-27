using System.Data;
using Dapper;

namespace PosApi.Services;

/// Queues rendered receipt text for a PrintAgent to pick up — server-initiated printing
/// (Test Print, X-Read, Z-Read, Blind Close, Send to Kitchen) is what keeps those figures out
/// of the browser. Agents POLL for pending jobs (see PrintJobsController) rather than being
/// called into directly, so no terminal or print area ever needs router port-forwarding or a
/// public IP, regardless of where it physically sits relative to the API server.
public class PrintService
{
    public async Task EnqueueAsync(IDbConnection con, string text, string? printerTarget, string? agentKey)
    {
        await con.ExecuteAsync(
            "INSERT INTO dbo.PrintJobs (AgentKey, PrinterTarget, JobText) VALUES (@key, @printerTarget, @text)",
            new { key = agentKey ?? "", printerTarget, text });
    }
}
