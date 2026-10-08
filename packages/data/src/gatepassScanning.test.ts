// Phase 3: the two gatepass-locked scanning desks, against the real database and the real
// use cases.
//
// The rule both desks obey: the Gatepass says what MAY be scanned, the QR says WHICH carton
// was. A carton is matched on its exact identity — article + colour + size, which is what a
// product_variant_id is — so a BLACK carton can never satisfy a GREEN line, and the document
// only advances when every line is finished.
//
// Nothing here sets a status or a count directly. Stock is built the only way it can be
// (generate → produce → receive) and consumed the only way it can be (a real scan).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CreateGatepassUseCase,
  DispatchScanUseCase,
  InMemoryEventBus,
  ProcessScanUseCase,
  StoreEntryScanUseCase,
  StoreExitScanUseCase,
} from "@erp/application";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

const FACTORY = "factory-777";
const CONTEXT = { factoryId: FACTORY, workstationId: "ws-prod-01", deviceId: "desktop-main" };

type Raw = import("node:sqlite").DatabaseSync;

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-gp-scan-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "scan.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.ensureOperationalContext({
    factoryId: FACTORY, factoryCode: "777", factoryName: "777 Manufacturing",
    workstationId: "ws-prod-01", workstationCode: "PROD-01", workstationName: "Production Line 01",
    deviceId: "desktop-main", deviceName: "Desktop Main", appVersion: "1.0.0",
  });
  const raw = (db as unknown as { db: Raw }).db;
  const bus = () => new InMemoryEventBus();
  const ids = () => new UuidGenerator();

  // Wired exactly as apps/desktop/src/main.ts wires them: the database is every repository.
  const produce = new ProcessScanUseCase({
    txManager: db, duplicateChecker: db, qrRegistry: db, productCatalog: db, qrMasterRepo: db,
    productionEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, eventPublisher: bus(), idGenerator: ids(),
  });
  const receive = new StoreEntryScanUseCase({
    txManager: db, qrLookupRepo: db, gatepassRepo: db, qrRegistry: db, qrMasterRepo: db,
    storeEntryEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, eventPublisher: bus(), idGenerator: ids(),
  });
  const moveOut = new StoreExitScanUseCase({
    txManager: db, qrLookupRepo: db, gatepassRepo: db, qrRegistry: db, qrMasterRepo: db,
    storeExitEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, eventPublisher: bus(), idGenerator: ids(),
  });
  const dispatch = new DispatchScanUseCase({
    txManager: db, qrLookupRepo: db, stockProjectionRepo: db, qrMasterRepo: db,
    dispatchEventsRepo: db, outboxRepo: db, eventPublisher: bus(), idGenerator: ids(),
    dispatchSessionRepo: db, gatepassRepo: db,
  });
  const creator = new CreateGatepassUseCase({ txManager: db, repo: db, idGenerator: ids(), localDate: () => "2026-10-06" });

  const statusOf = (id: string) => (raw.prepare("SELECT status FROM gatepasses WHERE id = ?").get(id) as { status: string }).status;
  const stockOf = (variantId: string) =>
    Number((raw.prepare("SELECT COALESCE(SUM(quantity_on_hand), 0) AS n FROM stock_projection_by_location WHERE product_variant_id = ? AND location_type = 'WAREHOUSE'").get(variantId) as { n: number }).n);
  const eventCount = (type: string) => Number((raw.prepare("SELECT COUNT(1) AS n FROM production_events WHERE event_type = ?").get(type) as { n: number }).n);

  return {
    db, raw, produce, receive, moveOut, dispatch, creator, statusOf, stockOf, eventCount,
    cleanup: () => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); },
  };
}

type Fixture = ReturnType<typeof createFixture>;

/** Produces and receives `quantity` cartons, the only way stock comes to exist. */
async function stockVariant(f: Fixture, quantity: number, color = "BLACK", article = "SK6", size = "7/10") {
  let row = f.raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string } | undefined;
  if (!row) {
    f.db.createProduct({ article, size, sellingPrice: 550, status: "ACTIVE" });
    row = f.raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string };
  }
  const ids = f.db.generateQrBatch({ articleSizeId: row.id, color, quantity, createdBy: "admin" }).qrCodes.map((b) => b.id);
  for (const id of ids) {
    assert.equal((await f.produce.execute({ rawScan: id, context: CONTEXT })).accepted, true, `produce ${id}`);
    assert.equal((await f.receive.execute({ rawScan: id, context: CONTEXT })).outcome, "RECEIVED", `receive ${id}`);
  }
  const variant = f.raw.prepare("SELECT id FROM product_variants WHERE article = ? AND color = ? AND size = ?").get(article, color, size) as { id: string };
  return { variantId: variant.id, ids };
}

