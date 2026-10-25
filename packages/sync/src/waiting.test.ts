import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SyncEnvelope } from "./contract.js";
import { parkEvent } from "./parking.js";
import { HEALTH_KEEPALIVE_MS, buildHealthReport, shouldReport } from "./healthReport.js";
import { describeWaiting, recordNeeded, waitCause, waitingSummary, waitTier } from "./waiting.js";

// A WAIT IS NEVER SILENT (waiting.ts). The park says what waits, for what, since when, and which
// material it leaves incomplete -- the stock screen marks that row, and the cloud report carries it.

const MIGRATION_091 = path.resolve(import.meta.dirname, "../../../migrations/sqlite/091_sync_inbox_parked.up.sql");
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const BACKOFF = { baseMs: 30_000, maxMs: 900_000 };

const openPark = (): DatabaseSync => {
  const raw = new DatabaseSync(":memory:");
  for (const statement of fs.readFileSync(MIGRATION_091, "utf8").split(";")) if (statement.trim()) raw.exec(statement.trim());
  return raw;
};

const envelope = (aggregateType: string, aggregateId: string, payload: Record<string, unknown>): SyncEnvelope => ({
  dedupeKey: `${aggregateType}:${aggregateId}:1`,
  aggregateType,
  aggregateId,
  operation: "INSERT",
  payload,
  originDeviceId: "dev-holder",
  createdAt: "2026-10-20T00:00:00.000Z",
});

test("every reason a contract parks with reads as a cause", () => {
  assert.deepEqual(waitCause("WAITING_FOR:INVENTORY_CATEGORY:c-17"), { kind: "MISSING", record: "INVENTORY_CATEGORY", id: "c-17" });
  assert.deepEqual(waitCause("UNKNOWN_INVENTORY_UNIT:u-kg"), { kind: "MISSING", record: "INVENTORY_UNIT", id: "u-kg" });
  assert.deepEqual(waitCause("STILL_IN_USE:INVENTORY_CATEGORY:c-1"), { kind: "IN_USE", record: "INVENTORY_CATEGORY", id: "c-1" });
  assert.deepEqual(waitCause("NAME_TAKEN:parties.party_name"), { kind: "NAME_TAKEN", column: "parties.party_name" });
  assert.deepEqual(waitCause("SOMETHING_NEW"), { kind: "OTHER", code: "SOMETHING_NEW" });
});

test("under an hour is waiting, over an hour stuck, over a day stale", () => {
  assert.equal(waitTier(59 * 60 * 1000), "WAITING");
  assert.equal(waitTier(HOUR), "STUCK");
  assert.equal(waitTier(24 * HOUR), "STALE");
});

test("the summary names what waits, for what, since when, and which material it leaves incomplete", () => {
  const park = openPark();
  const material = envelope("INVENTORY_ITEM", "i-1", {
    recordId: "i-1", revision: 2, deleted: false,
    body: { row: { id: "i-1", display_name: "NAWAAR — 5 SOOTAR — BLACK" }, children: {} },
  });
  const run = envelope("RAW_MATERIAL_QR_BATCH", "rmb-1", { batchId: "rmb-1", itemId: "i-2", partyId: "p-9" });
  parkEvent(park, { seq: 40, envelope: material, reason: "WAITING_FOR:INVENTORY_CATEGORY:c-17", nowMs: NOW - 3 * 24 * HOUR }, BACKOFF);
  parkEvent(park, { seq: 41, envelope: run, reason: "UNKNOWN_PARTY:p-9", nowMs: NOW - 2 * HOUR }, BACKOFF);
  // Found waiting again later: still the same entry, still dated from the first time.
  parkEvent(park, { seq: 40, envelope: material, reason: "WAITING_FOR:INVENTORY_CATEGORY:c-17", nowMs: NOW - HOUR }, BACKOFF);

  const summary = waitingSummary(park, NOW);
  assert.equal(summary.entries.length, 2);
  assert.deepEqual({ waiting: summary.waiting, stuck: summary.stuck, stale: summary.stale }, { waiting: 0, stuck: 1, stale: 1 });
  assert.equal(summary.oldestSince, new Date(NOW - 3 * 24 * HOUR).toISOString());

  const [stale, stuck] = summary.entries;
  assert.equal(stale?.tier, "STALE");
  assert.equal(stale?.itemId, "i-1", "the stock screen marks this material's row");
  assert.deepEqual(describeWaiting(stale!), {
    subject: "Material NAWAAR — 5 SOOTAR — BLACK",
    waitingFor: "a category not on this computer yet (c-17)",
    needs: "INVENTORY_CATEGORY:c-17",
  });
  assert.equal(stuck?.itemId, "i-2", "a label run leaves its material incomplete too");
  assert.equal(describeWaiting(stuck!).waitingFor, "a party not on this computer yet (p-9)");
});

