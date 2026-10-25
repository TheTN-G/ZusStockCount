using System.ComponentModel.DataAnnotations.Schema;

namespace ZusStoreStock.Models;

public class StoreOrderLine
{
    public int Id { get; set; }

    public int StoreOrderId { get; set; }
    public StoreOrder? StoreOrder { get; set; }

    public int ProductId { get; set; }
    public Product? Product { get; set; }

    // What was requested
    public int RequestedBundleQty { get; set; } = 0;
    public int RequestedLooseQty { get; set; } = 0;
    public int UnitsPerBundle { get; set; } = 1;   // copied from the product when the order is made

    // What actually arrived
    public int ReceivedBundleQty { get; set; } = 0;
    public int ReceivedLooseQty { get; set; } = 0;
    public DateTime? ReceivedExpiry { get; set; }

    // Pending, Received, Rejected, Added Upon Arrival
    public string ReceiveStatus { get; set; } = Models.ReceiveStatus.Pending;
    public string? RejectNote { get; set; }

    [NotMapped] public int RequestedTotal => RequestedBundleQty * UnitsPerBundle + RequestedLooseQty;
    [NotMapped] public int ReceivedTotal => ReceivedBundleQty * UnitsPerBundle + ReceivedLooseQty;
}