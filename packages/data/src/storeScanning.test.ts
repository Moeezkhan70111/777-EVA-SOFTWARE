import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DispatchScanUseCase,
  InMemoryEventBus,
  ProcessScanUseCase,
  StoreEntryScanUseCase,
} from "@erp/application";
import type { StoreEntryScanResult } from "@erp/application";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// Store Scanning against the real database. Every unit here is created the only way a
// unit can be created — QR Generator → Live Production scan — and then received through
// StoreEntryScanUseCase wired to SqliteDatabase exactly as the desktop app wires it.

const FACTORY = "factory-777";
const CONTEXT = { factoryId: FACTORY, workstationId: "ws-prod-01", deviceId: "desktop-main" };

type Raw = import("node:sqlite").DatabaseSync;

function openDb(dbPath: string) {
  const db = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: FACTORY,
    factoryCode: "777",
    factoryName: "777 Manufacturing",
    workstationId: "ws-prod-01",
    workstationCode: "PROD-01",
    workstationName: "Production Line 01",
    deviceId: "desktop-main",
    deviceName: "Desktop Main",
    appVersion: "1.0.0",
  });
  return db;
}

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-store-"));
  const dbPath = path.join(tempDir, "store.db");
  const db = openDb(dbPath);
  return {
    db,
    dbPath,
    raw: (db as unknown as { db: Raw }).db,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

const producer = (db: SqliteDatabase) =>
  new ProcessScanUseCase({
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

const receiver = (db: SqliteDatabase) =>
  new StoreEntryScanUseCase({
    txManager: db,
    qrLookupRepo: db,
    qrRegistry: db,
    qrMasterRepo: db,
    storeEntryEventsRepo: db,
    stockProjectionRepo: db,
    outboxRepo: db,
    eventPublisher: new InMemoryEventBus(),
    idGenerator: new UuidGenerator(),
  });

const dispatcher = (db: SqliteDatabase) =>
  new DispatchScanUseCase({
    txManager: db,
    qrLookupRepo: db,
    stockProjectionRepo: db,
    qrMasterRepo: db,
    dispatchEventsRepo: db,
    outboxRepo: db,
    eventPublisher: new InMemoryEventBus(),
    idGenerator: new UuidGenerator(),
  });

/** Registers `quantity` codes for article/colour/size via the real QR Generator. */
function generate(db: SqliteDatabase, raw: Raw, article: string, size: string, color: string, quantity: number): string[] {
  let row = raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string } | undefined;
  if (!row) {
    db.createProduct({ article, size, sellingPrice: 550, status: "ACTIVE" });
    row = raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string };
  }
  return db.generateQrBatch({ articleSizeId: row.id, color, quantity, createdBy: "admin" }).qrCodes.map((b) => b.id);
}

async function produce(db: SqliteDatabase, ids: string[]) {
  const useCase = producer(db);
  for (const id of ids) {
    const result = await useCase.execute({ rawScan: id, context: CONTEXT });
    assert.equal(result.accepted, true, `produce ${id}: ${result.reason ?? ""}`);
  }
}

function qrState(raw: Raw, qrId: string) {
  const row = raw
    .prepare("SELECT current_status, current_location_type, current_location_id FROM qr_master WHERE qr_id = ?")
    .get(qrId) as { current_status: string; current_location_type: string; current_location_id: string | null } | undefined;
  // node:sqlite rows have a null prototype; copy so deepEqual against literals works.
  return row ? { ...row } : undefined;
}

function locationStock(raw: Raw, article: string, color: string, size: string) {
  const variant = raw.prepare("SELECT id FROM product_variants WHERE article = ? AND color = ? AND size = ?").get(article, color, size) as { id: string };
  const rows = raw
    .prepare("SELECT location_type, quantity_on_hand FROM stock_projection_by_location WHERE product_variant_id = ?")
    .all(variant.id) as Array<{ location_type: string; quantity_on_hand: number }>;
  const total = raw.prepare("SELECT quantity_on_hand FROM stock_projection_by_variant WHERE product_variant_id = ?").get(variant.id) as { quantity_on_hand: number } | undefined;
  return {
    total: Number(total?.quantity_on_hand ?? 0),
    factory: Number(rows.find((r) => r.location_type === "FACTORY")?.quantity_on_hand ?? 0),
    store: Number(rows.find((r) => r.location_type === "WAREHOUSE")?.quantity_on_hand ?? 0),
  };
}

function storeEntryEvents(raw: Raw, qrId: string) {
  return raw
    .prepare("SELECT id, event_type, metadata_json, source_app FROM production_events WHERE qr_id = ? AND event_type = 'MOVED' ORDER BY event_ts_local")
    .all(qrId) as Array<{ id: string; event_type: string; metadata_json: string; source_app: string }>;
}

test("TEST 1 / 11 / 20 — a PRODUCED carton is received: status, location, stock and audit event all move together", async () => {
  const f = createFixture();
  try {
    const ids = generate(f.db, f.raw, "SK6", "7/10", "RED", 3);
    await produce(f.db, ids);
    const target = ids[0];
    assert.equal(target, "SK6_RED_7/10_000001");

    const before = locationStock(f.raw, "SK6", "RED", "7/10");
    assert.deepEqual(before, { total: 3, factory: 3, store: 0 });
    assert.equal(qrState(f.raw, target)?.current_status, "PRODUCED");

    const session = f.db.startOrResumeStoreReceivingSession({ deviceId: "desktop-main", startedBy: "store-op" });
    const result = await receiver(f.db).execute({ rawScan: target, context: CONTEXT, sessionId: session.id, actor: "store-op" });

    assert.equal(result.accepted, true, result.reason);
    assert.equal(result.outcome, "RECEIVED");
    assert.equal(result.previousStatus, "PRODUCED");
    assert.equal(result.currentStatus, "WAREHOUSE");
    assert.deepEqual([result.article, result.color, result.size, result.serial], ["SK6", "RED", "7/10", "000001"]);

    // Status + location on the unit itself.
    assert.deepEqual(qrState(f.raw, target), { current_status: "WAREHOUSE", current_location_type: "WAREHOUSE", current_location_id: FACTORY });

    // Inventory: the undispatched pool is unchanged, one unit moved from the factory to the store.
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 3, factory: 2, store: 1 });
    // Current Stock is the In Store figure, so receiving this one carton is what raised it to 1.
    const inventory = f.db.listInventory("SK6").find((r) => r.color === "RED" && r.size === "7/10");
    assert.deepEqual([inventory?.quantity, inventory?.productionQuantity, inventory?.storeQuantity], [1, 2, 1]);

    // Exactly one STORE_ENTRY audit event, in the shared event log, with the movement recorded.
    const events = storeEntryEvents(f.raw, target);
    assert.equal(events.length, 1);
    assert.equal(events[0].id, result.eventId);
    assert.equal(events[0].source_app, "desktop-store-scanner");
    const meta = JSON.parse(events[0].metadata_json) as Record<string, unknown>;
    assert.equal(meta.eventType, "STORE_ENTRY");
    assert.equal(meta.previousStatus, "PRODUCED");
    assert.equal(meta.newStatus, "WAREHOUSE");
    assert.equal(meta.fromLocationType, "FACTORY");
    assert.equal(meta.toLocationType, "WAREHOUSE");
    assert.equal(meta.actor, "store-op");
    assert.equal(meta.sessionId, session.id);

    // Queued for sync like every other scan event.
    const outbox = f.raw.prepare("SELECT aggregate_type, payload_json FROM sync_outbox WHERE aggregate_id = ?").get(result.eventId!) as { aggregate_type: string; payload_json: string };
    assert.equal(outbox.aggregate_type, "PRODUCTION_EVENT");
    assert.equal((JSON.parse(outbox.payload_json) as { eventType: string }).eventType, "STORE_ENTRY");
  } finally {
    f.cleanup();
  }
});

