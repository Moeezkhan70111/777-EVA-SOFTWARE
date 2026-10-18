import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddMachineUseCase, InMemoryEventBus, ProcessScanUseCase, ReceiveProductionUseCase } from "@erp/application";
import { B_CARTON_COLOUR, CARTON_GRADE, RECEIVE_PRODUCTION_OUTCOME, RECEIVE_PRODUCTION_STATION, businessDateOf } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// RECEIVE PRODUCTION against a real database (Phase 2): a carton is produced once, and only if its
// QR was generated. Every count is read back from what was persisted.

type Raw = import("node:sqlite").DatabaseSync;
const CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };
const today = () => businessDateOf(new Date().toISOString());

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-receive-production-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "rp.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });
  const raw = (db as unknown as { db: Raw }).db;
  const scanDeps = {
    txManager: db, duplicateChecker: db, qrRegistry: db, productCatalog: db, qrMasterRepo: db,
    productionEventsRepo: db, stockProjectionRepo: db, outboxRepo: db,
    eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
  };
  const receiver = new ReceiveProductionUseCase(scanDeps);
  const receive = (rawScan: string, actor = "aslam") => receiver.execute({ rawScan, context: CONTEXT, actor });

  const product = (article: string, size: string): string => {
    const find = () =>
      raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ? AND deleted_at IS NULL LIMIT 1").get(article, size) as
        | { id: string }
        | undefined;
    if (!find()) db.createProduct({ article, size, sellingPrice: 550, status: "ACTIVE" });
    return find()!.id;
  };

  /** A machine with both contractors, so its runs open a program (Phase 1.1). */
  const machine = async (): Promise<string> => {
    const deps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() };
    const party = (name: string, mobile: string) => db.createParty({ partyName: name, partyType: "CONTRACTOR", city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
    const added = await new AddMachineUseCase(deps).execute({
      name: "Machine 1", contractorPartyId: party("ASLAM", "0300-1111111"), packingContractorPartyId: party("BABAR", "0300-2222222"), actor: "admin",
    });
    return added.machineId!;
  };

  const count = (sql: string, ...args: string[]): number => Number((raw.prepare(sql).get(...args) as { n: number }).n);
  const snapshot = () => ({
    produced: count("SELECT COUNT(*) AS n FROM production_events WHERE event_type = 'PRODUCED'"),
    units: count("SELECT COUNT(*) AS n FROM qr_master"),
    codes: count("SELECT COUNT(*) AS n FROM qr_codes"),
    batches: count("SELECT COUNT(*) AS n FROM qr_batches"),
    programs: count("SELECT COUNT(*) AS n FROM machine_programs"),
    stock: count("SELECT COALESCE(SUM(quantity_on_hand), 0) AS n FROM stock_projection_by_variant"),
  });

  return {
    db, raw, receive, receiver, scanDeps, product, machine, count, snapshot,
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

test("A: a generated carton QR is received once — one PRODUCED event, the unit, and today's list shows it", async () => {
  await withFixture(async (f) => {
    const machineId = await f.machine();
    const run = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "BLACKGREY", quantity: 2, machineId });
    const qrId = run.qrCodes[0].id;

    const result = await f.receive(qrId);
    assert.equal(result.outcome, RECEIVE_PRODUCTION_OUTCOME.RECEIVED, result.reason);
    assert.equal(result.qrId, qrId);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM production_events WHERE qr_id = ? AND event_type = 'PRODUCED'", qrId), 1);

    const receipt = f.db.findProductionReceipt(qrId);
    assert.equal(receipt?.article, "SK6");
    assert.equal(receipt?.size, "7/10");
    assert.equal(receipt?.color, "BLACKGREY");
    assert.equal(receipt?.stage, "PRODUCED");
    assert.equal(receipt?.receivedBy, "aslam");
    assert.equal(receipt?.station, RECEIVE_PRODUCTION_STATION);
    assert.match(receipt?.programCode ?? "", /^MP-\d{6}$/);
    assert.equal(receipt?.machineName, "MACHINE 1");

    const day = f.db.listProductionReceipts({ date: today() });
    assert.equal(day?.totalCartons, 1);
    assert.equal(day?.equivalentDozens, 0.5);
    assert.deepEqual(day?.rows.map((row) => row.qrId), [qrId]);
    assert.equal(f.db.findProductionReceipt(run.qrCodes[1].id), null, "the other carton is not received");
  });
});

