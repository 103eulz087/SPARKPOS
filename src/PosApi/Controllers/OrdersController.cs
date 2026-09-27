using System.Data;
using Dapper;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.SqlClient;
using PosApi.Models;
using PosApi.Services;

namespace PosApi.Controllers;

/// Dine-in order lifecycle (open a table, add/remove items over possibly several
/// rounds, close on payment). The client goes local-first (see Sync() below) and mirrors
/// the retail sales offline queue — Open/AddItem/SetItemQty/Close/Void below still exist
/// as live single-order actions (Open is still used to resume/create when the client has
/// nothing cached locally yet), but the client no longer calls AddItem/SetItemQty/Close
/// directly; those go through the local queue and Sync() instead. Generate Bill on the
/// client loads the accumulated items into the normal cart and hands off to the existing
/// discount/payment flow unchanged; this controller only tracks the pre-payment tab.
[ApiController]
[Route("api/orders")]
[Authorize]
public class OrdersController(Db db, PrintService printer, ReceiptBuilder receipts) : ApiControllerBase(db)
{
    /// Opens a new order for a table, or resumes its existing open one if the
    /// table is already occupied — safe to call repeatedly for the same table.
    /// The pre-check below is only an optimization to skip a round trip on the
    /// common case; UQ_OpenOrders_OneOpenPerTable (filtered unique index) is what
    /// actually prevents two concurrent taps on the same table from each creating
    /// an order — on conflict we just load whichever one won.
    [HttpPost("open")]
    public async Task<IActionResult> Open(OpenTableRequest req)
    {
        using var con = Db.Open();

        var existing = await con.ExecuteScalarAsync<Guid?>(
            "SELECT OpenOrderUid FROM dbo.OpenOrders WHERE TableId = @t AND Status = 'Open'",
            new { t = req.TableId });
        if (existing != null) return Ok(await LoadOrder(con, existing.Value));

        var branchCode = await con.ExecuteScalarAsync<string?>(
            "SELECT BranchCode FROM dbo.Tables WHERE TableId = @t", new { t = req.TableId });
        if (branchCode == null) return NotFound(new { message = "Table not found." });

        var uid = Guid.NewGuid();
        try
        {
            await con.ExecuteAsync(
                @"INSERT INTO dbo.OpenOrders (OpenOrderUid, TableId, BranchCode, TerminalId, ShiftUid, OpenedByUserId)
                  VALUES (@uid, @TableId, @branchCode, @TerminalId, @ShiftUid, @by)",
                new { uid, req.TableId, branchCode, req.TerminalId, req.ShiftUid, by = UserId });
        }
        catch (SqlException ex) when (ex.Number is 2601 or 2627)
        {
            var winner = await con.ExecuteScalarAsync<Guid>(
                "SELECT OpenOrderUid FROM dbo.OpenOrders WHERE TableId = @t AND Status = 'Open'",
                new { t = req.TableId });
            return Ok(await LoadOrder(con, winner));
        }

        return Ok(await LoadOrder(con, uid));
    }

    [HttpGet("{openOrderUid:guid}")]
    public async Task<IActionResult> Get(Guid openOrderUid)
    {
        using var con = Db.Open();
        var result = await LoadOrder(con, openOrderUid);
        return result == null ? NotFound() : Ok(result);
    }

    /// Same merge-on-tap behavior as the retail cart: tapping a product already on the
    /// tab at the same price increments its quantity instead of adding a new line. The
    /// read-then-branch below isn't atomic, so a concurrent add (double-tap, or two
    /// terminals on the same table) can race to insert the same new LineNo — on that
    /// conflict we retry, which picks up the other request's write on the re-read.
    [HttpPost("{openOrderUid:guid}/items")]
    public async Task<IActionResult> AddItem(Guid openOrderUid, AddOrderItemRequest req)
    {
        if (req.Quantity <= 0) return BadRequest(new { message = "Quantity must be positive." });
        if (req.UnitPrice < 0) return BadRequest(new { message = "Unit price cannot be negative." });

        using var con = Db.Open();
        var status = await con.ExecuteScalarAsync<string?>(
            "SELECT Status FROM dbo.OpenOrders WHERE OpenOrderUid = @u", new { u = openOrderUid });
        if (status == null) return NotFound(new { message = "Order not found." });
        if (status != "Open") return BadRequest(new { message = $"Order is already {status.ToLower()}." });

        for (var attempt = 1; ; attempt++)
        {
            var existingLine = await con.ExecuteScalarAsync<int?>(
                @"SELECT [LineNo] FROM dbo.OpenOrderItems
                  WHERE OpenOrderUid = @u AND ProductId = @p AND UnitPrice = @price",
                new { u = openOrderUid, p = req.ProductId, price = req.UnitPrice });

            if (existingLine != null)
            {
                await con.ExecuteAsync(
                    "UPDATE dbo.OpenOrderItems SET Quantity = Quantity + @qty WHERE OpenOrderUid = @u AND [LineNo] = @lineNo",
                    new { qty = req.Quantity, u = openOrderUid, lineNo = existingLine });
                break;
            }

            var nextLine = await con.ExecuteScalarAsync<int>(
                "SELECT ISNULL(MAX([LineNo]), 0) + 1 FROM dbo.OpenOrderItems WHERE OpenOrderUid = @u",
                new { u = openOrderUid });

            try
            {
                await con.ExecuteAsync(
                    @"INSERT INTO dbo.OpenOrderItems
                        (OpenOrderUid, [LineNo], ProductId, Barcode, ProductName, CategoryId,
                         Quantity, UnitPrice, IsVatable, IsDiscountable)
                      VALUES (@openOrderUid, @nextLine, @ProductId, @Barcode, @ProductName, @CategoryId,
                         @Quantity, @UnitPrice, @IsVatable, @IsDiscountable)",
                    new { openOrderUid, nextLine, req.ProductId, req.Barcode, req.ProductName, req.CategoryId,
                          req.Quantity, req.UnitPrice, req.IsVatable, req.IsDiscountable });
                break;
            }
            catch (SqlException ex) when (ex.Number is 2601 or 2627 && attempt < 3)
            {
                // Lost the race for this LineNo (or the same product+price landed first) — retry.
            }
        }

        return Ok(await LoadOrder(con, openOrderUid));
    }

