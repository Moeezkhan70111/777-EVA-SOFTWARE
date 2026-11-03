import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddMachineUseCase, CancelGatepassUseCase, CreateGatepassUseCase, InMemoryEventBus } from "@erp/application";
import { businessDateOf, toPaisa } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";
import { CartonStockWouldGoNegative, moveCartonStock } from "./database/cartonStock.js";

// CARTON STOCK MOVEMENTS on one computer (docs/42): every writer records its movement and moves the
// figure through the one helper, a void withdraws the entry everywhere it was counted, and nothing
// is ever counted twice. The same writers on two computers, through sync: @erp/sync cartonStockEvents.test.ts.

type Raw = import("node:sqlite").DatabaseSync;
const STORE = "factory-1";
const today = () => businessDateOf(new Date().toISOString());

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-carton-stock-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "c.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: STORE, factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });
  const raw = (db as unknown as { db: Raw }).db;
  const deps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() };
  const contractor = (name: string, mobile: string) => db.createParty({ partyName: name, partyType: "CONTRACTOR", city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
  const aslam = contractor("ASLAM", "0300-1111111");
  const babar = contractor("BABAR", "0300-2222222");
  const customer = db.createParty({ partyName: "MAMA CHAPPAL", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300-3333333", status: "ACTIVE" });
  db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED"], status: "ACTIVE" });
  const sk6 = (raw.prepare("SELECT id FROM article_sizes WHERE article = 'SK6' AND size = '7/10'").get() as { id: string }).id;
  const red = (raw.prepare("SELECT id FROM product_variants WHERE article = 'SK6' AND color = 'RED'").get() as { id: string }).id;
  const machine = async (): Promise<string> =>
    (await new AddMachineUseCase(deps).execute({ name: "Machine 1", contractorPartyId: aslam, packingContractorPartyId: babar, actor: "admin" })).machineId!;
  const produce = (machineId: string, dozens: string, requestId: string = crypto.randomUUID()) =>
    db.recordManualProduction({ requestId, machineId, articleSizeId: sk6, color: "RED", dozens, storeLocationId: STORE, createdBy: "admin" });
  const gatepass = async (quantity: number) =>
    new CreateGatepassUseCase({ txManager: db, repo: db, idGenerator: new UuidGenerator() }).execute({
      partyId: customer, lines: [{ productVariantId: red, quantity }], actor: "clerk",
    });
  const cancel = (gatepassId: string) =>
    new CancelGatepassUseCase({ txManager: db, repo: db, idGenerator: new UuidGenerator() }).execute({ gatepassId, reason: "wrong party", actor: "clerk" });
  const onHand = () => Number((raw.prepare("SELECT COALESCE(SUM(quantity_on_hand), 0) AS n FROM stock_projection_by_variant WHERE product_variant_id = ?").get(red) as { n: number }).n);
  const inStore = () => db.listInventory("SK6").find((row) => row.color === "RED")?.storeQuantity ?? 0;
  const events = () =>
    (raw.prepare("SELECT event_type, quantity, balance_delta, manual_production_entry_id, gatepass_id FROM carton_stock_events ORDER BY rowid").all() as Array<Record<string, unknown>>)
      .map((row) => ({ ...row }));
  const earned = (partyId: string) => db.getContractorLedger(partyId, { fromDate: today(), toDate: today() }).earnedPaisa;
  return {
    db, raw, red, machine, produce, gatepass, cancel, onHand, inStore, events, earned, aslam, babar,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

type Fixture = ReturnType<typeof createFixture>;
const withFixture = async (work: (f: Fixture) => Promise<void>) => {
  const f = createFixture();
  try {
    await work(f);
  } finally {
    f.cleanup();
  }
};

test("Manual Production records one movement and raises both figures; a retried Save adds neither", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine();
    const { entry } = f.produce(m1, "10", "save-1");
    assert.equal(f.produce(m1, "10", "save-1").duplicate, true);
    assert.deepEqual(f.events(), [{ event_type: "MANUAL_PRODUCE", quantity: 20, balance_delta: 20, manual_production_entry_id: entry.id, gatepass_id: null }]);
    assert.equal(f.onHand(), 20);
    assert.equal(f.inStore(), 20);
  });
});

test("a gatepass takes its cartons out when it is made, reserves nothing, and its cancel puts them back once", async () => {
  await withFixture(async (f) => {
    f.produce(await f.machine(), "10");
    const made = await f.gatepass(5);
    assert.equal(made.accepted, true, made.reason);
    assert.equal(f.inStore(), 15, "out of Current Stock the moment it is made");
    assert.equal(f.onHand(), 15);
    const [row] = f.db.listStoreStockByArticle("SK6");
    assert.deepEqual([row?.storeQuantity, row?.reservedQuantity, row?.reflectedQuantity], [15, 0, 15], "one figure: nothing taken twice");

    assert.equal((await f.cancel(String(made.gatepassId))).accepted, true);
    assert.equal((await f.cancel(String(made.gatepassId))).outcome, "ALREADY_CANCELLED");
    assert.equal(f.inStore(), 20, "cancelling twice puts the cartons back once");
    assert.deepEqual(f.events().map((e) => [e.event_type, e.balance_delta, e.gatepass_id]), [
      ["MANUAL_PRODUCE", 20, null],
      ["GATEPASS_ISSUE", -5, made.gatepassId],
      ["GATEPASS_CANCEL", 5, made.gatepassId],
    ]);
  });
});

test("a gatepass for more than the store holds is refused, and nothing moves", async () => {
  await withFixture(async (f) => {
    f.produce(await f.machine(), "2");
    const refused = await f.gatepass(5);
    assert.equal(refused.accepted, false);
    assert.equal(refused.outcome, "INSUFFICIENT_STOCK");
    assert.equal(f.inStore(), 4);
    assert.equal(f.events().length, 1);
  });
});

test("11, 12 & 16. a production operator voids today's entry with a reason, never without one; stock, totals, Reconciliation and the Contractor Ledger move together -- once", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine();
    const kept = f.produce(m1, "5").entry;
    const voided = f.produce(m1, "10").entry;
    assert.equal(f.earned(f.aslam), toPaisa(70 * 15));

    assert.throws(() => f.db.voidManualProduction({ entryId: voided.id, reason: "  ", voidedBy: "operator", mayVoidEarlierDays: false }), /Give a reason/);
    const after = f.db.voidManualProduction({ entryId: voided.id, reason: "typed twice", voidedBy: "operator", mayVoidEarlierDays: false });
    assert.deepEqual([after.voidReason, after.voidedBy], ["typed twice", "operator"]);
    assert.throws(() => f.db.voidManualProduction({ entryId: voided.id, reason: "again", voidedBy: "operator", mayVoidEarlierDays: false }), /has already been voided/);

    assert.equal(f.inStore(), 10, "exactly its 20 cartons came out");
    assert.equal(f.events().filter((e) => e.event_type === "MANUAL_PRODUCTION_VOID").length, 1, "voiding twice emits one event");
    const day = f.db.listManualProduction({ date: today() });
    assert.equal(day?.totalCartons, 10, "a voided entry is not in the day's totals");
    assert.equal(day?.totalEntries, 2, "but it is still listed");
    assert.equal(day?.rows.find((row) => row.id === voided.id)?.voidedAt !== null, true, "shown as voided");
    assert.deepEqual(day?.summary.map((line) => line.cartons), [10]);
    assert.equal(f.earned(f.aslam), toPaisa(70 * 5), "the machine-day owed falls by exactly its share");
    assert.equal(f.earned(f.babar), toPaisa(30 * 5));
    assert.equal(f.db.listManualProduction({ date: today() })?.rows.find((row) => row.id === kept.id)?.voidedAt, null);
  });
});