test("B: a carton QR that was never generated is refused, and nothing is created or changed", async () => {
  await withFixture(async (f) => {
    const machineId = await f.machine();
    f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "BLACKGREY", quantity: 2, machineId });
    const before = f.snapshot();

    // Looks exactly like the real ones, one serial past what was generated.
    const result = await f.receive("SK6_BLACKGREY_7/10_000003");
    assert.equal(result.outcome, RECEIVE_PRODUCTION_OUTCOME.NOT_GENERATED);
    assert.equal(result.accepted, false);
    // And a product the Product Master has never heard of.
    assert.equal((await f.receive("ZZ9_RED_7/10_000001")).outcome, RECEIVE_PRODUCTION_OUTCOME.NOT_GENERATED);
    assert.deepEqual(f.snapshot(), before, "no receipt, unit, QR, run, program or stock was created");
  });
});

test("C: a raw material QR — even a real, registered one — is never a carton", async () => {
  await withFixture(async (f) => {
    const unitId = f.db.createInventoryUnit({ code: "DOZEN", name: "Dozen", unitFamily: "COUNT" });
    const supplier = f.db.createParty({ partyName: "SHEHZAD RUBBER", partyType: "SUPPLIER", city: "Lahore", mobileNumber: "0300-3333333", status: "ACTIVE" });
    const categoryId = f.db.createInventoryCategory({ name: "RUBBER UPPER" });
    f.db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "Article", fieldType: "TEXT", required: true, sortOrder: 1 });
    const { id: itemId } = f.db.createInventoryItem({ categoryId, values: { article: "SK6" }, unitId });
    const rawQr = f.db.generateRawMaterialQrBatch({ partyId: supplier, itemId, quantity: 1, packingQuantity: 5 }).qrCodes[0].id;
    const before = f.snapshot();

    const result = await f.receive(rawQr);
    assert.equal(result.outcome, RECEIVE_PRODUCTION_OUTCOME.RAW_MATERIAL_QR);
    assert.deepEqual(f.snapshot(), before);
  });
});

test("D: the same carton twice — one receipt, and the second says ALREADY RECEIVED", async () => {
  await withFixture(async (f) => {
    const run = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 1, machineId: await f.machine() });
    const qrId = run.qrCodes[0].id;
    assert.equal((await f.receive(qrId)).outcome, RECEIVE_PRODUCTION_OUTCOME.RECEIVED);
    const before = f.snapshot();

    const again = await f.receive(` ${qrId.toLowerCase()} `);
    assert.equal(again.outcome, RECEIVE_PRODUCTION_OUTCOME.ALREADY_RECEIVED, "case and spaces do not make it a new carton");
    assert.equal(again.accepted, false);
    assert.deepEqual(f.snapshot(), before);
  });
});

test("D: a carton produced at another station (Live Production) is already received here", async () => {
  await withFixture(async (f) => {
    const run = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 1, machineId: await f.machine() });
    const live = new ProcessScanUseCase(f.scanDeps);
    assert.equal((await live.execute({ rawScan: run.qrCodes[0].id, context: CONTEXT })).accepted, true);
    assert.equal((await f.receive(run.qrCodes[0].id)).outcome, RECEIVE_PRODUCTION_OUTCOME.ALREADY_RECEIVED);
  });
});

test("F: consecutive scans of distinct cartons are each recorded once, and the day's totals add up", async () => {
  await withFixture(async (f) => {
    const machineId = await f.machine();
    const black = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "BLACK", quantity: 6, machineId });
    const b = f.db.generateQrBatch({ articleSizeId: f.product("EVR9", "7/10"), color: B_CARTON_COLOUR, quantity: 2, grade: CARTON_GRADE.B, machineId });
    const ids = [...black.qrCodes, ...b.qrCodes].map((code) => code.id);

    for (const id of ids) assert.equal((await f.receive(id)).outcome, RECEIVE_PRODUCTION_OUTCOME.RECEIVED);

    const day = f.db.listProductionReceipts({ date: today(), pageSize: 5 });
    assert.equal(day?.totalCartons, 8);
    assert.equal(day?.equivalentDozens, 4);
    assert.equal(day?.rows.length, 5, "one page at a time");
    assert.equal(f.db.listProductionReceipts({ date: today(), pageSize: 5, page: 2 })?.rows.length, 3);
    assert.equal(f.db.findProductionReceipt(b.qrCodes[0].id)?.grade, CARTON_GRADE.B);
  });
});

