using System.Text;
using System.Text.Json;

namespace PosApi.Services;

/// Renders plain text for thermal printers — 32 columns at 58mm (the original handheld
/// default) or 48 columns at 80mm, per-terminal/per-print-area (see Terminals.PaperWidth,
/// PrintAreas.PaperWidth). Swap the layout here when the final BIR receipt format
/// arrives — nothing else changes.
public class ReceiptBuilder
{
    /// paperWidthMm: 58 or 80. Anything else falls back to 58mm's 32 columns.
    public static int Columns(int paperWidthMm) => paperWidthMm >= 80 ? 48 : 32;

    private static string C(int w, string s) => s.Length >= w ? s[..w] : new string(' ', (w - s.Length) / 2) + s;
    private static string LR(int w, string l, string r)
    {
        var gap = w - l.Length - r.Length;
        return gap > 0 ? l + new string(' ', gap) + r : (l + " " + r);
    }
    private static string Rule(int w) => new('-', w);
    private static string M(decimal d) => d.ToString("N2");

    public string BlindClose(dynamic v, int paperWidthMm = 58)
    {
        var w = Columns(paperWidthMm);
        string C(string s) => ReceiptBuilder.C(w, s);
        string LR(string l, string r) => ReceiptBuilder.LR(w, l, r);
        string Rule() => ReceiptBuilder.Rule(w);
        var sb = new StringBuilder();
        sb.AppendLine(C("*** BLIND CLOSE REPORT ***"));
        sb.AppendLine(C($"{v.BranchCode}/{v.TerminalCode}"));
        sb.AppendLine(C($"Cashier: {v.Cashier}"));
        sb.AppendLine(C(((DateTime)v.ClosedAt).ToString("yyyy-MM-dd HH:mm")));
        sb.AppendLine(Rule());
        sb.AppendLine("DENOMINATIONS DECLARED:");
        try
        {
            var denoms = JsonSerializer.Deserialize<Dictionary<string, int>>((string)v.DenominationsJson) ?? new();
            foreach (var d in denoms.Where(x => x.Value > 0).OrderByDescending(x => decimal.Parse(x.Key)))
                sb.AppendLine(LR($"  {d.Key} x {d.Value}", M(decimal.Parse(d.Key) * d.Value)));
        }
        catch { /* malformed json — skip the breakdown */ }
        sb.AppendLine(Rule());
        sb.AppendLine(LR("CASH BEGIN", M((decimal)v.CashBegin)));
        sb.AppendLine(LR("CASH SALES", M((decimal)v.CashSales)));
        sb.AppendLine(LR("CARD SALES (excluded)", M((decimal)v.CardSales)));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("DECLARED CASH", M((decimal)v.DeclaredCash)));
        sb.AppendLine(LR("EXPECTED CASH", M((decimal)v.ExpectedCash)));
        sb.AppendLine(LR("SHORT/(OVER)", M(-(decimal)v.ShortOver)));
        sb.AppendLine(Rule());
        sb.AppendLine(C("FOR SUPERVISOR VERIFICATION"));
        sb.AppendLine(C("Verified by: __________________"));
        sb.Append("\n\n\n");
        return sb.ToString();
    }

    public string XRead(dynamic x, int paperWidthMm = 58)
    {
        var w = Columns(paperWidthMm);
        string C(string s) => ReceiptBuilder.C(w, s);
        string LR(string l, string r) => ReceiptBuilder.LR(w, l, r);
        string Rule() => ReceiptBuilder.Rule(w);
        var sb = new StringBuilder();
        sb.AppendLine(C("*** X-READ ***"));
        sb.AppendLine(C((string)x.BranchName));
        sb.AppendLine(C($"{x.BranchCode}/{x.TerminalCode} - {x.Cashier}"));
        sb.AppendLine(C(DateTime.Now.ToString("yyyy-MM-dd HH:mm")));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("CASH BEGIN", M((decimal)x.CashBegin)));
        sb.AppendLine(LR("TXN COUNT", ((int)x.TxnCount).ToString()));
        sb.AppendLine(LR("VOID COUNT", ((int)x.VoidCount).ToString()));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("GROSS SALES", M((decimal)x.GrossSales)));
        sb.AppendLine(LR("TOTAL DISCOUNTS", M((decimal)x.TotalDiscounts)));
        sb.AppendLine(LR("NET SALES", M((decimal)x.NetSales)));
        sb.AppendLine(Rule());
        sb.AppendLine(C("DISCOUNT BREAKDOWN"));
        sb.AppendLine(LR("  SENIOR", M((decimal)x.DiscSenior)));
        sb.AppendLine(LR("  PWD", M((decimal)x.DiscPwd)));
        sb.AppendLine(LR("  NAAC", M((decimal)x.DiscNaac)));
        sb.AppendLine(LR("  MOV", M((decimal)x.DiscMov)));
        sb.AppendLine(LR("  SOLO PARENT", M((decimal)x.DiscSolo)));
        sb.AppendLine(Rule());
        sb.AppendLine(C("PAYMENT BREAKDOWN"));
        sb.AppendLine(LR("  CASH", M((decimal)x.CashSales)));
        sb.AppendLine(LR("  CARD", M((decimal)x.CardSales)));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("VATable Sales", M((decimal)x.VatableAmount)));
        sb.AppendLine(LR("VAT (12%)", M((decimal)x.VatAmount)));
        sb.AppendLine(LR("VAT-Exempt Sales", M((decimal)x.VatExemptAmount)));
        sb.AppendLine(LR("Zero-Rated Sales", M((decimal)x.ZeroRatedAmount)));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("OR RANGE", $"{x.BeginningOR}-{x.EndingOR}"));
        sb.AppendLine(C("X-READ DOES NOT LOCK THE DAY"));
        sb.Append("\n\n\n");
        return sb.ToString();
    }

    /// Kitchen/beverage ticket for one print area (Restaurant PosType's "Send to
    /// Kitchen") — deliberately no prices, kitchen/bar staff don't need them. `items`
    /// carries only the delta since the last send, not the whole order.
    public string KitchenTicket(string areaName, string tableNumber,
        IEnumerable<(string ProductName, decimal Quantity)> items, int paperWidthMm = 58)
    {
        var w = Columns(paperWidthMm);
        string C(string s) => ReceiptBuilder.C(w, s);
        string Rule() => ReceiptBuilder.Rule(w);
        var sb = new StringBuilder();
        sb.AppendLine(C($"*** {areaName.ToUpperInvariant()} ***"));
        sb.AppendLine(C($"TABLE {tableNumber}"));
        sb.AppendLine(C(DateTime.Now.ToString("yyyy-MM-dd HH:mm")));
        sb.AppendLine(Rule());
        foreach (var i in items)
            sb.AppendLine($"{i.Quantity:0.###} x {i.ProductName}");
        sb.AppendLine(Rule());
        sb.Append("\n\n\n");
        return sb.ToString();
    }

    public string ZRead(dynamic z, int paperWidthMm = 58)
    {
        var w = Columns(paperWidthMm);
        string C(string s) => ReceiptBuilder.C(w, s);
        string LR(string l, string r) => ReceiptBuilder.LR(w, l, r);
        string Rule() => ReceiptBuilder.Rule(w);
        var sb = new StringBuilder();
        sb.AppendLine(C((string)z.BranchName));
        sb.AppendLine(C("*** Z-READ / END OF DAY ***"));
        sb.AppendLine(C($"{z.BranchCode}/{z.TerminalCode} - Z# {z.ZCounter}"));
        sb.AppendLine(C(((DateTime)z.BusinessDate).ToString("yyyy-MM-dd")));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("BEGINNING OR", z.BeginningOR?.ToString() ?? "-"));
        sb.AppendLine(LR("ENDING OR", z.EndingOR?.ToString() ?? "-"));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("GROSS SALES", M((decimal)z.GrossSales)));
        sb.AppendLine(LR("TOTAL DISCOUNTS", M((decimal)z.TotalDiscounts)));
        sb.AppendLine(LR("NET SALES", M((decimal)z.NetSales)));
        sb.AppendLine(Rule());
        sb.AppendLine(C("DISCOUNT BREAKDOWN"));
        sb.AppendLine(LR("  SENIOR", M((decimal)z.DiscSenior)));
        sb.AppendLine(LR("  PWD", M((decimal)z.DiscPwd)));
        sb.AppendLine(LR("  NAAC", M((decimal)z.DiscNaac)));
        sb.AppendLine(LR("  MOV", M((decimal)z.DiscMov)));
        sb.AppendLine(LR("  SOLO PARENT", M((decimal)z.DiscSolo)));
        sb.AppendLine(Rule());
        sb.AppendLine(C("PAYMENT BREAKDOWN"));
        sb.AppendLine(LR("  CASH", M((decimal)z.CashSales)));
        sb.AppendLine(LR("  CARD", M((decimal)z.CardSales)));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("VATable Sales", M((decimal)z.VatableAmount)));
        sb.AppendLine(LR("VAT (12%)", M((decimal)z.VatAmount)));
        sb.AppendLine(LR("VAT-Exempt Sales", M((decimal)z.VatExemptAmount)));
        sb.AppendLine(LR("Zero-Rated Sales", M((decimal)z.ZeroRatedAmount)));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("TXN COUNT", ((int)z.TxnCount).ToString()));
        sb.AppendLine(LR("VOID COUNT", ((int)z.VoidCount).ToString()));
        sb.AppendLine(LR("VOID AMOUNT", M((decimal)z.VoidAmount)));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("OLD GRAND TOTAL", M((decimal)z.OldGrandTotal)));
        sb.AppendLine(LR("NEW GRAND TOTAL", M((decimal)z.NewGrandTotal)));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("Closed by", (string)z.ClosedByName));
        sb.AppendLine(LR("Authorized by", (string)z.ApprovedByName));
        sb.AppendLine(Rule());
        sb.AppendLine(C("DAY LOCKED - TERMINAL CLOSED"));
        sb.Append("\n\n\n");
        return sb.ToString();
    }

    public string ZReadEmailBody(dynamic z) => ZRead(z);

    /* ================= HTML email reports (real tables) =================
       Separate from the plain-text methods above, which stay 32-column for the
       thermal printer. Email has no such constraint, so these render as proper
       HTML tables — inline styles throughout, since email clients (Outlook,
       Gmail) don't reliably support <style> blocks or external CSS. */

    private static string H(object? o) => System.Net.WebUtility.HtmlEncode(o?.ToString() ?? "");

    private static string EmailShell(string eyebrow, string title, string innerHtml) => $@"<!DOCTYPE html>