    /// Sets a line's quantity — qty <= 0 removes it. Mirrors the retail cart's setQty
    /// semantics exactly, so the ordering-view UI can reuse the same +/- pattern.
    [HttpPut("{openOrderUid:guid}/items/{lineNo:int}")]
    public async Task<IActionResult> SetItemQty(Guid openOrderUid, int lineNo, [FromBody] SetOrderItemQtyRequest req)
    {
        using var con = Db.Open();
        if (req.Quantity <= 0)
            await con.ExecuteAsync(
                "DELETE FROM dbo.OpenOrderItems WHERE OpenOrderUid = @u AND [LineNo] = @lineNo",
                new { u = openOrderUid, lineNo });
        else
            await con.ExecuteAsync(
                "UPDATE dbo.OpenOrderItems SET Quantity = @q WHERE OpenOrderUid = @u AND [LineNo] = @lineNo",
                new { q = req.Quantity, u = openOrderUid, lineNo });
        return Ok(await LoadOrder(con, openOrderUid));
    }

    /// Called right after the client's normal checkout flow (completeSale) succeeds for
    /// a dine-in order — marks the tab billed, links the resulting sale, frees the table.
    /// The client fires this immediately after queuing the sale locally, without waiting
    /// for it to sync to dbo.Sales (freeing the table can't wait on that round trip), so
    /// SaleUid legitimately may not exist yet — that's logged, not rejected, to avoid
    /// leaving a paid-for table stuck "occupied" while sync is merely in flight.
    [HttpPost("{openOrderUid:guid}/close")]
    public async Task<IActionResult> Close(Guid openOrderUid, CloseOrderRequest req)
    {
        using var con = Db.Open();
        var rows = await con.ExecuteAsync(
            @"UPDATE dbo.OpenOrders SET Status='Billed', ClosedAt=SYSDATETIME(), SaleUid=@SaleUid
              WHERE OpenOrderUid=@u AND Status='Open'",
            new { req.SaleUid, u = openOrderUid });
        if (rows == 0) return NotFound(new { message = "Order not found or already closed." });

        var saleExists = await con.ExecuteScalarAsync<int>(
            "SELECT COUNT(*) FROM dbo.Sales WHERE SaleUid = @s", new { s = req.SaleUid });
        await AuditAsync(con, saleExists > 0 ? "TABLE_ORDER_CLOSE" : "TABLE_ORDER_CLOSE_UNVERIFIED",
            $"Open order {openOrderUid} closed with sale {req.SaleUid}"
            + (saleExists > 0 ? "" : " (not found in Sales yet — may still be syncing)"));

        return Ok();
    }

    /// Cancels an order with no payment ever involved (e.g. the party left without
    /// ordering) — no override needed, unlike voiding an actual completed sale.
    [HttpPost("{openOrderUid:guid}/void")]
    public async Task<IActionResult> Void(Guid openOrderUid)
    {
        using var con = Db.Open();
        await con.ExecuteAsync(
            "UPDATE dbo.OpenOrders SET Status='Voided', ClosedAt=SYSDATETIME() WHERE OpenOrderUid=@u AND Status='Open'",
            new { u = openOrderUid });
        await AuditAsync(con, "TABLE_ORDER_VOID", $"Open order {openOrderUid} voided");
        return Ok();
    }

