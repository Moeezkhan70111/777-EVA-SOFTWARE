import test from "node:test";
import assert from "node:assert/strict";
import { CLOCK_SKEW_LIMIT_MS, clockSkewOverLimit, measureClockSkew } from "./clockSkew.js";

const SERVER = "Thu, 05 Nov 2026 09:00:00 GMT";
const SERVER_MS = Date.parse(SERVER);
const HOUR_MS = 60 * 60_000;

test("a clock ahead of the cloud reads positive, one behind it negative", () => {
  assert.equal(measureClockSkew(SERVER, SERVER_MS + 1000), 1000);
  assert.equal(measureClockSkew(SERVER, SERVER_MS - 1000), -1000);
});

test("a reply with no usable date is no reading, never a reading of zero", () => {
  assert.equal(measureClockSkew(null, SERVER_MS), null);
  assert.equal(measureClockSkew("not a date", SERVER_MS), null);
});

test("no reading says nothing: a computer working offline is not warned", () => {
  assert.equal(clockSkewOverLimit(null), null);
});

test("inside the limit says nothing, either way", () => {
  assert.equal(clockSkewOverLimit(0), null);
  assert.equal(clockSkewOverLimit(CLOCK_SKEW_LIMIT_MS - 1), null);
  assert.equal(clockSkewOverLimit(-(CLOCK_SKEW_LIMIT_MS - 1)), null);
});

test("at the limit it speaks, either way", () => {
  assert.deepEqual(clockSkewOverLimit(CLOCK_SKEW_LIMIT_MS), { direction: "AHEAD", minutes: 5 });
  assert.deepEqual(clockSkewOverLimit(-CLOCK_SKEW_LIMIT_MS), { direction: "BEHIND", minutes: 5 });
});

test("PC2's October clock, 22 hours out, is caught", () => {
  assert.deepEqual(clockSkewOverLimit(measureClockSkew(SERVER, SERVER_MS - 22 * HOUR_MS)), { direction: "BEHIND", minutes: 1320 });
});