<html><head><meta charset=""utf-8""></head>
<body style=""margin:0;padding:24px;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917;"">
<div style=""max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;overflow:hidden;"">
  <div style=""background:#1c1917;color:#ffffff;padding:20px 24px;"">
    <div style=""font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#a8a29e;"">{H(eyebrow)}</div>
    <div style=""font-size:20px;font-weight:bold;"">{H(title)}</div>
  </div>
  <div style=""padding:24px;"">{innerHtml}</div>
</div>
</body></html>";

    private static string SectionHeading(string text) =>
        $@"<div style=""font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#78716c;font-weight:bold;margin:24px 0 8px;"">{H(text)}</div>";

    private static string FigureRow(string label, string value, bool strong = false) => $@"
<tr>
  <td style=""padding:6px 0;color:#57534e;border-bottom:1px solid #f5f5f4;font-size:14px;"">{H(label)}</td>
  <td style=""padding:6px 0;text-align:right;font-variant-numeric:tabular-nums;font-size:14px;font-weight:{(strong ? "700" : "400")};border-bottom:1px solid #f5f5f4;"">{H(value)}</td>
</tr>";

    private static string FigureTable(string rows) =>
        $@"<table style=""width:100%;border-collapse:collapse;"">{rows}</table>";

    private static string ItemsTableHtml(IEnumerable<dynamic> rows)
    {
        var sb = new StringBuilder();
        sb.Append(@"<table style=""width:100%;border-collapse:collapse;font-size:14px;"">
  <tr style=""text-align:left;color:#78716c;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;"">
    <th style=""padding:6px 0;border-bottom:2px solid #e7e5e4;"">Item</th>
    <th style=""padding:6px 0;border-bottom:2px solid #e7e5e4;text-align:right;"">Qty</th>
    <th style=""padding:6px 0;border-bottom:2px solid #e7e5e4;text-align:right;"">Amount</th>
  </tr>");
        decimal totalQty = 0, totalAmt = 0;
        var any = false;
        foreach (var r in rows)
        {
            any = true;
            decimal qty = (decimal)r.TotalQty, amt = (decimal)r.TotalAmount;
            totalQty += qty; totalAmt += amt;
            sb.Append($@"
  <tr>
    <td style=""padding:6px 0;border-bottom:1px solid #f5f5f4;"">{H((string)r.ProductName)}</td>
    <td style=""padding:6px 0;border-bottom:1px solid #f5f5f4;text-align:right;font-variant-numeric:tabular-nums;"">{qty:N2}</td>
    <td style=""padding:6px 0;border-bottom:1px solid #f5f5f4;text-align:right;font-variant-numeric:tabular-nums;"">{amt:N2}</td>
  </tr>");
        }
        if (!any) sb.Append(@"<tr><td colspan=""3"" style=""padding:10px 0;color:#a8a29e;"">No items sold</td></tr>");
        sb.Append($@"
  <tr>
    <td style=""padding:8px 0;font-weight:bold;border-top:2px solid #e7e5e4;"">Total</td>
    <td style=""padding:8px 0;font-weight:bold;border-top:2px solid #e7e5e4;text-align:right;font-variant-numeric:tabular-nums;"">{totalQty:N2}</td>
    <td style=""padding:8px 0;font-weight:bold;border-top:2px solid #e7e5e4;text-align:right;font-variant-numeric:tabular-nums;"">{totalAmt:N2}</td>
  </tr>
</table>");
        return sb.ToString();
    }

    private static string HourlyTableHtml(IEnumerable<dynamic> rows)
    {
        var sb = new StringBuilder();
        sb.Append(@"<table style=""width:100%;border-collapse:collapse;font-size:14px;"">
  <tr style=""text-align:left;color:#78716c;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;"">
    <th style=""padding:6px 0;border-bottom:2px solid #e7e5e4;"">Hour</th>
    <th style=""padding:6px 0;border-bottom:2px solid #e7e5e4;text-align:right;"">Txns</th>
    <th style=""padding:6px 0;border-bottom:2px solid #e7e5e4;text-align:right;"">Net sales</th>
  </tr>");
        var any = false;
        foreach (var r in rows)
        {
            any = true;
            sb.Append($@"
  <tr>
    <td style=""padding:6px 0;border-bottom:1px solid #f5f5f4;"">{(int)r.HourOfDay:00}:00</td>
    <td style=""padding:6px 0;border-bottom:1px solid #f5f5f4;text-align:right;"">{(int)r.TxnCount}</td>
    <td style=""padding:6px 0;border-bottom:1px solid #f5f5f4;text-align:right;font-variant-numeric:tabular-nums;"">{(decimal)r.NetSales:N2}</td>
  </tr>");
        }
        if (!any) sb.Append(@"<tr><td colspan=""3"" style=""padding:10px 0;color:#a8a29e;"">No transactions</td></tr>");
        sb.Append("</table>");
        return sb.ToString();
    }

    /// Blind Close's emailed shift report — X-Read figures + item summary + hourly
    /// breakdown, all as tables. Never sent to the cashier (same no-peek guarantee as
    /// the printed variance report); only reaches the configured admin recipients.
    public string XReadEmailHtml(dynamic x, IEnumerable<dynamic> items, IEnumerable<dynamic> hourly)
    {
        var figures = FigureTable(
            FigureRow("Cash begin", M((decimal)x.CashBegin)) +
            FigureRow("Transaction count", ((int)x.TxnCount).ToString()) +
            FigureRow("Void count", ((int)x.VoidCount).ToString()) +
            FigureRow("Gross sales", M((decimal)x.GrossSales)) +
            FigureRow("Total discounts", M((decimal)x.TotalDiscounts)) +
            FigureRow("Net sales", M((decimal)x.NetSales), strong: true) +
            FigureRow("Cash payments", M((decimal)x.CashSales)) +
            FigureRow("Card payments", M((decimal)x.CardSales)) +
            FigureRow("VATable sales", M((decimal)x.VatableAmount)) +
            FigureRow("VAT (12%)", M((decimal)x.VatAmount)) +
            FigureRow("VAT-exempt sales", M((decimal)x.VatExemptAmount)) +
            FigureRow("Zero-rated sales", M((decimal)x.ZeroRatedAmount)) +
            FigureRow("OR range", $"{x.BeginningOR}–{x.EndingOR}"));

        var inner = SectionHeading("Shift figures") + figures
            + SectionHeading("Group item sales summary") + ItemsTableHtml(items)
            + SectionHeading("Per-hour transactions") + HourlyTableHtml(hourly);

        return EmailShell("Shift close report",
            $"{(string)x.BranchCode}/{(string)x.TerminalCode} — {(string)x.Cashier}", inner);
    }

    /// End of Day's emailed Z-Read — figures + item summary, as tables. The printed
    /// receipt stays plain-text-only (a 32-column roll has no room for a table);
    /// only the email gets this richer layout.
    public string ZReadEmailHtml(dynamic z, IEnumerable<dynamic> items)
    {
        var figures = FigureTable(
            FigureRow("Gross sales", M((decimal)z.GrossSales)) +
            FigureRow("Total discounts", M((decimal)z.TotalDiscounts)) +
            FigureRow("Net sales", M((decimal)z.NetSales), strong: true) +
            FigureRow("Cash payments", M((decimal)z.CashSales)) +
            FigureRow("Card payments", M((decimal)z.CardSales)) +
            FigureRow("VATable sales", M((decimal)z.VatableAmount)) +
            FigureRow("VAT (12%)", M((decimal)z.VatAmount)) +
            FigureRow("VAT-exempt sales", M((decimal)z.VatExemptAmount)) +
            FigureRow("Zero-rated sales", M((decimal)z.ZeroRatedAmount)) +
            FigureRow("Transaction count", ((int)z.TxnCount).ToString()) +
            FigureRow("Void count", ((int)z.VoidCount).ToString()) +
            FigureRow("Void amount", M((decimal)z.VoidAmount)) +
            FigureRow("OR range", $"{z.BeginningOR?.ToString() ?? "-"}–{z.EndingOR?.ToString() ?? "-"}") +
            FigureRow("Old grand total", M((decimal)z.OldGrandTotal)) +
            FigureRow("New grand total", M((decimal)z.NewGrandTotal), strong: true) +
            FigureRow("Closed by", (string)z.ClosedByName) +
            FigureRow("Authorized by", (string)z.ApprovedByName));

        var inner = SectionHeading("Z-Read figures") + figures
            + SectionHeading("Group item sales summary") + ItemsTableHtml(items);

        return EmailShell($"Z-Read #{(int)z.ZCounter} — {((DateTime)z.BusinessDate):yyyy-MM-dd}",
            $"{(string)z.BranchName} — {(string)z.BranchCode}/{(string)z.TerminalCode}", inner);
    }

    public string TestPrint(string label, int paperWidthMm = 58)
    {
        var w = Columns(paperWidthMm);
        string C(string s) => ReceiptBuilder.C(w, s);
        string Rule() => ReceiptBuilder.Rule(w);
        var sb = new StringBuilder();
        sb.AppendLine(C("*** TEST PRINT ***"));
        sb.AppendLine(C(label));
        sb.AppendLine(C(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")));
        sb.AppendLine(Rule());
        sb.AppendLine("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
        sb.AppendLine("0123456789  1,234.56");
        sb.AppendLine(Rule());
        sb.AppendLine(C("Agent reachable - cutter OK"));
        sb.Append("\n\n\n");
        return sb.ToString();
    }
}
