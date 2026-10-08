import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CancelGatepassUseCase,
  CreateGatepassUseCase,
  DispatchScanUseCase,
  InMemoryEventBus,
  ProcessScanUseCase,
  StoreEntryScanUseCase,
  StoreExitScanUseCase,
  formatGatepassCode,
} from "@erp/application";
import type { CreateGatepassResult } from "@erp/application";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// Gatepass against the real database. Store stock is built the only way it can be built —
// QR Generator → Live Production → Store Move In — and then gatepasses are cut against it
// through CreateGatepassUseCase wired to SqliteDatabase exactly as the desktop app wires it.
//
// The recurring assertion is the one that matters most: a gatepass changes NOTHING about
// QRs, events, stock, vouchers or ledgers. Only its own two tables and audit_log.

const FACTORY = "factory-777";
const CONTEXT = { factoryId: FACTORY, workstationId: "ws-prod-01", deviceId: "desktop-main" };

type Raw = import("node:sqlite").DatabaseSync;

function openDb(dbPath: string) {
  const db = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-gatepass-"));
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

const gatepassCreator = (db: SqliteDatabase) =>
  new CreateGatepassUseCase({ txManager: db, repo: db, idGenerator: new UuidGenerator(), localDate: () => "2026-09-16" });

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

/** Produces and receives every id, so each one is In Store. */
async function stock(db: SqliteDatabase, ids: string[]) {
  const produce = producer(db);
  const receive = receiver(db);
  for (const id of ids) {
    const produced = await produce.execute({ rawScan: id, context: CONTEXT });
    assert.equal(produced.accepted, true, `produce ${id}: ${produced.reason ?? ""}`);
    const received = await receive.execute({ rawScan: id, context: CONTEXT });
    assert.equal(received.outcome, "RECEIVED", `receive ${id}: ${received.reason ?? ""}`);
  }
}

/** Builds In Store stock for article/colour/size and returns the variant id. */
async function stockVariant(db: SqliteDatabase, raw: Raw, article: string, size: string, color: string, quantity: number): Promise<{ variantId: string; ids: string[] }> {
  const ids = generate(db, raw, article, size, color, quantity);
  await stock(db, ids);
  const variant = raw.prepare("SELECT id FROM product_variants WHERE article = ? AND color = ? AND size = ?").get(article, color, size) as { id: string };
  return { variantId: variant.id, ids };
}

function createParty(db: SqliteDatabase, name: string, extra: Record<string, unknown> = {}): string {
  return db.createParty({ partyName: name, partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE", ...extra });
}

/** Everything a gatepass must NOT touch, in one snapshot (rows copied to plain objects for deepEqual). */
function untouchableState(raw: Raw) {
  const count = (sql: string) => Number((raw.prepare(sql).get() as { c: number }).c);
  const rows = (sql: string) => (raw.prepare(sql).all() as Array<Record<string, unknown>>).map((row) => ({ ...row }));
  return {
    qrMaster: rows("SELECT qr_id, current_status, current_location_type, updated_at FROM qr_master ORDER BY qr_id"),
    events: count("SELECT COUNT(1) AS c FROM production_events"),
    outbox: count("SELECT COUNT(1) AS c FROM sync_outbox"),
    byVariant: rows("SELECT product_variant_id, quantity_on_hand, quantity_reserved FROM stock_projection_by_variant ORDER BY product_variant_id"),
    byLocation: rows("SELECT product_variant_id, location_type, quantity_on_hand FROM stock_projection_by_location ORDER BY product_variant_id, location_type"),
    saleVouchers: count("SELECT COUNT(1) AS c FROM sale_vouchers"),
    saleLines: count("SELECT COUNT(1) AS c FROM sale_voucher_line_items"),
    cashVouchers: count("SELECT COUNT(1) AS c FROM cash_vouchers"),
    dispatchSessions: count("SELECT COUNT(1) AS c FROM dispatch_sessions"),
    qrCodes: rows("SELECT id, status FROM qr_codes ORDER BY id"),
  };
}

function auditRows(raw: Raw, entityId: string) {
  return (
    raw
      .prepare("SELECT event_type, entity_type, actor_user_id, actor_device_id, payload_json, hash_sha256 FROM audit_log WHERE entity_id = ? ORDER BY occurred_at, created_at")
      .all(entityId) as Array<{ event_type: string; entity_type: string; actor_user_id: string | null; actor_device_id: string | null; payload_json: string; hash_sha256: string }>
  ).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
}

test("schema — gatepasses and gatepass_lines exist, are additive, and reference parties / product_variants", () => {
  const f = createFixture();
  try {
    const sql = (table: string) => (f.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined)?.sql;
    assert.ok(sql("gatepasses"));
    assert.ok(sql("gatepass_lines"));
    assert.match(sql("gatepasses")!, /'CREATED','BILLED','AT_GATE','DISPATCHED','DELIVERED','CANCELLED'/);
    const headerFk = f.raw.prepare("PRAGMA foreign_key_list(gatepasses)").all() as Array<{ table: string; from: string }>;
    assert.ok(headerFk.some((k) => k.table === "parties" && k.from === "party_id"));
    const lineFk = f.raw.prepare("PRAGMA foreign_key_list(gatepass_lines)").all() as Array<{ table: string; from: string }>;
    assert.ok(lineFk.some((k) => k.table === "product_variants" && k.from === "product_variant_id"));
    assert.ok(lineFk.some((k) => k.table === "gatepasses" && k.from === "gatepass_id"));
    assert.ok(f.raw.prepare("SELECT 1 FROM schema_migrations WHERE version = '026_gatepass'").get());
    // 027 adds the two transport fields from the paper book, nullable, nothing else.
    assert.ok(f.raw.prepare("SELECT 1 FROM schema_migrations WHERE version = '027_gatepass_transport'").get());
    const headerColumns = (f.raw.prepare("PRAGMA table_info(gatepasses)").all() as Array<{ name: string; notnull: number }>);
    assert.deepEqual(headerColumns.filter((c) => c.name === "bilty_number" || c.name === "transport_via").map((c) => [c.name, c.notnull]), [["bilty_number", 0], ["transport_via", 0]]);
    // The QR lifecycle tables are exactly as migration 025 left them.
    assert.match(sql("qr_master")!, /'TO_GATE'/);
  } finally {
    f.cleanup();
  }
});

test("store stock by article: one row per colour + size that is In Store, nothing from the factory or the gate", async () => {
  const f = createFixture();
  try {
    await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 3);
    await stockVariant(f.db, f.raw, "SK6", "4/6", "RED", 2);
    const blue = await stockVariant(f.db, f.raw, "SK6", "7/10", "BLUE", 2);
    // A produced-but-not-received carton is factory stock, not store stock.
    const [factoryOnly] = generate(f.db, f.raw, "SK6", "7/10", "BLACK", 1);
    assert.equal((await producer(f.db).execute({ rawScan: factoryOnly, context: CONTEXT })).accepted, true);
    // One blue carton moved out to the gate leaves the store.
    assert.equal((await mover(f.db).execute({ rawScan: blue.ids[0], context: CONTEXT })).outcome, "MOVED_OUT");
    // Another article entirely.
    await stockVariant(f.db, f.raw, "SK12", "7/10", "BLACK", 4);

    const rows = f.db.listStoreStockByArticle("SK6").map((r) => [r.color, r.size, r.storeQuantity]);
    assert.deepEqual(rows, [
      ["BLUE", "7/10", 1],
      ["RED", "4/6", 2],
      ["RED", "7/10", 3],
    ]);
    assert.deepEqual(f.db.listStoreStockByArticle("sk6").length, 3, "article lookup is case-insensitive");
    assert.deepEqual(f.db.listStoreStockByArticle("SK99"), []);
    assert.deepEqual(f.db.listStoreStockByArticle(""), []);
    // Agrees with Current Stock's own store column.
    const inventory = f.db.listInventory("SK6").find((r) => r.color === "BLUE" && r.size === "7/10");
    assert.equal(inventory?.storeQuantity, 1);

    // The whole store in one read — every article, same figures, nothing with zero In Store
    // (the black carton is still on the factory floor, so SK6 BLACK does not appear at all).
    const whole = f.db.listStoreStock().map((r) => [r.article, r.color, r.size, r.storeQuantity]);
    assert.deepEqual(whole, [
      ["SK12", "BLACK", "7/10", 4],
      ["SK6", "BLUE", "7/10", 1],
      ["SK6", "RED", "4/6", 2],
      ["SK6", "RED", "7/10", 3],
    ]);
    // Once the last blue carton leaves the store, the row disappears rather than showing 0.
    assert.equal((await mover(f.db).execute({ rawScan: blue.ids[1], context: CONTEXT })).outcome, "MOVED_OUT");
    assert.ok(!f.db.listStoreStock().some((r) => r.color === "BLUE"));
  } finally {
    f.cleanup();
  }
});

test("create — a valid party, article, colour/size and quantity produce GP-000001 with the right lines and totals", async () => {
  const f = createFixture();
  try {
    const partyId = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 5);

    const result = await gatepassCreator(f.db).execute({
      partyId,
      lines: [{ productVariantId: red.variantId, quantity: 3, reflectedStockSeen: 5 }],
      biltyNumber: " B-4471 ",
      transportVia: "Daewoo Cargo",
      remarks: "  first cut  ",
      actor: "clerk",
      actorUserId: "user-1",
      deviceId: "desktop-main",
    });

    assert.equal(result.accepted, true, result.reason);
    assert.equal(result.outcome, "CREATED");
    assert.equal(result.gatepassNumber, 1);
    assert.equal(result.code, "GP-000001");
    assert.equal(result.totalQuantity, 3);
    assert.ok(result.gatepassId);

    const doc = f.db.getGatepass(result.gatepassId!);
    assert.ok(doc);
    assert.equal(doc.code, "GP-000001");
    assert.equal(doc.partyId, partyId);
    assert.equal(doc.partyName, "ABC TRADERS");
    assert.equal(doc.partyCity, "Lahore");
    assert.equal(doc.gatepassDate, "2026-09-16");
    assert.equal(doc.status, "CREATED");
    assert.equal(doc.biltyNumber, "B-4471");
    assert.equal(doc.transportVia, "Daewoo Cargo");
    assert.equal(doc.remarks, "first cut");
    assert.equal(doc.totalQuantity, 3);
    assert.equal(doc.createdBy, "clerk");
    assert.equal(doc.createdAt, result.createdAt);
    assert.equal(doc.cancelledAt, null);
    assert.deepEqual(
      doc.lines.map((l) => [l.lineNo, l.productVariantId, l.article, l.color, l.size, l.quantity, l.storeQuantityAtCreation]),
      [[1, red.variantId, "SK6", "RED", "7/10", 3, 5]]
    );

    // The same document by its number, for previous / next / load; anything else is null.
    assert.deepEqual(f.db.getGatepassByNumber(1), doc);
    assert.equal(f.db.getGatepassByNumber(2), null);
    assert.equal(f.db.getGatepassByNumber(0), null);
    assert.equal(f.db.getGatepassByNumber(1.5), null);
  } finally {
    f.cleanup();
  }
});

test("create — multiple colour + size lines, across two articles, stay separate and are never merged", async () => {
  const f = createFixture();
  try {
    const partyId = createParty(f.db, "ABC TRADERS");
    const red710 = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 6);
    const blue710 = await stockVariant(f.db, f.raw, "SK6", "7/10", "BLUE", 3);
    const red46 = await stockVariant(f.db, f.raw, "SK6", "4/6", "RED", 2);
    const sk12 = await stockVariant(f.db, f.raw, "SK12", "7/10", "BLACK", 4);

    const result = await gatepassCreator(f.db).execute({
      partyId,
      lines: [
        { productVariantId: red710.variantId, quantity: 5 },
        { productVariantId: blue710.variantId, quantity: 2 },
        { productVariantId: red46.variantId, quantity: 1 },
        { productVariantId: sk12.variantId, quantity: 3 },
      ],
      actor: "clerk",
    });
    assert.equal(result.accepted, true, result.reason);
    assert.equal(result.totalQuantity, 11);

    const doc = f.db.getGatepass(result.gatepassId!)!;
    assert.equal(doc.lineCount, 4);
    assert.equal(doc.biltyNumber, null, "transport fields are simply empty when not given");
    assert.equal(doc.transportVia, null);
    assert.deepEqual(
      doc.lines.map((l) => [l.article, l.color, l.size, l.quantity]),
      [
        ["SK6", "RED", "7/10", 5],
        ["SK6", "BLUE", "7/10", 2],
        ["SK6", "RED", "4/6", 1],
        ["SK12", "BLACK", "7/10", 3],
      ]
    );

    const listed = f.db.listGatepasses().rows[0];
    assert.equal(listed.code, "GP-000001");
    assert.equal(listed.lineCount, 4);
    assert.equal(listed.totalQuantity, 11);
    assert.deepEqual(listed.articles, ["SK12", "SK6"]);
  } finally {
    f.cleanup();
  }
});

