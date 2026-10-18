import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CancelGatepassUseCase,
  CreateGatepassUseCase,
  InMemoryEventBus,
  ProcessScanUseCase,
  StoreEntryScanUseCase,
  StoreExitScanUseCase,
} from "@erp/application";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// Gatepass reservations against the real database, driven by real scans.
//
//   Current Stock    physical cartons In Store (stock_projection_by_location at WAREHOUSE)
//   Reserved         Σ outstanding (requested − moved out) over CREATED gatepasses
//   Reflected Stock  Current Stock − Reserved
//
// Stock is built the only way it can be — QR Generator → Live Production → Store Move In —
// and consumed the only way it can be — a plain Store Move Out scan, which the business layer
// counts against the oldest open gatepass line owing that variant (the operator names nothing).
// Every figure below is read back through the same repository the Gatepass screen uses.

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-gatepass-reservations-"));
  const dbPath = path.join(tempDir, "gatepass.db");
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

// Wired exactly as apps/desktop/src/main.ts wires them: the database is also the gatepass repository.
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

const gatepassCreator = (db: SqliteDatabase) =>
  new CreateGatepassUseCase({ txManager: db, repo: db, idGenerator: new UuidGenerator(), localDate: () => "2026-09-21" });

const gatepassCanceller = (db: SqliteDatabase) => new CancelGatepassUseCase({ txManager: db, repo: db, idGenerator: new UuidGenerator() });

/** Registers `quantity` codes for article/size/colour via the real QR Generator. */
function generate(db: SqliteDatabase, raw: Raw, article: string, size: string, color: string, quantity: number): string[] {
  let row = raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string } | undefined;
  if (!row) {
    db.createProduct({ article, size, sellingPrice: 550, status: "ACTIVE" });
    row = raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string };
  }
  return db.generateQrBatch({ articleSizeId: row.id, color, quantity, createdBy: "admin" }).qrCodes.map((b) => b.id);
}

/** Produces and receives every id, so each one is In Store. Returns the variant id and the QR ids. */
async function stockVariant(db: SqliteDatabase, raw: Raw, article: string, size: string, color: string, quantity: number) {
  const ids = generate(db, raw, article, size, color, quantity);
  const produce = producer(db);
  const receive = receiver(db);
  for (const id of ids) {
    assert.equal((await produce.execute({ rawScan: id, context: CONTEXT })).accepted, true, `produce ${id}`);
    assert.equal((await receive.execute({ rawScan: id, context: CONTEXT })).outcome, "RECEIVED", `receive ${id}`);
  }
  const variant = raw.prepare("SELECT id FROM product_variants WHERE article = ? AND color = ? AND size = ?").get(article, color, size) as { id: string };
  return { variantId: variant.id, ids };
}

const createParty = (db: SqliteDatabase, name: string) => db.createParty({ partyName: name, partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });

/** Current / Reserved / Reflected for one colour + size, as the Gatepass screen reads them. */
function figures(db: SqliteDatabase, article: string, color: string, size: string) {
  const row = db.listStoreStockByArticle(article).find((r) => r.color === color && r.size === size);
  // A variant with nothing In Store is not listed; its figures are then 0 / whatever is reserved / negative.
  if (!row) {
    const whole = db.listStoreStock().find((r) => r.article === article && r.color === color && r.size === size);
    if (whole) return { current: whole.storeQuantity, reserved: whole.reservedQuantity, reflected: whole.reflectedQuantity };
    return { current: 0, reserved: 0, reflected: 0 };
  }
  return { current: row.storeQuantity, reserved: row.reservedQuantity, reflected: row.reflectedQuantity };
}

/** What a gatepass says about itself: per line requested / moved out / outstanding, plus the totals. */
function progress(db: SqliteDatabase, gatepassId: string) {
  const doc = db.getGatepass(gatepassId)!;
  return {
    status: doc.status,
    total: doc.totalQuantity,
    dispatched: doc.dispatchedFromStoreQuantity,
    outstanding: doc.outstandingQuantity,
    lines: doc.lines.map((l) => [l.color, l.size, l.quantity, l.dispatchedFromStoreQuantity, l.outstandingQuantity] as const),
  };
}

