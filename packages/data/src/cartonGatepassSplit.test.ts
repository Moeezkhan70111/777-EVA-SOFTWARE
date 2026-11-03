import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AddMachineUseCase,
  CancelGatepassUseCase,
  CreateGatepassUseCase,
  DispatchScanUseCase,
  InMemoryEventBus,
  ProcessScanUseCase,
  StoreEntryScanUseCase,
  StoreExitScanUseCase,
} from "@erp/application";
import { PERMISSION } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// A GATEPASS LINE IS SPLIT WHEN IT IS MADE (docs/42 section 3.5, revised 2026-11-03), against the real
// database and the real scanners: QR cartons in the store are reserved for Store Move Out exactly as
// before, and only the shortfall -- Manual Production cartons, which have no QR -- leaves stock at
// once. No carton is ever taken out of Current Stock twice. The all-QR behaviour itself is held by
// the gatepass*.test.ts files, unchanged.

type Raw = import("node:sqlite").DatabaseSync;
const FACTORY = "factory-777";
const CONTEXT = { factoryId: FACTORY, workstationId: "ws-01", deviceId: "desktop-main" };
const ids = () => new UuidGenerator();

function openDb(dbPath: string) {
  const db = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: FACTORY, factoryCode: "777", factoryName: "777", workstationId: "ws-01", workstationCode: "WS-01",
    workstationName: "WS", deviceId: "desktop-main", deviceName: "Desktop", appVersion: "1.0.0",
  });
  return db;
}

const scanDeps = (db: SqliteDatabase) => ({
  txManager: db, qrLookupRepo: db, gatepassRepo: db, qrRegistry: db, qrMasterRepo: db, stockProjectionRepo: db, outboxRepo: db,
  eventPublisher: new InMemoryEventBus(), idGenerator: ids(),
});
const producer = (db: SqliteDatabase) =>
  new ProcessScanUseCase({ ...scanDeps(db), duplicateChecker: db, productCatalog: db, productionEventsRepo: db });
const receiver = (db: SqliteDatabase) => new StoreEntryScanUseCase({ ...scanDeps(db), storeEntryEventsRepo: db });
const mover = (db: SqliteDatabase) => new StoreExitScanUseCase({ ...scanDeps(db), storeExitEventsRepo: db });
const dispatcher = (db: SqliteDatabase) => new DispatchScanUseCase({ ...scanDeps(db), dispatchEventsRepo: db, dispatchSessionRepo: db });

