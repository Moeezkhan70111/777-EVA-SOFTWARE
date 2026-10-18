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
  StoreExitScanUseCase,
} from "@erp/application";
import type { StoreExitScanResult } from "@erp/application";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// Store Move Out against the real database. Every unit is created the only way a unit can
// be created — QR Generator → Live Production scan → Store Scanning — and then moved out
// through StoreExitScanUseCase wired to SqliteDatabase exactly as the desktop app wires it.
// The scanner is generic: no test names a Gatepass. Reservation reconciliation behind the
// scan is covered in gatepassReservations.test.ts.

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-store-out-"));
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
    gatepassRepo: db,
    qrRegistry: db,
    qrMasterRepo: db,
    storeEntryEventsRepo: db,
    stockProjectionRepo: db,
    outboxRepo: db,
    eventPublisher: new InMemoryEventBus(),
    idGenerator: new UuidGenerator(),
  });

const mover = (db: SqliteDatabase) =>
  new StoreExitScanUseCase({
    txManager: db,
    qrLookupRepo: db,
    gatepassRepo: db,
    qrRegistry: db,
    qrMasterRepo: db,
    storeExitEventsRepo: db,
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

/** Produces and receives every id, so each one is In Store. */
async function stock(db: SqliteDatabase, ids: string[]) {
  await produce(db, ids);
  const useCase = receiver(db);
  for (const id of ids) {
    const result = await useCase.execute({ rawScan: id, context: CONTEXT });
    assert.equal(result.outcome, "RECEIVED", `receive ${id}: ${result.reason ?? ""}`);
  }
}


function qrState(raw: Raw, qrId: string) {
  const row = raw
    .prepare("SELECT current_status, current_location_type, current_location_id FROM qr_master WHERE qr_id = ?")
    .get(qrId) as { current_status: string; current_location_type: string; current_location_id: string | null } | undefined;
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
    gate: Number(rows.find((r) => r.location_type === "GATE")?.quantity_on_hand ?? 0),
  };
}

function movedEvents(raw: Raw, qrId: string) {
  return (
    raw
      .prepare("SELECT id, metadata_json, source_app FROM production_events WHERE qr_id = ? AND event_type = 'MOVED' ORDER BY event_ts_local, created_at")
      .all(qrId) as Array<{ id: string; metadata_json: string; source_app: string }>
  ).map((row) => ({ ...row, meta: JSON.parse(row.metadata_json) as Record<string, unknown> }));
}

test("schema — TO_GATE and GATE are accepted by qr_master and the location projection after the rebuild", () => {
  const f = createFixture();
  try {
    const checks = (table: string) =>
      (f.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql;
    assert.match(checks("qr_master"), /'TO_GATE'/);
    assert.match(checks("qr_master"), /'GATE'/);
    assert.match(checks("stock_projection_by_location"), /'GATE'/);
    // The rebuild kept the index and the foreign key from production_events intact.
    assert.ok(f.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_qr_master_current_status'").get());
    const fk = f.raw.prepare("PRAGMA foreign_key_list(production_events)").all() as Array<{ table: string; from: string }>;
    assert.ok(fk.some((k) => k.table === "qr_master" && k.from === "qr_id"));
    assert.ok(f.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'store_move_out_sessions'").get());
  } finally {
    f.cleanup();
  }
});

test("an In Store carton is moved out: status, location, stock and audit event all move together", async () => {
  const f = createFixture();
  try {
    const ids = generate(f.db, f.raw, "SK6", "7/10", "RED", 3);
    await stock(f.db, ids);
    const target = ids[0];
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 3, factory: 0, store: 3, gate: 0 });

    const session = f.db.startOrResumeStoreMoveOutSession({ deviceId: "desktop-main", startedBy: "store-op" });
    assert.match(session.code, /^SO-\d{6}$/);
    const result = await mover(f.db).execute({ rawScan: target, context: CONTEXT, sessionId: session.id, actor: "store-op" });

    assert.equal(result.accepted, true, result.reason);
    assert.equal(result.outcome, "MOVED_OUT");
    assert.equal(result.previousStatus, "WAREHOUSE");
    assert.equal(result.currentStatus, "TO_GATE");
    assert.deepEqual([result.article, result.color, result.size, result.serial], ["SK6", "RED", "7/10", "000001"]);

    // Status + location on the unit itself.
    assert.deepEqual(qrState(f.raw, target), { current_status: "TO_GATE", current_location_type: "GATE", current_location_id: FACTORY });

    // Inventory: the undispatched pool is unchanged, one unit moved from the store to the gate.
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 3, factory: 0, store: 2, gate: 1 });
    // Current Stock is the In Store figure, so moving this carton out dropped it from 3 to 2.
    const inventory = f.db.listInventory("SK6").find((r) => r.color === "RED" && r.size === "7/10");
    assert.deepEqual(
      [inventory?.quantity, inventory?.productionQuantity, inventory?.storeQuantity, inventory?.gateQuantity],
      [2, 0, 2, 1]
    );

    // Entry then exit, both in the shared event log, with the movement recorded.
    const events = movedEvents(f.raw, target);
    assert.equal(events.length, 2);
    assert.equal(events[1].id, result.eventId);
    assert.equal(events[1].source_app, "desktop-store-scanner");
    assert.equal(events[1].meta.eventType, "STORE_EXIT");
    assert.equal(events[1].meta.previousStatus, "WAREHOUSE");
    assert.equal(events[1].meta.newStatus, "TO_GATE");
    assert.equal(events[1].meta.fromLocationType, "WAREHOUSE");
    assert.equal(events[1].meta.toLocationType, "GATE");
    assert.equal(events[1].meta.actor, "store-op");
    assert.equal(events[1].meta.sessionId, session.id);

    // Queued for sync like every other scan event.
    const outbox = f.raw.prepare("SELECT aggregate_type, payload_json FROM sync_outbox WHERE aggregate_id = ?").get(result.eventId!) as { aggregate_type: string; payload_json: string };
    assert.equal(outbox.aggregate_type, "PRODUCTION_EVENT");
    assert.equal((JSON.parse(outbox.payload_json) as { eventType: string }).eventType, "STORE_EXIT");
  } finally {
    f.cleanup();
  }
});

