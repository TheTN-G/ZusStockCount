import assert from "node:assert/strict";
import { test } from "node:test";
import { filterExpiryRadarBatches } from "../src/lib/expiry-window";

test("expiry radar includes positive batches from today through the seventh day", () => {
  const batches = [
    { id: "yesterday", quantity: 1, expiryDate: "2026-10-24T00:00:00.000Z" },
    { id: "today", quantity: 1, expiryDate: "2026-10-25T00:00:00.000Z" },
    { id: "within-window", quantity: 2, expiryDate: "2026-10-28T00:00:00.000Z" },
    { id: "seventh-day", quantity: 1, expiryDate: "2026-11-01T00:00:00.000Z" },
    { id: "after-window", quantity: 1, expiryDate: "2026-11-02T00:00:00.000Z" },
    { id: "depleted", quantity: 0, expiryDate: "2026-10-28T00:00:00.000Z" },
    { id: "no-expiry", quantity: 1, expiryDate: null },
  ];

  assert.deepEqual(
    filterExpiryRadarBatches(batches, new Date("2026-10-25T23:59:00.000Z")).map(
      ({ id }) => id,
    ),
    ["today", "within-window", "seventh-day"],
  );
});

test("expiry radar excludes negative-quantity batches", () => {
  assert.deepEqual(
    filterExpiryRadarBatches(
      [{ quantity: -1, expiryDate: "2026-10-25" }],
      new Date("2026-10-25T12:00:00.000Z"),
    ),
    [],
  );
});
