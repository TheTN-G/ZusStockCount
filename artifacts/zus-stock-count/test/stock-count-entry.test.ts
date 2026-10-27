import assert from "node:assert/strict";
import test from "node:test";
import { countTotal, hasCountInput, splitCount } from "../src/stock-count-entry";

test("a blank count is unchanged, while an explicit zero is a count", () => {
  assert.equal(hasCountInput({ bundles: "", loose: "" }), false);
  assert.equal(countTotal({ bundles: "", loose: "" }, 12), null);
  assert.equal(hasCountInput({ bundles: "", loose: "0" }), true);
  assert.equal(countTotal({ bundles: "", loose: "0" }, 12), 0);
});

test("extra loose units remain raw until review, then roll into bundles", () => {
  const raw = { bundles: "", loose: "120" };
  assert.equal(countTotal(raw, 12), 120);
  assert.deepEqual(splitCount(countTotal(raw, 12)!, 12), {
    bundles: "10",
    loose: "0",
  });
});

test("bundle and loose quantities combine into base units", () => {
  assert.equal(countTotal({ bundles: "2", loose: "3" }, 10), 23);
  assert.deepEqual(splitCount(23, 10), { bundles: "2", loose: "3" });
});

test("invalid fractional, negative, or unsafe counts are rejected", () => {
  assert.equal(countTotal({ bundles: "1.5", loose: "0" }, 10), null);
  assert.equal(countTotal({ bundles: "", loose: "-1" }, 10), null);
  assert.equal(countTotal({ bundles: "9007199254740992", loose: "0" }, 10), null);
});

test("unbundled products count directly in their base unit", () => {
  assert.deepEqual(splitCount(120, 1), { bundles: "", loose: "120" });
  assert.equal(countTotal({ bundles: "", loose: "120" }, 1), 120);
});