test("the same carton scanned again is ALREADY_AT_GATE: no stock change, no second event", async () => {
  const f = createFixture();
  try {
    const [id] = generate(f.db, f.raw, "SK6", "7/10", "RED", 1);
    await stock(f.db, [id]);
    const useCase = mover(f.db);

    assert.equal((await useCase.execute({ rawScan: id, context: CONTEXT })).outcome, "MOVED_OUT");
    const updatedAt = (f.raw.prepare("SELECT updated_at FROM qr_master WHERE qr_id = ?").get(id) as { updated_at: string }).updated_at;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const duplicate = await useCase.execute({ rawScan: id, context: CONTEXT });

    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.outcome, "ALREADY_AT_GATE");
    assert.equal(duplicate.currentStatus, "TO_GATE");
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 1, factory: 0, store: 0, gate: 1 });
    assert.equal(movedEvents(f.raw, id).length, 2, "entry + one exit only");
    assert.equal((f.raw.prepare("SELECT updated_at FROM qr_master WHERE qr_id = ?").get(id) as { updated_at: string }).updated_at, updatedAt);
  } finally {
    f.cleanup();
  }
});

test("a carton that skipped the store (PRODUCED) is NOT_IN_STORE and left exactly as it was", async () => {
  const f = createFixture();
  try {
    const [id] = generate(f.db, f.raw, "SK6", "7/10", "RED", 1);
    await produce(f.db, [id]);
    const before = qrState(f.raw, id);

    const result = await mover(f.db).execute({ rawScan: id, context: CONTEXT });

    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "NOT_IN_STORE");
    assert.equal(result.currentStatus, "PRODUCED");
    assert.match(result.reason ?? "", /move it in first/i);
    assert.deepEqual(qrState(f.raw, id), before);
    assert.equal(movedEvents(f.raw, id).length, 0);
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 1, factory: 1, store: 0, gate: 0 });
  } finally {
    f.cleanup();
  }
});

test("unknown, never-produced, voided and dispatched codes are refused without writes", async () => {
  const f = createFixture();
  try {
    const useCase = mover(f.db);
    const eventCount = () => (f.raw.prepare("SELECT COUNT(1) AS c FROM production_events").get() as { c: number }).c;

    assert.equal((await useCase.execute({ rawScan: "SK6_RED_7/10_999999", context: CONTEXT })).outcome, "UNKNOWN_QR");

    const [generated] = generate(f.db, f.raw, "SK6", "7/10", "RED", 1);
    const notProduced = await useCase.execute({ rawScan: generated, context: CONTEXT });
    assert.equal(notProduced.outcome, "NOT_PRODUCED");
    assert.equal(notProduced.registryStatus, "GENERATED");
    assert.equal(qrState(f.raw, generated), undefined, "no unit was created");

    const [voidId] = generate(f.db, f.raw, "SK6", "7/10", "BLUE", 1);
    f.db.voidQrCode({ qrId: voidId, reason: "label torn", actor: "admin" });
    const voided = await useCase.execute({ rawScan: voidId, context: CONTEXT });
    assert.equal(voided.outcome, "NOT_PRODUCED");
    assert.equal(voided.registryStatus, "VOID");

    const [dispatchedId] = generate(f.db, f.raw, "SK6", "7/10", "GREEN", 1);
    await produce(f.db, [dispatchedId]);
    assert.equal((await dispatcher(f.db).execute({ rawScan: dispatchedId, context: CONTEXT })).accepted, true);
    const before = eventCount();
    const dispatched = await useCase.execute({ rawScan: dispatchedId, context: CONTEXT });
    assert.equal(dispatched.outcome, "NOT_ELIGIBLE");
    assert.equal(dispatched.currentStatus, "DISPATCHED");
    assert.match(dispatched.reason ?? "", /already been dispatched/i);
    assert.equal(eventCount(), before);
  } finally {
    f.cleanup();
  }
});

