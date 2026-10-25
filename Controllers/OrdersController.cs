using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using ZusStoreStock.Data;
using ZusStoreStock.Models;

namespace ZusStoreStock.Controllers;

[Authorize]
public class OrdersController : Controller
{
    private const long MaxQty = 1_000_000;

    // Who may approve, reject and mark orders as ordered.
    private const string Approvers = "Admin,Supervisor";

    private readonly ZusStoreStockContext _context;

    public OrdersController(ZusStoreStockContext context)
    {
        _context = context;
    }

    // ---------- Order list ----------
    // show = "pending", "approved", "ontheway", "received" or "rejected"
    public async Task<IActionResult> Index(string? show)
    {
        var all = await _context.StoreOrders
            .Include(o => o.OrderLines)
            .OrderByDescending(o => o.OrderDate).ThenByDescending(o => o.Id)
            .ToListAsync();

        show = show is "pending" or "approved" or "ontheway" or "received" or "rejected" ? show : "";

        ViewBag.Pending = all.Count(o => o.Status == OrderStatus.Pending);
        ViewBag.Approved = all.Count(o => o.Status == OrderStatus.Approved);
        ViewBag.OnTheWay = all.Count(o => o.Status == OrderStatus.Ordered || o.Status == OrderStatus.PartlyReceived);
        ViewBag.Show = show;

        var list = all.Where(o => show switch
        {
            "pending" => o.Status == OrderStatus.Pending,
            "approved" => o.Status == OrderStatus.Approved,
            "ontheway" => o.Status == OrderStatus.Ordered || o.Status == OrderStatus.PartlyReceived,
            "received" => o.Status == OrderStatus.Received,
            "rejected" => o.Status == OrderStatus.Rejected,
            _ => true
        }).ToList();

        return View(list);
    }

    // ---------- New order ----------
    [HttpGet]
    public async Task<IActionResult> Create()
    {
        ViewBag.Note = "";
        return View(await BuildRowsAsync(null));
    }

    [HttpPost]
    public async Task<IActionResult> Create(List<OrderLineInput>? lines, string? note)
    {
        lines ??= new List<OrderLineInput>();
        note = (note ?? "").Trim();

        string? error = null;
        if (note.Length > 500)
            error = "The note is too long (maximum 500 characters).";
        else if (lines.Any(l => l.Bundles < 0 || l.Loose < 0))
            error = "Quantities cannot be negative.";
        else if (lines.GroupBy(l => l.ProductId).Any(g => g.Count() > 1))
            error = "An item appears more than once. Please refresh the page and try again.";

        var wanted = lines.Where(l => l.Bundles > 0 || l.Loose > 0).ToList();
        if (error == null && wanted.Count == 0)
            error = "Please enter a quantity for at least one item.";

        var products = new Dictionary<int, Product>();
        if (error == null)
        {
            var ids = wanted.Select(w => w.ProductId).ToList();
            products = await _context.Products.Where(p => ids.Contains(p.Id)).ToDictionaryAsync(p => p.Id);

            foreach (var w in wanted)
            {
                if (!products.TryGetValue(w.ProductId, out var p) || !p.IsActive)
                {
                    error = "One of the items is not available any more. Please refresh the page and try again.";
                    break;
                }

                long total = (long)w.Bundles * p.UnitsPerBundle + w.Loose;
                if (total > MaxQty)
                {
                    error = $"The quantity for {p.Name} is too large.";
                    break;
                }
            }
        }

        if (error != null)
        {
            ViewBag.Note = note;
            TempData["Error"] = error;
            return View(await BuildRowsAsync(lines));
        }

        var order = new StoreOrder
        {
            OrderNumber = await NextNumberAsync("ORD"),
            Source = "Store Request",
            CreatedBy = User.Identity?.Name ?? "?",
            OrderDate = DateTime.Now,
            Status = OrderStatus.Pending,
            Note = note.Length == 0 ? null : note
        };

        foreach (var w in wanted)
        {
            var p = products[w.ProductId];
            order.OrderLines.Add(new StoreOrderLine
            {
                ProductId = p.Id,
                RequestedBundleQty = w.Bundles,
                RequestedLooseQty = w.Loose,
                UnitsPerBundle = p.UnitsPerBundle,
                ReceiveStatus = ReceiveStatus.Pending
            });
        }

        _context.StoreOrders.Add(order);
        await _context.SaveChangesAsync();

        TempData["Msg"] = $"Order {order.OrderNumber} sent for approval ({order.OrderLines.Count} item(s)).";
        return RedirectToAction(nameof(Details), new { id = order.Id });
    }

