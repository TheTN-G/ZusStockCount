import assert from "node:assert/strict";
import test from "node:test";
import {
  accessDenialForRequest,
  effectiveStoreAccess,
  staffMayAccessRequest,
} from "./storeAccess";

test("staff defaults keep useful work areas available while limiting transfers", () => {
  const access = effectiveStoreAccess("staff", null);
  assert.equal(access.dashboard, "view");
  assert.equal(access.stockCount, "edit");
  assert.equal(access.stockTransfers, "none");
});

test("view-only staff can read a section but cannot change it", () => {
  const access = { products: "view" };
  assert.equal(staffMayAccessRequest("/products", "GET", access), true);
  assert.equal(staffMayAccessRequest("/products/3", "PATCH", access), false);
  assert.match(
    accessDenialForRequest("staff", access, "/products/3", "PATCH") || "",
    /view this section/i,
  );
});

test("staff with edit access can add and update but cannot delete", () => {
  const access = { products: "edit" };
  assert.equal(staffMayAccessRequest("/products", "POST", access), true);
  assert.equal(staffMayAccessRequest("/products/3", "PATCH", access), true);
  assert.equal(staffMayAccessRequest("/products/3", "DELETE", access), false);
  assert.match(
    accessDenialForRequest("staff", access, "/products/3", "DELETE") || "",
    /only an owner/i,
  );
});

test("approvals access allows review lists without granting purchase-order edits", () => {
  const access = { approvals: "view", purchaseOrders: "none" };
  assert.equal(staffMayAccessRequest("/purchase-orders", "GET", access), true);
  assert.equal(staffMayAccessRequest("/purchase-orders/7/decision", "POST", access), false);
  assert.notEqual(
    accessDenialForRequest("staff", access, "/purchase-orders/7/decision", "POST"),
    null,
  );
});

test("purchase-order receipts require receiving access instead of purchase-order access", () => {
  const orderEditor = { purchaseOrders: "edit", receiving: "none" };
  const receivingViewer = { purchaseOrders: "none", receiving: "view" };
  const receivingEditor = { purchaseOrders: "none", receiving: "edit" };
  assert.equal(
    staffMayAccessRequest("/purchase-orders/7/receipts", "POST", orderEditor),
    false,
  );
  assert.equal(
    staffMayAccessRequest("/purchase-orders/7/receipts", "POST", receivingViewer),
    false,
  );
  assert.equal(
    staffMayAccessRequest("/purchase-orders/7/receipts", "POST", receivingEditor),
    true,
  );
});

test("owners and managers are not restricted by staff section permissions", () => {
  assert.equal(accessDenialForRequest("owner", {}, "/products", "DELETE"), null);
  assert.equal(accessDenialForRequest("supervisor", {}, "/products", "POST"), null);
});