    /// "Send to Kitchen" — prints only what's new since the last send (per line, via
    /// SentQuantity) to each item's mapped print area, grouped by area so the kitchen
    /// doesn't get a ticket per tap. Online-only in practice: browsers can't open raw TCP
    /// sockets to a LAN printer, so area printing always goes through this server call and
    /// PrintService (never RawBT, which only bridges to the handheld's own paired printer).
    /// The client sends the order's current full item snapshot (same shape as Sync()) so
    /// this works even if the order hasn't synced yet — this call itself upserts it.
    [HttpPost("{openOrderUid:guid}/send-to-kitchen")]
    public async Task<IActionResult> SendToKitchen(Guid openOrderUid, SendToKitchenRequest req)
    {
        using var con = Db.Open();

        var branchCode = await con.ExecuteScalarAsync<string?>(
            "SELECT BranchCode FROM dbo.OpenOrders WHERE OpenOrderUid = @u", new { u = openOrderUid });
        if (branchCode == null) return NotFound(new { message = "Order not found." });

        var prevSent = (await con.QueryAsync(
                "SELECT [LineNo], SentQuantity FROM dbo.OpenOrderItems WHERE OpenOrderUid = @u", new { u = openOrderUid }))
            .ToDictionary(r => (int)r.LineNo, r => (decimal)r.SentQuantity);

        var deltas = new List<(SendToKitchenItemDto Item, decimal DeltaQty)>();
        foreach (var i in req.Items)
        {
            var already = prevSent.TryGetValue(i.LineNo, out var s) ? s : 0m;
            var delta = i.Quantity - already;
            if (delta > 0) deltas.Add((i, delta));

            await con.ExecuteAsync(
                @"MERGE dbo.OpenOrderItems AS tgt
                  USING (SELECT @u AS OpenOrderUid, @LineNo AS [LineNo]) AS src
                  ON tgt.OpenOrderUid = src.OpenOrderUid AND tgt.[LineNo] = src.[LineNo]
                  WHEN MATCHED THEN UPDATE SET Quantity=@Quantity, UnitPrice=@UnitPrice, SentQuantity=@Quantity
                  WHEN NOT MATCHED THEN INSERT
                    (OpenOrderUid, [LineNo], ProductId, Barcode, ProductName, CategoryId, Quantity, UnitPrice,
                     IsVatable, IsDiscountable, SentQuantity)
                    VALUES (@u, @LineNo, @ProductId, @Barcode, @ProductName, @CategoryId, @Quantity, @UnitPrice,
                     @IsVatable, @IsDiscountable, @Quantity);",
                new { u = openOrderUid, i.LineNo, i.ProductId, i.Barcode, i.ProductName, i.CategoryId,
                      i.Quantity, i.UnitPrice, i.IsVatable, i.IsDiscountable });
        }

        if (deltas.Count == 0) return Ok(new { areas = Array.Empty<object>(), sentItems = Array.Empty<object>() });

        var areaRows = await con.QueryAsync(
            @"SELECT c.CategoryId, pa.AreaId, pa.AreaName, pa.PrinterTarget, pa.PaperWidth, pa.PrintAgentKey
              FROM dbo.Categories c
              LEFT JOIN dbo.CategoryPrintAreas cpa ON cpa.CategoryId = c.CategoryId AND cpa.BranchCode = @b
              LEFT JOIN dbo.PrintAreas pa ON pa.AreaId = cpa.AreaId AND pa.IsActive = 1
              WHERE c.CategoryId IN @cats",
            new { b = branchCode, cats = deltas.Select(d => d.Item.CategoryId).Distinct() });
        var areaByCategory = areaRows.ToDictionary(
            r => (int)r.CategoryId,
            r => (AreaId: (int?)r.AreaId, AreaName: (string?)r.AreaName, PrinterTarget: (string?)r.PrinterTarget,
                  PaperWidth: (int?)r.PaperWidth, PrintAgentKey: (string?)r.PrintAgentKey));

        var results = new List<object>();
        foreach (var grp in deltas.GroupBy(d => areaByCategory[d.Item.CategoryId].AreaId))
        {
            if (grp.Key == null)
            {
                results.Add(new { area = (string?)null, printed = false, message = "No print area assigned — not sent to any printer." });
                continue;
            }
            var (_, areaName, printerTarget, paperWidth, agentKey) = areaByCategory.Values.First(a => a.AreaId == grp.Key);
            var text = receipts.KitchenTicket(areaName!, req.TableNumber, grp.Select(g => (g.Item.ProductName, g.DeltaQty)),
                paperWidth ?? 58);
            await printer.EnqueueAsync(con, text, printerTarget, agentKey);
            results.Add(new { area = areaName, printed = true });
        }

        return Ok(new
        {
            areas = results,
            sentItems = deltas.Select(d => new { d.Item.ProductName, quantity = d.DeltaQty })
        });
    }

