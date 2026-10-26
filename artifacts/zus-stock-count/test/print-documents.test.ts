import assert from "node:assert/strict";
import test from "node:test";
import {
  purchaseOrderDocumentName,
  stockTakeDocumentName,
} from "../src/lib/print-documents";

test("purchase-order PDF name uses the issued order number", () => {
  assert.equal(purchaseOrderDocumentName("PO-2610001"), "PO-2610001");
});

test("stock-take PDF name uses Kuala Lumpur year-month and a padded count id", () => {
  assert.equal(stockTakeDocumentName("2026-10-26T03:00:00.000Z", 1), "ST-2610001");
});

test("stock-take PDF month follows Kuala Lumpur time at month boundaries", () => {
  assert.equal(stockTakeDocumentName("2026-09-30T17:00:00.000Z", 12), "ST-2610012");
});
