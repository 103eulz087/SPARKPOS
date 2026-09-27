using Dapper;
using Microsoft.AspNetCore.Mvc;
using PosApi.Services;

namespace PosApi.Controllers;

/// PrintAgent's poll endpoint — deliberately NOT [Authorize] (JWT), since a PrintAgent
/// process has no cashier/admin session to log in with. The `key` query param IS the
/// credential here: it's an agent's own PrintAgentKey (Terminals.PrintAgentKey /
/// PrintAreas.PrintAgentKey), a much lower-blast-radius secret than a user JWT — knowing it
/// only lets you see print jobs already queued for that one agent, nothing else.
[ApiController]
[Route("api/print-jobs")]
public class PrintJobsController(Db db) : ControllerBase
{
    /// Atomically claims the oldest pending job for this key, if any. Marking it Delivered
    /// the moment it's handed to the agent (rather than waiting for a separate ack) matches
    /// how RawBT printing already works elsewhere in this app — there's no channel to confirm
    /// paper actually came out, only that the handoff happened.
    [HttpGet("poll")]
    public async Task<IActionResult> Poll([FromQuery] string? key)
    {
        using var con = db.Open();
        // TOP alone has no defined order for UPDATE — go through a CTE ordered by
        // PrintJobId so "oldest pending" is actually deterministic, not just "some row".
        var job = await con.QuerySingleOrDefaultAsync(
            @";WITH oldest AS (
                  SELECT TOP (1) * FROM dbo.PrintJobs
                  WHERE AgentKey = @key AND Status = 'Pending'
                  ORDER BY PrintJobId
              )
              UPDATE oldest SET Status = 'Delivered', DeliveredAt = SYSDATETIME()
              OUTPUT INSERTED.PrintJobId, INSERTED.PrinterTarget, INSERTED.JobText;",
            new { key = key ?? "" });
        return job == null ? NoContent() : Ok(job);
    }
}