test("validation — no party, unknown party, inactive party, no lines, zero / negative / fractional quantity, unknown variant, duplicate line: nothing is written", async () => {
  const f = createFixture();
  try {
    const partyId = createParty(f.db, "ABC TRADERS");
    const inactiveId = createParty(f.db, "OLD TRADERS", { status: "INACTIVE" });
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 5);
    // A disabled Product Master variant is not a valid stock line either (checked below).
    const blue = await stockVariant(f.db, f.raw, "SK6", "7/10", "BLUE", 2);
    f.db.disableProduct(blue.variantId);
    const useCase = gatepassCreator(f.db);
    const before = untouchableState(f.raw);
    const gatepassCount = () => Number((f.raw.prepare("SELECT COUNT(1) AS c FROM gatepasses").get() as { c: number }).c);
    const lineCount = () => Number((f.raw.prepare("SELECT COUNT(1) AS c FROM gatepass_lines").get() as { c: number }).c);

    const line = { productVariantId: red.variantId, quantity: 1 };
    const cases: Array<[Parameters<typeof useCase.execute>[0], CreateGatepassResult["outcome"], RegExp]> = [
      [{ partyId: "", lines: [line], actor: "clerk" }, "NO_PARTY", /select a party/i],
      [{ partyId: "missing-party", lines: [line], actor: "clerk" }, "PARTY_NOT_FOUND", /not in the party master/i],
      [{ partyId: inactiveId, lines: [line], actor: "clerk" }, "PARTY_INACTIVE", /inactive/i],
      [{ partyId, lines: [], actor: "clerk" }, "NO_LINES", /at least one/i],
      [{ partyId, lines: [{ productVariantId: red.variantId, quantity: 0 }], actor: "clerk" }, "INVALID_QUANTITY", /greater than 0/i],
      [{ partyId, lines: [{ productVariantId: red.variantId, quantity: -2 }], actor: "clerk" }, "INVALID_QUANTITY", /greater than 0/i],
      [{ partyId, lines: [{ productVariantId: red.variantId, quantity: 1.5 }], actor: "clerk" }, "INVALID_QUANTITY", /whole number/i],
      [{ partyId, lines: [{ productVariantId: red.variantId, quantity: Number.NaN }], actor: "clerk" }, "INVALID_QUANTITY", /whole number/i],
      [{ partyId, lines: [{ productVariantId: "no-such-variant", quantity: 1 }], actor: "clerk" }, "VARIANT_NOT_FOUND", /product master/i],
      [{ partyId, lines: [line, { productVariantId: red.variantId, quantity: 2 }], actor: "clerk" }, "DUPLICATE_LINE", /appears twice/i],
    ];

    for (const [input, outcome, message] of cases) {
      const result = await useCase.execute(input);
      assert.equal(result.accepted, false, `${outcome} should be rejected`);
      assert.equal(result.outcome, outcome);
      assert.match(result.reason ?? "", message);
    }

    const disabled = await useCase.execute({ partyId, lines: [{ productVariantId: blue.variantId, quantity: 1 }], actor: "clerk" });
    assert.equal(disabled.outcome, "VARIANT_NOT_FOUND");
    assert.deepEqual(f.db.listStoreStockByArticle("SK6").map((r) => r.color), ["RED"], "disabled variant is not offered");

    assert.equal(gatepassCount(), 0);
    assert.equal(lineCount(), 0);
    assert.equal(Number((f.raw.prepare("SELECT COUNT(1) AS c FROM audit_log").get() as { c: number }).c), 0);
    // Nothing physical or financial moved while all of that was being refused.
    assert.deepEqual(untouchableState(f.raw), before);
  } finally {
    f.cleanup();
  }
});

