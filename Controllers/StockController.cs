using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using ZusStoreStock.Data;
using ZusStoreStock.Helpers;
using ZusStoreStock.Models;

namespace ZusStoreStock.Controllers;

[Authorize]
public class StockController : Controller
{
    private const long MaxQty = 1_000_000;
    private const long MaxUploadBytes = 5 * 1024 * 1024;

    private readonly ZusStoreStockContext _context;

    public StockController(ZusStoreStockContext context)
    {
        _context = context;
    }

    // ---------- Stock list ----------
    // show = "active", "low" or "expiring" (the three boxes at the top of the page)
    public async Task<IActionResult> Index(string? q, ProductCategory? category, StorageType? storage, string? show)
    {
        var all = await _context.Products.Include(p => p.Batches)
            .OrderBy(p => p.Category).ThenBy(p => p.StorageZone).ThenBy(p => p.Name)
            .ToListAsync();

        var today = DateTime.Today;
        show = show is "active" or "low" or "expiring" ? show : "";

        ViewBag.Total = all.Count(p => p.IsActive);
        ViewBag.Low = all.Count(p => p.IsLow);
        ViewBag.Soon = all.Count(p => p.ExpiresSoon(today));

        ViewBag.Q = q;
        ViewBag.Category = category;
        ViewBag.Storage = storage;
        ViewBag.Show = show;

        var list = all.Where(p =>
            (string.IsNullOrWhiteSpace(q) || p.Name.Contains(q.Trim(), StringComparison.OrdinalIgnoreCase)) &&
            (category == null || p.Category == category) &&
            (storage == null || p.StorageZone == storage) &&
            MatchesShow(p, show, today)).ToList();

        return View(list);
    }

    private static bool MatchesShow(Product p, string show, DateTime today) => show switch
    {
        "active" => p.IsActive,
        "low" => p.IsLow,
        "expiring" => p.ExpiresSoon(today),
        _ => true
    };

    // ---------- Add a new product ----------
    [HttpGet]
    public IActionResult Create()
    {
        return View(new Product());
    }

    [HttpPost]
    public async Task<IActionResult> Create(
        [Bind("Name,Description,Category,StorageZone,BundleUnit,UnitsPerBundle,LooseUnit,TracksExpiry")] Product product,
        int? thresholdInput, string? thresholdUnit)
    {
        Normalize(product);
        ApplyThreshold(product, thresholdInput, thresholdUnit);

        if (product.Name.Length > 0 &&
            await _context.Products.AnyAsync(p => p.Name == product.Name))
        {
            ModelState.AddModelError(nameof(Product.Name), $"A product called '{product.Name}' already exists.");
        }

        if (!ModelState.IsValid)
        {
            KeepThreshold(thresholdInput, thresholdUnit);
            TempData["Error"] = "Please fix the problems below and save again.";
            return View(product);
        }

        product.IsActive = true;
        _context.Products.Add(product);
        await _context.SaveChangesAsync();

        TempData["Msg"] = $"Product '{product.Name}' added. You can add its first stock below.";
        return RedirectToAction(nameof(Item), new { id = product.Id });
    }

    // ---------- Edit a product (details, bundle size, threshold, expiry tracking) ----------
    [HttpGet]
    public async Task<IActionResult> Edit(int id)
    {
        var product = await _context.Products.FindAsync(id);
        if (product == null)
        {
            TempData["Error"] = "That product was not found. It may have been removed.";
            return RedirectToAction(nameof(Index));
        }
        return View(product);
    }

    [HttpPost]
    public async Task<IActionResult> Edit(int id,
        [Bind("Name,Description,Category,StorageZone,BundleUnit,UnitsPerBundle,LooseUnit,TracksExpiry,IsActive")] Product product,
        int? thresholdInput, string? thresholdUnit)
    {
        var existing = await _context.Products.FindAsync(id);
        if (existing == null)
        {
            TempData["Error"] = "That product was not found. It may have been removed.";
            return RedirectToAction(nameof(Index));
        }

        Normalize(product);
        ApplyThreshold(product, thresholdInput, thresholdUnit);

        if (product.Name.Length > 0 &&
            await _context.Products.AnyAsync(p => p.Name == product.Name && p.Id != id))
        {
            ModelState.AddModelError(nameof(Product.Name), $"Another product is already called '{product.Name}'.");
        }

        if (!ModelState.IsValid)
        {
            product.Id = id;
            KeepThreshold(thresholdInput, thresholdUnit);
            TempData["Error"] = "Please fix the problems below and save again.";
            return View(product);
        }

        existing.Name = product.Name;
        existing.Description = product.Description;
        existing.Category = product.Category;
        existing.StorageZone = product.StorageZone;
        existing.BundleUnit = product.BundleUnit;
        existing.UnitsPerBundle = product.UnitsPerBundle;
        existing.LooseUnit = product.LooseUnit;
        existing.ThresholdLooseQty = product.ThresholdLooseQty;
        existing.TracksExpiry = product.TracksExpiry;
        existing.IsActive = product.IsActive;

        await _context.SaveChangesAsync();

        TempData["Msg"] = $"Product '{existing.Name}' updated.";
        return RedirectToAction(nameof(Item), new { id });
    }

