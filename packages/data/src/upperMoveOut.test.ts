import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InMemoryEventBus,
  IssueRawMaterialScanUseCase,
  ReceiveRawMaterialScanUseCase,
  UpperMoveOutUseCase,
} from "@erp/application";
import { UPPER_ISSUE_OUTCOME, businessDateOf } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// UPPER MOVE OUT against a real database (Phase 3). Uppers are labelled raw material packets, put in
// the store by Raw Material Input exactly as the floor does it; every figure is read back from what
// was persisted.

type Raw = import("node:sqlite").DatabaseSync;
const CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };
const today = () => businessDateOf(new Date().toISOString());

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-upper-move-out-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "u.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });
  const raw = (db as unknown as { db: Raw }).db;
  const deps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() };
  const upperOut = new UpperMoveOutUseCase(deps);

  const dozen = db.createInventoryUnit({ code: "DOZEN", name: "Dozen", unitFamily: "COUNT" });
  const supplier = db.createParty({ partyName: "SHEHZAD RUBBER", partyType: "SUPPLIER", city: "Lahore", mobileNumber: "0300-1111111", status: "ACTIVE" });

  /** A material in a category under a top-level one, with article / color / size fields. */
  const category = (top: string, sub: string) => {
    const parent = db.createInventoryCategory({ name: top });
    const id = db.createInventoryCategory({ name: sub, parentId: parent });
    ["article", "color", "size"].forEach((fieldKey, index) =>
      db.addInventoryCategoryField({ categoryId: id, fieldKey, label: fieldKey.toUpperCase(), fieldType: "TEXT", required: false, sortOrder: index + 1 })
    );
    return id;
  };
  const upperCategory = category("UPPER", "RUBBER UPPER");
  // A labelled raw material that is not an upper (Dana cannot be labelled at all).
  const otherCategory = category("PACKING MATERIAL", "POLY BAG");
  const material = (categoryId: string, values: Record<string, string>, packetHolds = 5) => {
    const { id } = db.createInventoryItem({ categoryId, values, unitId: dozen });
    db.setRawMaterialMovementConfig(id, { packName: "PACKET", packingQuantity: packetHolds, packingUnitId: dozen });
    return id;
  };

  /** Labels `count` packets and receives every one into the store, as Raw Material Input does. */
  const stockIn = async (itemId: string, count: number): Promise<string[]> => {
    const ids = db.generateRawMaterialQrBatch({ partyId: supplier, itemId, quantity: count, packingQuantity: 5 }).qrCodes.map((code) => code.id);
    const session = db.startRawMaterialReceivingSession({ partyId: supplier, deviceId: "device-1", startedBy: "store" });
    const receive = new ReceiveRawMaterialScanUseCase(deps);
    for (const id of ids) {
      const result = await receive.execute({ rawScan: id, partyId: supplier, sessionId: session.id, context: CONTEXT, actor: "store" });
      assert.equal(result.accepted, true, result.reason);
    }
    db.closeRawMaterialReceivingSession(session.id);
    return ids;
  };

  const machine = (name: string) => db.createMachine({ name }).id;
  const session = () => db.startOrResumeRawMaterialIssueSession({ deviceId: "device-1", startedBy: "store" }).id;
  const issue = (rawScan: string, machineId: string, actor = "aslam") =>
    upperOut.execute({ rawScan, machineId, sessionId: session(), context: CONTEXT, actor });

  const onHand = (itemId: string): number =>
    Number((raw.prepare("SELECT COALESCE(SUM(quantity_on_hand), 0) AS n FROM inventory_stock_balances WHERE item_id = ?").get(itemId) as { n: number }).n);
  const count = (sql: string, ...args: string[]): number => Number((raw.prepare(sql).get(...args) as { n: number }).n);
  const exits = () => count("SELECT COUNT(*) AS n FROM raw_material_qr_events WHERE event_type = 'STORE_EXIT'");

  return {
    db, raw, deps, upperOut, upperCategory, otherCategory, material, stockIn, machine, session, issue, onHand, count, exits,
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

test("A: without a machine nothing is issued and the stock is unchanged", async () => {
  await withFixture(async (f) => {
    const red = f.material(f.upperCategory, { article: "SK6", color: "RED", size: "7/10" });
    const [qr] = await f.stockIn(red, 1);
    const result = await f.issue(qr, "");
    assert.equal(result.outcome, UPPER_ISSUE_OUTCOME.MACHINE_REQUIRED);
    assert.equal(f.onHand(red), 5);
    assert.equal(f.exits(), 0);
  });
});

test("B: an upper packet issued to a machine — one exit stamped with the machine, stock down by the packet, once", async () => {
  await withFixture(async (f) => {
    const red = f.material(f.upperCategory, { article: "SK6", color: "RED", size: "7/10" });
    const [qr] = await f.stockIn(red, 2);
    const m1 = f.machine("Machine 1");

    const result = await f.issue(qr, m1);
    assert.equal(result.outcome, UPPER_ISSUE_OUTCOME.ISSUED, result.reason);
    assert.equal(f.onHand(red), 5, "10 DOZEN in, one packet of 5 DOZEN out");
    const event = f.raw.prepare("SELECT machine_id, actor, quantity, session_id FROM raw_material_qr_events WHERE id = ?").get(result.eventId!) as Record<string, unknown>;
    assert.equal(event.machine_id, m1);
    assert.equal(event.actor, "aslam");
    assert.equal(event.quantity, 5);
    assert.ok(event.session_id, "the device's issue session is reused");
    assert.equal(f.count("SELECT COUNT(*) AS n FROM raw_material_qrs WHERE id = ? AND current_status = 'ISSUED'", qr), 1);

    const page = f.db.listUpperIssues({ machineId: m1, date: today() });
    assert.equal(page?.rows.length, 1);
    assert.deepEqual(
      [page?.rows[0].qrId, page?.rows[0].article, page?.rows[0].size, page?.rows[0].colour, page?.rows[0].quantity, page?.rows[0].unitCode, page?.rows[0].machineName],
      [qr, "SK6", "7/10", "RED", 5, "DOZEN", "MACHINE 1"]
    );
    assert.deepEqual(page?.totals, { packets: 1, quantities: [{ unitCode: "DOZEN", quantity: 5 }] });
    assert.equal(f.db.findUpperIssue(qr.toLowerCase())?.machineName, "MACHINE 1", "J: the issue is read back from the database");
    assert.equal(f.db.currentUpperIssueSessionId("device-1"), event.session_id);
  });
});

test("C: a fabricated upper QR changes nothing", async () => {
  await withFixture(async (f) => {
    const red = f.material(f.upperCategory, { article: "SK6", color: "RED", size: "7/10" });
    const [qr] = await f.stockIn(red, 1);
    const fake = qr.replace(/\d+$/, "000999");
    const result = await f.issue(fake, f.machine("Machine 1"));
    assert.equal(result.outcome, UPPER_ISSUE_OUTCOME.UNKNOWN_QR);
    assert.equal(f.onHand(red), 5);
    assert.equal(f.exits(), 0);
    assert.equal((await f.issue("HELLO", f.machine("Machine 2"))).outcome, UPPER_ISSUE_OUTCOME.INVALID_QR);
  });
});

test("D: a finished carton QR, or raw material that is not an upper, is refused", async () => {
  await withFixture(async (f) => {
    const m1 = f.machine("Machine 1");
    f.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, status: "ACTIVE" });
    const articleSizeId = (f.raw.prepare("SELECT id FROM article_sizes LIMIT 1").get() as { id: string }).id;
    const carton = f.db.generateQrBatch({ articleSizeId, color: "RED", quantity: 1 }).qrCodes[0].id;
    assert.equal((await f.issue(carton, m1)).outcome, UPPER_ISSUE_OUTCOME.FINISHED_CARTON);

    const poly = f.material(f.otherCategory, { color: "CLEAR" });
    const [bag] = await f.stockIn(poly, 1);
    const result = await f.issue(bag, m1);
    assert.equal(result.outcome, UPPER_ISSUE_OUTCOME.NOT_UPPER);
    assert.equal(f.onHand(poly), 5);
    assert.equal(f.exits(), 0);
  });
});

