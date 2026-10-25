namespace ZusStoreStock.Models;

// One line posted from the "New order" page.
public class OrderLineInput
{
    public int ProductId { get; set; }
    public int Bundles { get; set; }
    public int Loose { get; set; }
}

// One row shown on the "New order" page.
public class OrderLineRow
{
    public Product Product { get; set; } = null!;
    public int Bundles { get; set; }
    public int Loose { get; set; }
}

// One line posted when the Admin checks a pending order.
public class DecisionLineInput
{
    public int LineId { get; set; }
    public int Bundles { get; set; }
    public int Loose { get; set; }
}