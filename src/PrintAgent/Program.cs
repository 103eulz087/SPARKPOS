using System.Net.Http.Json;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;

// ============================================================
//  TabletPOS Hardware Print Agent
//
//  Runs on the machine physically attached to the receipt printer. Two independent
//  jobs, both needed:
//   1. Hosts http://localhost:5099/print — the SAME-MACHINE browser calls this
//      directly for its own prints (sale receipts, dine-in kitchen slips). Loopback
//      only; nothing outside this machine ever needs to reach in.
//   2. POLLS the SparkPOS API (ApiServerUrl in appsettings.json, or PRINTAGENT_
//      APISERVERURL env var) for jobs the SERVER queued — Test Print, X-Read,
//      Z-Read, Blind Close, Send to Kitchen. This is a purely OUTBOUND connection,
//      so it needs zero router/firewall configuration no matter where this machine
//      sits relative to the server — a world of difference from the earlier design,
//      which had the server calling INTO this agent and therefore needed the agent
//      exposed (port-forwarded) to be reachable at all.
//
//  Either path ends up forwarding ESC/POS bytes to:
//     tcp://192.168.1.50:9100   network thermal printer
//     file://COM3               Windows serial/USB exposing a (virtual) COM port
//     file:///dev/usb/lp0       Linux USB
//     spool://XP-80C            Windows-installed printer on ANY port (USB001,
//                               LPT1, a share, etc.) via the print spooler's RAW
//                               data type — bypasses the driver's own rendering
//                               entirely, so raw ESC/POS bytes reach the printer
//                               unmodified. Use this when a printer only exposes
//                               a normal Windows print queue with no virtual-COM
//                               driver mode (Get-Printer shows its exact name).
// ============================================================

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://localhost:5099");
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();
app.UseCors();

// ApiServerUrl: the SparkPOS API's base URL (e.g. https://your-server.example or
// http://localhost:5000 for local dev). ApiKey: this agent's own identity when
// polling — must match a Terminals.PrintAgentKey / PrintAreas.PrintAgentKey value
// in Admin. Both blank = polling disabled (this agent only serves same-machine
// browser prints); ApiKey blank with ApiServerUrl set = the shared default agent.
var apiServerUrl = app.Configuration["ApiServerUrl"]?.TrimEnd('/');
var apiKey = app.Configuration["ApiKey"] ?? "";

app.MapGet("/health", () => Results.Ok(new
{
    status = "ok",
    agent = "TabletPOS PrintAgent 2.0",
    os = Environment.OSVersion.ToString(),
    polling = !string.IsNullOrEmpty(apiServerUrl)
}));

app.MapPost("/print", async (PrintJob job, ILogger<Program> log) =>
{
    var (ok, message) = await Dispatch.PrintAsync(job.Target, job.Text, log);
    return ok ? Results.Ok(new { printed = true, job.Target }) : Results.Problem(message);
});

if (!string.IsNullOrWhiteSpace(apiServerUrl))
{
    var pollLogger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Poller");
    _ = PollLoopAsync(apiServerUrl, apiKey, pollLogger);
}

app.Run();

static async Task PollLoopAsync(string apiServerUrl, string apiKey, ILogger log)
{
    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
    log.LogInformation("Polling {url} for print jobs (key: {key})", apiServerUrl, string.IsNullOrEmpty(apiKey) ? "<default>" : apiKey);
    while (true)
    {
        try
        {
            var res = await http.GetAsync($"{apiServerUrl}/api/print-jobs/poll?key={Uri.EscapeDataString(apiKey)}");
            if (res.StatusCode == System.Net.HttpStatusCode.OK)
            {
                var job = await res.Content.ReadFromJsonAsync<PolledJob>();
                if (job != null) await Dispatch.PrintAsync(job.PrinterTarget, job.JobText, log);
            }
        }
        catch (Exception ex)
        {
            log.LogWarning("Poll failed: {m}", ex.Message);
        }
        await Task.Delay(TimeSpan.FromSeconds(3));
    }
}

record PrintJob(string Text, string? Target);
record PolledJob(long PrintJobId, string? PrinterTarget, string JobText);