    /// Batch sync from the tablet's local-first dine-in queue (mirrors SalesController's
    /// /api/sales/sync). Whole-order snapshot replace, idempotent by OpenOrderUid — a
    /// client can retry the same batch forever without duplicating. Assumes a single
    /// terminal serves a given branch's tables at a time (see CLAUDE.md); a genuinely
    /// concurrent second device opening the same table while both are offline will fail
    /// UQ_OpenOrders_OneOpenPerTable here and just stay 'pending' client-side.
    [HttpPost("sync")]
    public async Task<IActionResult> Sync(SyncOrdersRequest req)
    {
        var results = new List<object>();
        using var con = Db.Open();

        foreach (var o in req.Orders)
        {
            try
            {
                var prevStatus = await con.ExecuteScalarAsync<string?>(
                    "SELECT Status FROM dbo.OpenOrders WHERE OpenOrderUid = @u", new { u = o.OpenOrderUid });

                if (prevStatus == null)
                {
                    await con.ExecuteAsync(
                        @"INSERT INTO dbo.OpenOrders
                            (OpenOrderUid, TableId, BranchCode, TerminalId, ShiftUid, OpenedByUserId,
                             OpenedAt, Status, ClosedAt, SaleUid)
                          VALUES (@OpenOrderUid, @TableId, @BranchCode, @TerminalId, @ShiftUid, @OpenedByUserId,
                             @OpenedAt, @Status, @ClosedAt, @SaleUid)", o);
                }
                else
                {
                    await con.ExecuteAsync(
                        @"UPDATE dbo.OpenOrders SET Status = @Status, ClosedAt = @ClosedAt, SaleUid = @SaleUid
                          WHERE OpenOrderUid = @OpenOrderUid", o);
                }

                // Whole-snapshot replace — the client always sends the order's full current
                // item list, so this is simpler and more robust than replaying individual
                // add/remove calls against whatever the server's copy happens to be.
                await con.ExecuteAsync("DELETE FROM dbo.OpenOrderItems WHERE OpenOrderUid = @u", new { u = o.OpenOrderUid });
                foreach (var i in o.Items)
                    await con.ExecuteAsync(
                        @"INSERT INTO dbo.OpenOrderItems
                            (OpenOrderUid, [LineNo], ProductId, Barcode, ProductName, CategoryId,
                             Quantity, UnitPrice, IsVatable, IsDiscountable)
                          VALUES (@u, @LineNo, @ProductId, @Barcode, @ProductName, @CategoryId,
                             @Quantity, @UnitPrice, @IsVatable, @IsDiscountable)",
                        new { u = o.OpenOrderUid, i.LineNo, i.ProductId, i.Barcode, i.ProductName, i.CategoryId,
                              i.Quantity, i.UnitPrice, i.IsVatable, i.IsDiscountable });

                // Only audit on an actual status transition, not on every retry of an
                // already-synced order (Sync() is safe to call repeatedly with the same batch).
                if (prevStatus != o.Status)
                {
                    if (o.Status == "Billed" && o.SaleUid != null)
                    {
                        var saleExists = await con.ExecuteScalarAsync<int>(
                            "SELECT COUNT(*) FROM dbo.Sales WHERE SaleUid = @s", new { s = o.SaleUid });
                        await AuditAsync(con, saleExists > 0 ? "TABLE_ORDER_CLOSE" : "TABLE_ORDER_CLOSE_UNVERIFIED",
                            $"Open order {o.OpenOrderUid} closed with sale {o.SaleUid} (synced)"
                            + (saleExists > 0 ? "" : " (not found in Sales yet — may still be syncing)"), o.BranchCode);
                    }
                    else if (o.Status == "Voided")
                    {
                        await AuditAsync(con, "TABLE_ORDER_VOID", $"Open order {o.OpenOrderUid} voided (synced)", o.BranchCode);
                    }
                }

                results.Add(new { openOrderUid = o.OpenOrderUid, status = "synced" });
            }
            catch (Exception ex)
            {
                results.Add(new { openOrderUid = o.OpenOrderUid, status = "error", message = ex.Message });
            }
        }
        return Ok(results);
    }

    private static async Task<object?> LoadOrder(IDbConnection con, Guid openOrderUid)
    {
        var order = await con.QuerySingleOrDefaultAsync(
            @"SELECT o.*, t.TableNumber FROM dbo.OpenOrders o
              JOIN dbo.Tables t ON t.TableId = o.TableId
              WHERE o.OpenOrderUid = @u", new { u = openOrderUid });
        if (order == null) return null;
        var items = await con.QueryAsync(
            "SELECT * FROM dbo.OpenOrderItems WHERE OpenOrderUid = @u ORDER BY [LineNo]", new { u = openOrderUid });
        return new { order, items };
    }
}