test("stock check — a line above the live In Store quantity is refused with the exact numbers, and an all-or-nothing document", async () => {
  const f = createFixture();
  try {
    const partyId = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 4);
    const blue = await stockVariant(f.db, f.raw, "SK6", "7/10", "BLUE", 2);

    const result = await gatepassCreator(f.db).execute({
      partyId,
      lines: [
        { productVariantId: red.variantId, quantity: 4, reflectedStockSeen: 4 }, // fine
        { productVariantId: blue.variantId, quantity: 5, reflectedStockSeen: 2 }, // too many, and the clerk knew it
      ],
      actor: "clerk",
    });

    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "INSUFFICIENT_STOCK");
    assert.match(result.reason ?? "", /exceeds Reflected Stock for SK6 \/ BLUE \/ 7\/10\. Current Stock: 2\. Reserved: 0\. Reflected Stock: 2\. Requested: 5\./);
    assert.deepEqual(result.shortages, [
      { productVariantId: blue.variantId, article: "SK6", color: "BLUE", size: "7/10", requested: 5, currentStock: 2, reserved: 0, reflected: 2, seen: 2 },
    ]);
    // The good line was not written either: a gatepass is one document, created whole or not at all.
    assert.equal(Number((f.raw.prepare("SELECT COUNT(1) AS c FROM gatepasses").get() as { c: number }).c), 0);
    assert.equal(Number((f.raw.prepare("SELECT COUNT(1) AS c FROM gatepass_lines").get() as { c: number }).c), 0);

    // Exactly the available quantity is allowed; it takes the store to "nothing left to cut", not below.
    const exact = await gatepassCreator(f.db).execute({ partyId, lines: [{ productVariantId: blue.variantId, quantity: 2 }], actor: "clerk" });
    assert.equal(exact.accepted, true, exact.reason);
  } finally {
    f.cleanup();
  }
});

