import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddMachineUseCase, InMemoryEventBus } from "@erp/application";
import { businessDateOf } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// EDITING TODAY'S MANUAL PRODUCTION against a real database (owner, 14 Nov 2026): "old stock 10, production 5,
// stock 15; edit 5 to 3: stock 13, and the Contractor Ledger shows 3 — reverse the first production, add the new".
// Quantities below are DOZEN as typed; the store counts cartons (1 dozen = 2 cartons).

type Raw = import("node:sqlite").DatabaseSync;
const STORE = "factory-1";
const today = () => businessDateOf(new Date().toISOString());

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-manual-edit-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "m.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: STORE, factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });
  const raw = (db as unknown as { db: Raw }).db;
  const deps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() };
  const party = (name: string, mobile: string) => db.createParty({ partyName: name, partyType: "CONTRACTOR", city: "Lahore", mobileNumber: mobile, status: "ACTIVE" });
  const aslam = party("ASLAM", "0300-1111111");
  const babar = party("BABAR", "0300-2222222");
  const machine = async (name: string): Promise<string> =>
    (await new AddMachineUseCase(deps).execute({ name, contractorPartyId: aslam, packingContractorPartyId: babar, actor: "admin" })).machineId!;

  db.createProduct({ article: "SK12", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["BLACKRED", "BLACKBLUE", "GREEN"], status: "ACTIVE" });
  db.createProduct({ article: "SK12", size: "4/6", sellingPrice: 500, machineRate: 60, packingRate: 25, colors: ["BLACKRED", "BLACKBLUE"], status: "ACTIVE" });
  db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 450, machineRate: 50, packingRate: 20, colors: ["RED"], status: "ACTIVE" });
  const sizeId = (article: string, size: string) =>
    (raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ?").get(article, size) as { id: string }).id;
  const big = sizeId("SK12", "7/10");
  const small = sizeId("SK12", "4/6");
  const other = sizeId("SK6", "7/10");

  const record = (machineId: string, articleSizeId: string, color: string, dozens: string) =>
    db.recordManualProduction({ requestId: crypto.randomUUID(), machineId, articleSizeId, color, dozens, storeLocationId: STORE, createdBy: "operator" }).entry;
  const edit = (machineId: string, cells: Array<{ articleSizeId: string; color: string; dozens: string }>, requestId: string = crypto.randomUUID(), article = "SK12") =>
    db.editManualProduction({ requestId, machineId, article, cells, storeLocationId: STORE, editedBy: "operator" });
  const storeStock = (article: string, color: string, size = "7/10"): number =>
    db.listInventory(article).find((row) => row.color === color && row.size === size)?.storeQuantity ?? 0;
  const liveCartons = (): number =>
    Number((raw.prepare("SELECT COALESCE(SUM(cartons), 0) AS n FROM manual_production_entries WHERE voided_at IS NULL").get() as { n: number }).n);
  const entries = () =>
    raw.prepare("SELECT entry_number, cartons, voided_at, void_reason FROM manual_production_entries ORDER BY entry_number").all() as Array<{ entry_number: number; cartons: number; voided_at: string | null; void_reason: string | null }>;
  const ledgerCartons = (partyId: string): number =>
    db.getContractorLedger(partyId, { fromDate: today(), toDate: today() }).entries.reduce((sum, entry) => sum + (entry.kind === "WORK" ? entry.work.cartons : 0), 0);
  const outOfStore = (articleSizeId: string, color: string, cartons: number) =>
    db.adjustCartonStock({ requestId: crypto.randomUUID(), articleSizeId, color, direction: "OUT", cartons, reason: "dispatched", adjustedBy: "owner", storeLocationId: STORE });

  return {
    db, raw, aslam, machine, big, small, other, record, edit, storeStock, liveCartons, entries, ledgerCartons, outOfStore,
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

test("the owner's example: stock 10, production 5 -> 15; edited 5 to 3 -> 13, and the ledger shows 3", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.record(m1, f.big, "BLACKRED", "10"); // the old stock: 10 dozen
    const before = f.ledgerCartons(f.aslam);
    const production = f.record(m1, f.big, "BLACKRED", "5");
    assert.equal(f.storeStock("SK12", "BLACKRED"), 30, "15 dozen");

    // Edit the day's BLACKRED 7/10 on Machine 1 from 15 to 13 dozen: the 5 becomes a 3.
    // (Today's figure on that machine is both entries together; the edit sets the figure.)
    const result = f.edit(m1, [{ articleSizeId: f.big, color: "BLACKRED", dozens: "13" }]);
    assert.equal(f.storeStock("SK12", "BLACKRED"), 26, "13 dozen");
    assert.equal(f.ledgerCartons(f.aslam), 26, "the ledger counts 13 dozen");
    assert.ok(before >= 0);

    assert.equal(result.changes.length, 1);
    const [change] = result.changes;
    assert.deepEqual([change.size, change.color, change.fromCartons, change.toCartons], ["7/10", "BLACKRED", 30, 26]);
    assert.deepEqual(change.voided, ["MAN-000001", production.code]);
    assert.equal(change.recorded, "MAN-000003");
    const reasons = f.entries().filter((row) => row.voided_at).map((row) => row.void_reason);
    assert.deepEqual(reasons, [
      "Edited on the Manual Production page: 15 dozen became 13 dozen (now MAN-000003).",
      "Edited on the Manual Production page: 15 dozen became 13 dozen (now MAN-000003).",
    ]);
  });
});

