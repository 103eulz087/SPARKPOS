using System.Net;
using System.Net.Mail;
using System.Net.Mime;
using System.Text;
using Dapper;

namespace PosApi.Services;

/// E-invoice copies: sends dbo.InvoiceEmails (queued by dbo.sp_QueueInvoiceEmail when a sale or
/// return is saved, or by "Email a copy" from Reprint). Each email carries the invoice exactly as
/// printed (Sales.ReceiptText / SaleReturns.ReceiptText) in the body and as a .txt attachment.
/// A sale made offline is emailed once it syncs. Failures retry with backoff, then stay Failed
/// (Admin → Email shows them, with a Retry button).
public class InvoiceEmailService(Db db, ILogger<InvoiceEmailService> log)
{
    private const int MaxAttempts = 10;
    private const int BatchSize = 25;   // per round, to stay inside SMTP providers' rate limits
    private static readonly int[] BackoffMinutes = [1, 2, 5, 10, 30, 60, 120, 240, 480];

    public static bool LooksLikeEmail(string s)
    {
        s = s.Trim();
        var at = s.IndexOf('@');
        return s.Length is > 5 and <= 254 && at > 0 && at == s.LastIndexOf('@') && !s.Contains(' ')
               && s.IndexOf('.', at) > at + 1 && !s.EndsWith('.');
    }

    public async Task<int> RunOnceAsync(CancellationToken stop = default)
    {
        using var con = db.Open();
        var due = (await con.QueryAsync(
            @"SELECT TOP (@n) * FROM dbo.InvoiceEmails
              WHERE Status = 'Pending' AND NextAttemptAt <= SYSDATETIME() ORDER BY InvoiceEmailId",
            new { n = BatchSize })).ToList();
        foreach (var e in due)
        {
            if (stop.IsCancellationRequested) break;
            long id = e.InvoiceEmailId;
            try
            {
                await SendOneAsync(con, e);
                await con.ExecuteAsync(
                    "UPDATE dbo.InvoiceEmails SET Status = 'Sent', SentAt = SYSDATETIME(), Attempts = Attempts + 1, LastError = NULL WHERE InvoiceEmailId = @id",
                    new { id });
            }
            catch (Exception ex)
            {
                int attempts = (int)e.Attempts + 1;
                // a refused address or nothing to send won't get better by waiting
                var final = attempts >= MaxAttempts || ex is SmtpFailedRecipientException or InvalidOperationException;
                var wait = BackoffMinutes[Math.Min(attempts - 1, BackoffMinutes.Length - 1)];
                await con.ExecuteAsync(
                    @"UPDATE dbo.InvoiceEmails SET Attempts = @attempts, LastError = @err,
                        Status = CASE WHEN @final = 1 THEN 'Failed' ELSE 'Pending' END,
                        NextAttemptAt = DATEADD(MINUTE, @wait, SYSDATETIME())
                      WHERE InvoiceEmailId = @id",
                    new { id, attempts, err = Trim(ex.Message, 400), final, wait });
                log.LogWarning("E-invoice email {id} to {to} failed (try {n}): {m}", id, (string)e.ToAddress, attempts, ex.Message);
            }
        }
        return due.Count;
    }

