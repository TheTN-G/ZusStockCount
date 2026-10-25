using System.Globalization;
using ClosedXML.Excel;
using ZusStoreStock.Models;

namespace ZusStoreStock.Helpers;

// One filled-in row read from the uploaded sheet.
public class SheetCount
{
    public int Row { get; set; }
    public int ProductId { get; set; }
    public string ItemName { get; set; } = string.Empty;
    public int Bundles { get; set; }
    public int Loose { get; set; }
    public DateTime? Expiry { get; set; }
}

public class SheetReadResult
{
    public List<SheetCount> Counts { get; } = new();
    public List<string> Errors { get; } = new();
    public string? FatalError { get; set; }
    public int BlankRows { get; set; }
}

public static class StockSheetHelper
{
    // Same order as the stock table on the Stock page, then the fill-in columns, then the ID.
    private const int ColItem = 1;
    private const int ColStorage = 2;
    private const int ColBundleSize = 3;
    private const int ColInStock = 4;
    private const int ColTotal = 5;
    private const int ColThreshold = 6;
    private const int ColNextExpiry = 7;
    private const int ColLastChecked = 8;
    private const int ColCountBundles = 9;
    private const int ColCountLoose = 10;
    private const int ColNewExpiry = 11;
    private const int ColId = 12;
    private const int LastCol = 12;

    private const int HeaderRow = 4;
    private const int MaxCount = 1_000_000;

    private static XLColor StorageFill(StorageType s) => s switch
    {
        StorageType.Ambient => XLColor.FromHtml("#ffe7a1"),
        StorageType.Chill => XLColor.FromHtml("#dbe7ff"),
        StorageType.Frozen => XLColor.FromHtml("#d3f1f7"),
        _ => XLColor.White
    };