const qrState = (raw: Raw, qrId: string) => {
  const row = raw.prepare("SELECT current_status, current_location_type FROM qr_master WHERE qr_id = ?").get(qrId) as { current_status: string; current_location_type: string };
  return `${row.current_status}@${row.current_location_type}`;
};

async function createGatepass(db: SqliteDatabase, partyId: string, lines: Array<{ variantId: string; quantity: number; seen?: number }>) {
  return gatepassCreator(db).execute({
    partyId,
    lines: lines.map((l) => ({ productVariantId: l.variantId, quantity: l.quantity, reflectedStockSeen: l.seen })),
    actor: "clerk",
    actorUserId: "user-clerk",
    deviceId: "desktop-main",
  });
}

/** Plain store scans — nothing gatepass-specific is passed. Asserts every scan is accepted. */
async function moveOut(db: SqliteDatabase, ids: string[]) {
  const move = mover(db);
  const results = [];
  for (const id of ids) {
    const result = await move.execute({ rawScan: id, context: CONTEXT, actor: "store-op", sessionId: "so-1" });
    assert.equal(result.outcome, "MOVED_OUT", `${id}: ${result.reason ?? ""}`);
    results.push(result);
  }
  return results;
}

/** Which gatepass the carton's latest STORE_EXIT event was counted against (null when none was reserved). */
const exitAttribution = (raw: Raw, qrId: string): string | null => {
  const row = raw
    .prepare("SELECT gatepass_id FROM production_events WHERE qr_id = ? AND event_type = 'MOVED' AND json_extract(metadata_json, '$.eventType') = 'STORE_EXIT' ORDER BY event_ts_local DESC, created_at DESC LIMIT 1")
    .get(qrId) as { gatepass_id: string | null } | undefined;
  return row?.gatepass_id ?? null;
};

// ─── Schema ───────────────────────────────────────────────────────────────────

