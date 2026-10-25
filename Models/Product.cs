using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace ZusStoreStock.Models;

public class Product
{
    // Items expiring within this many days (or already expired) are flagged.
    public const int ExpiryReminderDays = 3;

    // Used when stock is added without an expiry date (can be changed later).
    public const int DefaultExpiryMonths = 1;

    public int Id { get; set; }

    [Required(ErrorMessage = "Please enter the product name."), StringLength(120, ErrorMessage = "Name is too long (max 120 characters).")]
    public string Name { get; set; } = string.Empty;

    [StringLength(300, ErrorMessage = "Description is too long (max 300 characters).")]
    public string? Description { get; set; }

    [Display(Name = "Category")]
    public ProductCategory Category { get; set; } = ProductCategory.Food;

    [Display(Name = "Storage")]
    public StorageType StorageZone { get; set; } = StorageType.Ambient;

    [Required(ErrorMessage = "Please enter the bundle unit (e.g. ctn, box, roll)."), StringLength(20)]
    [Display(Name = "Bundle unit (ctn / box / roll ...)")]
    public string BundleUnit { get; set; } = "ctn";

    [Range(1, 1000000, ErrorMessage = "Qty per bundle must be 1 or more.")]
    [Display(Name = "Qty per bundle")]
    public int UnitsPerBundle { get; set; } = 1;

    [Required(ErrorMessage = "Please enter the loose unit (e.g. pkt, btl, pcs)."), StringLength(20)]
    [Display(Name = "Loose unit (pkt / btl / pcs ...)")]
    public string LooseUnit { get; set; } = "pcs";

    [Range(0, 1000000, ErrorMessage = "Threshold must be 0 or more.")]
    [Display(Name = "Reorder threshold (loose units)")]
    public int ThresholdLooseQty { get; set; } = 0;

    [Display(Name = "Track expiry date")]
    public bool TracksExpiry { get; set; } = true;

    [Display(Name = "Still ordering this item")]
    public bool IsActive { get; set; } = true;

    // Last time this item was physically counted.
    public DateTime? LastCheckedDate { get; set; }

    public List<StockBatch> Batches { get; set; } = new();

    [NotMapped] public int TotalLooseQty => Batches.Sum(b => b.Qty);
    [NotMapped] public bool IsLow => IsActive && TotalLooseQty <= ThresholdLooseQty;
    [NotMapped] public DateTime? NextExpiry => Batches.Where(b => b.Qty > 0 && b.ExpiryDate != null).Min(b => b.ExpiryDate);

    // "12 btl / ctn", or "Loose (tub)" when the item has no carton or box.
    [NotMapped]
    public string BundleSizeText =>
        UnitsPerBundle > 1 ? $"{UnitsPerBundle} {LooseUnit} / {BundleUnit}" : $"Loose ({LooseUnit})";

    // Suggests enough bundles to bring stock back to twice the threshold.
    [NotMapped]
    public int SuggestedBundles
    {
        get
        {
            var need = Math.Max(ThresholdLooseQty * 2, ThresholdLooseQty + 1) - TotalLooseQty;
            return need <= 0 ? 0 : (int)Math.Ceiling(need / (double)UnitsPerBundle);
        }
    }

    // Bundles first, then loose, e.g. "2 ctn + 5 pkt".
    public string Pack(int qty)
    {
        if (UnitsPerBundle <= 1) return $"{qty} {LooseUnit}";
        int b = qty / UnitsPerBundle, l = qty % UnitsPerBundle;
        if (b == 0) return $"{l} {LooseUnit}";
        return l == 0 ? $"{b} {BundleUnit}" : $"{b} {BundleUnit} + {l} {LooseUnit}";
    }

    // True when the earliest expiry is already past, or within the reminder days.
    public bool ExpiresSoon(DateTime today)
    {
        var d = NextExpiry;
        return d != null && d.Value <= today.AddDays(ExpiryReminderDays);
    }

    // CSS class for an expiry date: "exp-over" (past), "exp-soon" (reminder window) or "".
    public static string ExpiryCss(DateTime? date, DateTime today)
    {
        if (date == null) return "";
        return date.Value < today ? "exp-over"
             : date.Value <= today.AddDays(ExpiryReminderDays) ? "exp-soon"
             : "";
    }

    public string ExpiryClass(DateTime today) => ExpiryCss(NextExpiry, today);

    // "Never checked", "Today", "3 days ago"
    public string LastCheckedText(DateTime today)
    {
        if (LastCheckedDate == null) return "Never checked";
        int days = (today - LastCheckedDate.Value.Date).Days;
        return days <= 0 ? "Today" : days == 1 ? "Yesterday" : $"{days} days ago";
    }
}