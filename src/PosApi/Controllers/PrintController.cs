using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PosApi.Services;

namespace PosApi.Controllers;

/// Server-side relay to the print agent. The browser tries localhost:5099 first;
/// this is the fallback when that direct attempt fails — queues under the shared default
/// agent key, since this call has no terminal/branch context to route by a specific key.
[ApiController]
[Route("api/print")]
[Authorize]
public class PrintController(Db db, PrintService printer) : ApiControllerBase(db)
{
    public record PrintRequest(string Text, string? Target);

    [HttpPost]
    public async Task<IActionResult> Print(PrintRequest req)
    {
        using var con = Db.Open();
        await printer.EnqueueAsync(con, req.Text, req.Target, null);
        return Ok(new { printed = true });
    }
}
