import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AddMachineUseCase, InMemoryEventBus } from "@erp/application";
import { businessDateOf, productionDayId } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// THE MANUAL PRODUCTION PAGE'S SAVE AND "COMPLETE TODAY'S PRODUCTION" against a real database (docs/48):
// several lines are saved together or not at all, a day is marked complete once, and the day reads per machine.

type Raw = import("node:sqlite").DatabaseSync;
const STORE = "factory-1";
const today = () => businessDateOf(new Date().toISOString());

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-production-days-"));
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
  const product = (article: string, size: string, colors: string[]): string => {
    db.createProduct({ article, size, sellingPrice: 550, machineRate: 70, packingRate: 30, colors, status: "ACTIVE" });
    return (raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ?").get(article, size) as { id: string }).id;
  };
  const count = (table: string): number => Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const storeStock = (article: string, color: string): number => db.listInventory(article).find((row) => row.color === color)?.storeQuantity ?? 0;
  return {
    db, raw, machine, product, count, storeStock,
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

const line = (machineId: string, articleSizeId: string, color: string, dozens: unknown, requestId: string = crypto.randomUUID()) => ({ requestId, machineId, articleSizeId, color, dozens });

test("a Save of several lines, for two machines, records every line: its own entry, movement and program", async () => {
  await withFixture(async (f) => {
    const [m1, m2] = [await f.machine("Machine 1"), await f.machine("Machine 2")];
    const sk6 = f.product("SK6", "7/10", ["RED", "BLACK"]);
    const result = f.db.recordManualProductionBatch({
      lines: [line(m1, sk6, "RED", "10"), line(m1, sk6, "BLACK", "2.5"), line(m2, sk6, "RED", "1")],
      storeLocationId: STORE, createdBy: "admin",
    });
    assert.equal(result.duplicates, 0);
    assert.deepEqual(result.entries.map((entry) => [entry.code, entry.machineName, entry.color, entry.cartons]), [
      ["MAN-000001", "MACHINE 1", "RED", 20], ["MAN-000002", "MACHINE 1", "BLACK", 5], ["MAN-000003", "MACHINE 2", "RED", 2],
    ]);
    assert.deepEqual([f.storeStock("SK6", "RED"), f.storeStock("SK6", "BLACK")], [22, 5]);
    assert.equal(f.count("machine_programs"), 2, "each machine has its one program for today");
  });
});

test("one refused line refuses the whole Save, naming the line, and nothing is written", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const sk6 = f.product("SK6", "7/10", ["RED"]);
    const save = (lines: ReturnType<typeof line>[]) => f.db.recordManualProductionBatch({ lines, storeLocationId: STORE, createdBy: "admin" });
    assert.throws(() => save([line(m1, sk6, "RED", "10"), line(m1, sk6, "PINK", "1")]), /^Error: Line 2: .*colour/);
    assert.throws(() => save([line(m1, sk6, "RED", "10"), line(m1, sk6, "RED", "0.25")]), /^Error: Line 2: /);
    assert.throws(() => save([]), /at least one quantity/);
    const same = crypto.randomUUID();
    assert.throws(() => save([line(m1, sk6, "RED", "1", same), line(m1, sk6, "RED", "2", same)]), /could not be identified/);
    assert.deepEqual([f.count("manual_production_entries"), f.count("carton_stock_events"), f.storeStock("SK6", "RED")], [0, 0, 0]);
  });
});

test("a Save retried with the same lines returns the entries already made and adds nothing", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const sk6 = f.product("SK6", "7/10", ["RED", "BLACK"]);
    const lines = [line(m1, sk6, "RED", "10"), line(m1, sk6, "BLACK", "1")];
    const first = f.db.recordManualProductionBatch({ lines, storeLocationId: STORE, createdBy: "admin" });
    const again = f.db.recordManualProductionBatch({ lines, storeLocationId: STORE, createdBy: "admin" });
    assert.equal(again.duplicates, 2);
    assert.deepEqual(again.entries.map((entry) => entry.code), first.entries.map((entry) => entry.code));
    assert.deepEqual([f.count("manual_production_entries"), f.storeStock("SK6", "RED")], [2, 20]);
  });
});