test("TEST 2 — the same carton scanned again is ALREADY_IN_STORE: no stock change, no second event, timestamp untouched", async () => {
  const f = createFixture();
  try {
    const [id] = generate(f.db, f.raw, "SK6", "7/10", "RED", 1);
    await produce(f.db, [id]);
    const useCase = receiver(f.db);

    assert.equal((await useCase.execute({ rawScan: id, context: CONTEXT })).outcome, "RECEIVED");
    const updatedAt = (f.raw.prepare("SELECT updated_at FROM qr_master WHERE qr_id = ?").get(id) as { updated_at: string }).updated_at;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const duplicate = await useCase.execute({ rawScan: id, context: CONTEXT });

    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.outcome, "ALREADY_IN_STORE");
    assert.equal(duplicate.currentStatus, "WAREHOUSE");
    assert.deepEqual([duplicate.article, duplicate.color, duplicate.size], ["SK6", "RED", "7/10"]);
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 1, factory: 0, store: 1 });
    assert.equal(storeEntryEvents(f.raw, id).length, 1);
    assert.equal((f.raw.prepare("SELECT updated_at FROM qr_master WHERE qr_id = ?").get(id) as { updated_at: string }).updated_at, updatedAt);
  } finally {
    f.cleanup();
  }
});

test("TEST 3 — an unknown QR is rejected and nothing is created", async () => {
  const f = createFixture();
  try {
    const counts = () => ({
      products: (f.raw.prepare("SELECT COUNT(1) AS c FROM product_variants").get() as { c: number }).c,
      qrCodes: (f.raw.prepare("SELECT COUNT(1) AS c FROM qr_codes").get() as { c: number }).c,
      units: (f.raw.prepare("SELECT COUNT(1) AS c FROM qr_master").get() as { c: number }).c,
      events: (f.raw.prepare("SELECT COUNT(1) AS c FROM production_events").get() as { c: number }).c,
      stock: (f.raw.prepare("SELECT COUNT(1) AS c FROM stock_projection_by_location").get() as { c: number }).c,
      outbox: (f.raw.prepare("SELECT COUNT(1) AS c FROM sync_outbox").get() as { c: number }).c,
    });
    const before = counts();

    const result = await receiver(f.db).execute({ rawScan: "SK6_RED_7/10_999999", context: CONTEXT });

    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "UNKNOWN_QR");
    assert.equal(result.reason, "This QR is not registered.");
    assert.deepEqual(counts(), before);
  } finally {
    f.cleanup();
  }
});

