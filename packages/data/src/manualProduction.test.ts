import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddMachineUseCase, InMemoryEventBus } from "@erp/application";
import { CONTRACTOR_ROLE, businessDateOf, toPaisa } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// MANUAL PRODUCTION against a real database: an entry joins its machine's program for today, stocks
// its cartons in the store, and is work on the machine and packing contractors' ledgers — once.

type Raw = import("node:sqlite").DatabaseSync;
const STORE = "factory-1";
const today = () => businessDateOf(new Date().toISOString());

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-manual-production-"));
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

  db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED", "BLACK"], status: "ACTIVE" });
  const sk6 = (raw.prepare("SELECT id FROM article_sizes WHERE article = 'SK6' AND size = '7/10'").get() as { id: string }).id;

  const record = (machineId: string, color: string, dozens: unknown, requestId: string = crypto.randomUUID()) =>
    db.recordManualProduction({ requestId, machineId, articleSizeId: sk6, color, dozens, storeLocationId: STORE, createdBy: "admin" });
  const storeStock = (color: string): number =>
    db.listInventory("SK6").find((row) => row.color === color)?.storeQuantity ?? 0;
  const count = (table: string): number => Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

  return {
    db, raw, aslam, babar, machine, sk6, record, storeStock, count,
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

test("an entry joins the machine's program for today and stocks its cartons in the store", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const { entry, duplicate } = f.record(m1, "RED", "10");
    assert.equal(duplicate, false);
    assert.equal(entry.code, "MAN-000001");
    assert.deepEqual([entry.article, entry.size, entry.color, entry.cartons, entry.equivalentDozens], ["SK6", "7/10", "RED", 20, 10]);
    assert.equal(entry.machineName, "MACHINE 1");
    assert.match(entry.programCode, /^MP-\d{6}$/);
    assert.equal(f.storeStock("RED"), 20);
    assert.equal(f.storeStock("BLACK"), 0);

    // A second entry on the same machine and day joins the same program.
    const second = f.record(m1, "BLACK", "2.5").entry;
    assert.equal(second.programCode, entry.programCode);
    assert.equal(second.code, "MAN-000002");
    assert.equal(f.storeStock("BLACK"), 5);
    assert.equal(f.count("machine_programs"), 1);
  });
});

test("the day lists every entry and adds it up per article, size and colour", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.record(m1, "RED", "10");
    f.record(m1, "RED", "5");
    f.record(m1, "BLACK", "1");
    const page = f.db.listManualProduction({ date: today(), pageSize: 2 })!;
    assert.equal(page.totalEntries, 3);
    assert.equal(page.rows.length, 2, "a page at a time");
    assert.equal(page.rows[0].code, "MAN-000003", "newest first");
    assert.equal(page.totalCartons, 32);
    assert.equal(page.equivalentDozens, 16);
    assert.deepEqual(
      page.summary.map((line) => [line.color, line.cartons, line.equivalentDozens]),
      [["BLACK", 2, 1], ["RED", 30, 15]]
    );
    assert.equal(f.db.listManualProduction({ date: "2020-01-01" })!.totalEntries, 0, "another day is not this one");
    assert.equal(f.db.listManualProduction({ date: "not a day" }), null);
  });
});

test("the machine and packing contractors are paid for it, at the product's rate", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.record(m1, "RED", "10");
    const period = { fromDate: today(), toDate: today() };
    const workOf = (partyId: string) =>
      f.db.getContractorLedger(partyId, period).entries.flatMap((entry) => (entry.kind === "WORK" ? [entry.work] : []));

    const [day] = workOf(f.aslam);
    assert.equal(day.cartons, 20);
    assert.equal(day.dozens, 10);
    assert.equal(day.lines[0].role, CONTRACTOR_ROLE.MACHINE);
    assert.equal(day.amountPaisa, toPaisa(700), "10 dozen at Rs 70");

    const [packingDay] = workOf(f.babar);
    assert.equal(packingDay.lines[0].role, CONTRACTOR_ROLE.PACKING);
    assert.equal(packingDay.amountPaisa, toPaisa(300), "10 dozen at Rs 30");
    assert.equal(f.db.getContractorLedger(f.aslam, period).earnedPaisa, toPaisa(700));
  });
});

test("Reconciliation counts the program's manual cartons as production received", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    f.record(m1, "RED", "3");
    const program = f.db.listReconcilablePrograms(today()).find((row) => row.machineId === m1)!;
    const result = f.db.getProgramReconciliation(program.programId)!;
    assert.deepEqual(result.productionReceived, { cartons: 6, bCartons: 0, manualCartons: 6 });
    assert.equal(result.comparison.receivedDozens, 3);
  });
});

test("a retried Save is the same entry — the stock is added once", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const first = f.record(m1, "RED", "10", "press-1");
    const again = f.record(m1, "RED", "10", "press-1");
    assert.equal(again.duplicate, true);
    assert.equal(again.entry.id, first.entry.id);
    assert.equal(f.count("manual_production_entries"), 1);
    assert.equal(f.storeStock("RED"), 20);
  });
});

test("a refused entry writes nothing: not the entry, not the program, not the stock", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    assert.throws(() => f.record(m1, "RED", "1.25"), /whole or half dozens/);
    assert.throws(() => f.record(m1, "RED", "0"), /more than 0/);
    assert.throws(
      () => f.db.recordManualProduction({ requestId: "x", machineId: m1, articleSizeId: f.sk6, color: "GREEN", dozens: "1", storeLocationId: STORE, createdBy: null }),
      /not found/
    );
    assert.throws(
      () => f.db.recordManualProduction({ requestId: "y", machineId: "no-machine", articleSizeId: f.sk6, color: "RED", dozens: "1", storeLocationId: STORE, createdBy: null }),
      /no longer set up/
    );
    const black = (f.raw.prepare("SELECT id FROM product_variants WHERE article_size_id = ? AND color = 'BLACK'").get(f.sk6) as { id: string }).id;
    f.db.disableProduct(black);
    assert.throws(() => f.record(m1, "BLACK", "1"), /disabled in Product Master/);

    assert.equal(f.count("manual_production_entries"), 0);
    assert.equal(f.count("machine_programs"), 0);
    assert.equal(f.storeStock("RED"), 0);
  });
});