    // ---------- Download ----------
    public static byte[] Build(List<Product> products, string? preparedBy)
    {
        var today = DateTime.Today;
        var blue = XLColor.FromHtml("#1026eb");
        var cream = XLColor.FromHtml("#ffe7a1");
        var brown = XLColor.FromHtml("#452002");
        var red = XLColor.FromHtml("#c0392b");
        var lowFill = XLColor.FromHtml("#fdecea");
        var line = XLColor.FromHtml("#d9c27a");

        using var wb = new XLWorkbook();
        var ws = wb.Worksheets.Add("Stock Take");

        ws.Cell("A1").Value = "Zus Coffee - Store Stock Take";
        ws.Cell("A1").Style.Font.Bold = true;
        ws.Cell("A1").Style.Font.FontSize = 14;
        ws.Cell("A1").Style.Font.FontColor = blue;

        ws.Cell("A2").Value = $"Downloaded {DateTime.Now:dd MMM yyyy HH:mm}" +
                              (string.IsNullOrWhiteSpace(preparedBy) ? "" : $" by {preparedBy}");

        ws.Cell("A3").Value = "Write what you counted in the yellow columns (bundles first, then loose). " +
                              "Leave a row blank if you did not count it. Do not change the ID column at the end.";
        ws.Cell("A3").Style.Font.Italic = true;

        // Header
        var headers = new (int Col, string Text)[]
        {
            (ColItem, "Item"), (ColStorage, "Storage"), (ColBundleSize, "Bundle size"),
            (ColInStock, "In stock"), (ColTotal, "Total (loose)"), (ColThreshold, "Threshold"),
            (ColNextExpiry, "Next expiry"), (ColLastChecked, "Last checked"),
            (ColCountBundles, "Counted bundles"), (ColCountLoose, "Counted loose"),
            (ColNewExpiry, "Expiry date (if extra stock found)"),
            (ColId, "ID")
        };
        foreach (var h in headers) ws.Cell(HeaderRow, h.Col).Value = h.Text;

        var header = ws.Range(HeaderRow, 1, HeaderRow, LastCol);
        header.Style.Fill.BackgroundColor = blue;
        header.Style.Font.FontColor = XLColor.White;
        header.Style.Font.Bold = true;
        header.Style.Alignment.WrapText = true;
        header.Style.Alignment.Vertical = XLAlignmentVerticalValues.Center;

        // Rows
        int row = HeaderRow + 1;
        ProductCategory? currentCategory = null;

        foreach (var p in products)
        {
            if (currentCategory != p.Category)
            {
                currentCategory = p.Category;
                var groupRow = ws.Range(row, 1, row, LastCol);
                groupRow.Style.Fill.BackgroundColor = cream;
                groupRow.Style.Font.Bold = true;
                groupRow.Style.Font.FontColor = brown;
                ws.Cell(row, ColItem).Value = p.Category.ToString().ToUpperInvariant();
                row++;
            }

            ws.Cell(row, ColItem).Value = p.Name;
            ws.Cell(row, ColStorage).Value = p.StorageZone.ToString();
            ws.Cell(row, ColBundleSize).Value = p.BundleSizeText;
            ws.Cell(row, ColInStock).Value = p.Pack(p.TotalLooseQty);
            ws.Cell(row, ColTotal).Value = p.TotalLooseQty;
            ws.Cell(row, ColThreshold).Value = p.ThresholdLooseQty;
            ws.Cell(row, ColLastChecked).Value = p.LastCheckedText(today);
            ws.Cell(row, ColId).Value = p.Id;
            ws.Cell(row, ColId).Style.Font.FontColor = XLColor.Gray;

            // Low stock rows are light red, like on the Stock page.
            if (p.IsLow)
                ws.Range(row, ColItem, row, ColLastChecked).Style.Fill.BackgroundColor = lowFill;

            ws.Cell(row, ColStorage).Style.Fill.BackgroundColor = StorageFill(p.StorageZone);

            // Next expiry: red when within the reminder days, with a warning mark when already expired.
            var next = p.NextExpiry;
            if (next != null)
            {
                var cell = ws.Cell(row, ColNextExpiry);
                cell.Value = next.Value;

                if (next.Value.Date < today)
                {
                    cell.Style.NumberFormat.Format = "\"⚠ \"dd mmm yyyy";
                    cell.Style.Font.FontColor = red;
                    cell.Style.Font.Bold = true;
                }
                else
                {
                    cell.Style.NumberFormat.Format = "dd mmm yyyy";
                    if (next.Value.Date <= today.AddDays(Product.ExpiryReminderDays))
                    {
                        cell.Style.Font.FontColor = red;
                        cell.Style.Font.Bold = true;
                    }
                }
                cell.Style.Alignment.Horizontal = XLAlignmentHorizontalValues.Left;
            }

            // Yellow fill-in cells
            ws.Range(row, ColCountBundles, row, ColNewExpiry).Style.Fill.BackgroundColor = cream;
            ws.Cell(row, ColNewExpiry).Style.DateFormat.Format = "dd/MM/yyyy";

            row++;
        }

        int lastRow = row - 1;

        // Borders
        var table = ws.Range(HeaderRow, 1, lastRow, LastCol);
        table.Style.Border.InsideBorder = XLBorderStyleValues.Thin;
        table.Style.Border.InsideBorderColor = line;
        table.Style.Border.OutsideBorder = XLBorderStyleValues.Medium;
        table.Style.Border.OutsideBorderColor = brown;

        // Widths (the title text in rows 1-3 must not widen column A)
        ws.Columns().AdjustToContents(HeaderRow, lastRow);
        ws.Column(ColItem).Width = 34;
        ws.Column(ColStorage).Width = 11;
        ws.Column(ColBundleSize).Width = 16;
        ws.Column(ColNextExpiry).Width = 15;
        ws.Column(ColCountBundles).Width = 12;
        ws.Column(ColCountLoose).Width = 12;
        ws.Column(ColNewExpiry).Width = 20;
        ws.Column(ColId).Width = 6;
        ws.Row(HeaderRow).Height = 32;

        ws.SheetView.FreezeRows(HeaderRow);

        // Printing: landscape A4, one page wide, header repeats on every page
        ws.PageSetup.PageOrientation = XLPageOrientation.Landscape;
        ws.PageSetup.PaperSize = XLPaperSize.A4Paper;
        ws.PageSetup.PagesWide = 1;
        ws.PageSetup.PagesTall = 0;
        ws.PageSetup.SetRowsToRepeatAtTop(HeaderRow, HeaderRow);

        using var stream = new MemoryStream();
        wb.SaveAs(stream);
        return stream.ToArray();
    }

    // ---------- Upload ----------
    public static SheetReadResult Read(Stream stream)
    {
        var result = new SheetReadResult();

        try
        {
            using var wb = new XLWorkbook(stream);
            ReadSheet(wb, result);
        }
        catch (Exception)
        {
            result.FatalError = "The file could not be read. Please upload the .xlsx sheet that was downloaded from this app.";
        }

        return result;
    }

