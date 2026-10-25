namespace ZusStoreStock.Models;

// One row per expiry date. Qty is always stored in loose units.
public class StockBatch
{
    public int Id { get; set; }
    public int ProductId { get; set; }
    public Product? Product { get; set; }
    public int Qty { get; set; }
    public DateTime? ExpiryDate { get; set; }
    public DateTime ReceivedAt { get; set; } = DateTime.Now;
}

// Activity history. Qty is signed: + added, - used.
public class StockMove
{
    public int Id { get; set; }
    public int ProductId { get; set; }
    public int Qty { get; set; }
    public MoveType Type { get; set; }
    public string UserName { get; set; } = string.Empty;
    public DateTime At { get; set; } = DateTime.Now;
    public string? Note { get; set; }
}