test("concurrency — stock that moved between display and creation is reported as STOCK_CHANGED, not silently accepted", async () => {
  const f = createFixture();
  try {
    const partyId = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 5);

    // The clerk saw 5 on screen …
    const seen = f.db.listStoreStockByArticle("SK6")[0];
    assert.equal(seen.storeQuantity, 5);

    // … then two cartons left the store (moved out) and one was dispatched straight from the store.
    assert.equal((await mover(f.db).execute({ rawScan: red.ids[0], context: CONTEXT })).outcome, "MOVED_OUT");
    assert.equal((await mover(f.db).execute({ rawScan: red.ids[1], context: CONTEXT })).outcome, "MOVED_OUT");
    assert.equal((await dispatcher(f.db).execute({ rawScan: red.ids[2], context: CONTEXT })).accepted, true);

    const result = await gatepassCreator(f.db).execute({
      partyId,
      lines: [{ productVariantId: red.variantId, quantity: 4, reflectedStockSeen: seen.reflectedQuantity }],
      actor: "clerk",
    });
    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "STOCK_CHANGED");
    assert.match(result.reason ?? "", /reflected stock changed before the gatepass could be created/i);
    assert.deepEqual(result.shortages?.map((s) => [s.requested, s.currentStock, s.reserved, s.reflected, s.seen]), [[4, 2, 0, 2, 5]]);

    // After a refresh the clerk sees the truth and can cut what is really there.
    assert.equal(f.db.listStoreStockByArticle("SK6")[0].storeQuantity, 2);
    const retry = await gatepassCreator(f.db).execute({ partyId, lines: [{ productVariantId: red.variantId, quantity: 2, reflectedStockSeen: 2 }], actor: "clerk" });
    assert.equal(retry.accepted, true, retry.reason);
  } finally {
    f.cleanup();
  }
});