    // ---------- One item: batches, add, use, history ----------
    public async Task<IActionResult> Item(int id)
    {
        var product = await _context.Products.Include(p => p.Batches).FirstOrDefaultAsync(p => p.Id == id);
        if (product == null)
        {
            TempData["Error"] = "That product was not found. It may have been removed.";
            return RedirectToAction(nameof(Index));
        }

        ViewBag.Moves = await _context.StockMoves
            .Where(m => m.ProductId == id)
            .OrderByDescending(m => m.At)
            .Take(15)
            .ToListAsync();

        return View(product);
    }

    // ---------- Add stock ----------
    [HttpPost]
    public async Task<IActionResult> Add(int id, int bundles, int loose, DateTime? expiry)
    {
        var product = await _context.Products.Include(p => p.Batches).FirstOrDefaultAsync(p => p.Id == id);
        if (product == null)
        {
            TempData["Error"] = "That product was not found.";
            return RedirectToAction(nameof(Index));
        }

        long total = (long)bundles * product.UnitsPerBundle + loose;

        if (bundles < 0 || loose < 0 || total <= 0)
            return BackToItem(id, "Please enter a quantity greater than zero.", true);

        if (total > MaxQty)
            return BackToItem(id, "That quantity is too large. Please check the number and try again.", true);

        int qty = (int)total;

        // No expiry typed for an item that tracks expiry: use 1 month from today (can be changed later).
        DateTime? expiryToUse = expiry?.Date;
        bool defaulted = false;
        if (product.TracksExpiry && expiryToUse == null)
        {
            expiryToUse = DefaultExpiry();
            defaulted = true;
        }

        AddToBatch(product, qty, expiryToUse);
        _context.StockMoves.Add(NewMove(product, qty, MoveType.Add));
        await _context.SaveChangesAsync();

        string msg = $"Added {product.Pack(qty)} to {product.Name}. Now in stock: {product.Pack(product.TotalLooseQty)}.";
        if (defaulted)
            msg += $" No expiry date was entered, so it was set to {expiryToUse:dd MMM yyyy} ({Product.DefaultExpiryMonths} month from today). You can change it under 'Stock by expiry date'.";
        else if (expiryToUse != null && expiryToUse.Value < DateTime.Today)
            msg += " Note: the expiry date you entered is already in the past.";

        return BackToItem(id, msg);
    }

    // ---------- Change the expiry date of one batch ----------
    [HttpPost]
    public async Task<IActionResult> UpdateExpiry(int batchId, DateTime? expiry)
    {
        var batch = await _context.StockBatches
            .Include(b => b.Product).ThenInclude(p => p!.Batches)
            .FirstOrDefaultAsync(b => b.Id == batchId);

        if (batch?.Product == null)
        {
            TempData["Error"] = "That stock batch was not found. Please refresh the page.";
            return RedirectToAction(nameof(Index));
        }

        var product = batch.Product;

        if (expiry == null && product.TracksExpiry)
            return BackToItem(product.Id, "Please choose an expiry date.", true);

        var newDate = expiry?.Date;

        // Same expiry date = same batch, so join them if the date already exists.
        var other = product.Batches.FirstOrDefault(b => b.Id != batch.Id && b.ExpiryDate == newDate);
        if (other != null)
        {
            other.Qty += batch.Qty;
            _context.StockBatches.Remove(batch);
            await _context.SaveChangesAsync();
            return BackToItem(product.Id, $"Expiry date updated to {newDate:dd MMM yyyy}. It joined the existing batch with that date.");
        }

        batch.ExpiryDate = newDate;
        await _context.SaveChangesAsync();

        string text = newDate == null ? "Expiry date removed." : $"Expiry date updated to {newDate:dd MMM yyyy}.";
        if (newDate != null && newDate.Value < DateTime.Today)
            text += " Note: that date is already in the past.";
        return BackToItem(product.Id, text);
    }

