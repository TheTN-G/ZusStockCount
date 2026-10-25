namespace ZusStoreStock.Models;

public static class OrderStatus
{
    public const string Pending = "Pending Approval";
    public const string Approved = "Approved";
    public const string Rejected = "Rejected";
    public const string Ordered = "Ordered";
    public const string PartlyReceived = "Partially Received";
    public const string Received = "Received";

    // CSS class used to colour the status chip.
    public static string Css(string status) => status switch
    {
        Pending => "chip-status-pending",
        Approved => "chip-status-approved",
        Rejected => "chip-status-rejected",
        Ordered => "chip-status-ordered",
        PartlyReceived => "chip-status-partial",
        Received => "chip-status-received",
        _ => "chip-off"
    };
}

public static class ReceiveStatus
{
    public const string Pending = "Pending";
    public const string Received = "Received";
    public const string Rejected = "Rejected";
    public const string AddedOnArrival = "Added Upon Arrival";
}

public class StoreOrder
{
    public int Id { get; set; }
    public string OrderNumber { get; set; } = string.Empty;
    public string Source { get; set; } = "Store Request";   // "Store Request" or "HQ Delivery"
    public string CreatedBy { get; set; } = string.Empty;
    public DateTime OrderDate { get; set; } = DateTime.Now;
    public string Status { get; set; } = OrderStatus.Pending;
    public string? Note { get; set; }

    // Admin decision (approve / reject)
    public string? DecidedBy { get; set; }
    public DateTime? DecidedAt { get; set; }
    public string? DecisionNote { get; set; }

    // Admin marks the approved order as sent to HQ
    public string? OrderedBy { get; set; }
    public DateTime? OrderedAt { get; set; }

    // Receiving (next step)
    public DateTime? ReceivedDate { get; set; }
    public string? ReceivedBy { get; set; }

    public List<StoreOrderLine> OrderLines { get; set; } = new();
}