    // ---------- One order ----------
    public async Task<IActionResult> Details(int id)
    {
        var order = await _context.StoreOrders
            .Include(o => o.OrderLines).ThenInclude(l => l.Product)
            .FirstOrDefaultAsync(o => o.Id == id);

        if (order == null)
        {
            TempData["Error"] = "That order was not found.";
            return RedirectToAction(nameof(Index));
        }

        return View(order);
    }

    // ---------- Supervisor or Admin: approve or reject ----------
    [HttpPost]
    [Authorize(Roles = Approvers)]
    public async Task<IActionResult> Decide(int id, string? decision, string? decisionNote, List<DecisionLineInput>? lines)
    {
        var order = await _context.StoreOrders
            .Include(o => o.OrderLines).ThenInclude(l => l.Product)
            .FirstOrDefaultAsync(o => o.Id == id);

        if (order == null)
        {
            TempData["Error"] = "That order was not found.";
            return RedirectToAction(nameof(Index));
        }

        if (order.Status != OrderStatus.Pending)
        {
            TempData["Error"] = $"This order was already decided (status: {order.Status}).";
            return RedirectToAction(nameof(Details), new { id });
        }

        var note = (decisionNote ?? "").Trim();
        if (note.Length > 300)
        {
            TempData["Error"] = "The note is too long (maximum 300 characters).";
            return RedirectToAction(nameof(Details), new { id });
        }

        if (decision == "reject")
        {
            if (note.Length == 0)
            {
                TempData["Error"] = "Please write the reason for rejecting this order.";
                return RedirectToAction(nameof(Details), new { id });
            }

            order.Status = OrderStatus.Rejected;
            order.DecidedBy = User.Identity?.Name ?? "?";
            order.DecidedAt = DateTime.Now;
            order.DecisionNote = note;
            await _context.SaveChangesAsync();

            TempData["Msg"] = $"Order {order.OrderNumber} was rejected.";
            return RedirectToAction(nameof(Details), new { id });
        }

        if (decision != "approve")
        {
            TempData["Error"] = "Please choose Approve or Reject.";
            return RedirectToAction(nameof(Details), new { id });
        }

        // Approve: apply the quantities typed, then drop lines set to zero.
        var edits = (lines ?? new List<DecisionLineInput>())
            .GroupBy(l => l.LineId)
            .ToDictionary(g => g.Key, g => g.First());

        foreach (var line in order.OrderLines)
        {
            if (!edits.TryGetValue(line.Id, out var e)) continue;

            if (e.Bundles < 0 || e.Loose < 0)
            {
                TempData["Error"] = "Quantities cannot be negative.";
                return RedirectToAction(nameof(Details), new { id });
            }

            if ((long)e.Bundles * line.UnitsPerBundle + e.Loose > MaxQty)
            {
                TempData["Error"] = $"The quantity for {line.Product?.Name} is too large.";
                return RedirectToAction(nameof(Details), new { id });
            }

            line.RequestedBundleQty = e.Bundles;
            line.RequestedLooseQty = e.Loose;
        }

        var empty = order.OrderLines.Where(l => l.RequestedTotal == 0).ToList();
        if (empty.Count == order.OrderLines.Count)
        {
            TempData["Error"] = "All quantities are 0. Enter a quantity, or reject the order instead.";
            return RedirectToAction(nameof(Details), new { id });
        }

        _context.StoreOrderLines.RemoveRange(empty);

        order.Status = OrderStatus.Approved;
        order.DecidedBy = User.Identity?.Name ?? "?";
        order.DecidedAt = DateTime.Now;
        order.DecisionNote = note.Length == 0 ? null : note;
        await _context.SaveChangesAsync();

        string msg = $"Order {order.OrderNumber} approved.";
        if (empty.Count > 0) msg += $" {empty.Count} item(s) with quantity 0 were removed.";
        TempData["Msg"] = msg;
        return RedirectToAction(nameof(Details), new { id });
    }