    // ---------- Remove used stock ----------
    [HttpPost]
    public async Task<IActionResult> Use(int id, int bundles, int loose)
    {
        var product = await _context.Products.Include(p => p.Batches).FirstOrDefaultAsync(p => p.Id == id);
        if (product == null)
        {
            TempData["Error"] = "That product was not found.";
            return RedirectToAction(nameof(Index));
        }

        long total = (long)bundles * product.UnitsPerBundle + loose;

        if (bundles < 0 || loose < 0 || total <= 0)
            return BackToItem(id, "Please enter a quantity greater than zero.", true);

        if (total > product.TotalLooseQty)
            return BackToItem(id, $"Cannot remove that much. Only {product.Pack(product.TotalLooseQty)} in stock.", true);

        int qty = (int)total;

        Deduct(product, qty);
        _context.StockMoves.Add(NewMove(product, -qty, MoveType.Use));
        await _context.SaveChangesAsync();

        string msg = $"Removed {product.Pack(qty)} from {product.Name} (earliest expiry first). Now in stock: {product.Pack(product.TotalLooseQty)}.";
        if (product.IsLow) msg += " Stock is now at or below the threshold.";

        return BackToItem(id, msg);
    }

    // ---------- Excel: download the stock-take sheet ----------
    [HttpGet]
    public async Task<IActionResult> DownloadSheet()
    {
        var products = await _context.Products
            .Include(p => p.Batches)
            .Where(p => p.IsActive)
            .OrderBy(p => p.Category).ThenBy(p => p.StorageZone).ThenBy(p => p.Name)
            .ToListAsync();

        if (products.Count == 0)
        {
            TempData["Error"] = "There are no active products to put in the sheet yet. Please add a product first.";
            return RedirectToAction(nameof(Index));
        }

        var bytes = StockSheetHelper.Build(products, User.Identity?.Name);
        var fileName = $"StockTake_{DateTime.Today:yyyyMMdd}.xlsx";
        return File(bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName);
    }

    // ---------- Excel: upload the filled sheet and update stock ----------
    [HttpPost]
    [RequestSizeLimit(MaxUploadBytes)]
    public async Task<IActionResult> UploadSheet(IFormFile? file)
    {
        if (file == null || file.Length == 0)
            return UploadFailed("Please choose the filled Excel file (.xlsx) first.");

        if (!string.Equals(Path.GetExtension(file.FileName), ".xlsx", StringComparison.OrdinalIgnoreCase))
            return UploadFailed("Only .xlsx Excel files are accepted. Please save the sheet as .xlsx and try again.");

        if (file.Length > MaxUploadBytes)
            return UploadFailed("The file is too large (maximum 5 MB).");

        if (!await LooksLikeXlsxAsync(file))
            return UploadFailed("This file is not a valid .xlsx Excel file.");

        SheetReadResult read;
        using (var stream = file.OpenReadStream())
        {
            read = StockSheetHelper.Read(stream);
        }

        if (read.FatalError != null)
            return UploadFailed(read.FatalError);

        if (read.Errors.Count > 0)
            return UploadFailed(read.Errors);

        if (read.Counts.Count == 0)
            return UploadFailed("No counts found. Please fill in 'Counted bundles' and/or 'Counted loose' for the items you counted.");

        var ids = read.Counts.Select(c => c.ProductId).Distinct().ToList();
        var products = await _context.Products
            .Include(p => p.Batches)
            .Where(p => ids.Contains(p.Id))
            .ToDictionaryAsync(p => p.Id);

        // Pass 1: check every row. Nothing is saved unless all rows are fine.
        var errors = new List<string>();
        var plans = new List<(Product Product, SheetCount Count, int Counted)>();
        var seen = new HashSet<int>();

        foreach (var c in read.Counts)
        {
            string label = $"Row {c.Row} ({c.ItemName})";

            if (!seen.Add(c.ProductId))
            {
                errors.Add($"{label}: this item appears more than once in the sheet.");
                continue;
            }

            if (!products.TryGetValue(c.ProductId, out var p))
            {
                errors.Add($"{label}: this item is not in the system any more.");
                continue;
            }

            long counted = (long)c.Bundles * p.UnitsPerBundle + c.Loose;
            if (counted > MaxQty)
            {
                errors.Add($"{label}: the counted quantity is too large.");
                continue;
            }

            plans.Add((p, c, (int)counted));
        }

        if (errors.Count > 0)
            return UploadFailed(errors);

        // Pass 2: apply.
        var now = DateTime.Now;
        var defaultExpiry = DefaultExpiry();
        int increased = 0, decreased = 0, same = 0, defaultedExpiry = 0;

        foreach (var (p, c, counted) in plans)
        {
            int before = p.TotalLooseQty;
            int diff = counted - before;

            if (diff > 0)
            {
                DateTime? expiryToUse = null;
                if (p.TracksExpiry)
                {
                    expiryToUse = c.Expiry ?? defaultExpiry;
                    if (c.Expiry == null) defaultedExpiry++;
                }

                AddToBatch(p, diff, expiryToUse);
                increased++;
            }
            else if (diff < 0)
            {
                Deduct(p, -diff);
                decreased++;
            }
            else
            {
                same++;
            }

            p.LastCheckedDate = now;

            if (diff != 0)
            {
                var move = NewMove(p, diff, MoveType.Stocktake);
                move.Note = $"Excel stock-take: counted {p.Pack(counted)}, system had {p.Pack(before)}.";
                _context.StockMoves.Add(move);
            }
        }

        await _context.SaveChangesAsync();

        string msg = $"Stock-take uploaded: {plans.Count} item(s) counted ({increased} increased, {decreased} decreased, {same} unchanged).";
        if (read.BlankRows > 0) msg += $" {read.BlankRows} row(s) left blank were skipped.";
        if (defaultedExpiry > 0)
            msg += $" {defaultedExpiry} item(s) had extra stock with no expiry date, so it was set to {defaultExpiry:dd MMM yyyy} ({Product.DefaultExpiryMonths} month from today). You can change it on each item page.";

        TempData["Msg"] = msg;
        return RedirectToAction(nameof(Index));
    }