test("a day with nothing saved cannot be completed. With production it is marked once, and marking again changes nothing", async () => {
  await withFixture(async (f) => {
    assert.throws(() => f.db.completeProductionDay({ completedBy: "aslam" }), /No production has been saved today/);
    assert.equal(f.db.productionDayMark(today()), null);

    const m1 = await f.machine("Machine 1");
    const sk6 = f.product("SK6", "7/10", ["RED"]);
    f.db.recordManualProductionBatch({ lines: [line(m1, sk6, "RED", "10"), line(m1, sk6, "RED", "1")], storeLocationId: STORE, createdBy: "admin" });
    assert.throws(() => f.db.completeProductionDay({ completedBy: " " }), /Sign in again/);

    const { mark, duplicate } = f.db.completeProductionDay({ completedBy: "aslam" });
    assert.equal(duplicate, false);
    assert.deepEqual([mark.date, mark.completedBy, mark.cartons, mark.entries], [today(), "aslam", 22, 2]);
    const again = f.db.completeProductionDay({ completedBy: "babar" });
    assert.equal(again.duplicate, true);
    assert.deepEqual([again.mark.completedBy, again.mark.completedAt], ["aslam", mark.completedAt]);
    assert.equal(f.count("production_days"), 1);
    assert.equal((f.raw.prepare("SELECT id FROM production_days").get() as { id: string }).id, productionDayId(today()));
    assert.equal(f.storeStock("SK6", "RED"), 22, "the mark moves no stock");
  });
});

test("a voided entry does not count toward completing the day", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const sk6 = f.product("SK6", "7/10", ["RED"]);
    const { entries } = f.db.recordManualProductionBatch({ lines: [line(m1, sk6, "RED", "10")], storeLocationId: STORE, createdBy: "admin" });
    f.db.voidManualProduction({ entryId: entries[0]!.id, reason: "typed twice", voidedBy: "admin", mayVoidEarlierDays: false });
    assert.throws(() => f.db.completeProductionDay({ completedBy: "aslam" }), /No production has been saved today/);
  });
});

test("the day reads per machine and together, voided entries left out, and carries its mark", async () => {
  await withFixture(async (f) => {
    const [m1, m2] = [await f.machine("Machine 1"), await f.machine("Machine 2")];
    const sk6 = f.product("SK6", "7/10", ["RED", "BLACK"]);
    const sk6small = f.product("SK6", "4/6", ["RED"]);
    const { entries } = f.db.recordManualProductionBatch({
      lines: [line(m1, sk6, "RED", "10"), line(m1, sk6small, "RED", "3"), line(m2, sk6, "BLACK", "2"), line(m2, sk6, "RED", "50")],
      storeLocationId: STORE, createdBy: "admin",
    });
    f.db.voidManualProduction({ entryId: entries[3]!.id, reason: "wrong machine", voidedBy: "admin", mayVoidEarlierDays: false });

    const day = f.db.productionDayView(today());
    assert.ok(day);
    assert.deepEqual([day.totalCartons, day.entries, day.completed], [30, 3, null]);
    assert.deepEqual(day.machines.map((machine) => [machine.machineName, machine.cartons, machine.entries]), [["MACHINE 1", 26, 2], ["MACHINE 2", 4, 1]]);
    const [together] = day.articles;
    assert.deepEqual([together?.article, together?.colours, together?.total], ["SK6", ["BLACK", "RED"], 30]);
    assert.deepEqual(together?.rows.map((row) => [row.size, row.quantities]), [["7/10", [4, 20]], ["4/6", [0, 6]]]);

    f.db.completeProductionDay({ completedBy: "aslam" });
    assert.equal(f.db.productionDayView(today())?.completed?.completedBy, "aslam");
    assert.equal(f.db.productionDayView("not-a-date"), null);
    assert.deepEqual(f.db.productionDayView("2020-01-01")?.machines, []);
  });
});

test("a completed day is this computer's own change: it is marked to travel as PRODUCTION_DAY", async () => {
  await withFixture(async (f) => {
    const m1 = await f.machine("Machine 1");
    const sk6 = f.product("SK6", "7/10", ["RED"]);
    f.db.recordManualProductionBatch({ lines: [line(m1, sk6, "RED", "1")], storeLocationId: STORE, createdBy: "admin" });
    f.db.completeProductionDay({ completedBy: "aslam" });
    const dirty = f.raw.prepare("SELECT record_id FROM sync_dirty_records WHERE aggregate_type = 'PRODUCTION_DAY'").all() as Array<{ record_id: string }>;
    assert.deepEqual(dirty.map((row) => row.record_id), [productionDayId(today())]);
  });
});