async function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-carton-split-"));
  const dbPath = path.join(tempDir, "split.db");
  const db = openDb(dbPath);
  const raw = (db as unknown as { db: Raw }).db;
  const contractor = (name: string, mobile: string) => db.createParty({ partyName: name, partyType: "CONTRACTOR", city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
  const machineDeps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: ids() };
  const machineId = (await new AddMachineUseCase(machineDeps).execute({
    name: "Machine 1", contractorPartyId: contractor("ASLAM", "0300-1111111"), packingContractorPartyId: contractor("BABAR", "0300-2222222"), actor: "admin",
  })).machineId!;
  const customer = db.createParty({ partyName: "MAMA CHAPPAL", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300-3333333", status: "ACTIVE" });
  db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED"], status: "ACTIVE" });
  const sk6 = (raw.prepare("SELECT id FROM article_sizes WHERE article = 'SK6'").get() as { id: string }).id;
  const red = (raw.prepare("SELECT id FROM product_variants WHERE article = 'SK6' AND color = 'RED'").get() as { id: string }).id;
  return { db, raw, dbPath, tempDir, machineId, customer, sk6, red };
}
type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** QR cartons through the real QR Generator, production scan and Store In: each one In Store. */
async function stockQr(f: Fixture, quantity: number): Promise<string[]> {
  const qrIds = f.db.generateQrBatch({ articleSizeId: f.sk6, color: "RED", quantity, createdBy: "admin" }).qrCodes.map((b) => b.id);
  for (const id of qrIds) {
    assert.equal((await producer(f.db).execute({ rawScan: id, context: CONTEXT })).accepted, true);
    assert.equal((await receiver(f.db).execute({ rawScan: id, context: CONTEXT })).outcome, "RECEIVED");
  }
  return qrIds;
}

/** Manual Production cartons, into the same store row Store In fills: they have no QR. */
const stockManual = (f: Fixture, db: SqliteDatabase, cartons: number) =>
  db.recordManualProduction({ requestId: crypto.randomUUID(), machineId: f.machineId, articleSizeId: f.sk6, color: "RED", dozens: String(cartons / 2), storeLocationId: FACTORY, createdBy: "admin" });

const makeGatepass = (f: Fixture, quantity: number, db: SqliteDatabase = f.db) =>
  new CreateGatepassUseCase({ txManager: db, repo: db, idGenerator: ids() }).execute({ partyId: f.customer, lines: [{ productVariantId: f.red, quantity }], actor: "clerk" });
const cancel = (f: Fixture, gatepassId: string) =>
  new CancelGatepassUseCase({ txManager: f.db, repo: f.db, idGenerator: ids() }).execute({ gatepassId, reason: "wrong party", actor: "clerk" });
const scanOut = async (f: Fixture, qrId: string) => {
  const result = await mover(f.db).execute({ rawScan: qrId, context: CONTEXT });
  assert.equal(result.accepted, true, result.reason);
  return result;
};

/** Current / Reserved / Reflected as the gatepass screen reads them. */
function figures(f: Fixture) {
  const row = f.db.listStoreStockByArticle("SK6").find((r) => r.color === "RED");
  return { current: row?.storeQuantity ?? 0, reserved: row?.reservedQuantity ?? 0, reflected: row?.reflectedQuantity ?? 0 };
}
const movements = (f: Fixture) =>
  (f.raw.prepare("SELECT event_type, quantity FROM carton_stock_events WHERE gatepass_id IS NOT NULL ORDER BY rowid").all() as Array<Record<string, unknown>>)
    .map((row) => `${String(row.event_type)} ${String(row.quantity)}`);
const line = (f: Fixture, gatepassId: string) => {
  const [first] = f.db.getGatepass(gatepassId)?.lines ?? [];
  return { quantity: first?.quantity, scanned: first?.dispatchedFromStoreQuantity, issued: first?.issuedDirectlyQuantity, outstanding: first?.outstandingQuantity };
};

async function withFixture(work: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await createFixture();
  try {
    await work(f);
  } finally {
    f.db.close();
    fs.rmSync(f.tempDir, { recursive: true, force: true });
  }
}

test("1. enough QR cartons: nothing is issued at once, and the line is reserved for scanning exactly as before", async () => {
  await withFixture(async (f) => {
    await stockQr(f, 6);
    stockManual(f, f.db, 10);
    const made = await makeGatepass(f, 5);
    assert.equal(made.accepted, true, made.reason);
    assert.deepEqual(movements(f), [], "no GATEPASS_ISSUE");
    assert.deepEqual(figures(f), { current: 16, reserved: 5, reflected: 11 });
    assert.deepEqual(line(f, made.gatepassId!), { quantity: 5, scanned: 0, issued: 0, outstanding: 5 });
  });
});

test("2. no QR cartons: the whole line leaves stock at once and reserves nothing", async () => {
  await withFixture(async (f) => {
    stockManual(f, f.db, 10);
    const made = await makeGatepass(f, 5);
    assert.deepEqual(movements(f), ["GATEPASS_ISSUE 5"]);
    assert.deepEqual(figures(f), { current: 5, reserved: 0, reflected: 5 });
    assert.deepEqual(line(f, made.gatepassId!), { quantity: 5, scanned: 0, issued: 5, outstanding: 0 });
  });
});

test("3 & 6. 3 QR + 10 manual, gatepass for 5: 2 issued at once, 3 reserved for scanning", async () => {
  await withFixture(async (f) => {
    await stockQr(f, 3);
    stockManual(f, f.db, 10);
    const made = await makeGatepass(f, 5);
    assert.deepEqual(movements(f), ["GATEPASS_ISSUE 2"]);
    assert.deepEqual(figures(f), { current: 11, reserved: 3, reflected: 8 });
    assert.deepEqual(line(f, made.gatepassId!), { quantity: 5, scanned: 0, issued: 2, outstanding: 3 });
  });
});

test("4, 5 & 6. each QR scan takes one carton out once; after the reserved 3, the line takes no more and nothing leaves twice", async () => {
  await withFixture(async (f) => {
    const qr = await stockQr(f, 3);
    stockManual(f, f.db, 10);
    const made = await makeGatepass(f, 5);
    const first = await scanOut(f, qr[0]!);
    assert.equal(first.gatepass?.code, made.code, "the scan is still attributed to the gatepass");
    assert.equal(first.gatepass?.outstanding, 2);
    assert.deepEqual(figures(f), { current: 10, reserved: 2, reflected: 8 }, "one carton out, once; Reflected unchanged by the scan");
    await scanOut(f, qr[1]!);
    await scanOut(f, qr[2]!);
    assert.deepEqual(figures(f), { current: 8, reserved: 0, reflected: 8 }, "13 - 2 issued - 3 scanned");
    assert.deepEqual(line(f, made.gatepassId!), { quantity: 5, scanned: 3, issued: 2, outstanding: 0 });

    // A further QR carton scanned out is not the gatepass's: its line is settled.
    const [late] = await stockQr(f, 1);
    const plain = await scanOut(f, late!);
    assert.equal(plain.gatepass ?? null, null, "never attributed to a settled line");
    assert.deepEqual(line(f, made.gatepassId!), { quantity: 5, scanned: 3, issued: 2, outstanding: 0 });
    assert.deepEqual(figures(f), { current: 8, reserved: 0, reflected: 8 });
  });
});

test("7 & 8. a cancel puts back only what was issued at once, releases the reservation, and a second cancel moves nothing", async () => {
  await withFixture(async (f) => {
    await stockQr(f, 3);
    stockManual(f, f.db, 10);
    const made = await makeGatepass(f, 5);
    const cancelled = await cancel(f, made.gatepassId!);
    assert.equal(cancelled.accepted, true, cancelled.reason);
    assert.deepEqual([cancelled.releasedQuantity, cancelled.returnedToStockQuantity], [3, 2], "3 reserved released, 2 issued returned");
    assert.deepEqual(figures(f), { current: 13, reserved: 0, reflected: 13 });
    assert.equal((await cancel(f, made.gatepassId!)).outcome, "ALREADY_CANCELLED");
    assert.deepEqual(movements(f), ["GATEPASS_ISSUE 2", "GATEPASS_CANCEL 2"], "one cancel movement, ever");
    assert.deepEqual(figures(f), { current: 13, reserved: 0, reflected: 13 });
  });
});

test("9. a gatepass for more than Reflected Stock is still refused, and nothing moves", async () => {
  await withFixture(async (f) => {
    await stockQr(f, 2);
    stockManual(f, f.db, 2);
    const refused = await makeGatepass(f, 5);
    assert.equal(refused.outcome, "INSUFFICIENT_STOCK");
    assert.deepEqual(movements(f), []);
    assert.deepEqual(figures(f), { current: 4, reserved: 0, reflected: 4 });
  });
});

test("10. two computers' clerks racing for the last manual cartons on one database: one gatepass, never an overdraw", async () => {
  await withFixture(async (f) => {
    const second = openDb(f.dbPath);
    try {
      stockManual(f, f.db, 4);
      const [a, b] = await Promise.all([makeGatepass(f, 3), makeGatepass(f, 3, second)]);
      assert.equal([a, b].filter((r) => r.accepted).length, 1, `${String(a.outcome)} / ${String(b.outcome)}`);
      assert.deepEqual(movements(f), ["GATEPASS_ISSUE 3"]);
      assert.deepEqual(figures(f), { current: 1, reserved: 0, reflected: 1 });
    } finally {
      second.close();
    }
  });
});

test("10. production while a gatepass holds the write lock is refused whole, never interleaved; Save again lands it once", async () => {
  await withFixture(async (f) => {
    const second = openDb(f.dbPath);
    try {
      stockManual(f, f.db, 4);
      const requestId = crypto.randomUUID();
      const produce = () =>
        second.recordManualProduction({ requestId, machineId: f.machineId, articleSizeId: f.sk6, color: "RED", dozens: "3", storeLocationId: FACTORY, createdBy: "admin" });
      const [made, during] = await Promise.allSettled([makeGatepass(f, 3), Promise.resolve().then(produce)]);
      assert.equal(made.status === "fulfilled" && made.value.accepted, true);
      assert.equal(during.status, "rejected", "the second writer waits for nobody: it is refused, and wrote nothing");
      assert.deepEqual(figures(f), { current: 1, reserved: 0, reflected: 1 }, "4 - 3, and nothing of the refused entry");

      assert.equal(produce().duplicate, false, "Save again, same request id: it lands now");
      assert.equal(produce().duplicate, true, "and a third press adds nothing");
      assert.deepEqual(figures(f), { current: 7, reserved: 0, reflected: 7 }, "4 - 3 + 6, exact");
    } finally {
      second.close();
    }
  });
});

// ─── The lifecycle: billing, the store, the gate (docs/42 section 10.2) ─────────────────────────

const statusOf = (f: Fixture, gatepassId: string) => (f.raw.prepare("SELECT status FROM gatepasses WHERE id = ?").get(gatepassId) as { status: string }).status;
const bill = (f: Fixture, gatepassId: string) => f.db.createSaleVoucher({ partyId: f.customer, voucherDate: "2026-11-03", bookNo: "1", gatepassId });
const transitions = (f: Fixture, gatepassId: string) =>
  (f.raw
    .prepare(
      `SELECT event_type FROM audit_log WHERE entity_type = 'GATEPASS' AND entity_id = ?
         AND event_type IN ('GATEPASS_BILLED', 'GATEPASS_AT_GATE', 'GATEPASS_DISPATCHED') ORDER BY rowid`
    )
    .all(gatepassId) as Array<{ event_type: string }>).map((row) => row.event_type);
const count = (f: Fixture, sql: string, ...params: string[]) => Number((f.raw.prepare(sql).get(...params) as { n: number }).n);
const scanAgainst = async (f: Fixture, qrId: string, gatepassId: string) => {
  const result = await mover(f.db).execute({ rawScan: qrId, gatepassId, context: CONTEXT });
  assert.equal(result.accepted, true, result.reason);
  return result;
};
/** A user of the store desk, to see who is told "ready for Store". */
function storeUser(f: Fixture): string {
  const user = f.db.createUserAccount("store-desk", "Password123");
  f.raw.prepare("UPDATE app_users SET access_status = 'APPROVED' WHERE id = ?").run(user.id);
  f.db.assignUserRole(user.id, f.db.createRole({ name: "Store desk", permissions: ["store-scanning"] }).code);
  return user.id;
}
const billedNotices = (f: Fixture, userId: string) =>
  count(f, "SELECT COUNT(1) AS n FROM user_notifications WHERE user_id = ? AND kind = 'GATEPASS_BILLED'", userId);

/** A user of the gate desk, to see when the gate is told a gatepass has arrived. */
function gateUser(f: Fixture): string {
  const user = f.db.createUserAccount("gate-desk", "Password123");
  f.raw.prepare("UPDATE app_users SET access_status = 'APPROVED' WHERE id = ?").run(user.id);
  f.db.assignUserRole(user.id, f.db.createRole({ name: "Gate desk", permissions: [PERMISSION.LIVE_DISPATCH] }).code);
  return user.id;
}
const atGateNotices = (f: Fixture, userId: string) =>
  count(f, "SELECT COUNT(1) AS n FROM user_notifications WHERE user_id = ? AND kind = 'GATEPASS_AT_GATE'", userId);

/** Whether a desk's queue holds the gatepass: its list and its count, as the screens read them. */
const inQueue = (f: Fixture, stage: "BILLED" | "AT_GATE", gatepassId: string) => {
  const listed = f.db.listGatepasses({ status: stage, pageSize: 100 }).rows.some((row) => row.id === gatepassId);
  return { listed, counted: f.db.countGatepassesByStage()[stage] ?? 0 };
};

test("Q1, Q4 & L5. a manual-only gatepass, once billed, rests at BILLED in no desk's queue; the store is not told; nothing is scanned or moved", async () => {
  await withFixture(async (f) => {
    const store = storeUser(f);
    stockManual(f, f.db, 10);
    const made = await makeGatepass(f, 4);
    const gatepassId = made.gatepassId!;
    const eventsBefore = count(f, "SELECT COUNT(1) AS n FROM production_events");
    bill(f, gatepassId);
    assert.equal(statusOf(f, gatepassId), "BILLED", "billing changes one step only");
    assert.deepEqual(transitions(f, gatepassId), ["GATEPASS_BILLED"]);
    assert.deepEqual(inQueue(f, "BILLED", gatepassId), { listed: false, counted: 0 }, "not in the store's queue");
    assert.deepEqual(inQueue(f, "AT_GATE", gatepassId), { listed: false, counted: 0 }, "not in the gate's queue");
    assert.equal(f.db.listGatepasses({ status: "ALL", pageSize: 100 }).rows.some((row) => row.id === gatepassId), true, "still a document on the list");
    assert.equal(billedNotices(f, store), 0, "the store is not told to scan what it cannot");
    assert.equal(count(f, "SELECT COUNT(1) AS n FROM production_events"), eventsBefore, "no scan was invented");
    assert.deepEqual(movements(f), ["GATEPASS_ISSUE 4"]);
    assert.deepEqual(figures(f), { current: 6, reserved: 0, reflected: 6 });
  });
});

test("Q2. deleting that bill takes it back to CREATED, where it can be cancelled, and the cancel puts its issued cartons back", async () => {
  await withFixture(async (f) => {
    stockManual(f, f.db, 10);
    const made = await makeGatepass(f, 4);
    const gatepassId = made.gatepassId!;
    const voucher = bill(f, gatepassId);
    f.db.deleteSaleVoucher(voucher.id, "billed the wrong party");
    assert.equal(statusOf(f, gatepassId), "CREATED");
    const cancelled = await cancel(f, gatepassId);
    assert.equal(cancelled.accepted, true, cancelled.reason);
    assert.equal(cancelled.returnedToStockQuantity, 4);
    assert.deepEqual(movements(f), ["GATEPASS_ISSUE 4", "GATEPASS_CANCEL 4"]);
    assert.deepEqual(figures(f), { current: 10, reserved: 0, reflected: 10 }, "every issued carton is back");
  });
});

test("Q3. a mixed gatepass is in the store's queue until its QR part is scanned, then goes to the gate -- and the gate is told then, not before", async () => {
  await withFixture(async (f) => {
    const gate = gateUser(f);
    const qr = await stockQr(f, 3);
    stockManual(f, f.db, 10);
    const made = await makeGatepass(f, 5);
    const gatepassId = made.gatepassId!;
    bill(f, gatepassId);
    assert.equal(statusOf(f, gatepassId), "BILLED", "3 QR cartons unscanned: billing does not move it on");
    assert.deepEqual(inQueue(f, "BILLED", gatepassId), { listed: true, counted: 1 });
    await scanAgainst(f, qr[0]!, gatepassId);
    await scanAgainst(f, qr[1]!, gatepassId);
    assert.deepEqual(inQueue(f, "BILLED", gatepassId), { listed: true, counted: 1 }, "1 QR carton still to scan");
    assert.equal(atGateNotices(f, gate), 0, "the gate is not told before the store is done");
    assert.deepEqual(inQueue(f, "AT_GATE", gatepassId), { listed: false, counted: 0 });

    await scanAgainst(f, qr[2]!, gatepassId);
    assert.equal(statusOf(f, gatepassId), "AT_GATE");
    assert.equal(atGateNotices(f, gate), 1, "told once, by the last scan");
    assert.deepEqual(inQueue(f, "BILLED", gatepassId), { listed: false, counted: 0 });
    assert.deepEqual(inQueue(f, "AT_GATE", gatepassId), { listed: true, counted: 1 });
  });
});

test("Q5. a QR gatepass scanned out before it was billed goes to the gate on billing: in the gate's queue, the gate told once, and dispatch works", async () => {
  await withFixture(async (f) => {
    const store = storeUser(f);
    const gate = gateUser(f);
    const qr = await stockQr(f, 3);
    const made = await makeGatepass(f, 3);
    const gatepassId = made.gatepassId!;
    // The generic scanner, no gatepass named: each carton is attributed to the oldest open line.
    for (const id of qr) assert.equal((await scanOut(f, id)).gatepass?.code, made.code);
    assert.equal(statusOf(f, gatepassId), "CREATED", "a scan never moves an unbilled gatepass");

    const eventsBefore = count(f, "SELECT COUNT(1) AS n FROM production_events");
    bill(f, gatepassId);
    assert.equal(statusOf(f, gatepassId), "AT_GATE");
    assert.deepEqual(transitions(f, gatepassId), ["GATEPASS_BILLED", "GATEPASS_AT_GATE"]);
    assert.equal(count(f, "SELECT COUNT(1) AS n FROM production_events"), eventsBefore, "billing scanned nothing");
    assert.deepEqual(movements(f), [], "and moved no stock");
    assert.deepEqual(inQueue(f, "AT_GATE", gatepassId), { listed: true, counted: 1 });
    assert.deepEqual(inQueue(f, "BILLED", gatepassId), { listed: false, counted: 0 });
    assert.equal(atGateNotices(f, gate), 1, "the gate is told once");
    assert.equal(billedNotices(f, store), 0, "the store, which has nothing to do, is not");

    const session = f.db.getGatepassScanProgress(gatepassId)!.dispatchSessionId!;
    for (const id of qr) {
      const dispatched = await dispatcher(f.db).execute({ rawScan: id, sessionId: session, gatepassId, context: CONTEXT });
      assert.equal(dispatched.accepted, true, dispatched.reason);
    }
    assert.equal(statusOf(f, gatepassId), "DISPATCHED");
    assert.equal(atGateNotices(f, gate), 1);
  });
});

test("Q6. a mixed gatepass whose QR part was scanned before billing goes to the gate on billing, and the gate sees only its QR cartons", async () => {
  await withFixture(async (f) => {
    const gate = gateUser(f);
    const qr = await stockQr(f, 3);
    stockManual(f, f.db, 10);
    const made = await makeGatepass(f, 5);
    const gatepassId = made.gatepassId!;
    for (const id of qr) await scanOut(f, id);
    assert.deepEqual(line(f, gatepassId), { quantity: 5, scanned: 3, issued: 2, outstanding: 0 });

    bill(f, gatepassId);
    assert.equal(statusOf(f, gatepassId), "AT_GATE");
    assert.equal(atGateNotices(f, gate), 1);
    assert.deepEqual(inQueue(f, "AT_GATE", gatepassId), { listed: true, counted: 1 });
    const progress = f.db.getGatepassScanProgress(gatepassId)!;
    assert.deepEqual(
      [progress.requiredCartons, progress.issuedDirectlyCartons, progress.dispatchRemainingCartons],
      [5, 2, 3],
      "the gate is asked for the 3 QR cartons, never the 2 issued directly"
    );
    assert.deepEqual(movements(f), ["GATEPASS_ISSUE 2"], "billing moved no stock");
  });
});

test("L2. billing a QR-only gatepass leaves it Pending Store, and the store is told", async () => {
  await withFixture(async (f) => {
    const store = storeUser(f);
    await stockQr(f, 3);
    const made = await makeGatepass(f, 3);
    bill(f, made.gatepassId!);
    assert.equal(statusOf(f, made.gatepassId!), "BILLED");
    assert.equal(billedNotices(f, store), 1);
  });
});

test("L3, L4 & L12. a billed mixed gatepass waits for its QR cartons, goes to the gate on the last one, and on to DISPATCHED at the gate", async () => {
  await withFixture(async (f) => {
    const qr = await stockQr(f, 3);
    stockManual(f, f.db, 10);
    const made = await makeGatepass(f, 5);
    const gatepassId = made.gatepassId!;
    bill(f, gatepassId);
    assert.equal(statusOf(f, gatepassId), "BILLED", "3 QR cartons still to scan");
    await scanAgainst(f, qr[0]!, gatepassId);
    await scanAgainst(f, qr[1]!, gatepassId);
    assert.equal(statusOf(f, gatepassId), "BILLED", "partly scanned: still Pending Store");
    const last = await scanAgainst(f, qr[2]!, gatepassId);
    assert.equal(last.gatepassReachedGate, true);
    assert.equal(statusOf(f, gatepassId), "AT_GATE");

    const progress = f.db.getGatepassScanProgress(gatepassId)!;
    assert.deepEqual(
      [progress.issuedDirectlyCartons, progress.storeScannedCartons, progress.storeRemainingCartons, progress.dispatchRemainingCartons],
      [2, 3, 0, 3],
      "the gate is asked only for the 3 QR cartons"
    );
    for (const id of qr) {
      const dispatched = await dispatcher(f.db).execute({ rawScan: id, sessionId: progress.dispatchSessionId!, gatepassId, context: CONTEXT });
      assert.equal(dispatched.accepted, true, dispatched.reason);
    }
    assert.equal(statusOf(f, gatepassId), "DISPATCHED");
    assert.deepEqual(transitions(f, gatepassId), ["GATEPASS_BILLED", "GATEPASS_AT_GATE", "GATEPASS_DISPATCHED"]);
    assert.deepEqual(figures(f), { current: 8, reserved: 0, reflected: 8 }, "13 - 2 issued - 3 scanned, each once");
  });
});

test("L6. a repeat bill is refused: no second transition, no movement", async () => {
  await withFixture(async (f) => {
    stockManual(f, f.db, 10);
    const made = await makeGatepass(f, 4);
    bill(f, made.gatepassId!);
    assert.throws(() => bill(f, made.gatepassId!), /already has Sale Voucher/);
    assert.deepEqual(transitions(f, made.gatepassId!), ["GATEPASS_BILLED"]);
    assert.deepEqual(movements(f), ["GATEPASS_ISSUE 4"]);
  });
});

test("L7. cancelling a manual-only gatepass before it is billed puts its cartons back, once", async () => {
  await withFixture(async (f) => {
    stockManual(f, f.db, 10);
    const made = await makeGatepass(f, 4);
    const cancelled = await cancel(f, made.gatepassId!);
    assert.deepEqual([cancelled.releasedQuantity, cancelled.returnedToStockQuantity], [0, 4]);
    assert.equal((await cancel(f, made.gatepassId!)).outcome, "ALREADY_CANCELLED");
    assert.deepEqual(movements(f), ["GATEPASS_ISSUE 4", "GATEPASS_CANCEL 4"]);
    assert.deepEqual(figures(f), { current: 10, reserved: 0, reflected: 10 });
  });
});

test("L8. QR cartons a cancel released are reserved again by the next gatepass, never issued around", async () => {
  await withFixture(async (f) => {
    await stockQr(f, 3);
    stockManual(f, f.db, 5);
    const first = await makeGatepass(f, 3);
    await cancel(f, first.gatepassId!);
    const second = await makeGatepass(f, 3);
    assert.deepEqual(line(f, second.gatepassId!), { quantity: 3, scanned: 0, issued: 0, outstanding: 3 });
    assert.deepEqual(movements(f), [], "no carton left stock directly");
    assert.deepEqual(figures(f), { current: 8, reserved: 3, reflected: 5 });
  });
});

test("L9. a DELIVERED gatepass claims no QR cartons", async () => {
  await withFixture(async (f) => {
    const qr = await stockQr(f, 2);
    const first = await makeGatepass(f, 2);
    const gatepassId = first.gatepassId!;
    bill(f, gatepassId);
    for (const id of qr) await scanAgainst(f, id, gatepassId);
    const session = f.db.getGatepassScanProgress(gatepassId)!.dispatchSessionId!;
    for (const id of qr) await dispatcher(f.db).execute({ rawScan: id, sessionId: session, gatepassId, context: CONTEXT });
    f.db.saveGatepassDeliveryProof({ gatepassId, fileName: "proof.jpg", mimeType: "image/jpeg", byteSize: 2048, originalName: "b.jpg", uploadedBy: "driver" });
    assert.equal(statusOf(f, gatepassId), "DELIVERED");

    await stockQr(f, 2);
    stockManual(f, f.db, 4);
    const next = await makeGatepass(f, 2);
    assert.deepEqual(line(f, next.gatepassId!), { quantity: 2, scanned: 0, issued: 0, outstanding: 2 }, "both new QR cartons are free to reserve");
  });
});

test("L10. a carton brought back from the gate is still the gatepass's: it is not offered to the next one", async () => {
  await withFixture(async (f) => {
    const qr = await stockQr(f, 3);
    const first = await makeGatepass(f, 3);
    const gatepassId = first.gatepassId!;
    bill(f, gatepassId);
    for (const id of qr) await scanAgainst(f, id, gatepassId);
    const back = await receiver(f.db).execute({ rawScan: qr[0]!, context: CONTEXT, actor: "store-op" });
    assert.equal(back.accepted, true, back.reason);
    assert.deepEqual(line(f, gatepassId), { quantity: 3, scanned: 2, issued: 0, outstanding: 1 }, "it owes that carton again");

    stockManual(f, f.db, 4);
    const next = await makeGatepass(f, 2);
    assert.deepEqual(
      line(f, next.gatepassId!),
      { quantity: 2, scanned: 0, issued: 2, outstanding: 0 },
      "the one QR carton in the store is the first gatepass's, so the next is issued from manual stock"
    );
    assert.deepEqual(figures(f), { current: 3, reserved: 1, reflected: 2 }, "1 QR back + 4 manual - 2 issued");
  });
});

test("L11. two connections creating gatepasses at once never reserve the same QR cartons", async () => {
  await withFixture(async (f) => {
    const second = openDb(f.dbPath);
    try {
      await stockQr(f, 3);
      stockManual(f, f.db, 6);
      const results = await Promise.allSettled([makeGatepass(f, 3), makeGatepass(f, 3, second)]);
      const made = results.flatMap((r) => (r.status === "fulfilled" && r.value.accepted ? [r.value.gatepassId!] : []));
      assert.ok(made.length >= 1);
      const reserved = made.reduce((sum, id) => sum + Number(line(f, id).outstanding), 0);
      const issued = made.reduce((sum, id) => sum + Number(line(f, id).issued), 0);
      assert.equal(reserved, 3, "the 3 QR cartons are reserved once, by one gatepass");
      assert.equal(issued, 3 * made.length - 3, "anything beyond them was issued from manual stock");
      assert.deepEqual(figures(f), { current: 9 - issued, reserved: 3, reflected: 6 - issued });
    } finally {
      second.close();
    }
  });
});