test("concurrency — two clerks creating at once against the same stock: both fit → two distinct numbers; nothing left → the next is refused", async () => {
  const f = createFixture();
  const second = openDb(f.dbPath);
  try {
    const partyA = createParty(f.db, "ABC TRADERS");
    const partyB = createParty(f.db, "XYZ TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 10);

    // 6 + 4 = 10: both fit inside Reflected Stock. Numbers never collide.
    const [a, b] = await Promise.all([
      gatepassCreator(f.db).execute({ partyId: partyA, lines: [{ productVariantId: red.variantId, quantity: 6 }], actor: "clerk-a" }),
      gatepassCreator(second).execute({ partyId: partyB, lines: [{ productVariantId: red.variantId, quantity: 4 }], actor: "clerk-b" }),
    ]);
    assert.equal(a.accepted, true, a.reason);
    assert.equal(b.accepted, true, b.reason);
    assert.deepEqual([a.gatepassNumber, b.gatepassNumber].sort(), [1, 2]);
    assert.notEqual(a.gatepassId, b.gatepassId);

    const numbers = f.raw.prepare("SELECT gatepass_number FROM gatepasses ORDER BY gatepass_number").all() as Array<{ gatepass_number: number }>;
    assert.deepEqual(numbers.map((n) => n.gatepass_number), [1, 2]);

    // The store still physically holds all ten: only scanning moves stock. Reflected is 0.
    const store = f.raw
      .prepare("SELECT quantity_on_hand FROM stock_projection_by_location WHERE product_variant_id = ? AND location_type = 'WAREHOUSE'")
      .get(red.variantId) as { quantity_on_hand: number };
    assert.equal(store.quantity_on_hand, 10);
    assert.deepEqual(f.db.listStoreStockByArticle("SK6").map((r) => [r.storeQuantity, r.reservedQuantity, r.reflectedQuantity]), [[10, 10, 0]]);

    // Nothing is left to reserve: a third clerk is refused, however small the ask.
    const c = await gatepassCreator(second).execute({ partyId: partyA, lines: [{ productVariantId: red.variantId, quantity: 1 }], actor: "clerk-c" });
    assert.equal(c.outcome, "INSUFFICIENT_STOCK");
    assert.deepEqual(c.shortages?.map((s) => [s.requested, s.currentStock, s.reserved, s.reflected]), [[1, 10, 10, 0]]);
  } finally {
    second.close();
    f.cleanup();
  }
});

test("isolation — creating a gatepass changes no QR, no event, no stock projection, no voucher, no ledger and assigns no codes", async () => {
  const f = createFixture();
  try {
    const partyId = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 4);
    const blue = await stockVariant(f.db, f.raw, "SK6", "7/10", "BLUE", 2);
    // Put some unrelated financial history in place so "unchanged" means unchanged, not empty.
    const voucher = f.db.createSaleVoucher({ partyId, voucherDate: "2026-09-15", bookNo: "B1" });
    f.db.addVoucherLineItem(voucher.id, { productVariantId: red.variantId, quantity: 1, unitPrice: 550 });
    const balanceBefore = f.db.getCurrentPartyBalance(partyId);
    const before = untouchableState(f.raw);

    const result = await gatepassCreator(f.db).execute({
      partyId,
      lines: [
        { productVariantId: red.variantId, quantity: 4 },
        { productVariantId: blue.variantId, quantity: 1 },
      ],
      actor: "clerk",
    });
    assert.equal(result.accepted, true, result.reason);

    const after = untouchableState(f.raw);
    assert.deepEqual(after, before, "nothing outside gatepasses / gatepass_lines / audit_log changed");
    assert.equal(f.db.getCurrentPartyBalance(partyId), balanceBefore, "customer balance unchanged");

    // Every carton is still In Store, in the WAREHOUSE location, with its full event history intact.
    for (const id of [...red.ids, ...blue.ids]) {
      const qr = f.raw.prepare("SELECT current_status, current_location_type FROM qr_master WHERE qr_id = ?").get(id) as { current_status: string; current_location_type: string };
      assert.deepEqual({ ...qr }, { current_status: "WAREHOUSE", current_location_type: "WAREHOUSE" });
      const events = f.raw.prepare("SELECT event_type FROM production_events WHERE qr_id = ? ORDER BY event_ts_local").all(id) as Array<{ event_type: string }>;
      assert.deepEqual(events.map((e) => e.event_type), ["PRODUCED", "MOVED"]);
    }
    // The document references the variant, never a QR: no column on either table names a qr_id.
    const lineColumns = (f.raw.prepare("PRAGMA table_info(gatepass_lines)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!lineColumns.some((c) => /qr/i.test(c)));
    // QR Journey / Management see nothing new on any code.
    assert.equal(f.db.getQrJourney(red.ids[0])?.steps.map((s) => s.kind).join(","), "REGISTERED,PRODUCED,STORE_ENTRY");
    // And the same stock can still be moved out and dispatched afterwards — the plain scan
    // counts against this very document behind the scenes (see gatepassReservations.test.ts).
    assert.equal((await mover(f.db).execute({ rawScan: red.ids[0], context: CONTEXT })).outcome, "MOVED_OUT");
    assert.equal((await dispatcher(f.db).execute({ rawScan: red.ids[0], context: CONTEXT })).accepted, true);
  } finally {
    f.cleanup();
  }
});

test("audit — creation and cancellation are recorded in audit_log with actor, document and action", async () => {
  const f = createFixture();
  try {
    const partyId = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 3);

    const created = await gatepassCreator(f.db).execute({
      partyId,
      lines: [{ productVariantId: red.variantId, quantity: 2 }],
      actor: "clerk",
      actorUserId: "user-clerk",
      deviceId: "desktop-main",
    });
    assert.equal(created.accepted, true, created.reason);

    let rows = auditRows(f.raw, created.gatepassId!);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, "GATEPASS_CREATED");
    assert.equal(rows[0].entity_type, "GATEPASS");
    assert.equal(rows[0].actor_user_id, "user-clerk");
    assert.equal(rows[0].actor_device_id, "desktop-main");
    assert.equal(rows[0].payload.code, "GP-000001");
    assert.equal(rows[0].payload.actor, "clerk");
    assert.equal(rows[0].payload.partyName, "ABC TRADERS");
    assert.equal(rows[0].payload.totalQuantity, 2);
    assert.deepEqual((rows[0].payload.lines as Array<Record<string, unknown>>).map((l) => [l.article, l.color, l.size, l.quantity]), [["SK6", "RED", "7/10", 2]]);
    assert.match(rows[0].hash_sha256, /^[0-9a-f]{64}$/);

    const cancelled = await gatepassCanceller(f.db).execute({
      gatepassId: created.gatepassId!,
      reason: "wrong party",
      actor: "manager",
      actorUserId: "user-manager",
      deviceId: "desktop-main",
    });
    assert.equal(cancelled.accepted, true, cancelled.reason);
    assert.equal(cancelled.outcome, "CANCELLED");
    assert.equal(cancelled.code, "GP-000001");

    rows = auditRows(f.raw, created.gatepassId!);
    assert.deepEqual(rows.map((r) => r.event_type), ["GATEPASS_CREATED", "GATEPASS_CANCELLED"]);
    assert.equal(rows[1].actor_user_id, "user-manager");
    assert.equal(rows[1].payload.reason, "wrong party");
  } finally {
    f.cleanup();
  }
});

