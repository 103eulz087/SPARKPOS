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
    /// A column a Dapper row may not have (e.g. a DB not yet on a migration): 0 when missing.
    private static decimal Dec(dynamic row, string column) =>
        row is IDictionary<string, object> d && d.TryGetValue(column, out var v) && v != null ? Convert.ToDecimal(v) : 0m;

    /// BIR Sales Invoice No.: always 18 digits, zero-padded (Sales.ORNumber). Return
    /// numbers are 6 digits. Mirrors siNo()/returnNo() in web/src/lib/receipt.js.
    public static string Si(object? n) => n == null ? "-" : Convert.ToInt64(n).ToString("D18");
    public static string Rtn(object? n) => n == null ? "-" : Convert.ToInt32(n).ToString("D6");

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
        // How expected cash is reached, line by line: the change handed back is what's left of the stored
        // figures (cash begin + received - refunds - expected), so the slip always adds up to them.
        decimal begin = (decimal)v.CashBegin, received = (decimal)v.CashSales, refunds = (decimal)v.CashRefunds,
            expected = (decimal)v.ExpectedCash;
        sb.AppendLine(LR("CASH BEGIN", M(begin)));
        sb.AppendLine(LR("CASH RECEIVED", M(received)));
        sb.AppendLine(LR("LESS CHANGE GIVEN", M(begin + received - refunds - expected)));
        sb.AppendLine(LR("LESS CASH REFUNDS", M(refunds)));
        sb.AppendLine(LR("EXPECTED CASH", M(expected)));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("DECLARED CASH", M((decimal)v.DeclaredCash)));
        sb.AppendLine(LR("SHORT/(OVER)", M(-(decimal)v.ShortOver)));
        sb.AppendLine(Rule());
        sb.AppendLine("NOT IN THE DRAWER:");
        sb.AppendLine(LR("  CARD SALES", M((decimal)v.CardSales)));
        sb.AppendLine(LR("  GIFT CERT", M(Dec(v, "GcSales"))));   // 38_gift_certificates.sql
        sb.AppendLine(Rule());
        sb.AppendLine(C("FOR SUPERVISOR VERIFICATION"));
        sb.AppendLine(C("Verified by: __________________"));
        sb.Append("\n\n\n");
        return sb.ToString();
    }

    /// X-Read and Z-Read: sales and payments printed so each adds up on paper. Gross - discounts - the
    /// VAT taken off SC/PWD-exempt sales = net; cash received - the change handed back + card + GC = net.
    /// (CashSales is what was received, change included; ChangeGiven is missing on an older server: 0.)
    private static string SalesLines(int w, dynamic r)
    {
        decimal gross = (decimal)r.GrossSales, disc = (decimal)r.TotalDiscounts, net = (decimal)r.NetSales;
        var sb = new StringBuilder();
        sb.AppendLine(LR(w, "GROSS SALES", M(gross)));
        sb.AppendLine(LR(w, "LESS DISCOUNTS", M(disc)));
        sb.AppendLine(LR(w, "LESS VAT (SC/PWD)", M(gross - disc - net)));
        sb.AppendLine(LR(w, "NET SALES", M(net)));
        return sb.ToString();
    }

    private static string PaymentLines(int w, dynamic r)
    {
        decimal received = (decimal)r.CashSales, change = Dec(r, "ChangeGiven"), card = (decimal)r.CardSales, gc = Dec(r, "GcSales");
        var sb = new StringBuilder();
        sb.AppendLine(C(w, "PAYMENT BREAKDOWN"));
        sb.AppendLine(LR(w, "  CASH RECEIVED", M(received)));
        sb.AppendLine(LR(w, "  LESS CHANGE GIVEN", M(change)));
        sb.AppendLine(LR(w, "  CASH SALES", M(received - change)));
        sb.AppendLine(LR(w, "  CARD", M(card)));
        sb.AppendLine(LR(w, "  GIFT CERT", M(gc)));   // 38_gift_certificates.sql
        sb.AppendLine(LR(w, "  TOTAL", M(received - change + card + gc)));
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
        sb.AppendLine(LR("VOID AMOUNT", M((decimal)x.VoidAmount)));
        sb.AppendLine(LR("RETURN COUNT", ((int)x.ReturnCount).ToString()));
        sb.AppendLine(LR("RETURN AMOUNT", M((decimal)x.ReturnAmount)));
        sb.AppendLine(LR("DRAWER OPENED, NO SALE", ((int)Dec(x, "DrawerOpens")).ToString()));   // 39_open_drawer.sql
        sb.AppendLine(Rule());
        sb.Append((string)SalesLines(w, x));
        sb.AppendLine(Rule());
        sb.AppendLine(C("DISCOUNT BREAKDOWN"));
        sb.AppendLine(LR("  SENIOR", M((decimal)x.DiscSenior)));
        sb.AppendLine(LR("  PWD", M((decimal)x.DiscPwd)));
        sb.AppendLine(LR("  NAAC", M((decimal)x.DiscNaac)));
        sb.AppendLine(LR("  MOV", M((decimal)x.DiscMov)));
        sb.AppendLine(LR("  SOLO PARENT", M((decimal)x.DiscSolo)));
        // 30_other_discount.sql; a Z-Read stored before it has no such column
        sb.AppendLine(LR("  REGULAR/OTHER", M(Dec(x, "DiscOther"))));
        sb.AppendLine(LR("  PROMOS (BUY N TAKE M)", M(Dec(x, "DiscPromo"))));   // 34_promos.sql
        sb.AppendLine(Rule());
        sb.Append((string)PaymentLines(w, x));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("VATable Sales", M((decimal)x.VatableAmount)));
        sb.AppendLine(LR("VAT (12%)", M((decimal)x.VatAmount)));
        sb.AppendLine(LR("VAT-Exempt Sales", M((decimal)x.VatExemptAmount)));
        sb.AppendLine(LR("Zero-Rated Sales", M((decimal)x.ZeroRatedAmount)));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("BEG SI#", Si(x.BeginningOR)));
        sb.AppendLine(LR("END SI#", Si(x.EndingOR)));
        sb.AppendLine(LR("BEG RETURN#", Rtn(x.BeginningReturnNo)));
        sb.AppendLine(LR("END RETURN#", Rtn(x.EndingReturnNo)));
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
        sb.AppendLine(LR("BEG SI#", Si(z.BeginningOR)));
        sb.AppendLine(LR("END SI#", Si(z.EndingOR)));
        sb.AppendLine(LR("BEG RETURN#", Rtn(z.BeginningReturnNo)));
        sb.AppendLine(LR("END RETURN#", Rtn(z.EndingReturnNo)));
        sb.AppendLine(Rule());
        sb.Append((string)SalesLines(w, z));
        sb.AppendLine(Rule());
        sb.AppendLine(C("DISCOUNT BREAKDOWN"));
        sb.AppendLine(LR("  SENIOR", M((decimal)z.DiscSenior)));
        sb.AppendLine(LR("  PWD", M((decimal)z.DiscPwd)));
        sb.AppendLine(LR("  NAAC", M((decimal)z.DiscNaac)));
        sb.AppendLine(LR("  MOV", M((decimal)z.DiscMov)));
        sb.AppendLine(LR("  SOLO PARENT", M((decimal)z.DiscSolo)));
        // 30_other_discount.sql; a Z-Read stored before it has no such column
        sb.AppendLine(LR("  REGULAR/OTHER", M(Dec(z, "DiscOther"))));
        sb.AppendLine(LR("  PROMOS (BUY N TAKE M)", M(Dec(z, "DiscPromo"))));   // 34_promos.sql
        sb.AppendLine(Rule());
        sb.Append((string)PaymentLines(w, z));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("VATable Sales", M((decimal)z.VatableAmount)));
        sb.AppendLine(LR("VAT (12%)", M((decimal)z.VatAmount)));
        sb.AppendLine(LR("VAT-Exempt Sales", M((decimal)z.VatExemptAmount)));
        sb.AppendLine(LR("Zero-Rated Sales", M((decimal)z.ZeroRatedAmount)));
        sb.AppendLine(Rule());
        sb.AppendLine(LR("TXN COUNT", ((int)z.TxnCount).ToString()));
        sb.AppendLine(LR("VOID COUNT", ((int)z.VoidCount).ToString()));
        sb.AppendLine(LR("VOID AMOUNT", M((decimal)z.VoidAmount)));
        sb.AppendLine(LR("RETURN COUNT", ((int)z.ReturnCount).ToString()));
        sb.AppendLine(LR("RETURN AMOUNT", M((decimal)z.ReturnAmount)));
        sb.AppendLine(LR("DRAWER OPENED, NO SALE", ((int)Dec(z, "DrawerOpens")).ToString()));   // 39_open_drawer.sql
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
            FigureRow("Less VAT (SC/PWD)", M((decimal)x.GrossSales - (decimal)x.TotalDiscounts - (decimal)x.NetSales)) +
            FigureRow("Net sales", M((decimal)x.NetSales), strong: true) +
            FigureRow("Cash received", M((decimal)x.CashSales)) +
            FigureRow("Less change given", M(Dec(x, "ChangeGiven"))) +
            FigureRow("Cash sales", M((decimal)x.CashSales - Dec(x, "ChangeGiven"))) +
            FigureRow("Card payments", M((decimal)x.CardSales)) +
            FigureRow("Gift certificates", M(Dec(x, "GcSales"))) +
            FigureRow("Drawer opened, no sale", ((int)Dec(x, "DrawerOpens")).ToString()) +
            FigureRow("VATable sales", M((decimal)x.VatableAmount)) +
            FigureRow("VAT (12%)", M((decimal)x.VatAmount)) +
            FigureRow("VAT-exempt sales", M((decimal)x.VatExemptAmount)) +
            FigureRow("Zero-rated sales", M((decimal)x.ZeroRatedAmount)) +
            FigureRow("Void amount", M((decimal)x.VoidAmount)) +
            FigureRow("Return count", ((int)x.ReturnCount).ToString()) +
            FigureRow("Return amount (refunded)", M((decimal)x.ReturnAmount)) +
            FigureRow("Sales invoice range", $"{Si(x.BeginningOR)} – {Si(x.EndingOR)}") +
            FigureRow("Return no. range", $"{Rtn(x.BeginningReturnNo)} – {Rtn(x.EndingReturnNo)}"));

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
            FigureRow("Less VAT (SC/PWD)", M((decimal)z.GrossSales - (decimal)z.TotalDiscounts - (decimal)z.NetSales)) +
            FigureRow("Net sales", M((decimal)z.NetSales), strong: true) +
            FigureRow("Cash received", M((decimal)z.CashSales)) +
            FigureRow("Less change given", M(Dec(z, "ChangeGiven"))) +
            FigureRow("Cash sales", M((decimal)z.CashSales - Dec(z, "ChangeGiven"))) +
            FigureRow("Card payments", M((decimal)z.CardSales)) +
            FigureRow("Gift certificates", M(Dec(z, "GcSales"))) +
            FigureRow("Drawer opened, no sale", ((int)Dec(z, "DrawerOpens")).ToString()) +
            FigureRow("VATable sales", M((decimal)z.VatableAmount)) +
            FigureRow("VAT (12%)", M((decimal)z.VatAmount)) +
            FigureRow("VAT-exempt sales", M((decimal)z.VatExemptAmount)) +
            FigureRow("Zero-rated sales", M((decimal)z.ZeroRatedAmount)) +
            FigureRow("Transaction count", ((int)z.TxnCount).ToString()) +
            FigureRow("Void count", ((int)z.VoidCount).ToString()) +
            FigureRow("Void amount", M((decimal)z.VoidAmount)) +
            FigureRow("Return count", ((int)z.ReturnCount).ToString()) +
            FigureRow("Return amount (refunded)", M((decimal)z.ReturnAmount)) +
            FigureRow("Sales invoice range", $"{Si(z.BeginningOR)} – {Si(z.EndingOR)}") +
            FigureRow("Return no. range", $"{Rtn(z.BeginningReturnNo)} – {Rtn(z.EndingReturnNo)}") +
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
