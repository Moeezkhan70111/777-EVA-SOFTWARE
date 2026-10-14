import test from "node:test";
import assert from "node:assert/strict";
import { businessDateOf, businessDayStartIso } from "./contractorLedger.js";
import { RECEIVE_PRODUCTION_OUTCOME } from "./productionReceipt.js";

// Receive Production lists a BUSINESS day (Asia/Karachi, UTC+5) whatever the computer's own zone.

test("a business day starts at Karachi midnight, as a UTC instant", () => {
  assert.equal(businessDayStartIso("2026-10-14"), "2026-10-13T19:00:00.000Z");
  assert.equal(businessDayStartIso("2026-10-14", 1), "2026-10-14T19:00:00.000Z");
  assert.equal(businessDayStartIso("2026-03-01", -1), "2026-02-27T19:00:00.000Z", "month edges roll over");
});

test("businessDayStartIso is the inverse of businessDateOf at the day's edges", () => {
  const start = businessDayStartIso("2026-10-14")!;
  assert.equal(businessDateOf(start), "2026-10-14");
  assert.equal(businessDateOf(new Date(Date.parse(start) - 1).toISOString()), "2026-10-13");
});

test("a malformed date has no window", () => {
  assert.equal(businessDayStartIso("14/10/2026"), null);
  assert.equal(businessDayStartIso(""), null);
});

test("every scan ends in one named outcome", () => {
  assert.deepEqual(Object.values(RECEIVE_PRODUCTION_OUTCOME).sort(), [
    "ALREADY_RECEIVED", "ERROR", "INELIGIBLE", "INVALID_QR", "NOT_GENERATED", "RAW_MATERIAL_QR", "RECEIVED",
  ]);
});