test("cancel — the document is marked, its lines kept, the actor and reason recorded; it cannot be cancelled twice; a reason is required", async () => {
  const f = createFixture();
  try {
    const partyId = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 3);
    const created = await gatepassCreator(f.db).execute({ partyId, lines: [{ productVariantId: red.variantId, quantity: 2 }], actor: "clerk" });
    const before = untouchableState(f.raw);
    const canceller = gatepassCanceller(f.db);

    assert.equal((await canceller.execute({ gatepassId: created.gatepassId!, reason: "   ", actor: "manager" })).outcome, "REASON_REQUIRED");
    assert.equal((await canceller.execute({ gatepassId: "missing", reason: "x", actor: "manager" })).outcome, "NOT_FOUND");

    // A billed document is unwound from the billing side now, so the bill goes first.
    const linked = f.db.findSaleVoucherByGatepass(created.gatepassId!);
    if (linked) f.db.deleteSaleVoucher(linked.id, "cancelling the gatepass");

    const first = await canceller.execute({ gatepassId: created.gatepassId!, reason: "wrong party", actor: "manager" });
    assert.equal(first.accepted, true, first.reason);

    const doc = f.db.getGatepass(created.gatepassId!)!;
    assert.equal(doc.status, "CANCELLED");
    assert.equal(doc.cancelledBy, "manager");
    assert.equal(doc.cancelReason, "wrong party");
    assert.equal(doc.cancelledAt, first.cancelledAt);
    assert.equal(doc.lines.length, 1, "lines are preserved");
    assert.equal(doc.totalQuantity, 2);
    assert.equal(doc.createdBy, "clerk", "creation facts are untouched");

    const again = await canceller.execute({ gatepassId: created.gatepassId!, reason: "again", actor: "manager" });
    assert.equal(again.accepted, false);
    assert.equal(again.outcome, "ALREADY_CANCELLED");
    assert.equal(f.db.getGatepass(created.gatepassId!)!.cancelReason, "wrong party", "the first cancellation stands");

    // Cancelling reverses nothing physical, because creating moved nothing physical.
    assert.deepEqual(untouchableState(f.raw), before);
    // It stays in the list, flagged.
    const listed = f.db.listGatepasses().rows;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, "CANCELLED");
    assert.equal(f.db.listGatepasses({ status: "CREATED" }).total, 0);
    assert.equal(f.db.listGatepasses({ status: "CANCELLED" }).total, 1);
  } finally {
    f.cleanup();
  }
});

test("numbering and list — sequential GP numbers, newest first, searchable by number / code / party and filterable by party, article, date and status", async () => {
  const f = createFixture();
  try {
    const abc = createParty(f.db, "ABC TRADERS");
    const xyz = createParty(f.db, "XYZ TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 10);
    const sk12 = await stockVariant(f.db, f.raw, "SK12", "4/6", "BLACK", 10);

    const dated = (date: string) => new CreateGatepassUseCase({ txManager: f.db, repo: f.db, idGenerator: new UuidGenerator(), localDate: () => date });
    const g1 = await dated("2026-09-14").execute({ partyId: abc, lines: [{ productVariantId: red.variantId, quantity: 1 }], actor: "clerk" });
    const g2 = await dated("2026-09-15").execute({ partyId: xyz, lines: [{ productVariantId: sk12.variantId, quantity: 2 }], actor: "clerk" });
    const g3 = await dated("2026-09-16").execute({ partyId: abc, lines: [{ productVariantId: red.variantId, quantity: 3 }, { productVariantId: sk12.variantId, quantity: 1 }], actor: "clerk" });
    assert.deepEqual([g1.code, g2.code, g3.code], ["GP-000001", "GP-000002", "GP-000003"]);
    assert.equal(formatGatepassCode(123), "GP-000123");

    const all = f.db.listGatepasses();
    assert.equal(all.total, 3);
    assert.deepEqual(all.rows.map((r) => r.code), ["GP-000003", "GP-000002", "GP-000001"]);
    assert.deepEqual(all.rows.map((r) => [r.partyName, r.gatepassDate, r.totalQuantity, r.lineCount]), [
      ["ABC TRADERS", "2026-09-16", 4, 2],
      ["XYZ TRADERS", "2026-09-15", 2, 1],
      ["ABC TRADERS", "2026-09-14", 1, 1],
    ]);

    assert.deepEqual(f.db.listGatepasses({ search: "GP-000002" }).rows.map((r) => r.code), ["GP-000002"]);
    assert.deepEqual(f.db.listGatepasses({ search: "2" }).rows.map((r) => r.code), ["GP-000002"]);
    assert.deepEqual(f.db.listGatepasses({ search: "xyz" }).rows.map((r) => r.code), ["GP-000002"]);
    assert.deepEqual(f.db.listGatepasses({ partyId: abc }).rows.map((r) => r.code), ["GP-000003", "GP-000001"]);
    assert.deepEqual(f.db.listGatepasses({ article: "sk12" }).rows.map((r) => r.code), ["GP-000003", "GP-000002"]);
    assert.deepEqual(f.db.listGatepasses({ fromDate: "2026-09-15", toDate: "2026-09-15" }).rows.map((r) => r.code), ["GP-000002"]);
    assert.deepEqual(f.db.listGatepasses({ fromDate: "2026-09-15" }).rows.map((r) => r.code), ["GP-000003", "GP-000002"]);
    const paged = f.db.listGatepasses({ page: 2, pageSize: 2 });
    assert.equal(paged.total, 3);
    assert.deepEqual(paged.rows.map((r) => r.code), ["GP-000001"]);

    // Cancelling one leaves the numbering alone: the next document is GP-000004, never a reuse.
    assert.equal((await gatepassCanceller(f.db).execute({ gatepassId: g3.gatepassId!, reason: "test", actor: "m" })).accepted, true);
    const g4 = await dated("2026-09-16").execute({ partyId: abc, lines: [{ productVariantId: red.variantId, quantity: 1 }], actor: "clerk" });
    assert.equal(g4.code, "GP-000004");
    assert.equal(f.db.getGatepass("missing"), null);
  } finally {
    f.cleanup();
  }
});

test("history — a gatepass keeps its article / colour / size even after the Product Master entry is disabled", async () => {
  const f = createFixture();
  try {
    const partyId = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 2);
    const created = await gatepassCreator(f.db).execute({ partyId, lines: [{ productVariantId: red.variantId, quantity: 2 }], actor: "clerk" });
    f.db.disableProduct(red.variantId);

    const doc = f.db.getGatepass(created.gatepassId!)!;
    assert.deepEqual(doc.lines.map((l) => [l.article, l.color, l.size, l.quantity]), [["SK6", "RED", "7/10", 2]]);
    assert.deepEqual(f.db.listGatepasses({ article: "SK6" }).rows.map((r) => r.code), ["GP-000001"]);
  } finally {
    f.cleanup();
  }
});