test("15. a void is refused while a gatepass holds the cartons, names it, and goes through once it is cancelled", async () => {
  await withFixture(async (f) => {
    const entry = f.produce(await f.machine(), "10").entry;
    const made = await f.gatepass(15);
    assert.throws(
      () => f.db.voidManualProduction({ entryId: entry.id, reason: "wrong machine", voidedBy: "operator", mayVoidEarlierDays: false }),
      new RegExp(`already gone out on gatepass ${String(made.code)}\\. Cancel that gatepass first`)
    );
    assert.equal(f.inStore(), 5, "the refusal changed nothing");
    assert.equal(f.db.listManualProduction({ date: today() })?.rows[0]?.voidedAt, null);

    await f.cancel(String(made.gatepassId));
    f.db.voidManualProduction({ entryId: entry.id, reason: "wrong machine", voidedBy: "operator", mayVoidEarlierDays: false });
    assert.equal(f.inStore(), 0);
  });
});

test("the figure never goes below zero: the one helper refuses rather than clamps", async () => {
  await withFixture(async (f) => {
    f.produce(await f.machine(), "1");
    f.raw.exec("BEGIN");
    assert.throws(() => moveCartonStock(f.raw, { variantId: f.red, locationId: STORE, delta: -3, nowIso: new Date().toISOString() }), CartonStockWouldGoNegative);
    f.raw.exec("ROLLBACK");
    assert.equal(f.inStore(), 2);
  });
});

