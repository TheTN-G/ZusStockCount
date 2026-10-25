using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using ZusStoreStock.Data;
using ZusStoreStock.Models;

namespace ZusStoreStock.Controllers;

[Authorize]
public class ChecksController : Controller
{
    private const int MaxQty = 1_000_000;
    private readonly ZusStoreStockContext _context;

    public ChecksController(ZusStoreStockContext context)
    {
        _context = context;
    }

    public async Task<IActionResult> Index()
    {
        var checks = await _context.StockChecks
            .Include(c => c.Lines)
            .ThenInclude(line => line.Product)
            .OrderByDescending(c => c.CheckedAt)
            .Take(50)
            .ToListAsync();

        return View(checks);
    }

    [HttpGet]
    public async Task<IActionResult> Create(string scope = "All", string? scopeName = null)
    {
        var resolved = await ResolveScopeAsync(scope, scopeName);
        if (resolved == null)
        {
            TempData["Error"] = "That stock-count scope is not available.";
            return RedirectToAction(nameof(Index));
        }

        var form = new StockCheckForm
        {
            Scope = resolved.Value.Scope,
            ScopeName = resolved.Value.ScopeName,
            Lines = resolved.Value.Products
                .Select(p => new StockCheckCountInput { ProductId = p.Id })
                .ToList()
        };

        PrepareForm(form, resolved.Value.Products);
        return View(form);
    }

    [HttpPost]
    public async Task<IActionResult> Create(StockCheckForm form)
    {
        form.Scope = (form.Scope ?? "").Trim();
        var resolved = await ResolveScopeAsync(form.Scope, form.ScopeName);
        if (resolved == null)
        {
            ModelState.AddModelError(nameof(form.Scope), "That stock-count scope is not available. Start a new count.");
            PrepareForm(form, new List<Product>());
            return View(form);
        }

        form.Scope = resolved.Value.Scope;
        form.ScopeName = resolved.Value.ScopeName;
        var expectedIds = resolved.Value.Products.Select(p => p.Id).ToHashSet();
        var submittedIds = (form.Lines ?? new List<StockCheckCountInput>())
            .Select(line => line.ProductId)
            .ToList();

        if (submittedIds.Count != expectedIds.Count ||
            submittedIds.Distinct().Count() != submittedIds.Count ||
            !submittedIds.ToHashSet().SetEquals(expectedIds))
        {
            ModelState.AddModelError(nameof(form.Lines), "The product list changed or was incomplete. Refresh the page and count again.");
        }

        if (resolved.Value.Products.Count == 0)
        {
            ModelState.AddModelError(nameof(form.Lines), "There are no products in this scope to count.");
        }

        if (!ModelState.IsValid)
        {
            PrepareForm(form, resolved.Value.Products);
            return View(form);
        }

        var inputs = form.Lines.ToDictionary(line => line.ProductId);
        var now = DateTime.Now;
        var check = new StockCheck
        {
            CheckedAt = now,
            CheckedBy = User.Identity?.Name ?? "?",
            Scope = resolved.Value.Scope,
            ScopeName = resolved.Value.Scope == "Item"
                ? resolved.Value.Products[0].Name
                : resolved.Value.ScopeName,
            Note = string.IsNullOrWhiteSpace(form.Note) ? null : form.Note.Trim()
        };

        foreach (var product in resolved.Value.Products)
        {
            int systemQty = product.TotalLooseQty;
            int countedQty = inputs[product.Id].CountedQty!.Value;
            int difference = countedQty - systemQty;

            check.Lines.Add(new StockCheckLine
            {
                ProductId = product.Id,
                SystemQty = systemQty,
                CountedQty = countedQty
            });

            if (difference > 0)
            {
                DateTime? expiry = product.TracksExpiry
                    ? DateTime.Today.AddMonths(Product.DefaultExpiryMonths)
                    : null;
                AddToBatch(product, difference, expiry);
            }
            else if (difference < 0)
            {
                Deduct(product, -difference);
            }

            product.LastCheckedDate = now;

            if (difference != 0)
            {
                _context.StockMoves.Add(new StockMove
                {
                    ProductId = product.Id,
                    Qty = difference,
                    Type = MoveType.Stocktake,
                    UserName = User.Identity?.Name ?? "?",
                    At = now,
                    Note = $"Stock check: counted {product.Pack(countedQty)}, system had {product.Pack(systemQty)}."
                });
            }
        }

        _context.StockChecks.Add(check);
        await _context.SaveChangesAsync();

        TempData["Msg"] = $"Stock check saved: {check.Lines.Count} item(s), {check.Lines.Count(line => line.Difference != 0)} variance(s).";
        return RedirectToAction(nameof(Details), new { id = check.Id });
    }

