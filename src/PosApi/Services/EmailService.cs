using System.Net;
using System.Net.Mail;
using Dapper;

namespace PosApi.Services;

public class EmailService(Db db, ILogger<EmailService> logger)
{
    /// Sends the Z-Read to configured recipients. Never throws — EOD must not
    /// fail because SMTP is down; the failure is logged and audited instead.
    public async Task<bool> SendZReadAsync(string branchCode, string subject, string body)
    {
        try
        {
            using var con = db.Open();
            var cfg = await con.QuerySingleOrDefaultAsync<dynamic>(
                @"SELECT TOP 1 * FROM dbo.EmailConfig
                  WHERE IsActive = 1 AND SendOnEod = 1 AND (BranchCode = @b OR BranchCode IS NULL)
                  ORDER BY CASE WHEN BranchCode IS NULL THEN 1 ELSE 0 END",
                new { b = branchCode });
            if (cfg == null) return false;

            using var client = new SmtpClient((string)cfg.SmtpHost, (int)cfg.SmtpPort)
            {
                EnableSsl = (bool)cfg.EnableSsl,
                Credentials = new NetworkCredential((string)cfg.SmtpUser, (string)cfg.SmtpPassword)
            };
            var msg = new MailMessage
            { From = new MailAddress((string)cfg.FromAddress), Subject = subject, Body = body, IsBodyHtml = true };
            foreach (var to in ((string)cfg.ToAddresses).Split(',', StringSplitOptions.RemoveEmptyEntries))
                msg.To.Add(to.Trim());

            await client.SendMailAsync(msg);
            return true;
        }
        catch (Exception ex)
        {
            logger.LogWarning("Z-Read email failed for {b}: {m}", branchCode, ex.Message);
            return false;
        }
    }

    /// Generic report email (currently: Blind Close shift report) — gated by the caller via
    /// PosSettings.EmailOnBlindClose rather than SendOnEod, which is specifically for the
    /// automatic Z-Read delivery. Only requires the config to be active.
    public async Task<bool> SendReportAsync(string branchCode, string subject, string body)
    {
        try
        {
            using var con = db.Open();
            var cfg = await con.QuerySingleOrDefaultAsync<dynamic>(
                @"SELECT TOP 1 * FROM dbo.EmailConfig
                  WHERE IsActive = 1 AND (BranchCode = @b OR BranchCode IS NULL)
                  ORDER BY CASE WHEN BranchCode IS NULL THEN 1 ELSE 0 END",
                new { b = branchCode });
            if (cfg == null) return false;

            using var client = new SmtpClient((string)cfg.SmtpHost, (int)cfg.SmtpPort)
            {
                EnableSsl = (bool)cfg.EnableSsl,
                Credentials = new NetworkCredential((string)cfg.SmtpUser, (string)cfg.SmtpPassword)
            };
            var msg = new MailMessage
            { From = new MailAddress((string)cfg.FromAddress), Subject = subject, Body = body, IsBodyHtml = true };
            foreach (var to in ((string)cfg.ToAddresses).Split(',', StringSplitOptions.RemoveEmptyEntries))
                msg.To.Add(to.Trim());

            await client.SendMailAsync(msg);
            return true;
        }
        catch (Exception ex)
        {
            logger.LogWarning("Report email failed for {b}: {m}", branchCode, ex.Message);
            return false;
        }
    }

    /// Sends a one-off test using the saved global config, regardless of SendOnEod/IsActive.
    /// Unlike SendZReadAsync, this surfaces the real error so an admin can debug SMTP setup.
    public async Task<(bool Sent, string? Error)> SendTestAsync()
    {
        using var con = db.Open();
        var cfg = await con.QuerySingleOrDefaultAsync<dynamic>(
            "SELECT TOP 1 * FROM dbo.EmailConfig WHERE BranchCode IS NULL");
        if (cfg == null) return (false, "No email configuration saved yet.");

        try
        {
            using var client = new SmtpClient((string)cfg.SmtpHost, (int)cfg.SmtpPort)
            {
                EnableSsl = (bool)cfg.EnableSsl,
                Credentials = new NetworkCredential((string)cfg.SmtpUser, (string)cfg.SmtpPassword)
            };
            var msg = new MailMessage
            {
                From = new MailAddress((string)cfg.FromAddress),
                Subject = "SparkPOS test email",
                Body = "This is a test email from SparkPOS. If you received this, your SMTP settings are working."
            };
            foreach (var to in ((string)cfg.ToAddresses).Split(',', StringSplitOptions.RemoveEmptyEntries))
                msg.To.Add(to.Trim());

            await client.SendMailAsync(msg);
            return (true, null);
        }
        catch (Exception ex)
        {
            logger.LogWarning("Test email failed: {m}", ex.Message);
            return (false, ex.Message);
        }
    }
}