test("every movement made here is marked for sending, once", async () => {
  await withFixture(async (f) => {
    f.produce(await f.machine(), "10");
    const made = await f.gatepass(3);
    await f.cancel(String(made.gatepassId));
    const marks = f.raw.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = 'CARTON_STOCK_EVENT'").get() as { n: number };
    assert.equal(Number(marks.n), 3);
  });
});

/** Moves an entry to an earlier business day, as if it had been made two days ago. */
const makeOld = (f: Fixture, entryId: string) =>
  f.raw.prepare("UPDATE manual_production_entries SET entry_ts = ? WHERE id = ?").run(new Date(Date.now() - 2 * 86_400_000).toISOString(), entryId);

test("13. an entry from an earlier business day is not the production operator's to void: refused, nothing moves", async () => {
  await withFixture(async (f) => {
    const entry = f.produce(await f.machine(), "10").entry;
    makeOld(f, entry.id);
    assert.throws(
      () => f.db.voidManualProduction({ entryId: entry.id, reason: "wrong machine", voidedBy: "operator", mayVoidEarlierDays: false }),
      /was entered on \d{4}-\d{2}-\d{2}\. Only an administrator can void an entry from an earlier day\./
    );
    assert.equal(f.inStore(), 20);
    assert.equal(f.events().filter((e) => e.event_type === "MANUAL_PRODUCTION_VOID").length, 0);
    assert.equal((f.raw.prepare("SELECT voided_at FROM manual_production_entries WHERE id = ?").get(entry.id) as { voided_at: string | null }).voided_at, null);
  });
});

test("14. an administrator voids an entry from an earlier business day, with a reason, once", async () => {
  await withFixture(async (f) => {
    const entry = f.produce(await f.machine(), "10").entry;
    makeOld(f, entry.id);
    assert.throws(() => f.db.voidManualProduction({ entryId: entry.id, reason: " ", voidedBy: "owner", mayVoidEarlierDays: true }), /Give a reason/);
    const voided = f.db.voidManualProduction({ entryId: entry.id, reason: "test entry from the rollout", voidedBy: "owner", mayVoidEarlierDays: true });
    assert.deepEqual([voided.voidedBy, voided.voidReason], ["owner", "test entry from the rollout"]);
    assert.equal(f.inStore(), 0);
    assert.throws(() => f.db.voidManualProduction({ entryId: entry.id, reason: "again", voidedBy: "owner", mayVoidEarlierDays: true }), /already been voided/);
    assert.equal(f.events().filter((e) => e.event_type === "MANUAL_PRODUCTION_VOID").length, 1);
  });
});

test("16. a void is one transaction: if its stock movement fails, the entry, the stock and the ledger are as they were", async () => {
  await withFixture(async (f) => {
    const entry = f.produce(await f.machine(), "10").entry;
    const owed = f.earned(f.aslam);
    f.raw.exec(`CREATE TRIGGER test_refuse_void BEFORE INSERT ON carton_stock_events
                WHEN NEW.event_type = 'MANUAL_PRODUCTION_VOID' BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`);
    assert.throws(() => f.db.voidManualProduction({ entryId: entry.id, reason: "wrong machine", voidedBy: "operator", mayVoidEarlierDays: false }), /refused for the test/);
    f.raw.exec("DROP TRIGGER test_refuse_void");
    assert.equal((f.raw.prepare("SELECT voided_at FROM manual_production_entries WHERE id = ?").get(entry.id) as { voided_at: string | null }).voided_at, null);
    assert.deepEqual([f.inStore(), f.onHand(), f.earned(f.aslam)], [20, 20, owed]);
  });
});
