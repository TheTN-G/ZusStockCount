import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { parseStockCountWorkbook } from "../src/stock-count-workbook";

async function asArrayBuffer(workbook: ExcelJS.Workbook): Promise<ArrayBuffer> {
  const bytes = await workbook.xlsx.writeBuffer();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

test("imports SOPBox-style grouped sheets without converting entered loose quantities", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Count sheet");
  sheet.addRow(["Chiller", "Chiller", "Chiller", "Chiller", "Chiller", "Chiller"]);
  sheet.addRow(["Product ID", "Product Name", "Bundle Count", "Bundle Unit", "Loose Count", "Base Unit"]);
  sheet.addRow([16, "Milk", 1, "carton", 120, "bottle"]);
  sheet.addRow(["Frozen", "Frozen", "Frozen", "Frozen", "Frozen", "Frozen"]);
  sheet.addRow(["Product ID", "Product Name", "Bundle Count", "Bundle Unit", "Loose Count", "Base Unit"]);
  sheet.addRow([16, "Milk", 0, "carton", 0, "bottle"]);
  workbook.addWorksheet("Instructions").addRow(["Do not count here"]);

  const result = await parseStockCountWorkbook(await asArrayBuffer(workbook), [
    { productId: 16, sectionId: 11, sectionName: "Chiller" },
    { productId: 16, sectionId: 12, sectionName: "Frozen" },
  ]);

  assert.deepEqual(result.counts["16:11"], { bundles: "1", loose: "120" });
  assert.deepEqual(result.counts["16:12"], { bundles: "0", loose: "0" });
  assert.deepEqual(result.issues, []);
});

test("imports the downloadable ZUS template using its hidden product and section IDs", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Chiller");
  sheet.addRow([
    "Product",
    "Stock section",
    "Bundles",
    "Bundle unit",
    "Loose / base units",
    "Product ID",
    "Section ID",
    "Bundle size",
  ]);
  sheet.addRow(["Beans", "Chiller", 2, "carton", 3, 20, 7, 12]);

  const result = await parseStockCountWorkbook(await asArrayBuffer(workbook), [
    { productId: 20, sectionId: 7, sectionName: "Chiller" },
  ]);

  assert.deepEqual(result.counts["20:7"], { bundles: "2", loose: "3" });
  assert.deepEqual(result.issues, []);
});

test("imports outlet worksheets with storage-area columns and counted quantities", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Area - Chiller");
  sheet.addRow([
    "Product",
    "Storage area",
    "Unit",
    "Expected quantity",
    "Counted quantity",
    "Product ID",
    "Storage area ID",
    "Count session ID",
  ]);
  sheet.addRow(["Milk", "Chiller", "bottle", 14, 11, 16, 11, 52]);

  const result = await parseStockCountWorkbook(await asArrayBuffer(workbook), [
    { productId: 16, sectionId: 11, sectionName: "Chiller" },
  ]);

  assert.deepEqual(result.counts["16:11"], { bundles: "", loose: "11" });
  assert.deepEqual(result.issues, []);
});

test("blank lines are skipped, zero is preserved, and duplicate rows are reported", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Count sheet");
  sheet.addRow(["Product ID", "Product Name", "Bundle Count", "Bundle Unit", "Loose Count", "Base Unit"]);
  sheet.addRow([31, "Tea", "", "box", "", "sachet"]);
  sheet.addRow([31, "Tea", 0, "box", 0, "sachet"]);
  sheet.addRow([31, "Tea", 1, "box", 0, "sachet"]);

  const result = await parseStockCountWorkbook(await asArrayBuffer(workbook), [
    { productId: 31, sectionId: null },
  ]);

  assert.deepEqual(result.counts["31:outlet"], { bundles: "0", loose: "0" });
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /duplicate product-section pair/);
});
