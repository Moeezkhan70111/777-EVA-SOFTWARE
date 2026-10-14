import test from "node:test";
import assert from "node:assert/strict";
import { formatManualProductionCode, manualProductionCartons, MANUAL_PRODUCTION_MAX_DOZENS } from "./manualProduction.js";

test("dozens become cartons by the one rule: 1 dozen is 2 cartons, a half dozen is 1", () => {
  assert.deepEqual(manualProductionCartons("10"), { ok: true, dozens: 10, cartons: 20 });
  assert.deepEqual(manualProductionCartons("7.5"), { ok: true, dozens: 7.5, cartons: 15 });
  assert.deepEqual(manualProductionCartons(0.5), { ok: true, dozens: 0.5, cartons: 1 });
});

test("anything that is not whole cartons, or not a sensible quantity, is refused with a reason", () => {
  for (const input of ["", "  ", "abc", "0", "-2", "1.25", "0.1", String(MANUAL_PRODUCTION_MAX_DOZENS + 1), "Infinity", null, undefined]) {
    const result = manualProductionCartons(input);
    assert.equal(result.ok, false, `expected ${String(input)} to be refused`);
    if (!result.ok) assert.ok(result.reason.length > 10);
  }
  assert.equal(manualProductionCartons(String(MANUAL_PRODUCTION_MAX_DOZENS)).ok, true);
});

test("an entry's number reads MAN-000001", () => {
  assert.equal(formatManualProductionCode(1), "MAN-000001");
  assert.equal(formatManualProductionCode(1234), "MAN-001234");
});
