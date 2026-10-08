import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DispatchScanUseCase,
  InMemoryEventBus,
  ProcessScanUseCase,
  ReturnScanUseCase,
  StoreEntryScanUseCase,
  StoreExitScanUseCase,
} from "@erp/application";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// QR Journey against the real database: one code is walked through every station the
// system has, in the order a real carton might take, and the journey read model must spell
// out exactly that path — nothing invented, nothing missing.

const FACTORY = "factory-777";
const CONTEXT = { factoryId: FACTORY, workstationId: "ws-prod-01", deviceId: "desktop-main" };

type Raw = import("node:sqlite").DatabaseSync;

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-journey-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "j.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
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
  const bus = new InMemoryEventBus();
  const ids = new UuidGenerator();
  const stations = {
    produce: new ProcessScanUseCase({ txManager: db, duplicateChecker: db, qrRegistry: db, productCatalog: db, qrMasterRepo: db, productionEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, eventPublisher: bus, idGenerator: ids }),
    moveIn: new StoreEntryScanUseCase({ txManager: db, qrLookupRepo: db, gatepassRepo: db, qrRegistry: db, qrMasterRepo: db, storeEntryEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, eventPublisher: bus, idGenerator: ids }),
    moveOut: new StoreExitScanUseCase({ txManager: db, qrLookupRepo: db, gatepassRepo: db, qrRegistry: db, qrMasterRepo: db, storeExitEventsRepo: db, stockProjectionRepo: db, outboxRepo: db, eventPublisher: bus, idGenerator: ids }),
    dispatch: new DispatchScanUseCase({ txManager: db, qrLookupRepo: db, stockProjectionRepo: db, qrMasterRepo: db, dispatchEventsRepo: db, outboxRepo: db, eventPublisher: bus, idGenerator: ids }),
    returns: new ReturnScanUseCase({ txManager: db, qrLookupRepo: db, attributionRepo: db, qrMasterRepo: db, saleReturnsRepo: db, returnEventsRepo: db, outboxRepo: db, eventPublisher: bus, idGenerator: ids }),
  };
  return {
    db,
    raw: (db as unknown as { db: Raw }).db,
    stations,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function generate(db: SqliteDatabase, raw: Raw, article: string, size: string, color: string, quantity: number): string[] {
  let row = raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string } | undefined;
  if (!row) {
    db.createProduct({ article, size, sellingPrice: 550, status: "ACTIVE" });
    row = raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as { id: string };
  }
  return db.generateQrBatch({ articleSizeId: row.id, color, quantity, createdBy: "admin" }).qrCodes.map((b) => b.id);
}

/** Spreads events apart so the walk's ordering and durations are real, not same-millisecond ties. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

/**
 * A customer with a one-line bill for this article/size, and the dispatch session that bill
 * created. Dispatching against the session is what gives the carton its party attribution —
 * without it a return has no one to credit and is refused.
 */
function billFor(db: SqliteDatabase, raw: Raw, input: { partyName: string; article: string; size: string; color: string; dozens: number }) {
  const partyId = db.createParty({ partyName: input.partyName, partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });
  const variant = raw
    .prepare("SELECT id FROM product_variants WHERE article = ? AND color = ? AND size = ? LIMIT 1")
    .get(input.article, input.color, input.size) as { id: string };
  const voucher = db.createSaleVoucher({ partyId, voucherDate: "2026-09-22", bookNo: "B1" });
  db.addVoucherLineItem(voucher.id, { productVariantId: variant.id, quantity: input.dozens, unitPrice: 180, discount: 0 });
  const session = db.listDispatchSessions({ status: "ALL" }).find((s) => s.voucherId === voucher.id)!;
  return { partyId, voucherId: voucher.id, sessionId: session.sessionId, variantId: variant.id };
}