test("nothing parked, or no park at all, is an empty summary", () => {
  assert.deepEqual(waitingSummary(openPark(), NOW), { entries: [], waiting: 0, stuck: 0, stale: 0, oldestSince: null });
  assert.equal(waitingSummary(new DatabaseSync(":memory:"), NOW).entries.length, 0);
});

// ─── the report: one row per computer, sent on change or every 15 minutes ───


test("the report carries counts and up to five waits worth telling, in words", () => {
  const park = openPark();
  for (let n = 0; n < 7; n += 1) {
    const waiting = envelope("INVENTORY_ITEM", `i-${String(n)}`, { recordId: `i-${String(n)}`, revision: 1, deleted: false, body: { row: { id: `i-${String(n)}`, display_name: `Material ${String(n)}` }, children: {} } });
    parkEvent(park, { seq: n, envelope: { ...waiting, dedupeKey: `INVENTORY_ITEM:i-${String(n)}:1` }, reason: "WAITING_FOR:INVENTORY_CATEGORY:c-1", nowMs: NOW - (2 + n) * HOUR }, BACKOFF);
  }
  const fresh = envelope("PARTY", "p-1", { recordId: "p-1", revision: 1, deleted: false, body: { row: { id: "p-1", party_name: "New" }, children: {} } });
  parkEvent(park, { seq: 99, envelope: fresh, reason: "WAITING_FOR:PARTY_GROUP:g-1", nowMs: NOW - 60_000 }, BACKOFF);

  const report = buildHealthReport(waitingSummary(park, NOW), 2, 3);
  assert.deepEqual({ waiting: report.waiting, stuck: report.stuck, stale: report.stale }, { waiting: 1, stuck: 7, stale: 0 });
  assert.equal(report.sample.length, 5, "at most five, oldest first");
  assert.equal(report.sample[0]?.subject, "Material Material 6");
  assert.equal(report.sample[0]?.needs, "INVENTORY_CATEGORY:c-1", "names the record whose sending would end the wait");
  assert.ok(report.sample.every((item) => !item.subject.includes("New")), "an ordinary under-an-hour wait is not reported as a problem");
  assert.deepEqual([report.deadLetters, report.unsentMarks], [2, 3]);
});

test("a report goes when it says something new, or as a keepalive -- not every pass", () => {
  const quiet = buildHealthReport(waitingSummary(openPark(), NOW), 0, 0);
  assert.equal(shouldReport(null, quiet, NOW), true, "the first one always goes");
  const last = { report: quiet, sentAtMs: NOW };
  assert.equal(shouldReport(last, quiet, NOW + 60_000), false, "the same, a minute later: nothing sent");
  assert.equal(shouldReport(last, { ...quiet, deadLetters: 1 }, NOW + 60_000), true, "something changed");
  assert.equal(shouldReport(last, quiet, NOW + HEALTH_KEEPALIVE_MS), true, "the keepalive");
});

test("a record moved aside for another's name is incomplete too, under the name it really had", () => {
  const park = openPark();
  park.exec("CREATE TABLE sync_displaced_records (aggregate_type TEXT, record_id TEXT, original_json TEXT, displaced_at TEXT)");
  park.prepare("INSERT INTO sync_displaced_records VALUES ('PARTY', 'p-a', ?, ?)").run('{"party_name":"ALPHA"}', new Date(NOW - 2 * HOUR).toISOString());
  const summary = waitingSummary(park, NOW);
  assert.equal(summary.stuck, 1);
  assert.deepEqual(describeWaiting(summary.entries[0]!), {
    subject: "Party ALPHA",
    waitingFor: "its own update: its name was moved aside for another record's",
    needs: "PARTY:p-a",
  });
});

test("only a wait that sending a master record would end names one", () => {
  const entry = (cause: ReturnType<typeof waitCause>, aggregateType = "INVENTORY_ITEM") => ({
    dedupeKey: "k", aggregateType, aggregateId: "x-1", name: null, cause, since: "", ageMs: 0, tier: "WAITING" as const, itemId: null,
  });
  assert.equal(recordNeeded(entry(waitCause("WAITING_FOR:INVENTORY_UNIT:u-kg"))), "INVENTORY_UNIT:u-kg");
  assert.equal(recordNeeded(entry(waitCause("UNKNOWN_PARTY:p-9"), "RAW_MATERIAL_QR_BATCH")), "PARTY:p-9");
  assert.equal(recordNeeded(entry(waitCause("UNKNOWN_PRODUCT_VARIANT:v-1"))), null, "not a master record: nothing to send again");
  assert.equal(recordNeeded(entry(waitCause("STILL_IN_USE:INVENTORY_CATEGORY:c-1"))), null);
  assert.equal(recordNeeded(entry(waitCause("NAME_TAKEN:parties.party_name"))), null);
});