    private static void ReadSheet(XLWorkbook wb, SheetReadResult result)
    {
        var ws = wb.Worksheets.FirstOrDefault();
        if (ws == null)
        {
            result.FatalError = "The Excel file has no sheet in it.";
            return;
        }

        // Find the header row by the column names, so the column order does not matter.
        int headerRow = 0, colId = 0, colItem = 0, colBundles = 0, colLoose = 0, colExpiry = 0;

        for (int r = 1; r <= 20 && headerRow == 0; r++)
        {
            var map = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            for (int c = 1; c <= 30; c++)
            {
                var text = ws.Cell(r, c).GetString().Trim();
                if (text.Length > 0 && !map.ContainsKey(text)) map[text] = c;
            }

            if (map.TryGetValue("ID", out colId) &&
                map.TryGetValue("Item", out colItem) &&
                map.TryGetValue("Counted bundles", out colBundles) &&
                map.TryGetValue("Counted loose", out colLoose))
            {
                headerRow = r;
                var expiryKey = map.Keys.FirstOrDefault(k => k.StartsWith("Expiry date", StringComparison.OrdinalIgnoreCase));
                colExpiry = expiryKey != null ? map[expiryKey] : 0;
            }
        }

        if (headerRow == 0)
        {
            result.FatalError = "This does not look like the sheet downloaded from this app. " +
                                "Please download a fresh sheet, fill it in, and upload that one.";
            return;
        }

        int lastRow = ws.LastRowUsed()?.RowNumber() ?? headerRow;

        for (int r = headerRow + 1; r <= lastRow; r++)
        {
            // Only rows with a numeric ID are items (category heading rows are skipped).
            var idValue = ws.Cell(r, colId).Value;
            if (!idValue.IsNumber) continue;
            double idNumber = idValue.GetNumber();
            if (idNumber < 1 || idNumber > int.MaxValue || idNumber != Math.Floor(idNumber)) continue;

            string item = ws.Cell(r, colItem).GetString().Trim();
            string label = $"Row {r} ({(item.Length > 0 ? item : "no name")})";

            bool okBundles = TryReadCount(ws.Cell(r, colBundles), out int bundles, out bool bundlesBlank);
            bool okLoose = TryReadCount(ws.Cell(r, colLoose), out int loose, out bool looseBlank);

            if (!okBundles)
            {
                result.Errors.Add($"{label}: 'Counted bundles' must be a whole number, 0 or more.");
                continue;
            }
            if (!okLoose)
            {
                result.Errors.Add($"{label}: 'Counted loose' must be a whole number, 0 or more.");
                continue;
            }

            // Nothing written in either column = not counted, skip.
            if (bundlesBlank && looseBlank)
            {
                result.BlankRows++;
                continue;
            }

            DateTime? expiry = null;
            if (colExpiry > 0 && !TryReadDate(ws.Cell(r, colExpiry), out expiry))
            {
                result.Errors.Add($"{label}: the expiry date is not a valid date (use dd/MM/yyyy).");
                continue;
            }

            result.Counts.Add(new SheetCount
            {
                Row = r,
                ProductId = (int)idNumber,
                ItemName = item,
                Bundles = bundles,
                Loose = loose,
                Expiry = expiry?.Date
            });
        }
    }

    // Blank is allowed (counts as 0 when the other column is filled).
    private static bool TryReadCount(IXLCell cell, out int value, out bool blank)
    {
        value = 0;
        blank = false;
        var v = cell.Value;

        if (v.IsBlank)
        {
            blank = true;
            return true;
        }

        if (v.IsNumber)
        {
            double d = v.GetNumber();
            if (d < 0 || d > MaxCount || d != Math.Floor(d)) return false;
            value = (int)d;
            return true;
        }

        if (v.IsText)
        {
            string text = v.GetText().Trim();
            if (text.Length == 0)
            {
                blank = true;
                return true;
            }
            return int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value) && value <= MaxCount;
        }

        return false;
    }

    private static bool TryReadDate(IXLCell cell, out DateTime? date)
    {
        date = null;
        var v = cell.Value;

        if (v.IsBlank) return true;

        if (v.IsDateTime)
        {
            date = v.GetDateTime();
            return true;
        }

        if (v.IsNumber)
        {
            try
            {
                date = DateTime.FromOADate(v.GetNumber());
                return true;
            }
            catch
            {
                return false;
            }
        }

        if (v.IsText)
        {
            string text = v.GetText().Trim();
            if (text.Length == 0) return true;
            if (DateTime.TryParse(text, CultureInfo.GetCultureInfo("en-GB"), DateTimeStyles.None, out var parsed))
            {
                date = parsed;
                return true;
            }
        }

        return false;
    }
}