test("the journey spells out the whole path: in, out, in, out, dispatched, returned, back into the store", async () => {
  const f = createFixture();
  try {
    const [id] = generate(f.db, f.raw, "SK6", "7/10", "RED", 1);
    const s = f.stations;
    const expectOk = (result: { accepted: boolean; reason?: string; outcome?: string }, what: string) =>
      assert.equal(result.accepted, true, `${what}: ${result.reason ?? result.outcome ?? ""}`);

    expectOk(await s.produce.execute({ rawScan: id, context: CONTEXT }), "produce");
    await tick();
    expectOk(await s.moveIn.execute({ rawScan: id, context: CONTEXT, actor: "store-op" }), "move in #1");
    await tick();
    expectOk(await s.moveOut.execute({ rawScan: id, context: CONTEXT, actor: "store-op" }), "move out #1");
    await tick();
    expectOk(await s.moveIn.execute({ rawScan: id, context: CONTEXT, actor: "store-op" }), "move in #2");
    await tick();
    expectOk(await s.moveOut.execute({ rawScan: id, context: CONTEXT, actor: "gate-op" }), "move out #2");
    await tick();
    // Dispatched against a real bill, so the carton carries its party attribution.
    const bill = billFor(f.db, f.raw, { partyName: "MAMA CHAPPAL", article: "SK6", size: "7/10", color: "RED", dozens: 0.5 });
    expectOk(await s.dispatch.execute({ rawScan: id, sessionId: bill.sessionId, context: CONTEXT }), "dispatch");
    await tick();
    expectOk(await s.returns.execute({ rawScan: id, context: CONTEXT, actor: "gate-op" }), "return");
    await tick();
    expectOk(await s.moveIn.execute({ rawScan: id, context: CONTEXT, actor: "store-op" }), "move in #3");

    const journey = f.db.getQrJourney(id);
    assert.ok(journey);
    assert.equal(journey.qrId, id);
    assert.deepEqual([journey.article, journey.color, journey.size, journey.serial], ["SK6", "RED", "7/10", "000001"]);
    assert.equal(journey.stage, "WAREHOUSE");
    assert.equal(journey.currentStatus, "WAREHOUSE");
    assert.equal(journey.currentPlace, "WAREHOUSE");

    // The path, hop by hop.
    assert.deepEqual(
      journey.steps.map((st) => [st.index, st.kind, st.fromStatus, st.toStatus, st.fromPlace, st.toPlace]),
      [
        [1, "REGISTERED", null, "REGISTERED", null, null],
        [2, "PRODUCED", "REGISTERED", "PRODUCED", null, "FACTORY"],
        [3, "STORE_ENTRY", "PRODUCED", "WAREHOUSE", "FACTORY", "WAREHOUSE"],
        [4, "STORE_EXIT", "WAREHOUSE", "TO_GATE", "WAREHOUSE", "GATE"],
        [5, "STORE_ENTRY", "TO_GATE", "WAREHOUSE", "GATE", "WAREHOUSE"],
        [6, "STORE_EXIT", "WAREHOUSE", "TO_GATE", "WAREHOUSE", "GATE"],
        [7, "DISPATCHED", "TO_GATE", "DISPATCHED", "GATE", "CUSTOMER"],
        // Recording the return puts the carton ON the gate, not back in the factory: the
        // commercial return and the physical receipt are two separate hops.
        [8, "RETURNED", "DISPATCHED", "ON_GATE", "CUSTOMER", "GATE"],
        [9, "STORE_ENTRY", "ON_GATE", "WAREHOUSE", "GATE", "WAREHOUSE"],
      ]
    );

    // Every hop is in time order, timed against the previous one, and names who did it.
    for (let i = 1; i < journey.steps.length; i += 1) {
      assert.ok(journey.steps[i].occurredAt >= journey.steps[i - 1].occurredAt, `step ${i + 1} is after step ${i}`);
      assert.ok((journey.steps[i].sinceMs ?? -1) >= 0, `step ${i + 1} has an elapsed time`);
    }
    assert.equal(journey.steps[0].sinceMs, null);
    assert.equal(journey.steps[2].actor, "store-op");
    assert.equal(journey.steps[5].actor, "gate-op");
    assert.equal(journey.steps[1].deviceId, "desktop-main");
    assert.equal(journey.steps[1].workstation, "Production Line 01");
    assert.equal(journey.steps[1].factory, "777 Manufacturing");

    // Tallies of the path, and time spent per status (the current status counts up to now).
    assert.deepEqual(journey.counts, { REGISTERED: 1, PRODUCED: 1, STORE_ENTRY: 3, STORE_EXIT: 2, DISPATCHED: 1, RETURNED: 1 });
    for (const status of ["REGISTERED", "PRODUCED", "WAREHOUSE", "TO_GATE", "DISPATCHED", "ON_GATE"]) {
      assert.ok((journey.dwellMs[status] ?? 0) > 0, `time spent in ${status}`);
    }
    assert.equal(journey.firstScannedAt, journey.steps[1].occurredAt);
    assert.equal(journey.lastActivityAt, journey.steps[8].occurredAt);
    assert.equal(journey.registeredAt, journey.steps[0].occurredAt);
    assert.ok(journey.batchId);

    // The per-location stock agrees with the path: after dispatch → return → move in, the
    // one unit sits in the store and nowhere else. Note the GATE count is 0, not 1: the
    // recorded return moved no stock at all, and the move in ADDED the unit back.
    const variant = f.raw.prepare("SELECT id FROM product_variants WHERE article = 'SK6' AND color = 'RED' AND size = '7/10'").get() as { id: string };
    const byLocation = Object.fromEntries(
      (f.raw.prepare("SELECT location_type, quantity_on_hand FROM stock_projection_by_location WHERE product_variant_id = ?").all(variant.id) as Array<{ location_type: string; quantity_on_hand: number }>).map(
        (r) => [r.location_type, Number(r.quantity_on_hand)]
      )
    );
    assert.deepEqual(byLocation, { FACTORY: 0, WAREHOUSE: 1, GATE: 0 });
  } finally {
    f.cleanup();
  }
});