    // ---------- Supervisor or Admin: the approved order has been sent to HQ ----------
    [HttpPost]
    [Authorize(Roles = Approvers)]
    public async Task<IActionResult> MarkOrdered(int id)
    {
        var order = await _context.StoreOrders.FirstOrDefaultAsync(o => o.Id == id);
        if (order == null)
        {
            TempData["Error"] = "That order was not found.";
            return RedirectToAction(nameof(Index));
        }

        if (order.Status != OrderStatus.Approved)
        {
            TempData["Error"] = $"Only an approved order can be marked as ordered (status now: {order.Status}).";
            return RedirectToAction(nameof(Details), new { id });
        }

        order.Status = OrderStatus.Ordered;
        order.OrderedBy = User.Identity?.Name ?? "?";
        order.OrderedAt = DateTime.Now;
        await _context.SaveChangesAsync();

        TempData["Msg"] = $"Order {order.OrderNumber} marked as ordered. You can receive it when the stock arrives.";
        return RedirectToAction(nameof(Details), new { id });
    }

    // ---------- New product delivery (stock that arrived with no order, e.g. sent by HQ) ----------
    [HttpGet]
    public async Task<IActionResult> NewDelivery()
    {
        return await DeliveryViewAsync(new List<ExtraLineInput>(), "");
    }