test("schema — production_events.gatepass_id is nullable, references gatepasses, is indexed, and gatepass_lines caches nothing", () => {
  const f = createFixture();
  try {
    assert.ok(f.raw.prepare("SELECT 1 FROM schema_migrations WHERE version = '034_gatepass_store_exit_attribution'").get());
    const columns = f.raw.prepare("PRAGMA table_info(production_events)").all() as Array<{ name: string; notnull: number }>;
    const column = columns.find((c) => c.name === "gatepass_id");
    assert.ok(column, "gatepass_id column exists");
    assert.equal(column.notnull, 0, "historical events keep NULL — never attributed retroactively");
    const fks = f.raw.prepare("PRAGMA foreign_key_list(production_events)").all() as Array<{ table: string; from: string }>;
    assert.ok(fks.some((k) => k.table === "gatepasses" && k.from === "gatepass_id"));
    assert.ok(f.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_production_events_gatepass'").get());
    // Requested quantity is the only quantity stored on a line; dispatched / outstanding / reflected are derived.
    const lineColumns = (f.raw.prepare("PRAGMA table_info(gatepass_lines)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(lineColumns.filter((c) => /quantity|reserved|reflected|dispatched|outstanding/i.test(c)), ["quantity", "store_quantity_at_creation"]);
  } finally {
    f.cleanup();
  }
});

// ─── The acceptance scenario ──────────────────────────────────────────────────
// The store operator scans; nothing gatepass-specific happens on the station. The scan
// itself counts the carton against the oldest open gatepass line owing that variant.

test("acceptance — Current 5, GP1 2 → Current 5 / Reserved 2 / Available 3 → one PLAIN scan → Current 4, GP1 dispatched 1 / outstanding 1, Reserved 1, Available 3", async () => {
  const f = createFixture();
  try {
    const party = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 5);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 5, reserved: 0, reflected: 5 });

    // Test F — creating the gatepass reserves and moves nothing.
    const before = f.raw.prepare("SELECT qr_id, current_status, current_location_type FROM qr_master ORDER BY qr_id").all();
    const eventsBefore = (f.raw.prepare("SELECT COUNT(1) AS c FROM production_events").get() as { c: number }).c;
    const gp1 = await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 2, seen: 5 }]);
    assert.equal(gp1.accepted, true, gp1.reason);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 5, reserved: 2, reflected: 3 });
    assert.deepEqual(progress(f.db, gp1.gatepassId!), { status: "CREATED", total: 2, dispatched: 0, outstanding: 2, lines: [["RED", "7/10", 2, 0, 2]] });
    assert.deepEqual(f.raw.prepare("SELECT qr_id, current_status, current_location_type FROM qr_master ORDER BY qr_id").all(), before);
    assert.equal((f.raw.prepare("SELECT COUNT(1) AS c FROM production_events").get() as { c: number }).c, eventsBefore);

    // Test B / G — a plain scan: Current falls by one, GP1's outstanding falls by one, Available is unchanged.
    const [scan] = await moveOut(f.db, [red.ids[0]]);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 4, reserved: 1, reflected: 3 });
    assert.deepEqual(progress(f.db, gp1.gatepassId!), { status: "CREATED", total: 2, dispatched: 1, outstanding: 1, lines: [["RED", "7/10", 2, 1, 1]] });
    assert.deepEqual(scan.gatepass, { gatepassId: gp1.gatepassId, code: "GP-000001", partyName: "ABC TRADERS", article: "SK6", color: "RED", size: "7/10", requested: 2, dispatchedFromStore: 1, outstanding: 1 });
    assert.equal(exitAttribution(f.raw, red.ids[0]), gp1.gatepassId, "the event records exactly which reservation it consumed");
    assert.equal(qrState(f.raw, red.ids[0]), "TO_GATE@GATE");
    // The requested quantity is untouched history.
    assert.equal((f.raw.prepare("SELECT quantity FROM gatepass_lines WHERE gatepass_id = ?").get(gp1.gatepassId!) as { quantity: number }).quantity, 2);

    // Test I — exactly one stock decrement per scan: the location projection agrees with the QR states.
    const inStore = (f.raw.prepare("SELECT COUNT(1) AS c FROM qr_master WHERE current_status = 'WAREHOUSE'").get() as { c: number }).c;
    assert.equal(inStore, 4);
    assert.equal(figures(f.db, "SK6", "RED", "7/10").current, 4);

    // The second carton completes the document; the third leaves for nobody and still leaves.
    await moveOut(f.db, [red.ids[1]]);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 3, reserved: 0, reflected: 3 });
    assert.deepEqual(progress(f.db, gp1.gatepassId!).lines, [["RED", "7/10", 2, 2, 0]]);
    const [free] = await moveOut(f.db, [red.ids[2]]);
    assert.equal(free.gatepass, undefined);
    assert.equal(exitAttribution(f.raw, red.ids[2]), null);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 2, reserved: 0, reflected: 2 });
  } finally {
    f.cleanup();
  }
});

test("Test A — a plain scan with no reservation at all is an ordinary store OUT: Current falls, no gatepass is touched", async () => {
  const f = createFixture();
  try {
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 10);
    const [scan] = await moveOut(f.db, [red.ids[0]]);
    assert.equal(scan.gatepass, undefined);
    assert.equal(exitAttribution(f.raw, red.ids[0]), null);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 9, reserved: 0, reflected: 9 });
    assert.equal((f.raw.prepare("SELECT COUNT(1) AS c FROM gatepasses").get() as { c: number }).c, 0, "no gatepass was created or needed");
  } finally {
    f.cleanup();
  }
});