test("E: the same packet twice — stock goes down once, and the second says ALREADY ISSUED", async () => {
  await withFixture(async (f) => {
    const red = f.material(f.upperCategory, { article: "SK6", color: "RED", size: "7/10" });
    const [qr] = await f.stockIn(red, 2);
    const m1 = f.machine("Machine 1");
    assert.equal((await f.issue(qr, m1)).outcome, UPPER_ISSUE_OUTCOME.ISSUED);
    const again = await f.issue(qr.toLowerCase(), m1);
    assert.equal(again.outcome, UPPER_ISSUE_OUTCOME.ALREADY_ISSUED);
    assert.equal(f.onHand(red), 5);
    assert.equal(f.exits(), 1);
  });
});

test("F: the same packet issued at the same instant from two stations, to two machines — exactly one issue", async () => {
  await withFixture(async (f) => {
    const red = f.material(f.upperCategory, { article: "SK6", color: "RED", size: "7/10" });
    const [qr] = await f.stockIn(red, 1);
    const m1 = f.machine("Machine 1");
    const m2 = f.machine("Machine 2");
    const results = await Promise.all([f.issue(qr, m1), f.issue(qr, m2), f.issue(qr, m1)]);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ["ALREADY_ISSUED", "ALREADY_ISSUED", "ISSUED"]);
    assert.equal(f.onHand(red), 0, "never below zero");
    assert.equal(f.exits(), 1);
  });
});