test("TEST 4 / 5 — a registered code that never went through production is rejected unchanged", async () => {
  const f = createFixture();
  try {
    const [id] = generate(f.db, f.raw, "SK6", "7/10", "RED", 1);

    const result = await receiver(f.db).execute({ rawScan: id, context: CONTEXT });

    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "NOT_PRODUCED");
    assert.equal(result.registryStatus, "GENERATED");
    assert.deepEqual([result.article, result.color, result.size], ["SK6", "RED", "7/10"]);
    assert.equal(qrState(f.raw, id), undefined, "no unit was created");
    assert.equal((f.raw.prepare("SELECT status FROM qr_codes WHERE id = ?").get(id) as { status: string }).status, "GENERATED");
    assert.equal((f.raw.prepare("SELECT COUNT(1) AS c FROM production_events").get() as { c: number }).c, 0);

    // A voided label is refused the same way.
    const [voidId] = generate(f.db, f.raw, "SK6", "7/10", "BLUE", 1);
    f.db.voidQrCode({ qrId: voidId, reason: "label torn", actor: "admin" });
    const voided = await receiver(f.db).execute({ rawScan: voidId, context: CONTEXT });
    assert.equal(voided.outcome, "NOT_PRODUCED");
    assert.equal(voided.registryStatus, "VOID");
  } finally {
    f.cleanup();
  }
});

test("TEST 6 — a DISPATCHED carton cannot be received and is left exactly as it was", async () => {
  const f = createFixture();
  try {
    const [id] = generate(f.db, f.raw, "SK6", "7/10", "RED", 1);
    await produce(f.db, [id]);
    assert.equal((await dispatcher(f.db).execute({ rawScan: id, context: CONTEXT })).accepted, true);
    const stateBefore = qrState(f.raw, id);
    assert.equal(stateBefore?.current_status, "DISPATCHED");

    const result = await receiver(f.db).execute({ rawScan: id, context: CONTEXT });

    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "NOT_ELIGIBLE");
    assert.equal(result.currentStatus, "DISPATCHED");
    // The store is told what is missing, not just that the carton is ineligible: a carton
    // out with a customer needs its return recorded on the gate before the store sees it.
    assert.match(result.reason ?? "", /return has to be recorded/i);
    assert.deepEqual(qrState(f.raw, id), stateBefore);
    assert.equal(storeEntryEvents(f.raw, id).length, 0);
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 0, factory: 0, store: 0 });
  } finally {
    f.cleanup();
  }
});

