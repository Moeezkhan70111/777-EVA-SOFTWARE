import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InMemoryEventBus,
  IssueRawMaterialScanUseCase,
  ProcessScanUseCase,
  ReceiveRawMaterialScanUseCase,
  StoreEntryScanUseCase,
  StoreExitScanUseCase,
} from "@erp/application";
import { STORE_MOVEMENT_SOURCE, type StoreDailyReport } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

// The store's daily report against the real database. Every movement is made the way the
// screens make it — packets scanned through the receiving and issue use cases, loose stock typed
// through moveRawMaterialByHand, cartons produced and scanned through the carton use cases — and
// the report must find each one exactly once, on the right side and the right day.

const CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };
const ACTOR = "aslam";

type Raw = import("node:sqlite").DatabaseSync;

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-store-day-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "erp.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });
  const raw = (db as unknown as { db: Raw }).db;
  const deps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() };
  const cartonDeps = {
    txManager: db, duplicateChecker: db, qrRegistry: db, productCatalog: db, qrMasterRepo: db, qrLookupRepo: db,
    gatepassRepo: db, productionEventsRepo: db, storeEntryEventsRepo: db, storeExitEventsRepo: db,
    stockProjectionRepo: db, outboxRepo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
  };

  const dozen = db.createInventoryUnit({ code: "DOZEN", name: "Dozen", unitFamily: "COUNT" });
  const inch = db.createInventoryUnit({ code: "INCH", name: "Inch" });
  const supplier = db.createParty({ partyName: "ABC UPPER", partyType: "SUPPLIER", city: "Lahore", mobileNumber: "0300-3333333", status: "ACTIVE" });

  const category = db.createInventoryCategory({ name: "UPPER" });
  db.addInventoryCategoryField({ categoryId: category, fieldKey: "article", label: "ARTICLE", fieldType: "TEXT", required: true });
  // Labelled: packed 5 DOZEN to a packet. Loose: nawaar, counted in inches, never labelled —
  // created with an opening stock, which is itself a movement into the store today.
  const upper = db.createInventoryItem({ categoryId: category, values: { article: "SK6 BLACK" }, unitId: dozen });
  db.setRawMaterialMovementConfig(upper.id, { packName: "PACKET", packingQuantity: 5, packingUnitId: dozen });
  const nawaar = db.createInventoryItem({ categoryId: category, values: { article: "NAWAAR" }, unitId: inch, stockQuantity: 100 });

  return {
    db, raw, supplier, upperId: upper.id, nawaarId: nawaar.id,
    today: db.localYmd(new Date()),
    receivePackets: async (count: number): Promise<string[]> => {
      const session = db.startRawMaterialReceivingSession({ partyId: supplier, deviceId: "device-1", startedBy: ACTOR });
      const qrIds = db.generateRawMaterialQrBatch({ partyId: supplier, itemId: upper.id, quantity: count, packingQuantity: 5 }).qrCodes.map((qr) => qr.id);
      const receive = new ReceiveRawMaterialScanUseCase(deps);
      for (const qrId of qrIds) {
        const result = await receive.execute({ rawScan: qrId, partyId: supplier, sessionId: session.id, context: CONTEXT, actor: ACTOR });
        assert.equal(result.outcome, "RECEIVED");
      }
      return qrIds;
    },
    issuePacket: async (qrId: string) => {
      const session = db.startOrResumeRawMaterialIssueSession({ deviceId: "device-1", startedBy: ACTOR });
      const result = await new IssueRawMaterialScanUseCase(deps).execute({ rawScan: qrId, sessionId: session.id, issuedToPartyId: supplier, context: CONTEXT, actor: ACTOR });
      assert.equal(result.accepted, true, result.reason);
    },
    cartons: async (count: number): Promise<string[]> => {
      db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 550, status: "ACTIVE" });
      const sizeId = (raw.prepare("SELECT id FROM article_sizes WHERE article = 'SK6' AND size = '7/10'").get() as { id: string }).id;
      const ids = db.generateQrBatch({ articleSizeId: sizeId, color: "BLACK", quantity: count, createdBy: "admin" }).qrCodes.map((qr) => qr.id);
      for (const id of ids) {
        assert.equal((await new ProcessScanUseCase(cartonDeps).execute({ rawScan: id, context: CONTEXT })).accepted, true);
        assert.equal((await new StoreEntryScanUseCase(cartonDeps).execute({ rawScan: id, context: CONTEXT, actor: ACTOR })).outcome, "RECEIVED");
      }
      return ids;
    },
    moveCartonOut: async (qrId: string) => {
      assert.equal((await new StoreExitScanUseCase(cartonDeps).execute({ rawScan: qrId, context: CONTEXT, actor: ACTOR })).outcome, "MOVED_OUT");
    },
  };
}