test("F: a balance that does not cover the packet refuses it — stock never goes negative", async () => {
  await withFixture(async (f) => {
    const red = f.material(f.upperCategory, { article: "SK6", color: "RED", size: "7/10" });
    const [first, second] = await f.stockIn(red, 2);
    // An approved count correction took the balance down to what one packet holds.
    f.raw.prepare("UPDATE inventory_stock_balances SET quantity_on_hand = 5 WHERE item_id = ?").run(red);
    const m1 = f.machine("Machine 1");
    assert.equal((await f.issue(first, m1)).outcome, UPPER_ISSUE_OUTCOME.ISSUED);
    const short = await f.issue(second, m1);
    assert.equal(short.outcome, UPPER_ISSUE_OUTCOME.INSUFFICIENT_STOCK);
    assert.equal(f.onHand(red), 0);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM raw_material_qrs WHERE id = ? AND current_status = 'IN_STORE'", second), 1, "the packet stays in the store");
    assert.equal(f.exits(), 1);
  });
});

test("G: a retired or unknown machine is refused by the main process, whatever the screen sent", async () => {
  await withFixture(async (f) => {
    const red = f.material(f.upperCategory, { article: "SK6", color: "RED", size: "7/10" });
    const [qr] = await f.stockIn(red, 1);
    assert.equal((await f.issue(qr, "no-such-machine")).outcome, UPPER_ISSUE_OUTCOME.MACHINE_INELIGIBLE);
    const retired = f.machine("Machine 9");
    f.db.setMachineStatus(retired, "INACTIVE");
    assert.equal((await f.issue(qr, retired)).outcome, UPPER_ISSUE_OUTCOME.MACHINE_INELIGIBLE);
    assert.equal(f.onHand(red), 5);
    assert.equal(f.exits(), 0);
  });
});

test("H: issues to Machine 1 stay Machine 1's after switching to Machine 2", async () => {
  await withFixture(async (f) => {
    const red = f.material(f.upperCategory, { article: "SK6", color: "RED", size: "7/10" });
    const qrs = await f.stockIn(red, 5);
    const m1 = f.machine("Machine 1");
    const m2 = f.machine("Machine 2");
    for (const qr of qrs.slice(0, 2)) await f.issue(qr, m1);
    for (const qr of qrs.slice(2)) await f.issue(qr, m2);

    assert.deepEqual(f.db.listUpperIssues({ machineId: m1, date: today() })?.rows.map((row) => row.qrId).sort(), qrs.slice(0, 2).sort());
    assert.deepEqual(f.db.listUpperIssues({ machineId: m2, date: today() })?.rows.map((row) => row.qrId).sort(), qrs.slice(2).sort());
    const summary = f.db.getUpperIssueSummary({ machineId: m1, sessionId: f.session(), date: today() });
    assert.equal(summary?.session.packets, 2);
    assert.deepEqual(summary?.day.quantities, [{ unitCode: "DOZEN", quantity: 10 }]);
    assert.equal(f.db.getUpperIssueSummary({ machineId: m2, sessionId: f.session(), date: today() })?.day.packets, 3);
  });
});