test("a carton at the gate can be dispatched, and leaves from the GATE location", async () => {
  const f = createFixture();
  try {
    const ids = generate(f.db, f.raw, "SK6", "7/10", "RED", 2);
    await stock(f.db, ids);
    assert.equal((await mover(f.db).execute({ rawScan: ids[0], context: CONTEXT })).outcome, "MOVED_OUT");
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 2, factory: 0, store: 1, gate: 1 });

    const dispatched = await dispatcher(f.db).execute({ rawScan: ids[0], context: CONTEXT });
    assert.equal(dispatched.accepted, true, dispatched.reason);
    assert.equal(qrState(f.raw, ids[0])?.current_status, "DISPATCHED");
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 1, factory: 0, store: 1, gate: 0 });

    // Marking a gate unit damaged also takes it from the gate, not the store.
    assert.equal((await mover(f.db).execute({ rawScan: ids[1], context: CONTEXT })).outcome, "MOVED_OUT");
    f.db.markQrCodeDamaged({ qrId: ids[1], reason: "crushed", actor: "admin", context: CONTEXT });
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 0, factory: 0, store: 0, gate: 0 });
  } finally {
    f.cleanup();
  }
});

test("a carton moved out by mistake is brought back with a Move In scan (GATE → WAREHOUSE)", async () => {
  const f = createFixture();
  try {
    const [id] = generate(f.db, f.raw, "SK6", "7/10", "RED", 1);
    await stock(f.db, [id]);
    assert.equal((await mover(f.db).execute({ rawScan: id, context: CONTEXT })).outcome, "MOVED_OUT");

    const back = await receiver(f.db).execute({ rawScan: id, context: CONTEXT, actor: "store-op" });
    assert.equal(back.outcome, "RECEIVED");
    assert.equal(back.previousStatus, "TO_GATE");
    assert.equal(back.currentStatus, "WAREHOUSE");
    assert.deepEqual(qrState(f.raw, id), { current_status: "WAREHOUSE", current_location_type: "WAREHOUSE", current_location_id: FACTORY });
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 1, factory: 0, store: 1, gate: 0 });

    const events = movedEvents(f.raw, id).map((e) => [e.meta.eventType, e.meta.fromLocationType, e.meta.toLocationType]);
    assert.deepEqual(events, [
      ["STORE_ENTRY", "FACTORY", "WAREHOUSE"],
      ["STORE_EXIT", "WAREHOUSE", "GATE"],
      ["STORE_ENTRY", "GATE", "WAREHOUSE"],
    ]);

    // And it can go out again.
    assert.equal((await mover(f.db).execute({ rawScan: id, context: CONTEXT })).outcome, "MOVED_OUT");
  } finally {
    f.cleanup();
  }
});

test("two terminals moving the same carton out at once: exactly one store exit", async () => {
  const f = createFixture();
  const second = openDb(f.dbPath);
  try {
    const [id] = generate(f.db, f.raw, "SK6", "7/10", "RED", 1);
    await stock(f.db, [id]);

    const [a, b] = await Promise.all([
      mover(f.db).execute({ rawScan: id, context: { ...CONTEXT, deviceId: "desktop-store-1" } }),
      mover(second).execute({ rawScan: id, context: { ...CONTEXT, deviceId: "desktop-store-2" } }),
    ]);

    assert.deepEqual([a.outcome, b.outcome].sort(), ["ALREADY_AT_GATE", "MOVED_OUT"]);
    assert.equal(qrState(f.raw, id)?.current_status, "TO_GATE");
    assert.equal(movedEvents(f.raw, id).filter((e) => e.meta.eventType === "STORE_EXIT").length, 1, "one audit event");
    assert.deepEqual(locationStock(f.raw, "SK6", "RED", "7/10"), { total: 1, factory: 0, store: 0, gate: 1 });
  } finally {
    second.close();
    f.cleanup();
  }
});