test("TEST 7 — rapid consecutive scans of many cartons are each accepted and counted", async () => {
  const f = createFixture();
  try {
    const ids = generate(f.db, f.raw, "SK6", "7/10", "RED", 60);
    await produce(f.db, ids);
    const useCase = receiver(f.db);
    const session = f.db.startOrResumeStoreReceivingSession({ deviceId: "desktop-main" });

    const results: StoreEntryScanResult[] = [];
    for (const id of ids) results.push(await useCase.execute({ rawScan: id, context: CONTEXT, sessionId: session.id }));

    assert.equal(results.filter((r) => r.outcome === "RECEIVED").length, 60);
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 60, factory: 0, store: 60 });
    assert.equal(f.db.getStoreReceivingSessionSummary(session.id)?.receivedCount, 60);
  } finally {
    f.cleanup();
  }
});

test("TEST 8 / 13 / 14 — mixed scans keep the station working, and the session summary reflects only real receipts", async () => {
  const f = createFixture();
  try {
    const red = generate(f.db, f.raw, "SK6", "7/10", "RED", 3);
    const blue = generate(f.db, f.raw, "SK6", "7/10", "BLUE", 2);
    const sk12 = generate(f.db, f.raw, "SK12", "4/6", "RED", 1);
    await produce(f.db, [...red, ...blue, ...sk12]);
    const useCase = receiver(f.db);
    const session = f.db.startOrResumeStoreReceivingSession({ deviceId: "desktop-main", startedBy: "store-op" });
    assert.match(session.code, /^SR-\d{6}$/);

    const sequence = [
      red[0], // valid
      red[1], // valid
      "SK6_RED_7/10_999999", // unknown
      blue[0], // valid
      red[0], // duplicate
      sk12[0], // valid
      "garbage", // invalid format
      blue[1], // valid
    ];
    const outcomes: string[] = [];
    for (const raw of sequence) {
      outcomes.push((await useCase.execute({ rawScan: raw, context: CONTEXT, sessionId: session.id, actor: "store-op" })).outcome);
    }
    assert.deepEqual(outcomes, [
      "RECEIVED",
      "RECEIVED",
      "UNKNOWN_QR",
      "RECEIVED",
      "ALREADY_IN_STORE",
      "RECEIVED",
      "INVALID_FORMAT",
      "RECEIVED",
    ]);

    const summary = f.db.getStoreReceivingSessionSummary(session.id, { recentLimit: 3 });
    assert.ok(summary);
    assert.equal(summary.session.code, session.code);
    assert.equal(summary.receivedCount, 5);
    // Largest first; ties in a stable article → colour → size order.
    assert.deepEqual(summary.byProduct, [
      { article: "SK6", color: "BLUE", size: "7/10", count: 2 },
      { article: "SK6", color: "RED", size: "7/10", count: 2 },
      { article: "SK12", color: "RED", size: "4/6", count: 1 },
    ]);
    assert.equal(summary.recent.length, 3, "recent list is capped, not the whole history");
    assert.equal(summary.recent[0].qrId, blue[1]);
    assert.equal(summary.lastReceived?.qrId, blue[1]);
    assert.equal(summary.lastReceived?.actor, "store-op");

    // A receipt on another device's session does not leak into this one.
    const other = f.db.startNewStoreReceivingSession({ deviceId: "desktop-store-2" });
    assert.equal((await useCase.execute({ rawScan: red[2], context: CONTEXT, sessionId: other.id })).outcome, "RECEIVED");
    assert.equal(f.db.getStoreReceivingSessionSummary(session.id)?.receivedCount, 5);
    assert.equal(f.db.getStoreReceivingSessionSummary(other.id)?.receivedCount, 1);
  } finally {
    f.cleanup();
  }
});

test("TEST 9 — two terminals receiving the same carton at once: exactly one store entry", async () => {
  const f = createFixture();
  const second = openDb(f.dbPath); // a second connection to the same database file
  try {
    const [id] = generate(f.db, f.raw, "SK6", "7/10", "RED", 1);
    await produce(f.db, [id]);

    const [a, b] = await Promise.all([
      receiver(f.db).execute({ rawScan: id, context: { ...CONTEXT, deviceId: "desktop-store-1" } }),
      receiver(second).execute({ rawScan: id, context: { ...CONTEXT, deviceId: "desktop-store-2" } }),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    assert.deepEqual(outcomes, ["ALREADY_IN_STORE", "RECEIVED"]);
    assert.equal(qrState(f.raw, id)?.current_status, "WAREHOUSE");
    assert.equal(storeEntryEvents(f.raw, id).length, 1, "one audit event");
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 1, factory: 0, store: 1 });
  } finally {
    second.close();
    f.cleanup();
  }
});