test("I: upper stock is the balance — uppers only, down by what was issued, once", async () => {
  await withFixture(async (f) => {
    const red = f.material(f.upperCategory, { article: "SK6", color: "RED", size: "7/10" });
    const black = f.material(f.upperCategory, { article: "SK30", color: "BLACK", size: "1/6" });
    const poly = f.material(f.otherCategory, { color: "CLEAR" });
    const redQrs = await f.stockIn(red, 3);
    await f.stockIn(black, 1);
    await f.stockIn(poly, 2);
    await f.issue(redQrs[0], f.machine("Machine 1"));

    const stock = f.db.listUpperStock();
    assert.deepEqual(
      stock.map((row) => [row.article, row.size, row.colour, row.onHand, row.unitCode, row.packetsInStore]),
      [
        ["SK30", "1/6", "BLACK", 5, "DOZEN", 1],
        ["SK6", "7/10", "RED", 10, "DOZEN", 2],
      ],
      "packing material is not an upper"
    );
    assert.deepEqual(f.db.listUpperStock({ search: "red sk6" }).map((row) => row.article), ["SK6"]);
    assert.deepEqual(f.db.listUpperStock({ search: "1/6" }).map((row) => row.article), ["SK30"]);

    const summary = f.db.getUpperIssueSummary({ machineId: f.machine("Machine 2"), sessionId: null, date: today() });
    assert.deepEqual(summary?.stock, { packets: 3, quantities: [{ unitCode: "DOZEN", quantity: 15 }] });
    assert.equal(summary?.session.packets, 0);
  });
});

test("K: the generic Raw Material Output scanner still issues every category, and names no machine", async () => {
  await withFixture(async (f) => {
    const poly = f.material(f.otherCategory, { color: "CLEAR" });
    const red = f.material(f.upperCategory, { article: "SK6", color: "RED", size: "7/10" });
    const [bag] = await f.stockIn(poly, 1);
    const [packet] = await f.stockIn(red, 1);
    const generic = new IssueRawMaterialScanUseCase(f.deps);
    for (const qr of [bag, packet]) {
      const result = await generic.execute({ rawScan: qr, sessionId: f.session(), context: CONTEXT, actor: "store" });
      assert.equal(result.outcome, "ISSUED", result.reason);
    }
    assert.equal(f.onHand(poly), 0);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM raw_material_qr_events WHERE event_type = 'STORE_EXIT' AND machine_id IS NOT NULL"), 0);
  });
});

test("M: a failure after the status moved rolls the whole issue back, and the retry issues it once", async () => {
  await withFixture(async (f) => {
    const red = f.material(f.upperCategory, { article: "SK6", color: "RED", size: "7/10" });
    const [qr] = await f.stockIn(red, 1);
    const m1 = f.machine("Machine 1");
    const failing = new UpperMoveOutUseCase({
      ...f.deps,
      repo: Object.assign(Object.create(f.db), {
        appendRawMaterialQrEvent: () => {
          throw new Error("disk I/O error");
        },
      }) as typeof f.db,
    });
    await assert.rejects(() => failing.execute({ rawScan: qr, machineId: m1, sessionId: f.session(), context: CONTEXT, actor: "aslam" }), /disk I\/O error/);
    assert.equal(f.onHand(red), 5, "the stock debit rolled back");
    assert.equal(f.count("SELECT COUNT(*) AS n FROM raw_material_qrs WHERE id = ? AND current_status = 'IN_STORE'", qr), 1, "the packet is still in the store");
    assert.equal(f.exits(), 0);

    assert.equal((await f.issue(qr, m1)).outcome, UPPER_ISSUE_OUTCOME.ISSUED);
    assert.equal((await f.issue(qr, m1)).outcome, UPPER_ISSUE_OUTCOME.ALREADY_ISSUED);
    assert.equal(f.onHand(red), 0);
    assert.equal(f.exits(), 1);
  });
});
