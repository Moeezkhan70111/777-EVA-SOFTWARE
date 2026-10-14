import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AddMachineUseCase,
  InMemoryEventBus,
  ReceiveProductionUseCase,
  ReceiveRawMaterialScanUseCase,
  UpperMoveOutUseCase,
} from "@erp/application";
import { B_CARTON_COLOUR, CARTON_GRADE, businessDateOf } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// RECONCILIATION against a real database (Phase 4): uppers really issued on Upper Move Out, cartons
// really generated in the QR Generator and received on Receive Production — and the figures read back.

type Raw = import("node:sqlite").DatabaseSync;
const CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };
const today = () => businessDateOf(new Date().toISOString());

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-reconciliation-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "r.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.ensureOperationalContext({
    factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });
  const raw = (db as unknown as { db: Raw }).db;
  const deps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() };
  const scanDeps = {
    txManager: db, duplicateChecker: db, qrRegistry: db, productCatalog: db, qrMasterRepo: db,
    productionEventsRepo: db, stockProjectionRepo: db, outboxRepo: db,
    eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
  };
  const receiver = new ReceiveProductionUseCase(scanDeps);
  const upperOut = new UpperMoveOutUseCase(deps);

  const party = (name: string, type: string, mobile: string) => db.createParty({ partyName: name, partyType: type, city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
  const aslam = party("ASLAM", "CONTRACTOR", "0300-1111111");
  const babar = party("BABAR", "CONTRACTOR", "0300-2222222");
  const supplier = party("SHEHZAD RUBBER", "SUPPLIER", "0300-3333333");
  const machine = async (name: string): Promise<string> =>
    (await new AddMachineUseCase(deps).execute({ name, contractorPartyId: aslam, packingContractorPartyId: babar, actor: "admin" })).machineId!;

  const product = (article: string, size: string): string => {
    const find = () => raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ?").get(article, size) as { id: string } | undefined;
    if (!find()) db.createProduct({ article, size, sellingPrice: 550, status: "ACTIVE" });
    return find()!.id;
  };

  const units = new Map<string, string>();
  const unit = (code: string) => {
    if (!units.has(code)) units.set(code, db.createInventoryUnit({ code, name: code, unitFamily: "COUNT" }));
    return units.get(code)!;
  };
  const upperTop = db.createInventoryCategory({ name: "UPPER" });
  const upperCategory = db.createInventoryCategory({ name: "RUBBER UPPER", parentId: upperTop });
  db.addInventoryCategoryField({ categoryId: upperCategory, fieldKey: "article", label: "ARTICLE", fieldType: "TEXT", required: false, sortOrder: 1 });
  /** An upper material whose packets hold `holds` of `unitCode`. */
  const upper = (article: string, holds = 5, unitCode = "DOZEN") => {
    const { id } = db.createInventoryItem({ categoryId: upperCategory, values: { article }, unitId: unit(unitCode) });
    db.setRawMaterialMovementConfig(id, { packName: "PACKET", packingQuantity: holds, packingUnitId: unit(unitCode) });
    return id;
  };
  /** Labels and receives `count` packets into the store. */
  const stockIn = async (itemId: string, count: number, holds = 5): Promise<string[]> => {
    const ids = db.generateRawMaterialQrBatch({ partyId: supplier, itemId, quantity: count, packingQuantity: holds }).qrCodes.map((code) => code.id);
    const session = db.startRawMaterialReceivingSession({ partyId: supplier, deviceId: "device-1", startedBy: "store" });
    const receive = new ReceiveRawMaterialScanUseCase(deps);
    for (const id of ids) assert.equal((await receive.execute({ rawScan: id, partyId: supplier, sessionId: session.id, context: CONTEXT, actor: "store" })).accepted, true);
    db.closeRawMaterialReceivingSession(session.id);
    return ids;
  };
  const issueTo = async (machineId: string, qrIds: string[]) => {
    const sessionId = db.startOrResumeRawMaterialIssueSession({ deviceId: "device-1", startedBy: "store" }).id;
    for (const qr of qrIds) assert.equal((await upperOut.execute({ rawScan: qr, machineId, sessionId, context: CONTEXT, actor: "store" })).outcome, "ISSUED");
  };
  const receive = async (qrIds: string[]) => {
    for (const qr of qrIds) await receiver.execute({ rawScan: qr, context: CONTEXT, actor: "aslam" });
  };
  const programOf = (machineId: string) => db.listReconcilablePrograms(today()).find((program) => program.machineId === machineId)!;

  return {
    db, raw, machine, product, upper, stockIn, issueTo, receive, programOf,
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

test("one program: uppers issued to its machine on its day against its cartons received, in dozens", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const cartons = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 30, machineId: m1 });
    const packets = await f.stockIn(f.upper("SK6"), 4);
    await f.issueTo(m1, packets);
    await f.receive(cartons.qrCodes.slice(0, 23).map((code) => code.id));

    const result = f.db.getProgramReconciliation(f.programOf(m1).programId)!;
    assert.equal(result.program.machineName, "MACHINE 1");
    assert.match(result.program.code, /^MP-\d{6}$/);
    assert.deepEqual(result.upperOut, { packets: 4, quantities: [{ unitCode: "DOZEN", quantity: 20 }] });
    assert.deepEqual(result.productionReceived, { cartons: 23, bCartons: 0 });
    assert.deepEqual(result.comparison, { upperDozens: 20, otherUpper: [], receivedDozens: 11.5, comparable: true, differenceDozens: 8.5 });
  });
});