    [HttpPost]
    public async Task<IActionResult> NewDelivery(List<ExtraLineInput>? lines, string? note)
    {
        lines ??= new List<ExtraLineInput>();
        note = (note ?? "").Trim();
        var today = DateTime.Today;
        var errors = new List<string>();

        if (note.Length > 300)
            errors.Add("The note is too long (maximum 300 characters).");

        var wanted = lines.Where(l => l.ProductId > 0 || l.Bundles > 0 || l.Loose > 0).ToList();
        var ids = wanted.Select(l => l.ProductId).Where(x => x > 0).Distinct().ToList();
        var products = await _context.Products.Include(p => p.Batches)
            .Where(p => ids.Contains(p.Id)).ToDictionaryAsync(p => p.Id);
        var plan = new List<(Product Product, ExtraLineInput Input)>();

        foreach (var l in wanted)
        {
            if (l.ProductId <= 0)
            {
                errors.Add("An item has a quantity but no product chosen.");
                continue;
            }
            if (!products.TryGetValue(l.ProductId, out var p) || !p.IsActive)
            {
                errors.Add("One of the items is not available. Please refresh the page and try again.");
                continue;
            }

            long total = (long)l.Bundles * p.UnitsPerBundle + l.Loose;
            if (l.Bundles < 0 || l.Loose < 0)
                errors.Add($"{p.Name}: quantities cannot be negative.");
            else if (total <= 0)
                errors.Add($"{p.Name}: enter the quantity that arrived.");
            else if (total > MaxQty)
                errors.Add($"{p.Name}: the quantity is too large.");
            else if (l.Expiry != null && l.Expiry.Value.Date < today)
                errors.Add($"{p.Name}: the expiry date is already in the past.");
            else
                plan.Add((p, l));
        }

        if (errors.Count == 0 && plan.Count == 0)
            errors.Add("Please add at least one item that arrived.");

        if (errors.Count > 0)
        {
            TempData["Error"] = string.Join(" ", errors.Take(4)) + (errors.Count > 4 ? $" (and {errors.Count - 4} more)" : "");
            return await DeliveryViewAsync(lines, note);
        }

        var user = User.Identity?.Name ?? "?";
        var order = new StoreOrder
        {
            OrderNumber = await NextNumberAsync("HQD"),
            Source = "HQ Delivery",
            CreatedBy = user,
            OrderDate = DateTime.Now,
            Status = OrderStatus.Received,
            OrderedBy = user,
            OrderedAt = DateTime.Now,
            ReceivedBy = user,
            ReceivedDate = DateTime.Now,
            Note = note.Length == 0 ? null : note
        };

        var notes = new List<string>();
        foreach (var (p, l) in plan)
        {
            int total = l.Bundles * p.UnitsPerBundle + l.Loose;
            var expiry = ResolveExpiry(p, l.Expiry, today, out bool defaulted);

            order.OrderLines.Add(new StoreOrderLine
            {
                ProductId = p.Id,
                UnitsPerBundle = p.UnitsPerBundle,
                ReceivedBundleQty = l.Bundles,
                ReceivedLooseQty = l.Loose,
                ReceivedExpiry = expiry,
                ReceiveStatus = ReceiveStatus.AddedOnArrival
            });

            AddToBatch(p, total, expiry);
            _context.StockMoves.Add(NewMove(p, total, order.OrderNumber));

            if (defaulted) notes.Add($"{p.Name} had no expiry date, so {expiry:dd MMM yyyy} was used");
        }

        _context.StoreOrders.Add(order);

        try
        {
            await _context.SaveChangesAsync();
        }
        catch (DbUpdateException)
        {
            TempData["Error"] = "The delivery could not be saved. Please try again.";
            return await DeliveryViewAsync(lines, note);
        }

        string msg = $"Delivery {order.OrderNumber} saved: {plan.Count} item(s) added to stock.";
        if (notes.Count > 0) msg += " Please check: " + string.Join("; ", notes) + ".";
        TempData["Msg"] = msg;
        return RedirectToAction(nameof(Details), new { id = order.Id });
    }

    // ---------- Receive a delivery against an order ----------
    [HttpGet]
    public async Task<IActionResult> Receive(int id)
    {
        var order = await LoadOrderAsync(id);
        if (order == null)
        {
            TempData["Error"] = "That order was not found.";
            return RedirectToAction(nameof(Index));
        }

        if (!CanReceive(order))
        {
            TempData["Error"] = order.Status == OrderStatus.Received
                ? "This order was already fully received."
                : $"This order cannot be received yet (status: {order.Status}). A supervisor or admin must mark it as Ordered first.";
            return RedirectToAction(nameof(Details), new { id });
        }

        return await ReceiveViewAsync(order, new List<ReceiveLineInput>(), new List<ExtraLineInput>(), false);
    }

