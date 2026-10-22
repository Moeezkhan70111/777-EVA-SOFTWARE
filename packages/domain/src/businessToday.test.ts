import test from "node:test";
import assert from "node:assert/strict";
import { businessDateOf, businessToday } from "./contractorLedger.js";

// The regression these pin is specific: Karachi is UTC+5, so for the five hours after local
// midnight the UTC calendar date is still yesterday. Six places used the UTC date as "today",
// two of them to STAMP a voucher. Found 2026-10-23 at 00:50 Karachi, inside the window.

test("the five hours after midnight in Karachi are today, not yesterday", () => {
  // 2026-10-23 00:50 Karachi is 2026-10-22 19:50 UTC. The hour the bug was found in.
  const justAfterMidnight = "2026-10-22T19:50:00.000Z";

  assert.equal(businessDateOf(justAfterMidnight), "2026-10-23");
  // What the six places used to do, kept here so the difference is visible rather than implied.
  assert.equal(justAfterMidnight.slice(0, 10), "2026-10-22");
});

test("the boundary is midnight in Karachi, to the second", () => {
  // 18:59:59 UTC is 23:59:59 Karachi -- still the 22nd.
  assert.equal(businessDateOf("2026-10-22T18:59:59.999Z"), "2026-10-22");
  // 19:00:00 UTC is 00:00:00 Karachi -- the 23rd has begun.
  assert.equal(businessDateOf("2026-10-22T19:00:00.000Z"), "2026-10-23");
});

test("office hours are unaffected, which is why this hid for so long", () => {
  // 09:00 UTC is 14:00 Karachi: the same date either way, so nothing looked wrong by daylight.
  const midAfternoon = "2026-10-23T09:00:00.000Z";
  assert.equal(businessDateOf(midAfternoon), "2026-10-23");
  assert.equal(businessDateOf(midAfternoon), midAfternoon.slice(0, 10));
});

test("it crosses a month and a year correctly", () => {
  assert.equal(businessDateOf("2026-10-31T19:30:00.000Z"), "2026-11-01");
  assert.equal(businessDateOf("2026-12-31T19:30:00.000Z"), "2027-01-01");
  assert.equal(businessDateOf("2026-02-28T19:30:00.000Z"), "2026-03-01");
});

test("it is zero padded, because every caller compares it as a string in SQL", () => {
  // The queries filter `voucher_date <= ?` against a TEXT column, so "2026-1-5" would sort and
  // filter wrongly rather than fail loudly.
  const padded = businessDateOf("2026-01-04T19:30:00.000Z");
  assert.equal(padded, "2026-01-05");
  assert.match(padded, /^\d{4}-\d{2}-\d{2}$/);
});

test("businessToday is that same rule applied to now", () => {
  // This runs at whatever hour the suite runs -- including inside the broken window, which is
  // how the two midnight-flaky tests were noticed in the first place.
  const today = businessToday();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(today, businessDateOf(new Date().toISOString()));
});

test("the offset comes from the timezone database, not from adding five hours", () => {
  // Pakistan observed daylight saving in 2008 and 2009: on 2008-06-01 the offset was UTC+6, so
  // 18:30 UTC was already 00:30 on the 2nd. A hand-rolled +5 would have said the 1st.
  assert.equal(businessDateOf("2008-06-01T18:30:00.000Z"), "2008-06-02");
  // With no DST in force the same clock time is still the 1st.
  assert.equal(businessDateOf("2026-06-01T18:30:00.000Z"), "2026-06-01");
});