// ─── Billing desk ─────────────────────────────────────────────────────────────
// The sale voucher is made from the gatepass. Creating one tells every billing user; cancelling
// one tells them which bill to delete (or not to make one). One live bill per gatepass.

/** An approved account, optionally with a role — the way an administrator would set one up. */
function approvedUser(db: SqliteDatabase, raw: Raw, username: string, permissions: string[] = []): string {
  const user = db.createUserAccount(username, "Password123");
  raw.prepare("UPDATE app_users SET access_status = 'APPROVED' WHERE id = ?").run(user.id);
  if (permissions.length > 0) {
    const role = db.createRole({ name: `${username}-role`, permissions });
    db.assignUserRole(user.id, role.code);
  }
  return user.id;
}

const noticesFor = (db: SqliteDatabase, userId: string) =>
  db.getUserNotifications(userId).map((n) => ({ kind: n.kind, severity: n.severity, entityId: n.entityId, title: n.title, message: n.message }));

test("billing notices — creation tells every billing user (and administrators) in the same transaction; cancellation names the bill to delete", async () => {
  const f = createFixture();
  try {
    const admin = f.db.bootstrapFirstAdmin("owner", "Password123").id;
    const billing = approvedUser(f.db, f.raw, "billing-desk", ["sale-voucher-form", "sale-voucher-list"]);
    const clerk = approvedUser(f.db, f.raw, "gate-clerk", ["gatepass"]);
    const pending = f.db.createUserAccount("pending-billing", "Password123").id; // never approved
    const partyId = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 6);

    // A refused document leaves no notice behind.
    const refused = await gatepassCreator(f.db).execute({ partyId, lines: [{ productVariantId: red.variantId, quantity: 99 }], actor: "clerk" });
    assert.equal(refused.accepted, false);
    assert.deepEqual(noticesFor(f.db, billing), []);

    const created = await gatepassCreator(f.db).execute({ partyId, lines: [{ productVariantId: red.variantId, quantity: 3 }], actor: "clerk" });
    assert.equal(created.accepted, true, created.reason);

    const expected = {
      kind: "GATEPASS_CREATED",
      severity: "INFO",
      entityId: created.gatepassId,
      title: "New Gatepass GP-000001",
      message: "3 cartons for ABC TRADERS. Open it to make the sale voucher.",
    };
    assert.deepEqual(noticesFor(f.db, billing), [expected]);
    assert.deepEqual(noticesFor(f.db, admin), [expected]);
    assert.deepEqual(noticesFor(f.db, clerk), [], "no billing permission");
    assert.deepEqual(noticesFor(f.db, pending), [], "not approved");

    // No bill yet: cancelling warns not to make one.
    const cancelled = await gatepassCanceller(f.db).execute({ gatepassId: created.gatepassId!, reason: "wrong party", actor: "manager" });
    assert.equal(cancelled.accepted, true);
    const afterCancel = noticesFor(f.db, billing);
    assert.equal(afterCancel.length, 2);
    assert.equal(afterCancel[0].kind, "GATEPASS_CANCELLED");
    assert.equal(afterCancel[0].severity, "WARNING");
    assert.equal(afterCancel[0].title, "Gatepass GP-000001 cancelled");
    assert.match(afterCancel[0].message, /Cancelled by manager: wrong party\. Do not make a sale voucher/);

    // Once a bill exists the document is unwound from the billing side: cancelling it here is
    // refused, and the refusal names the exact bill the desk has to delete.
    const second = await gatepassCreator(f.db).execute({ partyId, lines: [{ productVariantId: red.variantId, quantity: 2 }], actor: "clerk" });
    const bill = f.db.createSaleVoucher({ partyId, voucherDate: "2026-09-16", bookNo: "B1", gatepassId: second.gatepassId });
    const cancelledSecond = await gatepassCanceller(f.db).execute({ gatepassId: second.gatepassId!, reason: "returned", actor: "manager" });
    assert.equal(cancelledSecond.accepted, false);
    assert.equal(cancelledSecond.outcome, "BILLED");
    assert.match(cancelledSecond.reason ?? "", new RegExp(`Delete Sale Voucher #${bill.voucherNumber} first`));
    assert.equal(f.db.getGatepass(second.gatepassId!)!.status, "BILLED", "nothing changed");

    // Deleting the bill is what frees it, and only then can it be cancelled.
    f.db.deleteSaleVoucher(bill.id, "wrong party");
    assert.equal(f.db.getGatepass(second.gatepassId!)!.status, "CREATED");
    const nowCancelled = await gatepassCanceller(f.db).execute({ gatepassId: second.gatepassId!, reason: "returned", actor: "manager" });
    assert.equal(nowCancelled.accepted, true, nowCancelled.reason);
    const notice = noticesFor(f.db, billing)[0];
    assert.equal(notice.kind, "GATEPASS_CANCELLED");
    assert.equal(notice.entityId, second.gatepassId);
  } finally {
    f.cleanup();
  }
});