const createParty = (f: Fixture, name = "ABC TRADERS") => f.db.createParty({ partyName: name, partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });

async function createGatepass(f: Fixture, partyId: string, lines: Array<{ variantId: string; quantity: number }>) {
  const result = await f.creator.execute({
    partyId, lines: lines.map((l) => ({ productVariantId: l.variantId, quantity: l.quantity })), actor: "clerk",
  });
  assert.equal(result.accepted, true, result.reason);
  return result.gatepassId!;
}

const bill = (f: Fixture, partyId: string, gatepassId: string) =>
  f.db.createSaleVoucher({ partyId, voucherDate: "2026-10-06", bookNo: "1", gatepassId });

/** A billed gatepass with `quantity` cartons of one colour in stock, ready for the store desk. */
async function billedGatepass(f: Fixture, quantity: number, color = "BLACK") {
  const stock = await stockVariant(f, quantity, color);
  const party = createParty(f);
  const gatepassId = await createGatepass(f, party, [{ variantId: stock.variantId, quantity }]);
  const voucher = bill(f, party, gatepassId);
  return { ...stock, party, gatepassId, voucher };
}

const storeScan = (f: Fixture, gatepassId: string, qrId: string) =>
  f.moveOut.execute({ rawScan: qrId, gatepassId, context: CONTEXT, actor: "store-op" });

// ─── Store: starting ──────────────────────────────────────────────────────────

test("a billed Gatepass accepts its own cartons at the store desk", async () => {
  const f = createFixture();
  try {
    const gp = await billedGatepass(f, 2);
    const result = await storeScan(f, gp.gatepassId, gp.ids[0]!);

    assert.equal(result.accepted, true, result.reason);
    assert.equal(result.outcome, "MOVED_OUT");
    assert.equal(result.gatepass?.gatepassId, gp.gatepassId, "counted against this document");
    assert.equal(f.statusOf(gp.gatepassId), "BILLED", "one of two is not the whole document");
  } finally { f.cleanup(); }
});

test("an unbilled Gatepass is refused at the store desk, and nothing moves", async () => {
  const f = createFixture();
  try {
    const stock = await stockVariant(f, 1);
    const gatepassId = await createGatepass(f, createParty(f), [{ variantId: stock.variantId, quantity: 1 }]);
    const before = f.stockOf(stock.variantId);

    const result = await storeScan(f, gatepassId, stock.ids[0]!);

    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "GATEPASS_NOT_READY");
    assert.match(result.reason ?? "", /not been billed/);
    assert.equal(f.stockOf(stock.variantId), before, "stock untouched");
    assert.equal(f.eventCount("MOVED"), 1, "only the receiving move exists");
  } finally { f.cleanup(); }
});

// ─── Store: the lock ──────────────────────────────────────────────────────────

test("a carton the Gatepass never asked for is refused by article, colour or size alike", async () => {
  const f = createFixture();
  try {
    const gp = await billedGatepass(f, 1, "BLACK");
    const green = await stockVariant(f, 1, "GREEN");
    const otherArticle = await stockVariant(f, 1, "BLACK", "SK10");
    const otherSize = await stockVariant(f, 1, "BLACK", "SK6", "8/13");

    for (const [label, wrong] of [["colour", green], ["article", otherArticle], ["size", otherSize]] as const) {
      const result = await storeScan(f, gp.gatepassId, wrong.ids[0]!);
      assert.equal(result.accepted, false, `wrong ${label} must be refused`);
      assert.equal(result.outcome, "NOT_ON_GATEPASS");
      assert.match(result.reason ?? "", /does not ask for/);
      assert.equal(f.stockOf(wrong.variantId), 1, `wrong ${label} stock untouched`);
    }
  } finally { f.cleanup(); }
});

test("an unknown code is refused without touching anything", async () => {
  const f = createFixture();
  try {
    const gp = await billedGatepass(f, 1);
    const result = await storeScan(f, gp.gatepassId, "SK6_BLACK_7/10_999999");

    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "UNKNOWN_QR");
    assert.equal(f.stockOf(gp.variantId), 1);
  } finally { f.cleanup(); }
});