    [HttpPost]
    public async Task<IActionResult> Receive(int id, List<ReceiveLineInput>? lines, List<ExtraLineInput>? extras, bool closeOrder)
    {
        var order = await LoadOrderAsync(id);
        if (order == null)
        {
            TempData["Error"] = "That order was not found.";
            return RedirectToAction(nameof(Index));
        }

        if (!CanReceive(order))
        {
            TempData["Error"] = $"This order cannot be received (status: {order.Status}).";
            return RedirectToAction(nameof(Details), new { id });
        }

        lines ??= new List<ReceiveLineInput>();
        extras ??= new List<ExtraLineInput>();
        var today = DateTime.Today;
        var errors = new List<string>();

        // ----- Check everything first. Nothing is saved unless all of it is valid. -----
        var pendingLines = order.OrderLines.Where(l => l.ReceiveStatus == ReceiveStatus.Pending).ToDictionary(l => l.Id);
        var seen = new HashSet<int>();
        var plan = new List<(StoreOrderLine Line, ReceiveLineInput Input)>();

        foreach (var input in lines)
        {
            if (!pendingLines.TryGetValue(input.LineId, out var line) || !seen.Add(input.LineId)) continue;
            string name = line.Product?.Name ?? "Item";

            if (input.Action == "received")
            {
                long total = (long)input.Bundles * line.UnitsPerBundle + input.Loose;
                if (input.Bundles < 0 || input.Loose < 0)
                    errors.Add($"{name}: quantities cannot be negative.");
                else if (total <= 0)
                    errors.Add($"{name}: enter the quantity that arrived, or choose Reject or Not yet.");
                else if (total > MaxQty)
                    errors.Add($"{name}: the quantity is too large.");
                else if (input.Expiry != null && input.Expiry.Value.Date < today)
                    errors.Add($"{name}: the expiry date is already in the past. If it arrived expired, choose Reject.");
                else
                    plan.Add((line, input));
            }
            else if (input.Action == "reject")
            {
                var reason = (input.RejectNote ?? "").Trim();
                if (reason.Length == 0)
                    errors.Add($"{name}: please write the reason for rejecting.");
                else if (reason.Length > 300)
                    errors.Add($"{name}: the reject reason is too long (maximum 300 characters).");
                else
                    plan.Add((line, input));
            }
        }

        var wantedExtras = extras.Where(e => e.ProductId > 0 || e.Bundles > 0 || e.Loose > 0).ToList();
        var extraIds = wantedExtras.Select(e => e.ProductId).Where(x => x > 0).Distinct().ToList();
        var extraProducts = await _context.Products.Include(p => p.Batches)
            .Where(p => extraIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id);
        var extraPlan = new List<(Product Product, ExtraLineInput Input)>();

        foreach (var e in wantedExtras)
        {
            if (e.ProductId <= 0)
            {
                errors.Add("An extra item has a quantity but no item chosen.");
                continue;
            }
            if (!extraProducts.TryGetValue(e.ProductId, out var p) || !p.IsActive)
            {
                errors.Add("One of the extra items is not available. Please refresh the page and try again.");
                continue;
            }

            long total = (long)e.Bundles * p.UnitsPerBundle + e.Loose;
            if (e.Bundles < 0 || e.Loose < 0)
                errors.Add($"{p.Name} (extra): quantities cannot be negative.");
            else if (total <= 0)
                errors.Add($"{p.Name} (extra): enter the quantity that arrived.");
            else if (total > MaxQty)
                errors.Add($"{p.Name} (extra): the quantity is too large.");
            else if (e.Expiry != null && e.Expiry.Value.Date < today)
                errors.Add($"{p.Name} (extra): the expiry date is already in the past.");
            else
                extraPlan.Add((p, e));
        }

        if (errors.Count == 0 && plan.Count == 0 && extraPlan.Count == 0 && !closeOrder)
            errors.Add("Nothing to save. Choose Received or Reject for at least one item, or add an extra item.");

        if (errors.Count > 0)
        {
            TempData["Error"] = string.Join(" ", errors.Take(4)) + (errors.Count > 4 ? $" (and {errors.Count - 4} more)" : "");
            return await ReceiveViewAsync(order, lines, extras, closeOrder);
        }

        // ----- Save -----
        var user = User.Identity?.Name ?? "?";
        int nReceived = 0, nRejected = 0, nExtra = 0, nClosed = 0;
        var notes = new List<string>();

        foreach (var (line, input) in plan)
        {
            var p = line.Product!;

            if (input.Action == "received")
            {
                int total = input.Bundles * line.UnitsPerBundle + input.Loose;
                var expiry = ResolveExpiry(p, input.Expiry, today, out bool defaulted);

                line.ReceivedBundleQty = input.Bundles;
                line.ReceivedLooseQty = input.Loose;
                line.ReceivedExpiry = expiry;
                line.ReceiveStatus = ReceiveStatus.Received;

                AddToBatch(p, total, expiry);
                _context.StockMoves.Add(NewMove(p, total, order.OrderNumber));

                if (defaulted) notes.Add($"{p.Name} had no expiry date, so {expiry:dd MMM yyyy} was used");
                if (total != line.RequestedTotal)
                    notes.Add($"{p.Name}: received {p.Pack(total)} but ordered {p.Pack(line.RequestedTotal)}");
                nReceived++;
            }
            else
            {
                line.ReceiveStatus = ReceiveStatus.Rejected;
                line.RejectNote = (input.RejectNote ?? "").Trim();
                line.ReceivedBundleQty = 0;
                line.ReceivedLooseQty = 0;
                nRejected++;
            }
        }

        foreach (var (p, e) in extraPlan)
        {
            int total = e.Bundles * p.UnitsPerBundle + e.Loose;
            var expiry = ResolveExpiry(p, e.Expiry, today, out bool defaulted);

            order.OrderLines.Add(new StoreOrderLine
            {
                ProductId = p.Id,
                UnitsPerBundle = p.UnitsPerBundle,
                ReceivedBundleQty = e.Bundles,
                ReceivedLooseQty = e.Loose,
                ReceivedExpiry = expiry,
                ReceiveStatus = ReceiveStatus.AddedOnArrival
            });

            AddToBatch(p, total, expiry);
            _context.StockMoves.Add(NewMove(p, total, order.OrderNumber));

            if (defaulted) notes.Add($"{p.Name} had no expiry date, so {expiry:dd MMM yyyy} was used");
            nExtra++;
        }

        if (closeOrder)
        {
            foreach (var l in order.OrderLines.Where(l => l.ReceiveStatus == ReceiveStatus.Pending))
            {
                l.ReceiveStatus = ReceiveStatus.Rejected;
                l.RejectNote = $"Did not arrive. Order closed by {user}.";
                nClosed++;
            }
        }

        int stillPending = order.OrderLines.Count(l => l.ReceiveStatus == ReceiveStatus.Pending);
        order.Status = stillPending == 0 ? OrderStatus.Received : OrderStatus.PartlyReceived;
        order.ReceivedBy = user;
        order.ReceivedDate = DateTime.Now;

        try
        {
            await _context.SaveChangesAsync();
        }
        catch (DbUpdateException)
        {
            TempData["Error"] = "The delivery could not be saved. Please try again.";
            return RedirectToAction(nameof(Receive), new { id });
        }

        var parts = new List<string>();
        if (nReceived > 0) parts.Add($"{nReceived} item(s) received into stock");
        if (nRejected > 0) parts.Add($"{nRejected} rejected");
        if (nExtra > 0) parts.Add($"{nExtra} extra item(s) added");
        if (nClosed > 0) parts.Add($"{nClosed} marked as not delivered");

        string msg = $"Order {order.OrderNumber}: {string.Join(", ", parts)}.";
        msg += stillPending > 0 ? $" {stillPending} item(s) still waiting to arrive." : " Order complete.";
        if (notes.Count > 0) msg += " Please check: " + string.Join("; ", notes) + ".";

        TempData["Msg"] = msg;
        return RedirectToAction(nameof(Details), new { id });
    }

