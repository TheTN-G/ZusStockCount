export const STOCKTAKE_MANIFEST_SHEET = "Count session";
export const STOCKTAKE_GUIDE_SHEET = "Count guide";
export const STOCKTAKE_MANIFEST_MARKER = "ZUS_STOCKTAKE";
export const STOCKTAKE_HEADERS = [
  "Product",
  "Storage area",
  "Unit",
  "Expected quantity",
  "Counted quantity",
  "Product ID",
  "Storage area ID",
  "Count session ID",
] as const;

export type StocktakeCountLine = {
  productId: number;
  productName: string;
  sectionId: number | null;
  sectionName: string | null;
  unit: string;
  expectedQuantity: number;
};

export type StocktakeSheetRows = {
  name: string;
  rows: unknown[][];
};

export type StocktakeValidation = {
  counts: Record<string, string>;
  validRows: Array<{ key: string; productName: string; sectionName: string; quantity: number }>;
  issues: string[];
};

export const stocktakeLineKey = (productId: number, sectionId: number | null) =>
  `${productId}:${sectionId ?? "outlet"}`;

const isBlank = (value: unknown) => value === null || value === undefined || value === "";
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function validateStocktakeWorkbook({
  sheets,
  countId,
  outletId,
  lines,
}: {
  sheets: StocktakeSheetRows[];
  countId: number;
  outletId: number;
  lines: StocktakeCountLine[];
}): StocktakeValidation {
  const issues: string[] = [];
  const counts: Record<string, string> = {};
  const validRows: StocktakeValidation["validRows"] = [];
  const manifestSheets = sheets.filter((sheet) => sheet.name === STOCKTAKE_MANIFEST_SHEET);

  if (manifestSheets.length !== 1) {
    return {
      counts,
      validRows,
      issues: ["This workbook is missing its count session details. Download a fresh worksheet for this count."],
    };
  }

  const manifest = manifestSheets[0].rows;
  if (
    manifest[0]?.[0] !== STOCKTAKE_MANIFEST_MARKER ||
    Number(manifest[1]?.[0]) !== countId ||
    Number(manifest[2]?.[0]) !== outletId
  ) {
    return {
      counts,
      validRows,
      issues: ["This worksheet belongs to a different count session or outlet. Download a fresh worksheet for this count."],
    };
  }

  const lineByKey = new Map(lines.map((line) => [stocktakeLineKey(line.productId, line.sectionId), line]));
  const seen = new Set<string>();
  let rowCount = 0;
  const countSheets = sheets.filter(
    (sheet) => sheet.name !== STOCKTAKE_MANIFEST_SHEET && sheet.name !== STOCKTAKE_GUIDE_SHEET,
  );

  for (const sheet of countSheets) {
    const header = sheet.rows[0]?.slice(0, STOCKTAKE_HEADERS.length) ?? [];
    if (
      header.length !== STOCKTAKE_HEADERS.length ||
      header.some((value, index) => value !== STOCKTAKE_HEADERS[index])
    ) {
      issues.push(`${sheet.name}: worksheet headings do not match the downloaded template.`);
      continue;
    }

    for (const [index, row] of sheet.rows.entries()) {
      const rowNumber = index + 1;
      if (rowNumber === 1 || row.slice(0, STOCKTAKE_HEADERS.length).every(isBlank)) continue;
      rowCount += 1;
      if (rowCount > 5000) {
        issues.push("Workbook exceeds the 5,000 row limit.");
        return { counts: {}, validRows: [], issues };
      }

      const [productNameValue, sectionNameValue, unitValue, expectedValue, countedValue, productIdValue, sectionIdValue, rowCountIdValue] = row;
      const productId = Number(productIdValue);
      const sectionId = isBlank(sectionIdValue) ? null : Number(sectionIdValue);
      if (
        !Number.isSafeInteger(productId) ||
        productId <= 0 ||
        (sectionId !== null && (!Number.isSafeInteger(sectionId) || sectionId <= 0))
      ) {
        issues.push(`${sheet.name}, row ${rowNumber}: product or storage area ID is missing or invalid.`);
        continue;
      }

      const key = stocktakeLineKey(productId, sectionId);
      const line = lineByKey.get(key);
      if (!line) {
        issues.push(`${sheet.name}, row ${rowNumber}: product and storage area are not part of this count.`);
        continue;
      }
      if (seen.has(key)) {
        issues.push(`${sheet.name}, row ${rowNumber}: duplicate product and storage area.`);
        continue;
      }
      seen.add(key);

      if (Number(rowCountIdValue) !== countId) {
        issues.push(`${sheet.name}, row ${rowNumber}: this row belongs to a different count session.`);
        continue;
      }
      const expectedQuantity = Number(expectedValue);
      if (
        !Number.isFinite(expectedQuantity) ||
        Math.abs(expectedQuantity - line.expectedQuantity) > 1e-9 ||
        text(productNameValue) !== line.productName ||
        text(sectionNameValue) !== (line.sectionName || "Outlet total") ||
        text(unitValue) !== line.unit
      ) {
        issues.push(`${sheet.name}, row ${rowNumber}: product details or expected quantity are stale. Download a fresh worksheet.`);
        continue;
      }
      if (isBlank(countedValue)) {
        issues.push(`${sheet.name}, row ${rowNumber}: counted quantity is missing.`);
        continue;
      }
      const quantity = Number(countedValue);
      if (!Number.isSafeInteger(quantity) || quantity < 0) {
        issues.push(`${sheet.name}, row ${rowNumber}: counted quantity must be a non-negative whole number.`);
        continue;
      }

      counts[key] = String(quantity);
      validRows.push({
        key,
        productName: line.productName,
        sectionName: line.sectionName || "Outlet total",
        quantity,
      });
    }
  }

  for (const [key, line] of lineByKey) {
    if (!seen.has(key)) {
      issues.push(`${line.productName} in ${line.sectionName || "Outlet total"}: row is missing from the workbook.`);
    }
  }

  return { counts, validRows, issues };
}