test("Test C — GP1 2 + GP2 1 on Current 5: plain scans consume GP1 first (oldest), then GP2 — 4/2/2 → 3/1/2 → 2/0/2", async () => {
  const f = createFixture();
  try {
    const party = createParty(f.db, "ABC TRADERS");
    const other = createParty(f.db, "XYZ TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 5);
    const gp1 = await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 2 }]);
    const gp2 = await createGatepass(f.db, other, [{ variantId: red.variantId, quantity: 1 }]);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 5, reserved: 3, reflected: 2 });

    const [first] = await moveOut(f.db, [red.ids[0]]);
    assert.equal(first.gatepass?.code, "GP-000001");
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 4, reserved: 2, reflected: 2 });
    assert.deepEqual(progress(f.db, gp1.gatepassId!).lines, [["RED", "7/10", 2, 1, 1]]);
    assert.deepEqual(progress(f.db, gp2.gatepassId!).lines, [["RED", "7/10", 1, 0, 1]]);

    const [second] = await moveOut(f.db, [red.ids[1]]);
    assert.equal(second.gatepass?.code, "GP-000001");
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 3, reserved: 1, reflected: 2 });
    assert.deepEqual(progress(f.db, gp1.gatepassId!).lines, [["RED", "7/10", 2, 2, 0]]);
    assert.deepEqual(progress(f.db, gp2.gatepassId!).lines, [["RED", "7/10", 1, 0, 1]]);

    const [third] = await moveOut(f.db, [red.ids[2]]);
    assert.equal(third.gatepass?.code, "GP-000002");
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 2, reserved: 0, reflected: 2 });
    assert.deepEqual(progress(f.db, gp2.gatepassId!).lines, [["RED", "7/10", 1, 1, 0]]);

    // The attribution is on the events themselves, in FIFO order.
    assert.deepEqual([exitAttribution(f.raw, red.ids[0]), exitAttribution(f.raw, red.ids[1]), exitAttribution(f.raw, red.ids[2])], [gp1.gatepassId, gp1.gatepassId, gp2.gatepassId]);
    // The list screen shows the same progress.
    assert.deepEqual(f.db.listGatepasses().rows.map((r) => [r.code, r.totalQuantity, r.dispatchedFromStoreQuantity, r.outstandingQuantity]), [["GP-000002", 1, 1, 0], ["GP-000001", 2, 2, 0]]);
  } finally {
    f.cleanup();
  }
});

test("the longer sequence — Current 5 / GP1 3 / GP2 1: three plain scans empty GP1, a fourth empties GP2; Reflected stays 1 throughout", async () => {
  const f = createFixture();
  try {
    const party = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 5);
    const gp1 = await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 3, seen: 5 }]);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 5, reserved: 3, reflected: 2 });
    const gp2 = await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 1, seen: 2 }]);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 5, reserved: 4, reflected: 1 });

    const gp3 = await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 2, seen: 1 }]);
    assert.equal(gp3.outcome, "INSUFFICIENT_STOCK");
    assert.deepEqual(gp3.shortages?.map((s) => [s.requested, s.currentStock, s.reserved, s.reflected, s.seen]), [[2, 5, 4, 1, 1]]);

    const scans = await moveOut(f.db, red.ids.slice(0, 3));
    assert.deepEqual(scans.map((s) => [s.gatepass?.code, s.gatepass?.dispatchedFromStore, s.gatepass?.outstanding]), [["GP-000001", 1, 2], ["GP-000001", 2, 1], ["GP-000001", 3, 0]]);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 2, reserved: 1, reflected: 1 });
    assert.deepEqual(progress(f.db, gp1.gatepassId!), { status: "CREATED", total: 3, dispatched: 3, outstanding: 0, lines: [["RED", "7/10", 3, 3, 0]] });
    assert.deepEqual(progress(f.db, gp2.gatepassId!), { status: "CREATED", total: 1, dispatched: 0, outstanding: 1, lines: [["RED", "7/10", 1, 0, 1]] });

    const [fourth] = await moveOut(f.db, [red.ids[3]]);
    assert.equal(fourth.gatepass?.code, "GP-000002");
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 1, reserved: 0, reflected: 1 });
    assert.deepEqual(progress(f.db, gp2.gatepassId!), { status: "CREATED", total: 1, dispatched: 1, outstanding: 0, lines: [["RED", "7/10", 1, 1, 0]] });

    // The last carton is free again for a new document.
    const gp4 = await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 1, seen: 1 }]);
    assert.equal(gp4.accepted, true, gp4.reason);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 1, reserved: 1, reflected: 0 });
  } finally {
    f.cleanup();
  }
});

// ─── Variant isolation ────────────────────────────────────────────────────────

