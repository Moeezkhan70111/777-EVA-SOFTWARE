import test from "node:test";
import assert from "node:assert/strict";
import {
  CARTONS_PER_DOZEN,
  OPERATIONAL_DAY_START_TIME,
  PAIRS_PER_CARTON,
  PAIRS_PER_DOZEN,
  UNIT_MODEL,
  cartonsToDozens,
  cartonsToPairs,
  dozensToCartons,
  dozensToPairs,
  operationalDayBounds,
  pairsToCartons,
  pairsToDozens,
} from "./units.js";

test("packing units", () => {
  assert.equal(PAIRS_PER_DOZEN, 12);
  assert.equal(CARTONS_PER_DOZEN, 2);
  assert.equal(PAIRS_PER_CARTON, 6);
  assert.equal(dozensToPairs(2.5), 30);
  assert.equal(pairsToDozens(30), 2.5);
  assert.equal(dozensToCartons(1.5), 3);
  assert.equal(cartonsToDozens(3), 1.5);
  assert.equal(cartonsToPairs(3), 18);
  assert.equal(pairsToCartons(18), 3);
});

test("a dispatch scan is one carton: a one-dozen bill line allows exactly two scans", () => {
  const requiredDzn = 1;
  assert.equal(dozensToCartons(requiredDzn), 2);
  assert.equal(dozensToPairs(requiredDzn), cartonsToPairs(dozensToCartons(requiredDzn)));
  assert.equal(UNIT_MODEL.scanUnit, "CARTON");
  assert.equal(UNIT_MODEL.stockUnit, "CARTON");
});

test("operational day runs 06:00 to 06:00 the next calendar day, across month and year ends", () => {
  assert.equal(OPERATIONAL_DAY_START_TIME, "06:00:00.000");
  assert.deepEqual(operationalDayBounds("2026-08-21"), { from: "2026-08-21T06:00:00.000", to: "2026-08-22T06:00:00.000" });
  assert.deepEqual(operationalDayBounds("2026-08-31"), { from: "2026-08-31T06:00:00.000", to: "2026-09-01T06:00:00.000" });
  assert.deepEqual(operationalDayBounds("2026-12-31"), { from: "2026-12-31T06:00:00.000", to: "2027-01-01T06:00:00.000" });
  // A time component on the input is ignored.
  assert.deepEqual(operationalDayBounds("2026-08-21T15:30:00"), { from: "2026-08-21T06:00:00.000", to: "2026-08-22T06:00:00.000" });
});