    // ---------- Helpers ----------
    private static DateTime DefaultExpiry() => DateTime.Today.AddMonths(Product.DefaultExpiryMonths);

    private static void Normalize(Product p)
    {
        p.Name = (p.Name ?? "").Trim();
        p.Description = string.IsNullOrWhiteSpace(p.Description) ? null : p.Description.Trim();
        p.BundleUnit = (p.BundleUnit ?? "").Trim().ToLowerInvariant();
        p.LooseUnit = (p.LooseUnit ?? "").Trim().ToLowerInvariant();
    }

    // The threshold is typed in loose units or in bundles, and always saved in loose units.
    private void ApplyThreshold(Product p, int? input, string? unit)
    {
        if (input == null || input < 0)
        {
            ModelState.AddModelError(nameof(Product.ThresholdLooseQty), "Please enter the reorder threshold (0 or more).");
            return;
        }

        long total = unit == "bundle" && p.UnitsPerBundle > 1
            ? (long)input.Value * p.UnitsPerBundle
            : input.Value;

        if (total > MaxQty)
        {
            ModelState.AddModelError(nameof(Product.ThresholdLooseQty), "The threshold is too large. Please check the number.");
            return;
        }

        p.ThresholdLooseQty = (int)total;
    }

    // So the form shows what was typed when it has to be shown again.
    private void KeepThreshold(int? input, string? unit)
    {
        ViewBag.ThresholdInput = input;
        ViewBag.ThresholdUnit = unit == "bundle" ? "bundle" : "loose";
    }

    private StockMove NewMove(Product p, int signedQty, MoveType type) => new()
    {
        ProductId = p.Id,
        Qty = signedQty,
        Type = type,
        UserName = User.Identity?.Name ?? "?",
        At = DateTime.Now
    };

    private IActionResult BackToItem(int id, string text, bool error = false)
    {
        TempData[error ? "Error" : "Msg"] = text;
        return RedirectToAction(nameof(Item), new { id });
    }

    private IActionResult UploadFailed(string message)
    {
        TempData["Error"] = message;
        return RedirectToAction(nameof(Index));
    }

    private IActionResult UploadFailed(List<string> problems)
    {
        var shown = string.Join(" | ", problems.Take(8));
        if (problems.Count > 8) shown += $" | ...and {problems.Count - 8} more.";
        TempData["Error"] = "Nothing was updated because of these problems: " + shown;
        return RedirectToAction(nameof(Index));
    }

    // An .xlsx file is a zip file, so it starts with "PK".
    private static async Task<bool> LooksLikeXlsxAsync(IFormFile file)
    {
        var header = new byte[2];
        using var stream = file.OpenReadStream();
        int read = await stream.ReadAsync(header, 0, header.Length);
        return read == 2 && header[0] == 0x50 && header[1] == 0x4B;
    }

    // Same expiry date = same batch.
    private static void AddToBatch(Product p, int qty, DateTime? expiry)
    {
        var batch = p.Batches.FirstOrDefault(b => b.ExpiryDate == expiry);
        if (batch != null) batch.Qty += qty;
        else p.Batches.Add(new StockBatch { Qty = qty, ExpiryDate = expiry, ReceivedAt = DateTime.Now });
    }

    // First expired, first out: takes from the earliest expiry first. No-expiry batches go last.
    private void Deduct(Product p, int qty)
    {
        foreach (var b in p.Batches.OrderBy(x => x.ExpiryDate ?? DateTime.MaxValue).ToList())
        {
            if (qty <= 0) break;
            int take = Math.Min(b.Qty, qty);
            b.Qty -= take;
            qty -= take;
            if (b.Qty == 0) _context.StockBatches.Remove(b);
        }
    }
}