namespace ZusStoreStock.Models;

// One line posted from the "Receive delivery" page.
public class ReceiveLineInput
{
    public int LineId { get; set; }
    public string? Action { get; set; }   // "received", "reject" or "later"
    public int Bundles { get; set; }
    public int Loose { get; set; }
    public DateTime? Expiry { get; set; }
    public string? RejectNote { get; set; }
}

// An item that arrived but was not on an order (also used by "New product delivery").
public class ExtraLineInput
{
    public int ProductId { get; set; }
    public int Bundles { get; set; }
    public int Loose { get; set; }
    public DateTime? Expiry { get; set; }
}

// Used by the shared + / - quantity box (Views/Shared/_QtyStepper.cshtml).
public record QtyField(string Name, int Value, string? Unit);

public static class ReceiveStatusUi
{
    // CSS class for the status chip of one order line (uses the chips already in site.css).
    public static string Css(string status) => status switch
    {
        ReceiveStatus.Received => "chip-status-received",
        ReceiveStatus.Rejected => "chip-status-rejected",
        ReceiveStatus.AddedOnArrival => "chip-status-ordered",
        _ => "chip-off"
    };
}