test("billing link — a sale voucher made from a gatepass remembers it; a second bill, or a cancelled gatepass, is refused; deleting the bill frees the gatepass", async () => {
  const f = createFixture();
  try {
    const partyId = createParty(f.db, "ABC TRADERS");
    const red = await stockVariant(f.db, f.raw, "SK6", "7/10", "RED", 6);
    const created = await gatepassCreator(f.db).execute({ partyId, lines: [{ productVariantId: red.variantId, quantity: 3 }], actor: "clerk" });
    const gatepassId = created.gatepassId!;

    assert.equal(f.db.findSaleVoucherByGatepass(gatepassId), null);
    assert.throws(() => f.db.createSaleVoucher({ partyId, voucherDate: "2026-09-16", bookNo: "B1", gatepassId: "no-such-gatepass" }), (e: unknown) => (e as { code?: string }).code === "GATEPASS_NOT_FOUND");

    const bill = f.db.createSaleVoucher({ partyId, voucherDate: "2026-09-16", bookNo: "B1", gatepassId });
    const doc = f.db.getSaleVoucher(bill.id)!;
    assert.equal(doc.gatepassId, gatepassId);
    assert.equal(doc.gatepassCode, "GP-000001");
    assert.equal(doc.gatepassStatus, "BILLED", "making the bill is what advances the document");
    assert.deepEqual(f.db.findSaleVoucherByGatepass(gatepassId), { id: bill.id, voucherNumber: bill.voucherNumber });

    // One live bill per gatepass — refused with the existing bill named, and the index agrees.
    assert.throws(
      () => f.db.createSaleVoucher({ partyId, voucherDate: "2026-09-16", bookNo: "B1", gatepassId }),
      (e: unknown) => (e as { code?: string; existingVoucherNumber?: string }).code === "GATEPASS_ALREADY_BILLED" && (e as { existingVoucherNumber?: string }).existingVoucherNumber === bill.voucherNumber
    );
    assert.throws(() => f.raw.prepare("INSERT INTO sale_vouchers (id, voucher_number, party_id, voucher_date, book_no, created_at, updated_at, gatepass_id) VALUES ('x', '999', ?, '2026-09-16', 'B1', 'now', 'now', ?)").run(partyId, gatepassId), /UNIQUE/);

    // A voucher without a gatepass is untouched by any of this.
    const plain = f.db.createSaleVoucher({ partyId, voucherDate: "2026-09-16", bookNo: "B1" });
    assert.equal(f.db.getSaleVoucher(plain.id)!.gatepassId, null);

    // Deleting the bill frees the gatepass for a corrected bill.
    assert.equal(f.db.deleteSaleVoucher(bill.id, "wrong rate").cancelled, true);
    assert.equal(f.db.findSaleVoucherByGatepass(gatepassId), null);
    const again = f.db.createSaleVoucher({ partyId, voucherDate: "2026-09-16", bookNo: "B1", gatepassId });
    assert.equal(f.db.getSaleVoucher(again.id)!.gatepassCode, "GP-000001");

    // The bill is deleted first — that is what releases the document — and only then can it
    // be cancelled. A cancelled gatepass can never be billed again.
    assert.equal(f.db.getSaleVoucher(again.id)!.gatepassStatus, "BILLED");
    f.db.deleteSaleVoucher(again.id, "gatepass cancelled");
    assert.equal(f.db.getGatepass(gatepassId)!.status, "CREATED");
    assert.equal((await gatepassCanceller(f.db).execute({ gatepassId, reason: "returned", actor: "manager" })).accepted, true);
    assert.equal(f.db.getGatepass(gatepassId)!.status, "CANCELLED");
    assert.throws(() => f.db.createSaleVoucher({ partyId, voucherDate: "2026-09-16", bookNo: "B1", gatepassId }), (e: unknown) => (e as { code?: string }).code === "GATEPASS_CANCELLED");
  } finally {
    f.cleanup();
  }
});