    public async Task<IActionResult> Details(int id)
    {
        var check = await _context.StockChecks
            .Include(c => c.Lines)
            .ThenInclude(line => line.Product)
            .FirstOrDefaultAsync(c => c.Id == id);

        if (check == null)
        {
            TempData["Error"] = "That stock check was not found.";
            return RedirectToAction(nameof(Index));
        }

        return View(check);
    }

    private async Task<(string Scope, string? ScopeName, List<Product> Products)?> ResolveScopeAsync(
        string? scope,
        string? scopeName)
    {
        scope = (scope ?? "").Trim();
        scopeName = (scopeName ?? "").Trim();

        IQueryable<Product> query = _context.Products
            .Include(product => product.Batches)
            .Where(product => product.IsActive);

        if (scope.Equals("All", StringComparison.OrdinalIgnoreCase))
        {
            scope = "All";
            scopeName = null;
        }
        else if (scope.Equals("Category", StringComparison.OrdinalIgnoreCase) &&
                 Enum.TryParse<ProductCategory>(scopeName, true, out var category))
        {
            scope = "Category";
            scopeName = category.ToString();
            query = query.Where(product => product.Category == category);
        }
        else if (scope.Equals("Item", StringComparison.OrdinalIgnoreCase) &&
                 int.TryParse(scopeName, out var productId) && productId > 0)
        {
            scope = "Item";
            query = query.Where(product => product.Id == productId);
        }
        else
        {
            return null;
        }

        var products = await query
            .OrderBy(product => product.Category)
            .ThenBy(product => product.StorageZone)
            .ThenBy(product => product.Name)
            .ToListAsync();

        if (scope == "Item" && products.Count == 1)
            scopeName = products[0].Id.ToString();

        return (scope, scopeName, products);
    }

    private void PrepareForm(StockCheckForm form, List<Product> products)
    {
        var submitted = (form.Lines ?? new List<StockCheckCountInput>())
            .GroupBy(line => line.ProductId)
            .ToDictionary(group => group.Key, group => group.First());

        form.Lines = products
            .Select(product => submitted.TryGetValue(product.Id, out var line)
                ? line
                : new StockCheckCountInput { ProductId = product.Id })
            .ToList();
        ViewBag.Products = products;
    }

    private static void AddToBatch(Product product, int qty, DateTime? expiry)
    {
        var batch = product.Batches.FirstOrDefault(b => b.ExpiryDate == expiry);
        if (batch != null)
        {
            batch.Qty += qty;
        }
        else
        {
            product.Batches.Add(new StockBatch
            {
                Qty = qty,
                ExpiryDate = expiry,
                ReceivedAt = DateTime.Now
            });
        }
    }

    private void Deduct(Product product, int qty)
    {
        foreach (var batch in product.Batches
                     .OrderBy(b => b.ExpiryDate ?? DateTime.MaxValue)
                     .ThenBy(b => b.ReceivedAt)
                     .ToList())
        {
            if (qty <= 0) break;

            int take = Math.Min(batch.Qty, qty);
            batch.Qty -= take;
            qty -= take;

            if (batch.Qty == 0)
                _context.StockBatches.Remove(batch);
        }
    }
}