test("a code that was generated and never scanned has a one-step journey; a voided one has two", () => {
  const f = createFixture();
  try {
    const [fresh, spoiled] = generate(f.db, f.raw, "SK6", "7/10", "BLUE", 2);

    const untouched = f.db.getQrJourney(fresh);
    assert.ok(untouched);
    assert.equal(untouched.stage, "REGISTERED");
    assert.equal(untouched.currentStatus, null);
    assert.equal(untouched.currentPlace, null);
    assert.deepEqual(untouched.steps.map((st) => st.kind), ["REGISTERED"]);
    assert.equal(untouched.firstScannedAt, null);
    assert.equal(untouched.lastActivityAt, untouched.registeredAt);

    f.db.voidQrCode({ qrId: spoiled, reason: "label torn", actor: "admin" });
    const voided = f.db.getQrJourney(spoiled);
    assert.ok(voided);
    assert.equal(voided.stage, "VOID");
    assert.deepEqual(
      voided.steps.map((st) => [st.kind, st.fromStatus, st.toStatus, st.actor, st.note]),
      [
        ["REGISTERED", null, "REGISTERED", null, null],
        ["VOID", "REGISTERED", "VOID", "admin", "label torn"],
      ]
    );
  } finally {
    f.cleanup();
  }
});

test("a damaged unit keeps the place it was written off at, and an unknown code has no journey", async () => {
  const f = createFixture();
  try {
    const [id] = generate(f.db, f.raw, "SK6", "7/10", "GREEN", 1);
    assert.equal((await f.stations.produce.execute({ rawScan: id, context: CONTEXT })).accepted, true);
    await tick();
    assert.equal((await f.stations.moveIn.execute({ rawScan: id, context: CONTEXT })).outcome, "RECEIVED");
    await tick();
    f.db.markQrCodeDamaged({ qrId: id, reason: "crushed", actor: "admin", context: CONTEXT });

    const journey = f.db.getQrJourney(id);
    assert.ok(journey);
    assert.equal(journey.stage, "DAMAGED");
    assert.equal(journey.currentPlace, "WAREHOUSE");
    const last = journey.steps[journey.steps.length - 1];
    assert.deepEqual([last.kind, last.fromStatus, last.toStatus, last.fromPlace, last.toPlace, last.actor, last.note], [
      "DAMAGED",
      "WAREHOUSE",
      "DAMAGED",
      "WAREHOUSE",
      "WAREHOUSE",
      "admin",
      "crushed",
    ]);

    assert.equal(f.db.getQrJourney("SK6_RED_7/10_999999"), null);
    assert.equal(f.db.getQrJourney(""), null);
  } finally {
    f.cleanup();
  }
});
