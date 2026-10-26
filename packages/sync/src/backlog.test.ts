import test from "node:test";
import assert from "node:assert/strict";
import { drainBacklog, pullBacklog } from "./backlog.js";
import type { DrainResult } from "./drain.js";
import type { PullResult } from "./pull.js";

// A PASS WORKS THROUGH A BACKLOG, WITHIN ITS BUDGET (backlog.ts): batch after batch while each comes
// back full, and never past a short batch, an unreached service, or the budget.

const COUNTS = { PENDING: 0, IN_FLIGHT: 0, FAILED: 0, DEAD_LETTER: 0, SYNCED: 0 } as DrainResult["counts"];

const batch = (leased: number, synced = leased, extra: Partial<DrainResult> = {}): DrainResult => ({
  reclaimed: 0, leased, synced, failed: leased - synced, deadLettered: 0, refusals: [], counts: COUNTS, ...extra,
});

const drainOf = (batches: DrainResult[]) => {
  let calls = 0;
  return { calls: () => calls, runOnce: async () => batches[calls++] ?? batch(0) };
};

const page = (fetched: number, extra: Partial<PullResult> = {}): PullResult => ({
  from: 0, cursor: fetched, fetched, applied: fetched, duplicates: 0, refused: [], parked: 0, ...extra,
});

const BUDGET = { batchSize: 100, maxBatches: 20, withinMs: 40_000, now: () => 0 };

test("full batches keep coming until a short one: everything is sent, and it is all added up", async () => {
  const drain = drainOf([batch(100), batch(100), batch(37), batch(100)]);
  let built = 0;
  const result = await drainBacklog(drain, BUDGET, () => { built += 1; });
  assert.equal(drain.calls(), 3, "stops at the short batch");
  assert.equal(built, 2, "builds before every batch after the first");
  assert.deepEqual([result.leased, result.synced], [237, 237]);
});

test("a batch where nothing was sent, or the service was not reached, ends the pass", async () => {
  const refused = drainOf([batch(100), batch(100, 0), batch(100)]);
  assert.equal((await drainBacklog(refused, BUDGET)).synced, 100);
  assert.equal(refused.calls(), 2, "the same rows would only be refused again this minute");

  const unreached = drainOf([batch(100), batch(0, 0, { transportError: "offline" }), batch(100)]);
  const result = await drainBacklog(unreached, BUDGET);
  assert.equal(unreached.calls(), 2);
  assert.equal(result.transportError, "offline", "the pass still says it could not reach the service");
});

test("the budget holds: no more batches than allowed, and none started after the time limit", async () => {
  const endless = drainOf(Array.from({ length: 50 }, () => batch(100)));
  await drainBacklog(endless, { ...BUDGET, maxBatches: 5 });
  assert.equal(endless.calls(), 5);

  let clock = 0;
  const slow = drainOf(Array.from({ length: 50 }, () => batch(100)));
  await drainBacklog({ runOnce: async () => { clock += 15_000; return slow.runOnce(); } }, { ...BUDGET, now: () => clock });
  assert.equal(slow.calls(), 3, "0s, 15s, 30s started; 45s is past the 40s limit");
});

test("the pull reads page after page while each is full, and adds the pages up", async () => {
  const pages = [page(200), page(200, { from: 200, cursor: 400 }), page(12, { from: 400, cursor: 412, parked: 3 })];
  let calls = 0;
  const result = await pullBacklog({ runOnce: async () => pages[calls++] ?? page(0) }, { ...BUDGET, batchSize: 200 });
  assert.equal(calls, 3);
  assert.deepEqual([result.from, result.cursor, result.fetched, result.applied, result.parked], [0, 412, 412, 412, 3]);
});

test("the pull stops at an unreached service, and keeps the restart flag of the first page", async () => {
  const pages = [page(200, { restartedForProject: true }), page(0, { transportError: "offline" }), page(200)];
  let calls = 0;
  const result = await pullBacklog({ runOnce: async () => pages[calls++] ?? page(0) }, { ...BUDGET, batchSize: 200 });
  assert.equal(calls, 2);
  assert.equal(result.transportError, "offline");
  assert.equal(result.restartedForProject, true);
});