const sources = (report: StoreDailyReport | null) => Object.fromEntries((report?.summary.bySource ?? []).map((row) => [row.source, row.count]));

test("Store In: scanned packets, a typed delivery, opening stock and cartons — each counted once", async () => {
  const f = createFixture();
  await f.receivePackets(2);
  const typed = f.db.moveRawMaterialByHand({ itemId: f.nawaarId, direction: "IN", quantity: 50, unitCode: "INCH", partyId: f.supplier, actor: ACTOR });
  assert.equal(typed.outcome, "MOVED");
  await f.cartons(3);

  const report = f.db.getStoreDailyReport(f.today, "IN")!;

  assert.deepEqual(sources(report), {
    [STORE_MOVEMENT_SOURCE.SCAN]: 2,
    [STORE_MOVEMENT_SOURCE.MANUAL]: 1,
    [STORE_MOVEMENT_SOURCE.CARTON]: 3,
    [STORE_MOVEMENT_SOURCE.OPENING]: 1,
  }, "a scan's own stock event is not counted a second time");
  assert.equal(report.summary.packets, 2);
  assert.equal(report.summary.cartons, 3);
  assert.equal(report.entryCount, 7);

  const upper = report.summary.byMaterial.find((row) => row.itemId === f.upperId)!;
  assert.deepEqual([upper.quantity, upper.unitCode, upper.packets, upper.typed], [10, "DOZEN", 2, 0]);
  const nawaar = report.summary.byMaterial.find((row) => row.itemId === f.nawaarId)!;
  assert.deepEqual([nawaar.quantity, nawaar.unitCode, nawaar.typed], [150, "INCH", 2], "100 opening + 50 typed");
  assert.deepEqual(report.summary.byProduct, [{ article: "SK6", color: "BLACK", size: "7/10", cartons: 3 }]);

  const scan = report.entries.find((entry) => entry.kind === "MATERIAL" && entry.source === STORE_MOVEMENT_SOURCE.SCAN);
  assert.equal(scan?.kind === "MATERIAL" ? scan.partyName : null, "ABC UPPER", "a scanned packet names its supplier");
  assert.equal(scan?.actor, ACTOR);
});

test("Store Out: a packet scanned out, loose stock typed out and a carton to the gate — and nothing that came in", async () => {
  const f = createFixture();
  const [packet] = await f.receivePackets(2);
  await f.issuePacket(packet);
  assert.equal(f.db.moveRawMaterialByHand({ itemId: f.nawaarId, direction: "OUT", quantity: 30, unitCode: "INCH", note: "cutting table", actor: ACTOR }).outcome, "MOVED");
  const [carton] = await f.cartons(2);
  await f.moveCartonOut(carton);

  const report = f.db.getStoreDailyReport(f.today, "OUT")!;

  assert.deepEqual(sources(report), {
    [STORE_MOVEMENT_SOURCE.SCAN]: 1,
    [STORE_MOVEMENT_SOURCE.MANUAL]: 1,
    [STORE_MOVEMENT_SOURCE.CARTON]: 1,
  });
  const upper = report.summary.byMaterial.find((row) => row.itemId === f.upperId)!;
  assert.equal(upper.quantity, 5, "one packet of 5 DOZEN left");
  const nawaar = report.summary.byMaterial.find((row) => row.itemId === f.nawaarId)!;
  assert.equal(nawaar.quantity, 30, "typed out is stored negative but reads as 30 out");
});

test("the day is the business day: a movement just before local midnight belongs to the day before", async () => {
  const f = createFixture();
  f.db.moveRawMaterialByHand({ itemId: f.nawaarId, direction: "IN", quantity: 5, unitCode: "INCH", partyId: f.supplier });
  const dayStart = f.db.localDayStartIso(f.today)!;
  const justBefore = new Date(Date.parse(dayStart) - 1000).toISOString();
  f.raw.prepare("UPDATE inventory_stock_events SET created_at = ? WHERE note LIKE 'Manual move in%'").run(justBefore);

  assert.equal(sources(f.db.getStoreDailyReport(f.today, "IN"))[STORE_MOVEMENT_SOURCE.MANUAL], undefined);
  const yesterday = f.db.localYmd(new Date(Date.parse(dayStart) - 1000));
  assert.equal(sources(f.db.getStoreDailyReport(yesterday, "IN"))[STORE_MOVEMENT_SOURCE.MANUAL], 1);
});

test("a quiet day is an empty report, and a date that is not a date is refused", () => {
  const f = createFixture();
  const report = f.db.getStoreDailyReport("2020-01-01", "OUT")!;
  assert.equal(report.entryCount, 0);
  assert.deepEqual(report.summary.bySource, []);
  assert.equal(f.db.getStoreDailyReport("13/10/2026", "IN"), null);
});