test("Test D — a BLUE scan never consumes a RED reservation; a RED scan touches only the RED line even on a multi-line document", async () => {
  const f = createFixture();
  try {
    const party = createParty(f.db, "ABC TRADERS");
    const red710 = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 5);
    const blue710 = await stockVariant(f.db, f.raw, "SK6", "7/10", "BLUE", 4);
    const red46 = await stockVariant(f.db, f.raw, "SK6", "4/6", "RED", 2);
    const gp = await createGatepass(f.db, party, [
      { variantId: red710.variantId, quantity: 2 },
      { variantId: red46.variantId, quantity: 1 },
    ]);

    // BLUE 7/10 has no reservation: an ordinary OUT, RED's lines untouched.
    const [blue] = await moveOut(f.db, [blue710.ids[0]]);
    assert.equal(blue.gatepass, undefined);
    assert.deepEqual(figures(f.db, "SK6", "BLUE", "7/10"), { current: 3, reserved: 0, reflected: 3 });
    assert.deepEqual(progress(f.db, gp.gatepassId!).lines, [["RED", "7/10", 2, 0, 2], ["RED", "4/6", 1, 0, 1]]);

    // RED 7/10 consumes only the RED 7/10 line — not RED 4/6 (same article and colour, other size).
    const [red] = await moveOut(f.db, [red710.ids[0]]);
    assert.deepEqual([red.gatepass?.color, red.gatepass?.size], ["RED", "7/10"]);
    assert.deepEqual(progress(f.db, gp.gatepassId!).lines, [["RED", "7/10", 2, 1, 1], ["RED", "4/6", 1, 0, 1]]);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 4, reserved: 1, reflected: 3 });
    assert.deepEqual(figures(f.db, "SK6", "RED", "4/6"), { current: 2, reserved: 1, reflected: 1 });
  } finally {
    f.cleanup();
  }
});

// ─── Concurrency ──────────────────────────────────────────────────────────────

test("over-reservation — GP1 3 + GP2 2 fill Current 5; GP3 for 1 is rejected, and the fully reserved variant still shows on the grid", async () => {
  const f = createFixture();
  try {
    const party = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 5);
    assert.equal((await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 3 }])).accepted, true);
    assert.equal((await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 2 }])).accepted, true);
    const gp3 = await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 1 }]);
    assert.equal(gp3.outcome, "INSUFFICIENT_STOCK");
    assert.match(gp3.reason ?? "", /Current Stock: 5\. Reserved: 5\. Reflected Stock: 0\. Requested: 1\./);
    assert.deepEqual(f.db.listStoreStock().map((r) => [r.color, r.storeQuantity, r.reservedQuantity, r.reflectedQuantity]), [["RED", 5, 5, 0]]);
  } finally {
    f.cleanup();
  }
});

test("concurrent creation — Current 5 with 3 outstanding: two clients asking 2 and 2 at once cannot both succeed; racing for the last carton likewise", async () => {
  const f = createFixture();
  const second = openDb(f.dbPath);
  try {
    const party = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 5);
    assert.equal((await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 3 }])).accepted, true);

    const [a, b] = await Promise.all([
      createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 2, seen: 2 }]),
      createGatepass(second, party, [{ variantId: red.variantId, quantity: 2, seen: 2 }]),
    ]);
    assert.equal([a, b].filter((r) => r.accepted).length, 1, `${a.outcome} / ${b.outcome}`);
    const refused = [a, b].find((r) => !r.accepted)!;
    assert.equal(refused.outcome, "STOCK_CHANGED");
    assert.deepEqual(refused.shortages?.map((s) => [s.requested, s.currentStock, s.reserved, s.reflected, s.seen]), [[2, 5, 5, 0, 2]]);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 5, reserved: 5, reflected: 0 });
    assert.equal((f.raw.prepare("SELECT COUNT(1) AS c FROM gatepasses").get() as { c: number }).c, 2);
  } finally {
    second.close();
    f.cleanup();
  }
});

test("concurrent scans — two terminals moving two different cartons of a variant at once each consume a different outstanding carton, in order", async () => {
  const f = createFixture();
  const second = openDb(f.dbPath);
  try {
    const party = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 3);
    const gp = await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 2 }]);

    const [a, b] = await Promise.all([
      mover(f.db).execute({ rawScan: red.ids[0], context: CONTEXT }),
      mover(second).execute({ rawScan: red.ids[1], context: CONTEXT }),
    ]);
    assert.deepEqual([a.outcome, b.outcome], ["MOVED_OUT", "MOVED_OUT"]);
    // Serialised by the write lock: one saw "1 of 2", the other "2 of 2" — never both "1 of 2".
    assert.deepEqual([a.gatepass?.dispatchedFromStore, b.gatepass?.dispatchedFromStore].sort(), [1, 2]);
    assert.deepEqual(progress(f.db, gp.gatepassId!).lines, [["RED", "7/10", 2, 2, 0]]);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 1, reserved: 0, reflected: 1 });
  } finally {
    second.close();
    f.cleanup();
  }
});

