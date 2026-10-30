// STOCK MOVEMENTS ARE CAPTURED ON EVERY PATH, AND CARRY THE CHANGE THEY MADE (stockEventSync.ts).
//
// The store PC moves stock through several write paths, in two sign conventions. Whatever path
// wrote a movement, the event it queues must carry exactly the change that movement made to the
// balance -- so a computer that adds up the deltas holds the store's balance. These run the real
// paths against a real database and hold the sum of the queued deltas to the real balance.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryEventBus, IssueRawMaterialScanUseCase, ReceiveRawMaterialScanUseCase } from "@erp/application";
import { SqliteDatabase, withCaptureSuppressed } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

const CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };
const NOW = "2026-10-26T10:00:00.000Z";

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-stock-sync-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "erp.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });
  const deps = { txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator() };
  const receive = new ReceiveRawMaterialScanUseCase(deps);
  const issue = new IssueRawMaterialScanUseCase(deps);

  const unitId = db.createInventoryUnit({ code: "DOZ", name: "Dozen", unitFamily: "COUNT" }) as unknown as string;
  const supplier = db.createParty({ partyName: "SHEHZAD RUBBER", partyType: "SUPPLIER", city: "Lahore", mobileNumber: "0300-1111111", status: "ACTIVE" });
  const categoryId = db.createInventoryCategory({ name: "RUBBER UPPER" });
  db.addInventoryCategoryField({ categoryId, fieldKey: "colour", label: "Colour", fieldType: "TEXT", required: true, sortOrder: 1 });

  const session = db.startRawMaterialReceivingSession({ partyId: supplier, deviceId: "device-1", startedBy: "aslam" });
  const issueSession = db.startOrResumeRawMaterialIssueSession({ deviceId: "device-1", startedBy: "aslam" });

  return {
    db,
    unitId,
    supplier,
    categoryId,
    holdStore: (epoch: number) =>
      db.db.prepare(
        `INSERT OR REPLACE INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
         VALUES ('RAW_MATERIAL_STORE', 'device-1', 'Store PC', ?, 0, ?, 'https://test.supabase.co', ?)`
      ).run(epoch, NOW, NOW),
    scanIn: (qrId: string) => receive.execute({ rawScan: qrId, partyId: supplier, sessionId: session.id, context: CONTEXT, actor: "store-op" }),
    scanOut: (qrId: string) => issue.execute({ rawScan: qrId, sessionId: issueSession.id, issuedToPartyId: supplier, context: CONTEXT, actor: "store-op" }),
    balance: (itemId: string) =>
      Number((db.db.prepare("SELECT quantity_on_hand AS q FROM inventory_stock_balances WHERE item_id = ?").get(itemId) as { q: number } | undefined)?.q ?? 0),
    queued: () =>
      (db.db.prepare("SELECT dedupe_key, lease_epoch, payload_json FROM sync_outbox WHERE aggregate_type = 'STOCK_EVENT' ORDER BY rowid").all() as Array<Record<string, unknown>>)
        .map((row) => ({ key: String(row.dedupe_key), epoch: Number(row.lease_epoch), payload: JSON.parse(String(row.payload_json)) as Record<string, unknown> })),
    marks: () => Number((db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = 'STOCK_EVENT'").get() as { n: number }).n),
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test("every write path's movement carries the change it made: the queued deltas add up to the balance", async () => {
  const f = createFixture();
  try {
    f.holdStore(4);
    // Opening stock, typed with the material.
    const item = f.db.createInventoryItem({ categoryId: f.categoryId, values: { colour: "RED" }, unitId: f.unitId, stockQuantity: 10 });
    f.db.setRawMaterialMovementConfig(item.id, { packingQuantity: 2, packingUnitId: f.unitId });
    const labels = f.db.generateRawMaterialQrBatch({ partyId: f.supplier, itemId: item.id, quantity: 3, packingQuantity: 2 }).qrCodes.map((q) => q.id);

    // Scans: quantity stored POSITIVE, the type says the direction.
    for (const label of labels) assert.equal((await f.scanIn(label)).accepted, true);
    assert.equal((await f.scanOut(labels[0]!)).accepted, true);
    // Adjustments and hand moves: quantity stored SIGNED.
    f.db.adjustInventoryStock({ itemId: item.id, quantity: -1, eventType: "ADJUST", note: "Count" });
    f.db.adjustInventoryStock({ itemId: item.id, quantity: -3, eventType: "TRANSFER_OUT", note: "Hand move out" });
    f.db.adjustInventoryStock({ itemId: item.id, quantity: 4, eventType: "TRANSFER_IN", note: "Hand move in" });

    const built = f.db.buildStockEvents(NOW);
    const sent = f.queued();
    assert.deepEqual(built, { queued: 8, unqueued: 0, vanished: 0 }, "opening, three in, one out, three by hand");
    assert.equal(f.marks(), 0);
    assert.ok(sent.every((row) => row.epoch === 4), "each under the store lease held when it was recorded");

    const deltas = sent.map((row) => Number(row.payload.balanceDelta));
    assert.equal(deltas.reduce((sum, delta) => sum + delta, 0), f.balance(item.id), "10 + 3x2 - 2 - 1 - 3 + 4 = 14");
    assert.equal(f.balance(item.id), 14);
    const scanOut = sent.find((row) => row.payload.eventType === "TRANSFER_OUT" && Number(row.payload.quantity) > 0);
    assert.deepEqual([scanOut?.payload.quantity, scanOut?.payload.balanceDelta], [2, -2], "a scan out is stored positive and moves the balance down");
    const handOut = sent.find((row) => row.payload.eventType === "TRANSFER_OUT" && Number(row.payload.quantity) < 0);
    assert.deepEqual([handOut?.payload.quantity, handOut?.payload.balanceDelta], [-3, -3], "a hand move out is stored negative and moves it down once");
  } finally {
    f.cleanup();
  }
});

test("a movement recorded with no store lease waits, marked, for the backfill", () => {
  const f = createFixture();
  try {
    const item = f.db.createInventoryItem({ categoryId: f.categoryId, values: { colour: "BLUE" }, unitId: f.unitId, stockQuantity: 5 });
    assert.equal(f.marks(), 1);
    assert.deepEqual(f.db.buildStockEvents(NOW), { queued: 0, unqueued: 0, vanished: 0 });
    assert.equal(f.marks(), 1, "still marked");
    assert.equal(f.queued().length, 0);
    assert.ok(item.id);
  } finally {
    f.cleanup();
  }
});

test("only a new movement is captured: rewriting or deleting one is not sent, and suppressed writes are not marked", () => {
  const f = createFixture();
  try {
    f.holdStore(1);
    const item = f.db.createInventoryItem({ categoryId: f.categoryId, values: { colour: "GREEN" }, unitId: f.unitId, stockQuantity: 5 });
    f.db.buildStockEvents(NOW);
    assert.equal(f.queued().length, 1);

    f.db.db.prepare("UPDATE inventory_stock_events SET note = 'edited' WHERE item_id = ?").run(item.id);
    f.db.db.prepare("DELETE FROM inventory_stock_events WHERE item_id = ?").run(item.id);
    assert.equal(f.marks(), 0, "a W.5 rewrite is not a new movement");

    f.db.db.exec("BEGIN");
    withCaptureSuppressed(f.db.db, () => {
      f.db.db
        .prepare("INSERT INTO inventory_stock_events (id, item_id, event_type, quantity, unit_id, created_at) VALUES ('arrived', ?, 'RECEIVE', 1, ?, ?)")
        .run(item.id, f.unitId, NOW);
    });
    f.db.db.exec("COMMIT");
    assert.equal(f.marks(), 0, "a movement received from another computer is not this one's to send");
  } finally {
    f.cleanup();
  }
});

test("a marked movement removed before the pass is cleared, not sent", () => {
  const f = createFixture();
  try {
    f.holdStore(1);
    const item = f.db.createInventoryItem({ categoryId: f.categoryId, values: { colour: "PINK" }, unitId: f.unitId, stockQuantity: 5 });
    f.db.db.prepare("DELETE FROM inventory_stock_events WHERE item_id = ?").run(item.id);
    assert.deepEqual(f.db.buildStockEvents(NOW), { queued: 0, unqueued: 0, vanished: 1 });
    assert.equal(f.marks(), 0);
  } finally {
    f.cleanup();
  }
});