test("a carton that is not in the store is refused", async () => {
  const f = createFixture();
  try {
    const gp = await billedGatepass(f, 2);
    // Produced but never received: it is on the factory floor, not in the store.
    const row = f.raw.prepare("SELECT id FROM article_sizes WHERE article = 'SK6' LIMIT 1").get() as { id: string };
    const [floorId] = f.db.generateQrBatch({ articleSizeId: row.id, color: "BLACK", quantity: 1, createdBy: "admin" }).qrCodes.map((b) => b.id);
    await f.produce.execute({ rawScan: floorId!, context: CONTEXT });

    const result = await storeScan(f, gp.gatepassId, floorId!);
    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "NOT_IN_STORE");
  } finally { f.cleanup(); }
});

test("scanning the same carton twice never counts twice", async () => {
  const f = createFixture();
  try {
    const gp = await billedGatepass(f, 2);
    assert.equal((await storeScan(f, gp.gatepassId, gp.ids[0]!)).accepted, true);

    const again = await storeScan(f, gp.gatepassId, gp.ids[0]!);
    assert.equal(again.accepted, false);
    assert.equal(again.outcome, "ALREADY_AT_GATE");

    const progress = f.db.getGatepassScanProgress(gp.gatepassId)!;
    assert.equal(progress.storeScannedCartons, 1, "still one carton");
    assert.equal(f.stockOf(gp.variantId), 1, "stock moved exactly once");
  } finally { f.cleanup(); }
});

test("a line that already has everything it asked for takes no more", async () => {
  const f = createFixture();
  try {
    // Two cartons in stock, but the document only asks for one.
    const stock = await stockVariant(f, 2);
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, [{ variantId: stock.variantId, quantity: 1 }]);
    bill(f, party, gatepassId);

    assert.equal((await storeScan(f, gatepassId, stock.ids[0]!)).accepted, true);
    assert.equal(f.statusOf(gatepassId), "AT_GATE");

    const extra = await storeScan(f, gatepassId, stock.ids[1]!);
    assert.equal(extra.accepted, false);
    assert.equal(extra.outcome, "GATEPASS_NOT_READY", "the document has left the store desk");
    assert.equal(f.stockOf(stock.variantId), 1, "the second carton stayed in the store");
  } finally { f.cleanup(); }
});

// ─── Store: lines and progress ────────────────────────────────────────────────

test("two colours on one document are counted apart, and neither satisfies the other", async () => {
  const f = createFixture();
  try {
    const black = await stockVariant(f, 2, "BLACK");
    const green = await stockVariant(f, 2, "GREEN");
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, [
      { variantId: black.variantId, quantity: 2 },
      { variantId: green.variantId, quantity: 1 },
    ]);
    bill(f, party, gatepassId);

    await storeScan(f, gatepassId, black.ids[0]!);
    const progress = f.db.getGatepassScanProgress(gatepassId)!;

    const blackLine = progress.lines.find((l) => l.color === "BLACK")!;
    const greenLine = progress.lines.find((l) => l.color === "GREEN")!;
    assert.deepEqual(
      [blackLine.requiredCartons, blackLine.storeScannedCartons, blackLine.storeRemainingCartons],
      [2, 1, 1]
    );
    assert.deepEqual(
      [greenLine.requiredCartons, greenLine.storeScannedCartons, greenLine.storeRemainingCartons],
      [1, 0, 1],
      "the green line is untouched by a black carton"
    );
    assert.equal(progress.requiredCartons, 3);
    assert.equal(progress.storeRemainingCartons, 2);
    assert.equal(f.statusOf(gatepassId), "BILLED", "partly scanned is not finished");
  } finally { f.cleanup(); }
});