    private static async Task SendOneAsync(System.Data.IDbConnection con, dynamic e)
    {
        var cfg = await con.QuerySingleOrDefaultAsync(
            @"SELECT TOP 1 * FROM dbo.EmailConfig WHERE IsActive = 1 AND (BranchCode = @b OR BranchCode IS NULL)
              ORDER BY CASE WHEN BranchCode IS NULL THEN 1 ELSE 0 END", new { b = (string)e.BranchCode })
            ?? throw new InvalidOperationException("Email isn't set up or is turned off (Admin → Email).");

        string kind = e.Kind, text, docNo, subject, intro;
        string? branchName, terminal;
        if (kind == "SALE")
        {
            var s = await con.QuerySingleOrDefaultAsync(
                @"SELECT s.ORNumber, s.ReceiptText, s.CustomerName, b.BranchName, t.TerminalCode
                  FROM dbo.Sales s JOIN dbo.Branches b ON b.BranchCode = s.BranchCode
                  JOIN dbo.Terminals t ON t.TerminalId = s.TerminalId WHERE s.SaleUid = @u", new { u = (Guid)e.RefUid })
                ?? throw new InvalidOperationException("The sale is no longer there.");
            text = (string?)s.ReceiptText ?? throw new InvalidOperationException("This invoice has no stored copy to send.");
            docNo = ReceiptBuilder.Si(s.ORNumber);
            branchName = s.BranchName; terminal = s.TerminalCode;
            subject = $"Sales Invoice {docNo}";
            intro = "Here is an electronic copy of your sales invoice.";
        }
        else
        {
            var r = await con.QuerySingleOrDefaultAsync(
                @"SELECT r.ReturnNo, r.ReceiptText, os.ORNumber, b.BranchName, t.TerminalCode
                  FROM dbo.SaleReturns r JOIN dbo.Sales os ON os.SaleUid = r.OrigSaleUid
                  JOIN dbo.Branches b ON b.BranchCode = r.BranchCode
                  JOIN dbo.Terminals t ON t.TerminalId = r.TerminalId WHERE r.ReturnUid = @u", new { u = (Guid)e.RefUid })
                ?? throw new InvalidOperationException("The return is no longer there.");
            text = (string?)r.ReceiptText ?? throw new InvalidOperationException("This return has no stored copy to send.");
            docNo = ReceiptBuilder.Rtn(r.ReturnNo);
            branchName = r.BranchName; terminal = r.TerminalCode;
            subject = $"Return {docNo} (Ref SI {ReceiptBuilder.Si(r.ORNumber)})";
            intro = "Here is an electronic copy of your return receipt.";
        }
        bool repository = e.ToRepository;
        subject = repository
            ? $"[{(string)e.BranchCode} {terminal}] {subject}"     // easy to search in the shared mailbox
            : $"{subject} — {branchName}";
        if (repository) intro = "The customer gave no email address; this copy is kept for the store's records.";

        var html = new StringBuilder()
            .Append("<div style=\"font-family:Arial,Helvetica,sans-serif;color:#1e293b;font-size:14px\">")
            .Append($"<p>{WebUtility.HtmlEncode(intro)}</p>")
            .Append("<pre style=\"font-family:Consolas,'Courier New',monospace;font-size:13px;line-height:1.45;")
            .Append("background:#ffffff;border:1px solid #cbd5e1;padding:16px;display:inline-block;margin:8px 0\">")
            .Append(WebUtility.HtmlEncode(text))
            .Append("</pre>")
            .Append($"<p style=\"color:#64748b;font-size:12px\">{WebUtility.HtmlEncode(branchName ?? "")} · sent by SparkPOS. ")
            .Append("The same copy is attached as a text file. Please keep it for your records.</p></div>")
            .ToString();

        using var client = new SmtpClient((string)cfg.SmtpHost, (int)cfg.SmtpPort)
        {
            EnableSsl = (bool)cfg.EnableSsl,
            Credentials = new NetworkCredential((string)cfg.SmtpUser, (string)cfg.SmtpPassword)
        };
        using var msg = new MailMessage { From = new MailAddress((string)cfg.FromAddress), Subject = subject };
        msg.To.Add((string)e.ToAddress);
        msg.AlternateViews.Add(AlternateView.CreateAlternateViewFromString($"{intro}\n\n{text}", Encoding.UTF8, MediaTypeNames.Text.Plain));
        msg.AlternateViews.Add(AlternateView.CreateAlternateViewFromString(html, Encoding.UTF8, MediaTypeNames.Text.Html));
        using var file = new MemoryStream(Encoding.UTF8.GetBytes(text));
        msg.Attachments.Add(new Attachment(file, $"{(kind == "SALE" ? "SI" : "RETURN")}-{docNo}.txt", MediaTypeNames.Text.Plain));
        await client.SendMailAsync(msg);
    }

    private static string Trim(string s, int n) => s.Length <= n ? s : s[..n];
}

/// Runs InvoiceEmailService every Email:InvoiceIntervalSeconds (default 30; 0 = off).
public class InvoiceEmailWorker(InvoiceEmailService svc, IConfiguration cfg, ILogger<InvoiceEmailWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        var seconds = cfg.GetValue("Email:InvoiceIntervalSeconds", 30);
        if (seconds <= 0) return;
        await Task.Delay(TimeSpan.FromSeconds(15), stop);
        while (!stop.IsCancellationRequested)
        {
            try { await svc.RunOnceAsync(stop); }
            catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "E-invoice email round failed"); }
            await Task.Delay(TimeSpan.FromSeconds(seconds), stop);
        }
    }
}