test("QR Management sees the same truth: stage To Gate and a STORE_EXIT step on the timeline", async () => {
  const f = createFixture();
  try {
    const [id] = generate(f.db, f.raw, "SK6", "7/10", "RED", 1);
    await stock(f.db, [id]);
    const result = await mover(f.db).execute({ rawScan: id, context: CONTEXT, actor: "store-op" });
    assert.equal(result.outcome, "MOVED_OUT");

    const detail = f.db.getQrDetail(id);
    assert.ok(detail);
    assert.equal(detail.stage, "TO_GATE");
    assert.equal(detail.lifecycle?.currentStatus, "TO_GATE");
    assert.equal(detail.lifecycle?.locationType, "GATE");
    assert.deepEqual(
      detail.events.map((e) => [e.eventType, e.subType]),
      [
        ["PRODUCED", null],
        ["MOVED", "STORE_ENTRY"],
        ["MOVED", "STORE_EXIT"],
      ]
    );
    const exit = detail.events[2];
    assert.equal(exit.occurredAt, result.movedOutAt);
    assert.equal(exit.note, "WAREHOUSE → GATE · by store-op");

    const overview = f.db.getQrGenerationOverview({ article: "SK6" });
    assert.equal(overview.stageCounts?.TO_GATE, 1);
  } finally {
    f.cleanup();
  }
});

test("move-out sessions: independent of receiving sessions, and the summary counts only real move-outs", async () => {
  const f = createFixture();
  try {
    const red = generate(f.db, f.raw, "SK6", "7/10", "RED", 3);
    const blue = generate(f.db, f.raw, "SK6", "7/10", "BLUE", 2);
    const sk12 = generate(f.db, f.raw, "SK12", "4/6", "RED", 1);
    await stock(f.db, [...red, ...blue, ...sk12]);

    // Receiving and move-out sessions number and resume independently on the same device.
    const receivingSession = f.db.startOrResumeStoreReceivingSession({ deviceId: "desktop-main" });
    const session = f.db.startOrResumeStoreMoveOutSession({ deviceId: "desktop-main", startedBy: "store-op" });
    assert.equal(receivingSession.code, "SR-000001");
    assert.equal(session.code, "SO-000001");
    assert.equal(f.db.startOrResumeStoreMoveOutSession({ deviceId: "desktop-main" }).id, session.id, "same day, same device → same session");

    const useCase = mover(f.db);
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
      "MOVED_OUT",
      "MOVED_OUT",
      "UNKNOWN_QR",
      "MOVED_OUT",
      "ALREADY_AT_GATE",
      "MOVED_OUT",
      "INVALID_FORMAT",
      "MOVED_OUT",
    ]);

    const summary = f.db.getStoreMoveOutSessionSummary(session.id, { recentLimit: 3 });
    assert.ok(summary);
    assert.equal(summary.session.code, session.code);
    assert.equal(summary.movedOutCount, 5);
    assert.deepEqual(summary.byProduct, [
      { article: "SK6", color: "BLUE", size: "7/10", count: 2 },
      { article: "SK6", color: "RED", size: "7/10", count: 2 },
      { article: "SK12", color: "RED", size: "4/6", count: 1 },
    ]);
    assert.equal(summary.recent.length, 3, "recent list is capped, not the whole history");
    assert.equal(summary.recent[0].qrId, blue[1]);
    assert.equal(summary.lastMovedOut?.qrId, blue[1]);
    assert.equal(summary.lastMovedOut?.actor, "store-op");
    assert.ok(summary.lastMovedOut?.movedOutAt);

    // Receiving scans in the same period never leak into the move-out tally, and vice versa.
    assert.equal(f.db.getStoreReceivingSessionSummary(receivingSession.id)?.receivedCount, 0);

    // A new session closes the old one and continues the numbering.
    const fresh = f.db.startNewStoreMoveOutSession({ deviceId: "desktop-main" });
    assert.equal(fresh.code, "SO-000002");
    assert.equal(f.db.getStoreMoveOutSession(session.id)?.status, "CLOSED");
    assert.equal(f.db.getStoreMoveOutSession(fresh.id)?.status, "OPEN");
    assert.equal(f.db.getStoreReceivingSession(receivingSession.id)?.status, "OPEN", "the receiving session is untouched");
    assert.equal(f.db.getStoreMoveOutSessionSummary("missing"), null);

    const results: StoreExitScanResult[] = [];
    for (const id of [red[2]]) results.push(await useCase.execute({ rawScan: id, context: CONTEXT, sessionId: fresh.id }));
    assert.equal(results[0].outcome, "MOVED_OUT");
    assert.equal(f.db.getStoreMoveOutSessionSummary(fresh.id)?.movedOutCount, 1);
    assert.equal(f.db.getStoreMoveOutSessionSummary(session.id)?.movedOutCount, 5);
  } finally {
    f.cleanup();
  }
});