    // ---------- Helpers ----------
    private static bool CanReceive(StoreOrder o) =>
        o.Status == OrderStatus.Ordered || o.Status == OrderStatus.PartlyReceived;

    private Task<StoreOrder?> LoadOrderAsync(int id) =>
        _context.StoreOrders
            .Include(o => o.OrderLines).ThenInclude(l => l.Product).ThenInclude(p => p!.Batches)
            .FirstOrDefaultAsync(o => o.Id == id);

    private async Task<IActionResult> ReceiveViewAsync(StoreOrder order, List<ReceiveLineInput> lines, List<ExtraLineInput> extras, bool close)
    {
        ViewBag.Products = await _context.Products.Where(p => p.IsActive)
            .OrderBy(p => p.Category).ThenBy(p => p.Name).ToListAsync();
        ViewBag.EnteredLines = lines.GroupBy(l => l.LineId).ToDictionary(g => g.Key, g => g.First());
        ViewBag.EnteredExtras = extras;
        ViewBag.EnteredClose = close;
        return View("Receive", order);
    }

    private async Task<IActionResult> DeliveryViewAsync(List<ExtraLineInput> entered, string note)
    {
        var products = await _context.Products.Include(p => p.Batches).Where(p => p.IsActive)
            .OrderBy(p => p.Category).ThenBy(p => p.Name).ToListAsync();
        ViewBag.Entered = entered;
        ViewBag.Note = note;
        return View("NewDelivery", products);
    }