test("two programs never mix: another machine the same day, and the same machine on another day", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const m2 = await f.machine("Machine 2");
    const c1 = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 10, machineId: m1 });
    const c2 = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 10, machineId: m2 });
    const packets = await f.stockIn(f.upper("SK6"), 5);
    await f.issueTo(m1, packets.slice(0, 2));
    await f.issueTo(m2, packets.slice(2, 4));
    await f.issueTo(m1, packets.slice(4));
    await f.receive(c1.qrCodes.slice(0, 4).map((code) => code.id));
    await f.receive(c2.qrCodes.slice(0, 6).map((code) => code.id));
    // Machine 1's last issue happened YESTERDAY — it belongs to yesterday's program, not today's.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    f.raw.prepare("UPDATE raw_material_qr_events SET event_ts_local = ?, event_date = ? WHERE event_type = 'STORE_EXIT' AND qr_id = ?").run(yesterday, yesterday.slice(0, 10), packets[4]);

    const one = f.db.getProgramReconciliation(f.programOf(m1).programId)!;
    const two = f.db.getProgramReconciliation(f.programOf(m2).programId)!;
    assert.deepEqual([one.upperOut.packets, one.productionReceived.cartons], [2, 4]);
    assert.deepEqual([two.upperOut.packets, two.productionReceived.cartons], [2, 6]);
    assert.deepEqual(f.db.listReconcilablePrograms(today()).map((program) => program.machineName), ["MACHINE 1", "MACHINE 2"]);
  });
});

test("either side empty is zero, not missing", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 4, machineId: m1 });
    const result = f.db.getProgramReconciliation(f.programOf(m1).programId)!;
    assert.deepEqual(result.upperOut, { packets: 0, quantities: [] });
    assert.deepEqual(result.productionReceived, { cartons: 0, bCartons: 0 });
    assert.equal(result.comparison.differenceDozens, 0);
    assert.equal(f.db.getProgramReconciliation("no-such-program"), null);
  });
});