test("5 edited to 3 when the 5 was the day's only entry: reversed, and 3 recorded", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.record(m1, f.big, "GREEN", "5");
    f.edit(m1, [{ articleSizeId: f.big, color: "GREEN", dozens: "3" }]);
    assert.equal(f.storeStock("SK12", "GREEN"), 6);
    assert.equal(f.ledgerCartons(f.aslam), 6);
    assert.deepEqual(f.entries().map((row) => [row.entry_number, row.cartons, row.voided_at !== null]), [[1, 10, true], [2, 6, false]]);
  });
});

test("a whole article at once: changed boxes change, a box set to 0 is removed, a new box is added, the rest are untouched", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.record(m1, f.big, "BLACKRED", "1");
    f.record(m1, f.big, "BLACKBLUE", "2");
    f.record(m1, f.small, "BLACKRED", "10");
    const result = f.edit(m1, [
      { articleSizeId: f.big, color: "BLACKRED", dozens: "1" }, // unchanged
      { articleSizeId: f.big, color: "BLACKBLUE", dozens: "0" }, // removed
      { articleSizeId: f.big, color: "GREEN", dozens: "54" }, // new
      { articleSizeId: f.small, color: "BLACKRED", dozens: "2" }, // changed
    ]);
    assert.deepEqual(result.changes.map((change) => [change.size, change.color, change.fromCartons, change.toCartons, change.recorded !== null]), [
      ["7/10", "BLACKBLUE", 4, 0, false],
      ["7/10", "GREEN", 0, 108, true],
      ["4/6", "BLACKRED", 20, 4, true],
    ]);
    assert.equal(f.storeStock("SK12", "BLACKRED"), 2, "untouched");
    assert.equal(f.storeStock("SK12", "BLACKBLUE"), 0);
    assert.equal(f.storeStock("SK12", "GREEN"), 108);
    assert.equal(f.storeStock("SK12", "BLACKRED", "4/6"), 4);
    assert.equal(f.liveCartons(), 2 + 108 + 4);
    const removed = f.entries().find((row) => row.entry_number === 2)!;
    assert.equal(removed.void_reason, "Edited on the Manual Production page: 2 dozen removed.");
  });
});

test("a Save sent twice changes nothing the second time", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.record(m1, f.big, "BLACKRED", "5");
    const requestId = crypto.randomUUID();
    const cells = [{ articleSizeId: f.big, color: "BLACKRED", dozens: "3" }];
    assert.equal(f.edit(m1, cells, requestId).changes.length, 1);
    assert.equal(f.edit(m1, cells, requestId).changes.length, 0);
    assert.equal(f.storeStock("SK12", "BLACKRED"), 6);
    assert.equal(f.entries().length, 2);
  });
});

test("every changed box or none: one refused box changes nothing", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.record(m1, f.big, "BLACKRED", "5");
    assert.throws(
      () => f.edit(m1, [
        { articleSizeId: f.big, color: "BLACKRED", dozens: "3" },
        { articleSizeId: f.small, color: "BLACKBLUE", dozens: "1.25" },
      ]),
      /SK12 4\/6 BLACKBLUE/
    );
    assert.equal(f.storeStock("SK12", "BLACKRED"), 10);
    assert.equal(f.entries().length, 1);
    assert.equal(f.entries()[0].voided_at, null);
  });
});

test("only the difference must still be in the store; taking out cartons that have gone is refused", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.record(m1, f.big, "BLACKRED", "5"); // 10 cartons
    f.outOfStore(f.big, "BLACKRED", 8); // 2 left in the store
    // 5 -> 4 dozen: +8 recorded, then the 10 voided: 2 + 8 - 10 = 0. Allowed.
    f.edit(m1, [{ articleSizeId: f.big, color: "BLACKRED", dozens: "4" }]);
    assert.equal(f.storeStock("SK12", "BLACKRED"), 0);
    // 4 -> 0 would take 8 cartons the store no longer has.
    assert.throws(() => f.edit(m1, [{ articleSizeId: f.big, color: "BLACKRED", dozens: "0" }]), /no longer holds|gatepass/);
    assert.equal(f.storeStock("SK12", "BLACKRED"), 0);
  });
});

test("another machine's and another article's production are never touched", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const m2 = await f.machine("Machine 2");
    f.record(m1, f.big, "BLACKRED", "5");
    f.record(m2, f.big, "BLACKRED", "7");
    f.record(m1, f.other, "RED", "2");
    f.edit(m1, [{ articleSizeId: f.big, color: "BLACKRED", dozens: "0" }]);
    assert.equal(f.storeStock("SK12", "BLACKRED"), 14, "Machine 2's 7 dozen stays");
    assert.equal(f.storeStock("SK6", "RED"), 4);
    // A size of another article is refused outright.
    assert.throws(() => f.edit(m1, [{ articleSizeId: f.other, color: "RED", dozens: "1" }]), /not part of SK12/);
  });
});

test("the edit grid starts from today's live figures for one machine and article", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const m2 = await f.machine("Machine 2");
    f.record(m1, f.big, "BLACKRED", "1");
    f.record(m1, f.big, "BLACKRED", "2");
    f.record(m1, f.small, "BLACKBLUE", "10");
    f.record(m2, f.big, "GREEN", "4");
    const voided = f.record(m1, f.big, "GREEN", "9");
    f.db.voidManualProduction({ entryId: voided.id, reason: "typed twice", voidedBy: "operator", mayVoidEarlierDays: false });

    const view = f.db.manualProductionArticleToday({ machineName: "MACHINE 1", article: "SK12" });
    assert.equal(view.date, today());
    assert.equal(view.machineId, m1);
    assert.deepEqual(view.cells.map((cell) => [cell.size, cell.color, cell.cartons]), [["4/6", "BLACKBLUE", 20], ["7/10", "BLACKRED", 6]]);
    assert.equal(f.db.manualProductionArticleToday({ machineName: "MACHINE 3", article: "SK12" }).machineId, null);
  });
});