test("the carton that finishes the last line sends the document to the gate, once", async () => {
  const f = createFixture();
  try {
    const black = await stockVariant(f, 1, "BLACK");
    const green = await stockVariant(f, 1, "GREEN");
    const party = createParty(f);
    const gatepassId = await createGatepass(f, party, [
      { variantId: black.variantId, quantity: 1 },
      { variantId: green.variantId, quantity: 1 },
    ]);
    bill(f, party, gatepassId);

    const first = await storeScan(f, gatepassId, black.ids[0]!);
    assert.equal(first.gatepassReachedGate, false);
    assert.equal(f.statusOf(gatepassId), "BILLED");

    const last = await storeScan(f, gatepassId, green.ids[0]!);
    assert.equal(last.gatepassReachedGate, true);
    assert.equal(f.statusOf(gatepassId), "AT_GATE");

    // The movement and the transition are one transaction: both happened, each exactly once.
    assert.equal(f.db.getGatepassScanProgress(gatepassId)!.storeRemainingCartons, 0);
    assert.equal(
      Number((f.raw.prepare("SELECT COUNT(1) AS n FROM audit_log WHERE entity_id = ? AND event_type = 'GATEPASS_AT_GATE'").get(gatepassId) as { n: number }).n),
      1
    );
  } finally { f.cleanup(); }
});

test("every accepted store scan is attributed to the document it was scanned for", async () => {
  const f = createFixture();
  try {
    const gp = await billedGatepass(f, 2);
    await storeScan(f, gp.gatepassId, gp.ids[0]!);

    const stamped = f.raw
      .prepare("SELECT gatepass_id FROM production_events WHERE qr_id = ? AND event_type = 'MOVED' AND json_extract(metadata_json, '$.eventType') = 'STORE_EXIT'")
      .get(gp.ids[0]!) as { gatepass_id: string | null } | undefined;
    assert.equal(stamped?.gatepass_id, gp.gatepassId);
  } finally { f.cleanup(); }
});

// ─── Dispatch ─────────────────────────────────────────────────────────────────

/** A gatepass standing at the gate, with its cartons already moved out of the store. */
async function atGate(f: Fixture, quantity: number, color = "BLACK") {
  const gp = await billedGatepass(f, quantity, color);
  for (const id of gp.ids) assert.equal((await storeScan(f, gp.gatepassId, id)).accepted, true, `move out ${id}`);
  assert.equal(f.statusOf(gp.gatepassId), "AT_GATE");
  const session = f.db.getGatepassScanProgress(gp.gatepassId)!.dispatchSessionId!;
  return { ...gp, session };
}

const dispatchScan = (f: Fixture, gatepassId: string, sessionId: string, qrId: string) =>
  f.dispatch.execute({ rawScan: qrId, sessionId, gatepassId, context: CONTEXT });

test("a Gatepass at the gate dispatches its own cartons", async () => {
  const f = createFixture();
  try {
    const gp = await atGate(f, 2);
    const result = await dispatchScan(f, gp.gatepassId, gp.session, gp.ids[0]!);

    assert.equal(result.accepted, true, result.reason);
    assert.equal(result.gatepassDispatched, false, "one of two is not the whole document");
    assert.equal(f.statusOf(gp.gatepassId), "AT_GATE");
    assert.equal(f.db.getGatepassScanProgress(gp.gatepassId)!.dispatchedCartons, 1);
  } finally { f.cleanup(); }
});

test("a Gatepass still at the store desk cannot be dispatched", async () => {
  const f = createFixture();
  try {
    const gp = await billedGatepass(f, 1);
    const session = f.db.getGatepassScanProgress(gp.gatepassId)!.dispatchSessionId!;

    const result = await dispatchScan(f, gp.gatepassId, session, gp.ids[0]!);
    assert.equal(result.accepted, false);
    assert.match(result.reason ?? "", /NOT AT THE GATE YET/);
    assert.equal(f.statusOf(gp.gatepassId), "BILLED");
  } finally { f.cleanup(); }
});

test("dispatch holds the operator to the colour the Gatepass asked for", async () => {
  const f = createFixture();
  try {
    const gp = await atGate(f, 1, "BLACK");
    // A GREEN carton of the same article and size, standing at the gate on its own.
    const green = await stockVariant(f, 1, "GREEN");
    await f.moveOut.execute({ rawScan: green.ids[0]!, context: CONTEXT });

    const result = await dispatchScan(f, gp.gatepassId, gp.session, green.ids[0]!);
    assert.equal(result.accepted, false, "the bill would allow it; the Gatepass does not");
    assert.match(result.reason ?? "", /DOES NOT ASK FOR SK6 GREEN/);
    assert.equal(f.statusOf(gp.gatepassId), "AT_GATE");
  } finally { f.cleanup(); }
});