test("the day's summary adds the whole day up per article, size and colour — not just one page", async () => {
  await withFixture(async (f) => {
    const machineId = await f.machine();
    const red = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 20, machineId });
    const black = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "4/6"), color: "BLACK", quantity: 40, machineId });
    const b = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "4/6"), color: B_CARTON_COLOUR, quantity: 2, grade: CARTON_GRADE.B, machineId });
    for (const code of [...red.qrCodes, ...black.qrCodes, ...b.qrCodes]) await f.receive(code.id);
    await f.receive(red.qrCodes[0].id); // a repeat scan adds nothing

    const day = f.db.listProductionReceipts({ date: today(), pageSize: 5 });
    assert.equal(day?.rows.length, 5, "the details are paged");
    assert.deepEqual(
      day?.summary.map((line) => [line.article, line.size, line.color, line.grade, line.cartons, line.equivalentDozens]),
      [
        ["SK6", "4/6", "BLACK", null, 40, 20],
        ["SK6", "4/6", "MIX", "B", 2, 1],
        ["SK6", "7/10", "RED", null, 20, 10],
      ]
    );
    assert.equal(day?.totalCartons, 62);
    assert.equal(day?.equivalentDozens, 31);
  });
});

test("G: a voided carton QR is ineligible, and nothing is recorded", async () => {
  await withFixture(async (f) => {
    const run = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 2, machineId: await f.machine() });
    f.db.voidQrCode({ qrId: run.qrCodes[1].id, reason: "Label torn", actor: "admin" });
    const before = f.snapshot();

    const result = await f.receive(run.qrCodes[1].id);
    assert.equal(result.outcome, RECEIVE_PRODUCTION_OUTCOME.INELIGIBLE);
    assert.match(result.reason ?? "", /voided/i);
    assert.deepEqual(f.snapshot(), before);
  });
});

test("H: the same carton scanned at the same instant from two stations — exactly one receipt", async () => {
  await withFixture(async (f) => {
    const run = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 1, machineId: await f.machine() });
    const qrId = run.qrCodes[0].id;

    const results = await Promise.all([f.receive(qrId, "aslam"), f.receive(qrId, "babar"), f.receive(qrId, "khan")]);
    const outcomes = results.map((result) => result.outcome).sort();
    assert.deepEqual(outcomes, [
      RECEIVE_PRODUCTION_OUTCOME.ALREADY_RECEIVED,
      RECEIVE_PRODUCTION_OUTCOME.ALREADY_RECEIVED,
      RECEIVE_PRODUCTION_OUTCOME.RECEIVED,
    ]);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM production_events WHERE qr_id = ? AND event_type = 'PRODUCED'", qrId), 1);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM qr_master WHERE qr_id = ?", qrId), 1);
  });
});

test("I: a receipt that fails part-way leaves nothing, and the retry records it exactly once", async () => {
  await withFixture(async (f) => {
    const run = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 1, machineId: await f.machine() });
    const qrId = run.qrCodes[0].id;
    const before = f.snapshot();

    // The stock projection fails after the unit and the PRODUCED event were written.
    const failing = new ReceiveProductionUseCase({
      ...f.scanDeps,
      stockProjectionRepo: { incrementProduced: async () => { throw new Error("disk I/O error"); } } as unknown as typeof f.scanDeps.stockProjectionRepo,
    });
    await assert.rejects(() => failing.execute({ rawScan: qrId, context: CONTEXT, actor: "aslam" }), /disk I\/O error/);
    assert.deepEqual(f.snapshot(), before, "the whole receipt rolled back");
    assert.equal(f.db.findProductionReceipt(qrId), null, "the authoritative answer: not received");

    assert.equal((await f.receive(qrId)).outcome, RECEIVE_PRODUCTION_OUTCOME.RECEIVED);
    assert.equal((await f.receive(qrId)).outcome, RECEIVE_PRODUCTION_OUTCOME.ALREADY_RECEIVED);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM production_events WHERE qr_id = ? AND event_type = 'PRODUCED'", qrId), 1);
  });
});

test("malformed input is an invalid QR, never a lookup", async () => {
  await withFixture(async (f) => {
    const before = f.snapshot();
    for (const value of ["", "   ", "HELLO", "SK6-RED-7/10-000001"]) {
      assert.equal((await f.receive(value)).outcome, RECEIVE_PRODUCTION_OUTCOME.INVALID_QR, `"${value}"`);
    }
    assert.deepEqual(f.snapshot(), before);
  });
});

test("K: receiving changes no Machine Program figure and opens no program", async () => {
  await withFixture(async (f) => {
    const run = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "BLACKGREY", quantity: 10, machineId: await f.machine() });
    const programsBefore = f.db.listMachineDayPrograms(today());
    for (const code of run.qrCodes.slice(0, 4)) await f.receive(code.id);

    assert.deepEqual(f.db.listMachineDayPrograms(today()), programsBefore);
    assert.equal(programsBefore[0].cartons, 10);
    assert.equal(programsBefore[0].equivalentDozens, 5);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM machine_programs"), 1);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM qr_codes"), 10, "no QR is made by receiving");
  });
});
