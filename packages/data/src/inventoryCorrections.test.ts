// Undoing data-entry mistakes: deleting a material, a dropdown choice or a run of labels that
// should never have existed, and re-stating a material in the unit it should have had.
//
// The rule every one of these obeys: a mistake that nothing recorded can be erased, but as soon
// as something real points at it — stock, a movement, a scan — it is history, and history is
// kept. Every assertion below goes through the real database, never a seeded shortcut.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryEventBus, ReceiveRawMaterialScanUseCase } from "@erp/application";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

const CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-corrections-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "erp.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.ensureOperationalContext({
    factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });

  const receive = new ReceiveRawMaterialScanUseCase({
    txManager: db, repo: db, eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- direct schema access for assertions
  const raw = (db as any).db;

  const dozen = db.createInventoryUnit({ code: "DOZ", name: "Dozen", unitFamily: "COUNT" }) as unknown as string;
  const pair = db.createInventoryUnit({ code: "PAIR", name: "Pair", unitFamily: "COUNT" }) as unknown as string;
  const supplier = db.createParty({
    partyName: "ABID", partyType: "SUPPLIER", city: "Lahore", mobileNumber: "0300-1111111", status: "ACTIVE",
  });

  const categoryId = db.createInventoryCategory({ name: "UPPER" });
  const sizeFieldId = db.addInventoryCategoryField({ categoryId, fieldKey: "size", label: "SIZE", fieldType: "DROPDOWN", required: true, sortOrder: 1 });
  db.addInventoryCategoryField({ categoryId, fieldKey: "colour", label: "COLOUR", fieldType: "TEXT", required: true, sortOrder: 2 });

  const makeItem = (colour: string, size: string, stockQuantity = 0) =>
    db.createInventoryItem({
      categoryId, values: { size, colour }, unitId: dozen,
      // Passing 0 would still write an opening movement; a material with no stock has none.
      stockQuantity: stockQuantity > 0 ? stockQuantity : undefined,
    }).id;

  const exists = (table: string, where: string, ...args: unknown[]) =>
    Number((raw.prepare(`SELECT COUNT(1) c FROM ${table} WHERE ${where}`).get(...args) as { c: number }).c);

  return {
    db, raw, dozen, pair, supplier, categoryId, sizeFieldId, makeItem, exists, receive,
    session: db.startRawMaterialReceivingSession({ partyId: supplier, deviceId: "device-1", startedBy: "aslam" }),
    cleanup: () => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); },
  };
}

// ─── Deleting a material ──────────────────────────────────────────────────────

test("a material entered by mistake is deleted outright, with its attribute values", () => {
  const f = createFixture();
  try {
    const itemId = f.makeItem("GREY", "10/12");
    assert.deepEqual(f.db.inventoryItemDeleteBlockers(itemId), []);

    const deleted = f.db.deleteInventoryItem({ itemId, deletedBy: "aslam" });
    assert.match(deleted.displayName, /GREY/);
    assert.equal(f.exists("inventory_items", "id = ?", itemId), 0);
    assert.equal(f.exists("inventory_item_values", "item_id = ?", itemId), 0);
    // The deletion itself stays on the record.
    assert.equal(f.exists("inventory_item_audit", "entity_id = ? AND action = 'DELETE'", itemId), 1);
  } finally { f.cleanup(); }
});

test("a material holding stock is refused, and says what it holds", () => {
  const f = createFixture();
  try {
    const itemId = f.makeItem("BLACK", "7/10", 41);
    assert.deepEqual(f.db.inventoryItemDeleteBlockers(itemId), ["41 DOZ in stock", "1 stock movement"]);
    assert.throws(() => f.db.deleteInventoryItem({ itemId }), /41 DOZ in stock.*Disable it instead/s);
    assert.equal(f.exists("inventory_items", "id = ?", itemId), 1);
  } finally { f.cleanup(); }
});