test("a carton cannot be dispatched twice", async () => {
  const f = createFixture();
  try {
    const gp = await atGate(f, 2);
    assert.equal((await dispatchScan(f, gp.gatepassId, gp.session, gp.ids[0]!)).accepted, true);

    const again = await dispatchScan(f, gp.gatepassId, gp.session, gp.ids[0]!);
    assert.equal(again.accepted, false);
    assert.match(again.reason ?? "", /ALREADY BEEN DISPATCHED/);
    assert.equal(f.db.getGatepassScanProgress(gp.gatepassId)!.dispatchedCartons, 1);
  } finally { f.cleanup(); }
});

test("the carton that finishes dispatch sends the document out, and only once", async () => {
  const f = createFixture();
  try {
    const gp = await atGate(f, 2);
    assert.equal((await dispatchScan(f, gp.gatepassId, gp.session, gp.ids[0]!)).gatepassDispatched, false);

    const last = await dispatchScan(f, gp.gatepassId, gp.session, gp.ids[1]!);
    assert.equal(last.gatepassDispatched, true);
    assert.equal(f.statusOf(gp.gatepassId), "DISPATCHED");
    assert.equal(
      Number((f.raw.prepare("SELECT COUNT(1) AS n FROM audit_log WHERE entity_id = ? AND event_type = 'GATEPASS_DISPATCHED'").get(gp.gatepassId) as { n: number }).n),
      1
    );
  } finally { f.cleanup(); }
});

test("a dispatched carton stays traceable to its party, Gatepass and bill", async () => {
  const f = createFixture();
  try {
    const gp = await atGate(f, 1);
    await dispatchScan(f, gp.gatepassId, gp.session, gp.ids[0]!);

    // The chain the existing architecture already carries — no extra table.
    const trace = f.raw
      .prepare(
        `SELECT pe.qr_id, pe.event_ts_local, pe.article_snapshot, pe.color_snapshot, pe.size_snapshot,
                pe.dispatch_session_id, sv.voucher_number, g.gatepass_number, p.party_name
         FROM production_events pe
         JOIN dispatch_sessions ds ON ds.id = pe.dispatch_session_id
         JOIN sale_vouchers sv ON sv.id = ds.voucher_id
         JOIN gatepasses g ON g.id = sv.gatepass_id
         JOIN parties p ON p.id = g.party_id
         WHERE pe.event_type = 'DISPATCHED' AND pe.qr_id = ?`
      )
      .get(gp.ids[0]!) as Record<string, unknown> | undefined;

    assert.ok(trace, "the carton answers every tracking question through the existing chain");
    assert.equal(trace!.party_name, "ABC TRADERS");
    assert.equal(trace!.voucher_number, gp.voucher.voucherNumber);
    assert.equal(trace!.color_snapshot, "BLACK");
    assert.ok(trace!.event_ts_local, "and when it happened");
  } finally { f.cleanup(); }
});

// ─── The generic modes must still work ────────────────────────────────────────

test("the generic store scanner is untouched: no Gatepass named, FIFO reconciliation as before", async () => {
  const f = createFixture();
  try {
    const gp = await billedGatepass(f, 2);

    // No gatepassId: the old behaviour, which finds the oldest open line owing this variant.
    const result = await f.moveOut.execute({ rawScan: gp.ids[0]!, context: CONTEXT });
    assert.equal(result.accepted, true);
    assert.equal(result.outcome, "MOVED_OUT");
    assert.equal(result.gatepass?.gatepassId, gp.gatepassId, "still reconciled, without being asked");
  } finally { f.cleanup(); }
});

test("the generic dispatch flow is untouched: the bill still decides, colour-blind as before", async () => {
  const f = createFixture();
  try {
    const gp = await atGate(f, 2, "BLACK");
    // The bill needs its line before the generic allowance can say yes: 2 cartons = 1 dozen,
    // and what the bill may say is locked to the gatepass (docs/23).
    f.db.addVoucherLineItem(gp.voucher.id, { productVariantId: gp.variantId, quantity: 1, unitPrice: 550 });

    // No gatepassId: validated against the bill, which has no colour.
    const result = await f.dispatch.execute({ rawScan: gp.ids[0]!, sessionId: gp.session, context: CONTEXT });
    assert.equal(result.accepted, true, result.reason);
    assert.equal(result.gatepassDispatched, false, "the generic flow advances no document");
    assert.equal(f.statusOf(gp.gatepassId), "AT_GATE", "status is only moved by the locked flow");
  } finally { f.cleanup(); }
});