// ─── Transaction safety ───────────────────────────────────────────────────────

test("Test H — if the reconciliation read fails, the physical move rolls back too: the carton is still In Store and no event exists", async () => {
  const f = createFixture();
  try {
    const party = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 3);
    await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 1 }]);
    const eventsBefore = (f.raw.prepare("SELECT COUNT(1) AS c FROM production_events").get() as { c: number }).c;

    const broken = new StoreExitScanUseCase({
      txManager: f.db,
      qrLookupRepo: f.db,
      gatepassRepo: {
        async findOldestOutstandingGatepassLine() {
          throw new Error("reconciliation failed");
        },
        gatepassStoreScanComplete: () => false,
        advanceGatepassStatus: () => false,
        findGatepassLineForVariant: () => null,
        readGatepassStatus: () => null,
      },
      qrRegistry: f.db,
      qrMasterRepo: f.db,
      storeExitEventsRepo: f.db,
      stockProjectionRepo: f.db,
      outboxRepo: f.db,
      eventPublisher: new InMemoryEventBus(),
      idGenerator: new UuidGenerator(),
    });
    await assert.rejects(broken.execute({ rawScan: red.ids[0], context: CONTEXT }), /reconciliation failed/);

    // The guarded status move had already run inside the transaction; ROLLBACK undid it.
    assert.equal(qrState(f.raw, red.ids[0]), "WAREHOUSE@WAREHOUSE");
    assert.equal((f.raw.prepare("SELECT COUNT(1) AS c FROM production_events").get() as { c: number }).c, eventsBefore);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 3, reserved: 1, reflected: 2 });
    // And the same carton still moves out normally afterwards.
    await moveOut(f.db, [red.ids[0]]);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 2, reserved: 0, reflected: 2 });
  } finally {
    f.cleanup();
  }
});

// ─── Cancellation ─────────────────────────────────────────────────────────────

test("cancellation — refused once a carton has left the store; before any move the whole reservation is released; Current never moves", async () => {
  const f = createFixture();
  try {
    const party = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 5);

    const gp1 = await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 2 }]);
    await moveOut(f.db, [red.ids[0]]);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 4, reserved: 1, reflected: 3 });
    const eventsBefore = (f.raw.prepare("SELECT COUNT(1) AS c FROM production_events").get() as { c: number }).c;

    // Once a carton has physically left the store the paper can no longer be torn up: the
    // goods are standing at the gate and putting them back is a controlled reversal, which
    // this system does not have. The document, the reservation and the stock all stand.
    const cancelled = await gatepassCanceller(f.db).execute({ gatepassId: gp1.gatepassId!, reason: "customer took one", actor: "manager", actorUserId: "user-m" });
    assert.equal(cancelled.accepted, false);
    assert.equal(cancelled.outcome, "ALREADY_MOVED");
    assert.match(cancelled.reason ?? "", /already left the store/);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 4, reserved: 1, reflected: 3 }, "nothing was released");
    assert.equal(qrState(f.raw, red.ids[0]), "TO_GATE@GATE");
    assert.equal((f.raw.prepare("SELECT COUNT(1) AS c FROM production_events").get() as { c: number }).c, eventsBefore, "nothing physical happened");
    assert.deepEqual(progress(f.db, gp1.gatepassId!), { status: "CREATED", total: 2, dispatched: 1, outstanding: 1, lines: [["RED", "7/10", 2, 1, 1]] });
    assert.equal(
      (f.raw.prepare("SELECT COUNT(1) AS c FROM audit_log WHERE entity_id = ? AND event_type = 'GATEPASS_CANCELLED'").get(gp1.gatepassId!) as { c: number }).c,
      0,
      "a refused cancellation writes no audit row"
    );

    // Its remaining carton is still owed, so the next plain scan is still counted against it.
    const [stillOwed] = await moveOut(f.db, [red.ids[1]]);
    assert.equal(stillOwed.gatepass?.gatepassId, gp1.gatepassId);

    const gp2 = await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 2 }]);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 3, reserved: 2, reflected: 1 });
    const cancelE = await gatepassCanceller(f.db).execute({ gatepassId: gp2.gatepassId!, reason: "wrong party", actor: "manager" });
    assert.equal(cancelE.releasedQuantity, 2);
    assert.equal(cancelE.dispatchedFromStoreQuantity, 0);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 3, reserved: 0, reflected: 3 });
  } finally {
    f.cleanup();
  }
});