/// The actual ESC/POS dispatch, shared by the inbound /print handler and the poll loop —
/// same target schemes regardless of which path a job arrived through.
static class Dispatch
{
    public static async Task<(bool Ok, string Message)> PrintAsync(string? target, string text, ILogger log)
    {
        var resolvedTarget = string.IsNullOrWhiteSpace(target) ? "tcp://127.0.0.1:9100" : target;
        var bytes = BuildEscPos(text);

        try
        {
            if (resolvedTarget.StartsWith("tcp://", StringComparison.OrdinalIgnoreCase))
            {
                var uri = new Uri(resolvedTarget);
                using var tcp = new TcpClient();
                await tcp.ConnectAsync(uri.Host, uri.Port > 0 ? uri.Port : 9100);
                await tcp.GetStream().WriteAsync(bytes);
            }
            else if (resolvedTarget.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
            {
                var path = resolvedTarget["file://".Length..];
                await File.WriteAllBytesAsync(path, bytes);
            }
            else if (resolvedTarget.StartsWith("spool://", StringComparison.OrdinalIgnoreCase))
            {
                var printerName = resolvedTarget["spool://".Length..];
                RawPrinter.Print(printerName, bytes);
            }
            else if (resolvedTarget.Equals("console", StringComparison.OrdinalIgnoreCase))
            {
                // Development mode: dump the receipt to the console instead of a printer.
                Console.WriteLine(new string('=', 44));
                Console.WriteLine(text);
                Console.WriteLine(new string('=', 44));
            }
            else
            {
                return (false, $"Unknown printer target: {resolvedTarget}");
            }

            log.LogInformation("Printed {bytes} bytes to {target}", bytes.Length, resolvedTarget);
            return (true, "");
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Print failed to {target}", resolvedTarget);
            return (false, $"Print failed: {ex.Message}");
        }
    }

    static byte[] BuildEscPos(string text)
    {
        var ms = new MemoryStream();
        ms.Write([0x1B, 0x40]);                        // ESC @  initialise
        ms.Write(Encoding.ASCII.GetBytes(text));
        ms.Write([0x0A, 0x0A, 0x0A, 0x0A]);            // feed
        ms.Write([0x1D, 0x56, 0x42, 0x00]);            // GS V B  partial cut
        return ms.ToArray();
    }
}

/// Sends raw bytes straight to a Windows-installed printer via the print spooler's RAW
/// data type, bypassing the driver's own text/graphics rendering — this is what lets ESC/POS
/// commands reach a thermal printer unmodified even when it's only installed as a normal
/// print queue (e.g. on a virtual USB00x port) with no virtual-COM-port driver mode.
static class RawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DOCINFO
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string DocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? OutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string DataType;
    }

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool OpenPrinter(string printerName, out IntPtr hPrinter, IntPtr defaults);

    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern int StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFO docInfo);

    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool WritePrinter(IntPtr hPrinter, byte[] data, int count, out int written);

    public static void Print(string printerName, byte[] bytes)
    {
        if (!OpenPrinter(printerName, out var hPrinter, IntPtr.Zero))
            throw new InvalidOperationException(
                $"Could not open printer \"{printerName}\" (Win32 error {Marshal.GetLastWin32Error()}). " +
                "Check the exact name via Get-Printer.");
        try
        {
            var docInfo = new DOCINFO { DocName = "SparkPOS Receipt", DataType = "RAW" };
            if (StartDocPrinter(hPrinter, 1, ref docInfo) == 0)
                throw new InvalidOperationException($"StartDocPrinter failed (Win32 error {Marshal.GetLastWin32Error()}).");
            try
            {
                if (!StartPagePrinter(hPrinter))
                    throw new InvalidOperationException($"StartPagePrinter failed (Win32 error {Marshal.GetLastWin32Error()}).");
                try
                {
                    if (!WritePrinter(hPrinter, bytes, bytes.Length, out var written) || written != bytes.Length)
                        throw new InvalidOperationException($"WritePrinter failed (Win32 error {Marshal.GetLastWin32Error()}).");
                }
                finally { EndPagePrinter(hPrinter); }
            }
            finally { EndDocPrinter(hPrinter); }
        }
        finally { ClosePrinter(hPrinter); }
    }
}
