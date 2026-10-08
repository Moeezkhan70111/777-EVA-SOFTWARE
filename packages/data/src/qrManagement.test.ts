import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DispatchScanUseCase, InMemoryEventBus, ProcessScanUseCase } from "@erp/application";
import { SqliteDatabase } from "./sqliteDatabase.js";
import type { QrStage } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// QR Management reads: grouped generation runs, filters, per-code stage derivation and
// the detail/timeline. Every assertion here is against what the database actually
// recorded through the real generator and scan use cases — nothing is seeded directly
// except the generation timestamps, which are rewritten so date filters can be tested.

const SCAN_CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };

function createDbFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-qrm-"));
  const dbPath = path.join(tempDir, "qrm.db");
  const db = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.ensureOperationalContext({
    factoryId: "factory-1",
    factoryCode: "F001",
    factoryName: "Factory",
    workstationId: "workstation-1",
    workstationCode: "WS001",
    workstationName: "WS",
    deviceId: "device-1",
    deviceName: "Device",
    appVersion: "1.0.0",
  });
  return {
    db,
    raw: (db as unknown as { db: import("node:sqlite").DatabaseSync }).db,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function ensureProduct(db: SqliteDatabase, article: string, size: string): string {
  const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  const existing = raw
    .prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1")
    .get(article, size) as { id: string } | undefined;
  if (existing) return existing.id;
  db.createProduct({ article, size, sellingPrice: 550, status: "ACTIVE" });
  return ensureProduct(db, article, size);
}

/** Generates a run and stamps it with the given generation instant (ISO). */
function generateAt(
  fixture: ReturnType<typeof createDbFixture>,
  input: { article: string; size: string; color: string; quantity: number; at: string; by?: string }
): { batchId: string; ids: string[] } {
  const articleSizeId = ensureProduct(fixture.db, input.article, input.size);
  const result = fixture.db.generateQrBatch({
    articleSizeId,
    color: input.color,
    quantity: input.quantity,
    createdBy: input.by,
  });
  fixture.raw.prepare("UPDATE qr_batches SET created_at = ? WHERE id = ?").run(input.at, result.batch.id);
  fixture.raw.prepare("UPDATE qr_codes SET created_at = ?, updated_at = ? WHERE batch_id = ?").run(input.at, input.at, result.batch.id);
  return { batchId: result.batch.id, ids: result.qrCodes.map((b) => b.id) };
}

/** A local-calendar instant (10:30 on the given day) as the UTC ISO string the app stores. */
const localIso = (y: number, m: number, d: number, h = 10, min = 30) => new Date(y, m - 1, d, h, min, 0, 0).toISOString();

async function produce(db: SqliteDatabase, ids: string[]) {
  const useCase = new ProcessScanUseCase({
    txManager: db,
    duplicateChecker: db,
    qrRegistry: db,
    productCatalog: db,
    qrMasterRepo: db,
    productionEventsRepo: db,
    stockProjectionRepo: db,
    outboxRepo: db,
    eventPublisher: new InMemoryEventBus(),
    idGenerator: new UuidGenerator(),
  });
  for (const id of ids) {
    const result = await useCase.execute({ rawScan: id, context: SCAN_CONTEXT });
    assert.equal(result.accepted, true, `produce ${id}: ${result.reason ?? ""}`);
  }
}

async function dispatch(db: SqliteDatabase, ids: string[]) {
  const useCase = new DispatchScanUseCase({
    txManager: db,
    qrLookupRepo: db,
    stockProjectionRepo: db,
    qrMasterRepo: db,
    dispatchEventsRepo: db,
    outboxRepo: db,
    eventPublisher: new InMemoryEventBus(),
    idGenerator: new UuidGenerator(),
  });
  for (const id of ids) {
    const result = await useCase.execute({ rawScan: id, context: SCAN_CONTEXT });
    assert.equal(result.accepted, true, `dispatch ${id}: ${result.reason ?? ""}`);
  }
}

/** Builds the world every test below reads. */
async function seedWorld(fixture: ReturnType<typeof createDbFixture>) {
  // 15 Sep 2026: three runs, two of them for SK6.
  const sk6Red = generateAt(fixture, { article: "SK6", size: "7/10", color: "RED", quantity: 50, at: localIso(2026, 9, 15, 10, 32), by: "admin" });
  const sk6Blue = generateAt(fixture, { article: "SK6", size: "7/10", color: "BLUE", quantity: 20, at: localIso(2026, 9, 15, 11, 5), by: "admin" });
  const sk12Red = generateAt(fixture, { article: "SK12", size: "4/6", color: "RED", quantity: 100, at: localIso(2026, 9, 15, 14, 0) });
  // 16 Sep 2026: a second SK6 RED 7/10 run, continuing the serial sequence.
  const sk6RedLater = generateAt(fixture, { article: "SK6", size: "7/10", color: "RED", quantity: 25, at: localIso(2026, 9, 16, 9, 0), by: "aslam" });
  // 1 Sep 2026: an older run outside most windows.
  const older = generateAt(fixture, { article: "SK12", size: "7/10", color: "BLACK", quantity: 10, at: localIso(2026, 9, 1, 8, 0) });

  // Real lifecycle events through the real use cases.
  await produce(fixture.db, sk6Red.ids.slice(0, 8)); // 000001–000008 produced
  await dispatch(fixture.db, sk6Red.ids.slice(0, 1)); // 000001 dispatched
  fixture.db.voidQrCode({ qrId: sk6Red.ids[49], reason: "Label torn", actor: "admin" }); // 000050 void
  fixture.db.markQrCodeDamaged({ qrId: sk6Red.ids[7], reason: "Crushed", actor: "admin", context: SCAN_CONTEXT }); // 000008 damaged
  await produce(fixture.db, sk12Red.ids.slice(0, 30));

  return { sk6Red, sk6Blue, sk12Red, sk6RedLater, older };
}

const stagesOf = (db: SqliteDatabase, batchId: string): Record<string, QrStage> =>
  Object.fromEntries(db.listQrBatchMembers(batchId, { pageSize: 1000 }).rows.map((r) => [r.qrId, r.stage]));

test("QR Management: a single generation date returns exactly that day's runs, grouped one row per run", async () => {
  const fixture = createDbFixture();
  try {
    const world = await seedWorld(fixture);

    const overview = fixture.db.getQrGenerationOverview({ fromDate: "2026-09-15", toDate: "2026-09-15" });

    assert.equal(overview.total, 3);
    assert.deepEqual(
      overview.groups.map((g) => `${g.article} ${g.color} ${g.size} ${g.startSequence}-${g.endSequence} x${g.quantity}`),
      ["SK12 RED 4/6 1-100 x100", "SK6 BLUE 7/10 1-20 x20", "SK6 RED 7/10 1-50 x50"] // newest first
    );
    assert.equal(overview.totalQrCount, 170);
    // 16 Sep and 1 Sep runs are not in the day.
    assert.ok(!overview.groups.some((g) => g.batchId === world.sk6RedLater.batchId));
    assert.ok(!overview.groups.some((g) => g.batchId === world.older.batchId));

    // Range display + identity rebuild.
    const sk6Red = overview.groups.find((g) => g.batchId === world.sk6Red.batchId)!;
    assert.equal(sk6Red.firstQrId, "SK6_RED_7/10_000001");
    assert.equal(sk6Red.lastQrId, "SK6_RED_7/10_000050");
    assert.equal(sk6Red.generatedBy, "admin");

    // Per-run status summary is derived from real events: 1 dispatched, 6 produced (8 scanned
    // minus 1 dispatched minus 1 damaged), 1 damaged, 1 void, 41 still only generated.
    assert.deepEqual(sk6Red.stageCounts, { DISPATCHED: 1, PRODUCED: 6, DAMAGED: 1, VOID: 1, REGISTERED: 41 });

    // Headline tallies are the sum over every run in the filter.
    assert.deepEqual(overview.stageCounts, { DISPATCHED: 1, PRODUCED: 36, DAMAGED: 1, VOID: 1, REGISTERED: 131 });
  } finally {
    fixture.cleanup();
  }
});

test("QR Management: a date range is inclusive on both ends and uses the generation timestamp only", async () => {
  const fixture = createDbFixture();
  try {
    const world = await seedWorld(fixture);

    const range = fixture.db.getQrGenerationOverview({ fromDate: "2026-09-01", toDate: "2026-09-15" });
    assert.equal(range.total, 4);
    assert.ok(range.groups.some((g) => g.batchId === world.older.batchId), "1 Sep (from-bound) is included");
    assert.ok(range.groups.some((g) => g.batchId === world.sk6Red.batchId), "15 Sep (to-bound) is included");
    assert.ok(!range.groups.some((g) => g.batchId === world.sk6RedLater.batchId), "16 Sep is excluded");

    // Move every scan event to 20 Sep, a day on which nothing was generated. Filtering that
    // day must return nothing: the filter is on generation time, never on scan time.
    const scanDay = localIso(2026, 9, 20, 12, 0);
    fixture.raw.prepare("UPDATE production_events SET event_ts_local = ?, event_date = ?, created_at = ?").run(scanDay, "2026-09-20", scanDay);
    fixture.raw.prepare("UPDATE qr_master SET created_at = ?, updated_at = ?").run(scanDay, scanDay);
    const scanDayOnly = fixture.db.getQrGenerationOverview({ fromDate: "2026-09-20", toDate: "2026-09-20" });
    assert.equal(scanDayOnly.total, 0);
    assert.equal(scanDayOnly.totalQrCount, 0);
    // …while the generation day still shows those same (now scanned) codes.
    assert.equal(fixture.db.getQrGenerationOverview({ fromDate: "2026-09-15", toDate: "2026-09-15" }).stageCounts?.PRODUCED, 36);

    // Open-ended bounds.
    assert.equal(fixture.db.getQrGenerationOverview({ fromDate: "2026-09-16" }).total, 1);
    assert.equal(fixture.db.getQrGenerationOverview({ toDate: "2026-09-01" }).total, 1);
    assert.equal(fixture.db.getQrGenerationOverview({}).total, 5);
  } finally {
    fixture.cleanup();
  }
});

test("QR Management: article, size and colour filters work alone and AND together", async () => {
  const fixture = createDbFixture();
  try {
    await seedWorld(fixture);
    const runs = (f: Parameters<SqliteDatabase["getQrGenerationOverview"]>[0]) =>
      fixture.db.getQrGenerationOverview(f).groups.map((g) => `${g.article} ${g.color} ${g.size} ${g.startSequence}-${g.endSequence}`).sort();

    assert.deepEqual(runs({ article: "SK6" }), ["SK6 BLUE 7/10 1-20", "SK6 RED 7/10 1-50", "SK6 RED 7/10 51-75"]);
    assert.deepEqual(runs({ size: "7/10" }), ["SK12 BLACK 7/10 1-10", "SK6 BLUE 7/10 1-20", "SK6 RED 7/10 1-50", "SK6 RED 7/10 51-75"]);
    assert.deepEqual(runs({ color: "RED" }), ["SK12 RED 4/6 1-100", "SK6 RED 7/10 1-50", "SK6 RED 7/10 51-75"]);
    assert.deepEqual(runs({ article: "SK6", size: "7/10" }), ["SK6 BLUE 7/10 1-20", "SK6 RED 7/10 1-50", "SK6 RED 7/10 51-75"]);
    assert.deepEqual(runs({ article: "SK6", color: "RED" }), ["SK6 RED 7/10 1-50", "SK6 RED 7/10 51-75"]);
    assert.deepEqual(runs({ article: "SK6", color: "RED", size: "7/10" }), ["SK6 RED 7/10 1-50", "SK6 RED 7/10 51-75"]);
    assert.deepEqual(runs({ article: "SK12", color: "BLUE" }), []);

    // Combined with the date: 15 Sep + SK6 + RED + 7/10 → the one 15 Sep run only.
    const combined = fixture.db.getQrGenerationOverview({ fromDate: "2026-09-15", toDate: "2026-09-15", article: "SK6", color: "RED", size: "7/10" });
    assert.equal(combined.total, 1);
    assert.equal(combined.totalQrCount, 50);
    assert.deepEqual(combined.stageCounts, { DISPATCHED: 1, PRODUCED: 6, DAMAGED: 1, VOID: 1, REGISTERED: 41 });

    // Input is normalised the same way the generator stores it.
    assert.equal(fixture.db.getQrGenerationOverview({ article: "sk6", color: "red ", size: "7 / 10" }).total, 2);

    // Picker options come from what was actually generated.
    assert.deepEqual(fixture.db.listQrGenerationFilterOptions(), {
      articles: ["SK12", "SK6"],
      colors: ["BLACK", "BLUE", "RED"],
      sizes: ["4/6", "7/10"],
    });
  } finally {
    fixture.cleanup();
  }
});

test("QR Generator: operator and requester are stored with the run and surface everywhere it is read", () => {
  const fixture = createDbFixture();
  try {
    const articleSizeId = ensureProduct(fixture.db, "SK6", "7/10");
    const run = fixture.db.generateQrBatch({
      articleSizeId,
      color: "RED",
      quantity: 3,
      createdBy: "Moeezkhan123",
      requestedBy: "  Aslam (Production)  ",
    });
    assert.equal(run.batch.createdBy, "Moeezkhan123");
    assert.equal(run.batch.requestedBy, "Aslam (Production)"); // trimmed

    assert.equal(fixture.db.listQrBatches({ limit: 1 })[0].requestedBy, "Aslam (Production)");
    const group = fixture.db.getQrGenerationOverview({}).groups[0];
    assert.equal(group.generatedBy, "Moeezkhan123");
    assert.equal(group.requestedBy, "Aslam (Production)");
    const detail = fixture.db.getQrDetail(run.qrCodes[0].id);
    assert.equal(detail?.batch?.createdBy, "Moeezkhan123");
    assert.equal(detail?.batch?.requestedBy, "Aslam (Production)");

    // Blank requester is stored as nothing, not as an empty string.
    const plain = fixture.db.generateQrBatch({ articleSizeId, color: "RED", quantity: 1, createdBy: "Moeezkhan123", requestedBy: "   " });
    assert.equal(plain.batch.requestedBy, null);
    assert.equal(fixture.db.getQrDetail(plain.qrCodes[0].id)?.batch?.requestedBy, null);
  } finally {
    fixture.cleanup();
  }
});

test("QR Management: two runs of the same combination stay separate and keep their own dates", async () => {
  const fixture = createDbFixture();
  try {
    const world = await seedWorld(fixture);
    const overview = fixture.db.getQrGenerationOverview({ article: "SK6", color: "RED", size: "7/10" });
    assert.equal(overview.total, 2);
    const [later, earlier] = overview.groups;
    assert.equal(later.batchId, world.sk6RedLater.batchId);
    assert.equal(`${later.startSequence}-${later.endSequence}`, "51-75");
    assert.equal(later.generatedAt, localIso(2026, 9, 16, 9, 0));
    assert.equal(later.generatedBy, "aslam");
    assert.equal(earlier.batchId, world.sk6Red.batchId);
    assert.equal(`${earlier.startSequence}-${earlier.endSequence}`, "1-50");
    assert.equal(earlier.generatedAt, localIso(2026, 9, 15, 10, 32));
  } finally {
    fixture.cleanup();
  }
});

test("QR Management: expanding a run lists every code in serial order with its real status, a page at a time", async () => {
  const fixture = createDbFixture();
  try {
    const world = await seedWorld(fixture);

    const all = fixture.db.listQrBatchMembers(world.sk6Red.batchId, { pageSize: 1000 });
    assert.equal(all.total, 50);
    assert.equal(all.rows.length, 50);
    assert.deepEqual(
      all.rows.map((r) => r.sequence),
      Array.from({ length: 50 }, (_, i) => i + 1)
    );

    const stages = stagesOf(fixture.db, world.sk6Red.batchId);
    assert.equal(stages["SK6_RED_7/10_000001"], "DISPATCHED");
    assert.equal(stages["SK6_RED_7/10_000002"], "PRODUCED");
    assert.equal(stages["SK6_RED_7/10_000007"], "PRODUCED");
    assert.equal(stages["SK6_RED_7/10_000008"], "DAMAGED");
    assert.equal(stages["SK6_RED_7/10_000009"], "REGISTERED");
    assert.equal(stages["SK6_RED_7/10_000049"], "REGISTERED");
    assert.equal(stages["SK6_RED_7/10_000050"], "VOID");

    // Paging: 20 per page → pages of 20, 20, 10.
    const p1 = fixture.db.listQrBatchMembers(world.sk6Red.batchId, { page: 1, pageSize: 20 });
    const p3 = fixture.db.listQrBatchMembers(world.sk6Red.batchId, { page: 3, pageSize: 20 });
    assert.equal(p1.rows.length, 20);
    assert.equal(p1.rows[0].qrId, "SK6_RED_7/10_000001");
    assert.equal(p3.rows.length, 10);
    assert.equal(p3.rows[9].qrId, "SK6_RED_7/10_000050");
    assert.equal(p3.total, 50);

    // Unknown batch → empty, nothing thrown.
    assert.deepEqual(fixture.db.listQrBatchMembers("nope").rows, []);
  } finally {
    fixture.cleanup();
  }
});

test("QR Management: the overview never returns individual codes and pages over runs", async () => {
  const fixture = createDbFixture();
  try {
    await seedWorld(fixture);
    const page1 = fixture.db.getQrGenerationOverview({ page: 1, pageSize: 2 });
    const page3 = fixture.db.getQrGenerationOverview({ page: 3, pageSize: 2 });
    assert.equal(page1.total, 5);
    assert.equal(page1.groups.length, 2);
    assert.equal(page3.groups.length, 1);
    // Headline tallies are independent of the page, and can be skipped while paging.
    assert.equal(page1.totalQrCount, 205);
    assert.equal(page3.totalQrCount, 205);
    assert.deepEqual(page1.stageCounts, page3.stageCounts);
    const pagingOnly = fixture.db.getQrGenerationOverview({ page: 2, pageSize: 2, includeSummary: false });
    assert.equal(pagingOnly.groups.length, 2);
    assert.equal(pagingOnly.total, 5);
    assert.equal(pagingOnly.totalQrCount, null);
    assert.equal(pagingOnly.stageCounts, null);
    // No group carries a code list; the largest run (100 codes) is represented by one row.
    for (const group of [...page1.groups, ...page3.groups]) {
      assert.equal("rows" in group, false);
      assert.equal("codes" in group, false);
    }
  } finally {
    fixture.cleanup();
  }
});

test("QR Management: detail shows the real timeline and current status; unknown codes are not found and not created", async () => {
  const fixture = createDbFixture();
  try {
    await seedWorld(fixture);

    // Dispatched code: generated → produced → dispatched.
    const dispatched = fixture.db.getQrDetail("SK6_RED_7/10_000001");
    assert.ok(dispatched);
    assert.equal(dispatched.stage, "DISPATCHED");
    assert.equal(dispatched.registry?.registeredAt, localIso(2026, 9, 15, 10, 32));
    assert.equal(dispatched.batch?.createdBy, "admin");
    assert.deepEqual(
      dispatched.events.map((e) => e.eventType),
      ["PRODUCED", "DISPATCHED"]
    );
    assert.equal(dispatched.lifecycle?.currentStatus, "DISPATCHED");

    // Damaged code carries the reason in its history.
    const damaged = fixture.db.getQrDetail("SK6_RED_7/10_000008");
    assert.equal(damaged?.stage, "DAMAGED");
    assert.deepEqual(damaged?.events.map((e) => e.eventType), ["PRODUCED", "DAMAGED"]);
    assert.equal(damaged?.events[1].note, "Crushed");

    // Void code: registry-only, no scan events, void audit trail present.
    const voided = fixture.db.getQrDetail("SK6_RED_7/10_000050");
    assert.equal(voided?.stage, "VOID");
    assert.equal(voided?.events.length, 0);
    assert.equal(voided?.lifecycle, null);
    assert.equal(voided?.registry?.voidReason, "Label torn");
    assert.equal(voided?.registry?.voidedBy, "admin");

    // Generated-only code: no events at all.
    const generated = fixture.db.getQrDetail("SK6_RED_7/10_000037");
    assert.equal(generated?.stage, "REGISTERED");
    assert.equal(generated?.events.length, 0);
    assert.equal(generated?.serial, "000037");

    // Direct lookup is case-insensitive on the code and never creates anything.
    assert.equal(fixture.db.getQrDetail("sk6_red_7/10_000037")?.qrId, "SK6_RED_7/10_000037");
    const counts = () =>
      Object.fromEntries(
        ["qr_codes", "qr_batches", "qr_sequences", "qr_master", "production_events", "product_variants", "article_sizes"].map((table) => [
          table,
          (fixture.raw.prepare(`SELECT COUNT(1) AS c FROM ${table}`).get() as { c: number }).c,
        ])
      );
    const before = counts();
    assert.equal(fixture.db.getQrDetail("SK6_RED_7/10_999999"), null);
    assert.equal(fixture.db.getQrDetail("ZZZ_FAKE_1/1_000001"), null);
    assert.deepEqual(fixture.db.searchQrCodes("ZZZ_FAKE_1/1_000001"), []);
    assert.deepEqual(fixture.db.getQrGenerationOverview({ article: "ZZZ" }).groups, []);
    assert.deepEqual(counts(), before);
  } finally {
    fixture.cleanup();
  }
});

test("QR Management: run-level and headline tallies always agree with the per-code stages", async () => {
  const fixture = createDbFixture();
  try {
    await seedWorld(fixture);
    const overview = fixture.db.getQrGenerationOverview({ pageSize: 100 });
    const summed: Record<string, number> = {};
    for (const group of overview.groups) {
      const perCode = Object.values(stagesOf(fixture.db, group.batchId));
      const tally: Record<string, number> = {};
      for (const stage of perCode) tally[stage] = (tally[stage] ?? 0) + 1;
      assert.deepEqual(group.stageCounts, tally, `run ${group.batchId}`);
      assert.equal(perCode.length, group.quantity);
      for (const [stage, n] of Object.entries(tally)) summed[stage] = (summed[stage] ?? 0) + n;
    }
    assert.deepEqual(overview.stageCounts, summed);
    assert.equal(overview.totalQrCount, Object.values(summed).reduce((a, b) => a + b, 0));
    assert.equal(overview.totalQrCount, 205);
  } finally {
    fixture.cleanup();
  }
});