test("an upper counted in PAIR is shown as it is and never converted — no difference is given", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 4, machineId: m1 });
    await f.issueTo(m1, await f.stockIn(f.upper("SK6"), 1));
    await f.issueTo(m1, await f.stockIn(f.upper("SK9", 24, "PAIR"), 1, 24));
    const result = f.db.getProgramReconciliation(f.programOf(m1).programId)!;
    assert.deepEqual(result.upperOut.quantities, [{ unitCode: "DOZEN", quantity: 5 }, { unitCode: "PAIR", quantity: 24 }]);
    assert.equal(result.comparison.comparable, false);
    assert.equal(result.comparison.differenceDozens, null);
  });
});

test("repeated scans count once, and B cartons are received production of the program", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const cartons = f.db.generateQrBatch({ articleSizeId: f.product("EVR9", "7/10"), color: "BLACK", quantity: 4, machineId: m1 });
    const b = f.db.generateQrBatch({ articleSizeId: f.product("EVR9", "7/10"), color: B_CARTON_COLOUR, quantity: 2, grade: CARTON_GRADE.B, machineId: m1 });
    const packets = await f.stockIn(f.upper("EVR9"), 1);
    const ids = [...cartons.qrCodes, ...b.qrCodes].map((code) => code.id);
    await f.receive([...ids, ...ids]); // every carton scanned twice
    await f.issueTo(m1, packets);
    const sessionId = f.db.startOrResumeRawMaterialIssueSession({ deviceId: "device-1", startedBy: "store" }).id;
    const again = await new UpperMoveOutUseCase({ txManager: f.db, repo: f.db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() })
      .execute({ rawScan: packets[0], machineId: m1, sessionId, context: CONTEXT, actor: "store" });
    assert.equal(again.outcome, "ALREADY_ISSUED");

    const result = f.db.getProgramReconciliation(f.programOf(m1).programId)!;
    assert.deepEqual(result.productionReceived, { cartons: 6, bCartons: 2 });
    assert.equal(result.upperOut.packets, 1);
    assert.equal(result.comparison.receivedDozens, 3);
  });
});

test("an issue that is both on the program's machine and against one of its own upper lines counts once", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 4, machineId: m1 });
    const item = f.upper("SK6");
    await f.issueTo(m1, await f.stockIn(item, 1));
    const program = f.programOf(m1);
    // The retired workflow's link: a run and an upper line of this program, stamped on the same exit.
    const now = new Date().toISOString();
    f.raw.exec("PRAGMA foreign_keys = OFF");
    f.raw.prepare("INSERT INTO machine_program_runs (id, program_id, injector_no, run_no, sole_colour, article_size_id, created_at, updated_at) VALUES ('run-1', ?, 1, 1, 'BLACK', ?, ?, ?)").run(program.programId, f.product("SK6", "7/10"), now, now);
    f.raw.prepare("INSERT INTO machine_program_upper_lines (id, run_id, line_no, item_id, quantity, unit_id, created_at, updated_at) VALUES ('line-1', 'run-1', 1, ?, 5, 'u', ?, ?)").run(item, now, now);
    f.raw.exec("PRAGMA foreign_keys = ON");
    f.raw.prepare("UPDATE raw_material_qr_events SET machine_program_upper_line_id = 'line-1' WHERE event_type = 'STORE_EXIT'").run();

    assert.equal(f.db.getProgramReconciliation(program.programId)!.upperOut.packets, 1);
  });
});

test("reading a reconciliation changes nothing", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const cartons = f.db.generateQrBatch({ articleSizeId: f.product("SK6", "7/10"), color: "RED", quantity: 4, machineId: m1 });
    await f.receive([cartons.qrCodes[0].id]);
    const count = () => (f.raw.prepare("SELECT (SELECT COUNT(*) FROM production_events) + (SELECT COUNT(*) FROM raw_material_qr_events) + (SELECT COUNT(*) FROM inventory_stock_events) AS n").get() as { n: number }).n;
    const before = count();
    for (let i = 0; i < 3; i += 1) f.db.getProgramReconciliation(f.programOf(m1).programId);
    assert.equal(count(), before);
  });
});