    // No date typed: food and drinks get a default expiry; other items stay without one.
    private static DateTime? ResolveExpiry(Product p, DateTime? typed, DateTime today, out bool defaulted)
    {
        defaulted = false;
        if (typed != null) return typed.Value.Date;
        if (!p.TracksExpiry) return null;
        defaulted = true;
        return today.AddMonths(Product.DefaultExpiryMonths);
    }

    // Same expiry date = same batch.
    private static void AddToBatch(Product p, int qty, DateTime? expiry)
    {
        var batch = p.Batches.FirstOrDefault(b => b.ExpiryDate == expiry);
        if (batch != null) batch.Qty += qty;
        else p.Batches.Add(new StockBatch { Qty = qty, ExpiryDate = expiry, ReceivedAt = DateTime.Now });
    }

    private StockMove NewMove(Product p, int qty, string orderNumber) => new()
    {
        ProductId = p.Id,
        Qty = qty,
        Type = MoveType.Received,
        UserName = User.Identity?.Name ?? "?",
        At = DateTime.Now,
        Note = orderNumber
    };

    // All active items, low stock first. Low items get a suggested quantity on a fresh page.
    private async Task<List<OrderLineRow>> BuildRowsAsync(List<OrderLineInput>? entered)
    {
        var products = await _context.Products
            .Include(p => p.Batches)
            .Where(p => p.IsActive)
            .OrderBy(p => p.Category).ThenBy(p => p.StorageZone).ThenBy(p => p.Name)
            .ToListAsync();

        var map = (entered ?? new List<OrderLineInput>())
            .GroupBy(e => e.ProductId)
            .ToDictionary(g => g.Key, g => g.First());

        var rows = products.Select(p =>
        {
            int bundles = 0, loose = 0;

            if (map.TryGetValue(p.Id, out var e))
            {
                bundles = Math.Max(0, e.Bundles);
                loose = Math.Max(0, e.Loose);
            }
            else if (entered == null && p.IsLow)
            {
                int need = p.SuggestedBundles;
                if (p.UnitsPerBundle > 1) bundles = need; else loose = need;
            }

            return new OrderLineRow { Product = p, Bundles = bundles, Loose = loose };
        })
        .OrderByDescending(r => r.Product.IsLow)
        .ToList();

        return rows;
    }

    // ORD2610-001, ORD2610-002 ... and HQD2610-001 ... (restarts every month)
    private async Task<string> NextNumberAsync(string kind)
    {
        var prefix = $"{kind}{DateTime.Now:yyMM}-";
        int n = await _context.StoreOrders.CountAsync(o => o.OrderNumber.StartsWith(prefix)) + 1;

        string number;
        do
        {
            number = $"{prefix}{n:D3}";
            n++;
        }
        while (await _context.StoreOrders.AnyAsync(o => o.OrderNumber == number));

        return number;
    }
}