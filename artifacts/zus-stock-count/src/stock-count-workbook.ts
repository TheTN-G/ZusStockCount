import ExcelJS from "exceljs";
import type { CountDraft } from "./stock-count-entry";

export type WorkbookCountLine = {
  productId: number;
  sectionId: number | null;
  sectionName?: string | null;
};

export type WorkbookCountImport = {
  counts: Record<string, CountDraft>;
  issues: string[];
  rowCount: number;
  exceededLimit: boolean;
};

const keyFor = (productId: number, sectionId: number | null) =>
  `${productId}:${sectionId ?? "outlet"}`;

const isBlank = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && !value.trim());

const normalizeHeader = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[_/-]+/g, " ")
    .replace(/\s+/g, " ");

function wholeCount(value: unknown): number | null {
  if (isBlank(value)) return null;
  if (typeof value === "boolean" || value instanceof Date) return Number.NaN;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : Number.NaN;
}

export async function parseStockCountWorkbook(
  buffer: ArrayBuffer,
  countLines: WorkbookCountLine[],
): Promise<WorkbookCountImport> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const lineMap = new Map(
    countLines.map((line) => [keyFor(line.productId, line.sectionId), line]),
  );
  const linesByProduct = new Map<number, WorkbookCountLine[]>();
  for (const line of countLines) {
    linesByProduct.set(line.productId, [
      ...(linesByProduct.get(line.productId) || []),
      line,
    ]);
  }

  const counts: Record<string, CountDraft> = {};
  const issues: string[] = [];
  const seen = new Set<string>();
  let rowCount = 0;
  let exceededLimit = false;

  workbook.eachSheet((sheet) => {
    if (["count guide", "instructions"].includes(sheet.name.trim().toLocaleLowerCase())) {
      return;
    }

    let columns:
      | {
          productId: number;
          bundles?: number;
          loose?: number;
          total?: number;
          sectionId?: number;
          sectionName?: number;
        }
      | undefined;
    let currentGroup = "";

    sheet.eachRow((row, rowNumber) => {
      if (exceededLimit) return;
      const textAt = (column: number) =>
        String(row.getCell(column).text || row.getCell(column).value || "").trim();
      const cells = Array.from({ length: row.cellCount }, (_, index) =>
        normalizeHeader(textAt(index + 1)),
      );
      const findColumn = (...names: string[]) => {
        const index = cells.findIndex((value) => names.includes(value));
        return index < 0 ? undefined : index + 1;
      };
      const productIdColumn = findColumn("product id", "id");
      const bundleColumn = findColumn("bundle count", "bundles", "bundle");
      const looseColumn = findColumn(
        "loose count",
        "loose base units",
        "loose units",
        "loose",
      );
      const totalColumn = findColumn(
        "counted stock",
        "counted quantity",
        "physical count",
        "quantity",
      );

      if (
        productIdColumn &&
        (bundleColumn || looseColumn || totalColumn)
      ) {
        columns = {
          productId: productIdColumn,
          ...(bundleColumn ? { bundles: bundleColumn } : {}),
          ...(looseColumn ? { loose: looseColumn } : {}),
          ...(totalColumn ? { total: totalColumn } : {}),
          ...(findColumn("section id", "storage area id")
            ? { sectionId: findColumn("section id", "storage area id")! }
            : {}),
          ...(findColumn("stock section", "section", "storage area")
            ? { sectionName: findColumn("stock section", "section", "storage area")! }
            : {}),
        };
        return;
      }

      const uniqueText = [...new Set(cells.filter(Boolean))];
      const firstCell = textAt(1);
      if (
        columns &&
        uniqueText.length === 1 &&
        firstCell &&
        !Number.isSafeInteger(Number(firstCell))
      ) {
        currentGroup = firstCell;
        return;
      }
      if (!columns) {
        if (firstCell && uniqueText.length === 1) currentGroup = firstCell;
        return;
      }

      const rawId = row.getCell(columns.productId).value;
      const bundleCell = columns.bundles
        ? row.getCell(columns.bundles).value
        : "";
      const looseCell = columns.loose
        ? row.getCell(columns.loose).value
        : "";
      const totalCell = columns.total ? row.getCell(columns.total).value : "";
      if (isBlank(rawId)) {
        if (
          isBlank(bundleCell) &&
          isBlank(looseCell) &&
          isBlank(totalCell) &&
          firstCell
        ) {
          currentGroup = firstCell;
        }
        return;
      }
      if (
        isBlank(bundleCell) &&
        isBlank(looseCell) &&
        isBlank(totalCell)
      ) {
        return;
      }

      rowCount += 1;
      if (rowCount > 5000) {
        exceededLimit = true;
        issues.push("Workbook exceeds the 5,000 row limit.");
        return;
      }

      const productId = Number(rawId);
      if (!Number.isSafeInteger(productId) || productId <= 0) {
        issues.push(`${sheet.name}, row ${rowNumber}: Product ID must be a whole number.`);
        return;
      }
      const bundles = wholeCount(bundleCell);
      const loose = wholeCount(looseCell);
      const total = wholeCount(totalCell);
      if (
        Number.isNaN(bundles) ||
        Number.isNaN(loose) ||
        Number.isNaN(total)
      ) {
        issues.push(
          `${sheet.name}, row ${rowNumber}: counts must be whole numbers of 0 or more.`,
        );
        return;
      }

      let line: WorkbookCountLine | undefined;
      if (columns.sectionId) {
        const rawSection = row.getCell(columns.sectionId).value;
        const sectionId = isBlank(rawSection) ? null : Number(rawSection);
        if (
          sectionId === null ||
          (Number.isSafeInteger(sectionId) && sectionId > 0)
        ) {
          line = lineMap.get(keyFor(productId, sectionId));
        }
      } else {
        const candidates = linesByProduct.get(productId) || [];
        const rowSection = columns.sectionName
          ? textAt(columns.sectionName)
          : "";
        const wantedSection = rowSection || currentGroup;
        line = wantedSection
          ? candidates.find(
              (candidate) =>
                (candidate.sectionName || "Outlet total").toLocaleLowerCase() ===
                wantedSection.toLocaleLowerCase(),
            )
          : candidates.length === 1
            ? candidates[0]
            : undefined;
      }

      if (!line) {
        issues.push(
          `${sheet.name}, row ${rowNumber}: unknown product and stock-section pair; it remains available for manual entry.`,
        );
        return;
      }

      const key = keyFor(line.productId, line.sectionId);
      if (seen.has(key)) {
        issues.push(`${sheet.name}, row ${rowNumber}: duplicate product-section pair.`);
        return;
      }
      seen.add(key);
      if (total !== null) {
        counts[key] = { bundles: "", loose: String(total) };
      } else {
        counts[key] = {
          bundles: bundles === null ? "" : String(bundles),
          loose: loose === null ? "" : String(loose),
        };
      }
    });
  });

  return { counts, issues, rowCount, exceededLimit };
}
