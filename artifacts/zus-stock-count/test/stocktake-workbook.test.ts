import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import {
  STOCKTAKE_HEADERS,
  STOCKTAKE_MANIFEST_MARKER,
  STOCKTAKE_MANIFEST_SHEET,
  validateStocktakeWorkbook,
  type StocktakeSheetRows,
} from "../src/lib/stocktake-workbook";

const countId = 27;
const outletId = 4;
const lines = [
  {
    productId: 101,
    productName: "Oat milk",
    sectionId: 12,
    sectionName: "Chiller",
    unit: "carton",
    expectedQuantity: 8,
  },
  {
    productId: 102,
    productName: "Coffee beans",
    sectionId: 13,
    sectionName: "Dry store",
    unit: "bag",
    expectedQuantity: 3.5,
  },
];

function makeWorkbook(rows: unknown[][], count = countId, outlet = outletId): StocktakeSheetRows[] {
  return [
    {
      name: "Chiller",
      rows: [
        [...STOCKTAKE_HEADERS],
        ["Oat milk", "Chiller", "carton", 8, 0, 101, 12, count],
        ...rows,
      ],
    },
    {
      name: "Dry store",
      rows: [
        [...STOCKTAKE_HEADERS],
        ["Coffee beans", "Dry store", "bag", 3.5, 6, 102, 13, count],
      ],
    },
    {
      name: STOCKTAKE_MANIFEST_SHEET,
      rows: [[STOCKTAKE_MANIFEST_MARKER], [count], [outlet]],
    },
  ];
}

test("accepts complete counts only for the matching outlet and session", () => {
  const result = validateStocktakeWorkbook({
    sheets: makeWorkbook([]),
    countId,
    outletId,
    lines,
  });

  assert.deepEqual(result.issues, []);
  assert.equal(Object.keys(result.counts).length, 2);
  assert.equal(result.counts["101:12"], "0");
  assert.equal(result.counts["102:13"], "6");
  assert.equal(result.validRows.length, 2);
});

test("validates an Excel workbook after it has been saved and reopened", async () => {
  const workbook = new ExcelJS.Workbook();
  const section = workbook.addWorksheet("Area - Chiller");
  section.addRow([...STOCKTAKE_HEADERS]);
  section.addRow(["Oat milk", "Chiller", "carton", 8, 5, 101, 12, countId]);
  const manifest = workbook.addWorksheet(STOCKTAKE_MANIFEST_SHEET);
  manifest.addRows([[STOCKTAKE_MANIFEST_MARKER], [countId], [outletId]]);
  manifest.state = "hidden";

  const bytes = await workbook.xlsx.writeBuffer();
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(bytes);
  const sheets = reopened.worksheets.map((sheet) => {
    const rows: unknown[][] = [];
    sheet.eachRow((row) => {
      rows.push(Array.from({ length: STOCKTAKE_HEADERS.length }, (_, index) => row.getCell(index + 1).value));
    });
    return { name: sheet.name, rows };
  });

  const result = validateStocktakeWorkbook({ sheets, countId, outletId, lines: [lines[0]] });
  assert.deepEqual(result.issues, []);
  assert.equal(result.counts["101:12"], "5");
});

test("rejects duplicate rows and missing physical quantities", () => {
  const sheets = makeWorkbook([["Oat milk", "Chiller", "carton", 8, 2, 101, 12, countId]]);
  sheets[1].rows = [sheets[1].rows[0], ["Coffee beans", "Dry store", "bag", 3.5, "", 102, 13, countId]];

  const result = validateStocktakeWorkbook({ sheets, countId, outletId, lines });

  assert.ok(result.issues.some((issue) => issue.includes("duplicate product and storage area")));
  assert.ok(result.issues.some((issue) => issue.includes("counted quantity is missing")));
  assert.equal(Object.keys(result.counts).length, 1);
  assert.equal(result.validRows.length, 1);
});

test("rejects a workbook from another outlet or count session", () => {
  const wrongOutlet = validateStocktakeWorkbook({
    sheets: makeWorkbook([], countId, outletId + 1),
    countId,
    outletId,
    lines,
  });
  const wrongSession = validateStocktakeWorkbook({
    sheets: makeWorkbook([], countId + 1, outletId),
    countId,
    outletId,
    lines,
  });

  assert.ok(wrongOutlet.issues[0].includes("different count session or outlet"));
  assert.ok(wrongSession.issues[0].includes("different count session or outlet"));
});

test("rejects stale line details and invalid quantities", () => {
  const sheets = makeWorkbook([]);
  sheets[0].rows[1][3] = 9;
  sheets[1].rows[1][4] = -1;

  const result = validateStocktakeWorkbook({ sheets, countId, outletId, lines });

  assert.ok(result.issues.some((issue) => issue.includes("stale")));
  assert.ok(result.issues.some((issue) => issue.includes("non-negative whole number")));
  assert.equal(Object.keys(result.counts).length, 0);
});