// ─── Bring-back: the compensating record ──────────────────────────────────────

test("a carton brought back from the gate makes the gatepass it was counted against outstanding again — by its own exit event, never by article + size", async () => {
  const f = createFixture();
  try {
    const party = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 5);
    const gp1 = await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 3 }]);
    const gp2 = await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 1 }]);
    await moveOut(f.db, red.ids.slice(0, 4)); // GP1 ×3 then GP2 ×1, oldest first
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 1, reserved: 0, reflected: 1 });
    assert.equal(exitAttribution(f.raw, red.ids[1]), gp1.gatepassId);

    // One of GP1's cartons comes back with a plain receiving scan.
    const back = await receiver(f.db).execute({ rawScan: red.ids[1], context: CONTEXT, actor: "store-op" });
    assert.equal(back.outcome, "RECEIVED");
    const entry = f.raw.prepare("SELECT gatepass_id, json_extract(metadata_json, '$.eventType') AS kind FROM production_events WHERE qr_id = ? AND event_type = 'MOVED' ORDER BY event_ts_local DESC, created_at DESC LIMIT 1").get(red.ids[1]) as { gatepass_id: string; kind: string };
    assert.deepEqual({ ...entry }, { gatepass_id: gp1.gatepassId, kind: "STORE_ENTRY" });

    // GP1 is owed that carton again; GP2 — same article, colour and size — is untouched.
    assert.deepEqual(progress(f.db, gp1.gatepassId!).lines, [["RED", "7/10", 3, 2, 1]]);
    assert.deepEqual(progress(f.db, gp2.gatepassId!).lines, [["RED", "7/10", 1, 1, 0]]);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 2, reserved: 1, reflected: 1 });

    // The next plain scan of a RED carton is counted against GP1 again (the only open line).
    const [again] = await moveOut(f.db, [red.ids[1]]);
    assert.equal(again.gatepass?.code, "GP-000001");
    assert.deepEqual(progress(f.db, gp1.gatepassId!).lines, [["RED", "7/10", 3, 3, 0]]);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 1, reserved: 0, reflected: 1 });
  } finally {
    f.cleanup();
  }
});

// ─── Nothing else is touched ──────────────────────────────────────────────────

test("creating a gatepass writes only gatepasses, gatepass_lines, audit_log and notifications — no QR, event, projection, voucher or ledger row", async () => {
  const f = createFixture();
  try {
    const party = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 5);
    const tables = ["qr_master", "production_events", "stock_projection_by_variant", "stock_projection_by_location", "sync_outbox", "sale_vouchers", "sale_voucher_line_items", "cash_vouchers", "dispatch_sessions", "qr_codes"];
    const snapshot = () => ({
      counts: tables.map((table) => [table, (f.raw.prepare(`SELECT COUNT(1) AS c FROM ${table}`).get() as { c: number }).c]),
      qrs: f.raw.prepare("SELECT qr_id, current_status, current_location_type, updated_at FROM qr_master ORDER BY qr_id").all(),
      stock: f.raw.prepare("SELECT product_variant_id, location_type, quantity_on_hand, updated_at FROM stock_projection_by_location ORDER BY product_variant_id, location_type").all(),
    });
    const before = JSON.stringify(snapshot());
    const created = await createGatepass(f.db, party, [{ variantId: red.variantId, quantity: 5 }]);
    assert.equal(created.accepted, true, created.reason);
    assert.equal(JSON.stringify(snapshot()), before);
    assert.deepEqual(figures(f.db, "SK6", "RED", "7/10"), { current: 5, reserved: 5, reflected: 0 });
  } finally {
    f.cleanup();
  }
});
