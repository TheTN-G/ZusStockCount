using System.ComponentModel.DataAnnotations.Schema;

namespace ZusStoreStock.Models;

// One stock check session: a single item, a category, or all stock.
public class StockCheck
{
    public int Id { get; set; }
    public DateTime CheckedAt { get; set; } = DateTime.Now;
    public string CheckedBy { get; set; } = string.Empty;
    public string Scope { get; set; } = "All";        // Item, Category or All
    public string? ScopeName { get; set; }            // item name or category name
    public string? Note { get; set; }
    public List<StockCheckLine> Lines { get; set; } = new();
}

public class StockCheckLine
{
    public int Id { get; set; }
    public int StockCheckId { get; set; }
    public StockCheck? StockCheck { get; set; }
    public int ProductId { get; set; }
    public Product? Product { get; set; }
    public int SystemQty { get; set; }
    public int CountedQty { get; set; }
    [NotMapped] public int Difference => CountedQty - SystemQty;
}