test("a material whose labels have been scanned is refused, and can be disabled instead", async () => {
  const f = createFixture();
  try {
    const itemId = f.makeItem("NAVY", "8/13");
    const qrId = f.db.generateRawMaterialQrBatch({ partyId: f.supplier, itemId, quantity: 1, packingQuantity: 5 }).qrCodes[0]!.id;
    await f.receive.execute({ rawScan: qrId, partyId: f.supplier, sessionId: f.session.id, context: CONTEXT, actor: "store-op" });

    assert.throws(() => f.db.deleteInventoryItem({ itemId }), /cannot be deleted/);

    f.db.setInventoryItemStatus({ itemId, status: "INACTIVE", updatedBy: "aslam" });
    assert.equal(f.exists("inventory_items", "id = ? AND status = 'INACTIVE'", itemId), 1);
    // Disabling keeps everything the material took part in.
    assert.equal(f.exists("raw_material_qrs", "item_id = ?", itemId), 1);
  } finally { f.cleanup(); }
});

// ─── Deleting a dropdown choice ───────────────────────────────────────────────

test("an unused dropdown choice is removed, and the same value can be added back", () => {
  const f = createFixture();
  try {
    const optionId = f.db.addInventoryFieldOption({ fieldId: f.sizeFieldId, value: "7/0" });
    assert.deepEqual(f.db.inventoryFieldOptionUsage(optionId), []);

    assert.equal(f.db.deleteInventoryFieldOption({ optionId, deletedBy: "aslam" }).optionValue, "7/0");
    assert.equal(f.exists("inventory_category_field_options", "id = ?", optionId), 0);

    // Removed outright rather than hidden, so the value is free again.
    const again = f.db.addInventoryFieldOption({ fieldId: f.sizeFieldId, value: "7/0" });
    assert.equal(f.exists("inventory_category_field_options", "id = ?", again), 1);
  } finally { f.cleanup(); }
});

test("a dropdown choice a material still carries is refused, naming the material", () => {
  const f = createFixture();
  try {
    const optionId = f.db.addInventoryFieldOption({ fieldId: f.sizeFieldId, value: "7/10" });
    f.makeItem("BLACK", "7/10");

    assert.equal(f.db.inventoryFieldOptionUsage(optionId).length, 1);
    assert.throws(() => f.db.deleteInventoryFieldOption({ optionId }), /still used by 1 material/);
    assert.equal(f.exists("inventory_category_field_options", "id = ?", optionId), 1);
  } finally { f.cleanup(); }
});

// ─── Erasing a run of labels ──────────────────────────────────────────────────

test("a run generated by mistake is erased and hands its serial numbers back", () => {
  const f = createFixture();
  try {
    const itemId = f.makeItem("COMMANDO", "10/12");
    const batch = f.db.generateRawMaterialQrBatch({ partyId: f.supplier, itemId, quantity: 6, packingQuantity: 5 });
    assert.equal(f.db.getRawMaterialQrSequenceState({ partyId: f.supplier, itemId })?.nextSequence, 7);

    assert.deepEqual(f.db.rawMaterialQrBatchDeleteBlockers(batch.batch.id), []);
    const erased = f.db.deleteRawMaterialQrBatch({ batchId: batch.batch.id, deletedBy: "aslam" });

    assert.equal(erased.quantity, 6);
    assert.equal(f.exists("raw_material_qrs", "batch_id = ?", batch.batch.id), 0);
    assert.equal(f.exists("raw_material_qr_batches", "id = ?", batch.batch.id), 0);
    // As if it had never been generated: the next run starts from one again.
    assert.equal(erased.nextSequence, 1);
    assert.equal(f.db.getRawMaterialQrSequenceState({ partyId: f.supplier, itemId })?.nextSequence, 1);
  } finally { f.cleanup(); }
});

test("erasing a run leaves the runs around it untouched and never reissues a live serial", () => {
  const f = createFixture();
  try {
    const itemId = f.makeItem("COMMANDO", "7/10");
    const first = f.db.generateRawMaterialQrBatch({ partyId: f.supplier, itemId, quantity: 1, packingQuantity: 5 });
    const mistake = f.db.generateRawMaterialQrBatch({ partyId: f.supplier, itemId, quantity: 10, packingQuantity: 5 });

    const erased = f.db.deleteRawMaterialQrBatch({ batchId: mistake.batch.id, deletedBy: "aslam" });

    // Serial 1 is still registered, so the counter stops there rather than at zero.
    assert.equal(f.exists("raw_material_qrs", "id = ?", first.qrCodes[0]!.id), 1);
    assert.equal(erased.nextSequence, 2);
    assert.equal(f.db.getRawMaterialQrSequenceState({ partyId: f.supplier, itemId })?.nextSequence, 2);
  } finally { f.cleanup(); }
});