test("TEST 10 — QR Management sees the same truth: stage In Store and a STORE_ENTRY step on the timeline", async () => {
  const f = createFixture();
  try {
    const [id] = generate(f.db, f.raw, "SK6", "7/10", "RED", 1);
    await produce(f.db, [id]);
    const result = await receiver(f.db).execute({ rawScan: id, context: CONTEXT, actor: "store-op" });
    assert.equal(result.outcome, "RECEIVED");

    const detail = f.db.getQrDetail(id);
    assert.ok(detail);
    assert.equal(detail.stage, "WAREHOUSE");
    assert.equal(detail.lifecycle?.currentStatus, "WAREHOUSE");
    assert.equal(detail.lifecycle?.locationType, "WAREHOUSE");
    assert.deepEqual(
      detail.events.map((e) => [e.eventType, e.subType]),
      [
        ["PRODUCED", null],
        ["MOVED", "STORE_ENTRY"],
      ]
    );
    const entry = detail.events[1];
    assert.equal(entry.occurredAt, result.receivedAt);
    assert.equal(entry.note, "FACTORY → WAREHOUSE · by store-op");

    // The overview tallies derive the same stage.
    const overview = f.db.getQrGenerationOverview({ article: "SK6" });
    assert.equal(overview.stageCounts?.WAREHOUSE, 1);
  } finally {
    f.cleanup();
  }
});

test("a carton in the store can still be dispatched, and leaves from the store location", async () => {
  const f = createFixture();
  try {
    const ids = generate(f.db, f.raw, "SK6", "7/10", "RED", 2);
    await produce(f.db, ids);
    assert.equal((await receiver(f.db).execute({ rawScan: ids[0], context: CONTEXT })).outcome, "RECEIVED");
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 2, factory: 1, store: 1 });

    const dispatched = await dispatcher(f.db).execute({ rawScan: ids[0], context: CONTEXT });
    assert.equal(dispatched.accepted, true, dispatched.reason);
    assert.equal(qrState(f.raw, ids[0])?.current_status, "DISPATCHED");
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 1, factory: 1, store: 0 });

    // Marking a stored unit damaged also takes it from the store, not the factory.
    assert.equal((await receiver(f.db).execute({ rawScan: ids[1], context: CONTEXT })).outcome, "RECEIVED");
    f.db.markQrCodeDamaged({ qrId: ids[1], reason: "crushed", actor: "admin", context: CONTEXT });
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 0, factory: 0, store: 0 });
  } finally {
    f.cleanup();
  }
});

test("receiving sessions: resumed within the day, numbered sequentially, one open per device", () => {
  const f = createFixture();
  try {
    const first = f.db.startOrResumeStoreReceivingSession({ deviceId: "desktop-main", startedBy: "store-op" });
    const resumed = f.db.startOrResumeStoreReceivingSession({ deviceId: "desktop-main" });
    assert.equal(resumed.id, first.id, "same day, same device → same session");
    assert.equal(first.code, "SR-000001");
    assert.equal(first.status, "OPEN");
    assert.equal(first.startedBy, "store-op");

    const fresh = f.db.startNewStoreReceivingSession({ deviceId: "desktop-main" });
    assert.equal(fresh.code, "SR-000002");
    assert.equal(f.db.getStoreReceivingSession(first.id)?.status, "CLOSED");
    assert.equal(f.db.getStoreReceivingSession(fresh.id)?.status, "OPEN");

    // A session that started on an earlier day is not resumed.
    f.raw.prepare("UPDATE store_receiving_sessions SET started_at = ? WHERE id = ?").run("2026-01-01T03:00:00.000Z", fresh.id);
    const next = f.db.startOrResumeStoreReceivingSession({ deviceId: "desktop-main" });
    assert.notEqual(next.id, fresh.id);
    assert.equal(next.code, "SR-000003");
    assert.equal(f.db.getStoreReceivingSessionSummary("missing"), null);
  } finally {
    f.cleanup();
  }
});
