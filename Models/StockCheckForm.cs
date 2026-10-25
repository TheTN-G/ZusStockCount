using System.ComponentModel.DataAnnotations;

namespace ZusStoreStock.Models;

public class StockCheckForm
{
    [Required]
    public string Scope { get; set; } = "All";

    public string? ScopeName { get; set; }

    [StringLength(500, ErrorMessage = "The note is too long (maximum 500 characters).")]
    public string? Note { get; set; }

    public List<StockCheckCountInput> Lines { get; set; } = new();
}

public class StockCheckCountInput
{
    public int ProductId { get; set; }

    [Required(ErrorMessage = "Enter a physical count for each listed product.")]
    [Range(0, 1_000_000, ErrorMessage = "Counts must be between 0 and 1,000,000.")]
    public int? CountedQty { get; set; }
}