test("a run with a surviving later serial leaves its gap rather than handing out a live number", () => {
  const f = createFixture();
  try {
    const itemId = f.makeItem("COMMANDO", "1/2");
    const mistake = f.db.generateRawMaterialQrBatch({ partyId: f.supplier, itemId, quantity: 1, packingQuantity: 5 });
    const keep = f.db.generateRawMaterialQrBatch({ partyId: f.supplier, itemId, quantity: 1, packingQuantity: 5 });

    const erased = f.db.deleteRawMaterialQrBatch({ batchId: mistake.batch.id, deletedBy: "aslam" });

    // Serial 2 is still out there, so the next run must be 3 — reusing 1 would walk into it.
    assert.equal(f.exists("raw_material_qrs", "id = ?", keep.qrCodes[0]!.id), 1);
    assert.equal(erased.nextSequence, 3);
  } finally { f.cleanup(); }
});

test("a run with a scanned label is refused — it is part of what happened in the store", async () => {
  const f = createFixture();
  try {
    const itemId = f.makeItem("SILAI", "9/10");
    const batch = f.db.generateRawMaterialQrBatch({ partyId: f.supplier, itemId, quantity: 3, packingQuantity: 5 });
    await f.receive.execute({ rawScan: batch.qrCodes[0]!.id, partyId: f.supplier, sessionId: f.session.id, context: CONTEXT, actor: "store-op" });

    assert.ok(f.db.rawMaterialQrBatchDeleteBlockers(batch.batch.id).length > 0);
    assert.throws(() => f.db.deleteRawMaterialQrBatch({ batchId: batch.batch.id }), /cannot be erased/);
    assert.equal(f.exists("raw_material_qrs", "batch_id = ?", batch.batch.id), 3);
  } finally { f.cleanup(); }
});

// ─── Correcting the unit ──────────────────────────────────────────────────────

test("a wrongly chosen unit is re-stated without changing a single figure", () => {
  const f = createFixture();
  try {
    const itemId = f.makeItem("PURPLE", "R16", 271);

    const result = f.db.correctInventoryItemUnit({ itemId, unitId: f.pair, reason: "Entered as dozen by mistake", correctedBy: "aslam" });

    assert.equal(result.fromUnitCode, "DOZ");
    assert.equal(result.toUnitCode, "PAIR");
    assert.equal(result.quantityOnHand, 271, "the number must not be converted");
    // Item, balance and every recorded movement all read in the new unit.
    assert.equal(f.exists("inventory_items", "id = ? AND default_unit_id = ?", itemId, f.pair), 1);
    assert.equal(f.exists("inventory_stock_balances", "item_id = ? AND unit_id = ?", itemId, f.pair), 1);
    assert.equal(f.exists("inventory_stock_events", "item_id = ? AND unit_id = ?", itemId, f.dozen), 0);
    assert.equal(f.exists("inventory_item_audit", "item_id = ? AND action = 'CORRECT_UNIT'", itemId), 1);
  } finally { f.cleanup(); }
});

test("a material whose labels already carry the old unit is refused", () => {
  const f = createFixture();
  try {
    const itemId = f.makeItem("BLACK", "R16", 41);
    f.db.generateRawMaterialQrBatch({ partyId: f.supplier, itemId, quantity: 2, packingQuantity: 5 });

    assert.throws(() => f.db.correctInventoryItemUnit({ itemId, unitId: f.pair, reason: "wrong unit" }), /printed label/);
    assert.equal(f.exists("inventory_items", "id = ? AND default_unit_id = ?", itemId, f.dozen), 1);
  } finally { f.cleanup(); }
});

test("correcting a unit without saying why is refused", () => {
  const f = createFixture();
  try {
    const itemId = f.makeItem("NAVY", "R16", 92);
    assert.throws(() => f.db.correctInventoryItemUnit({ itemId, unitId: f.pair, reason: "  " }), /why/);
  } finally { f.cleanup(); }
});
