// Raw Material Input, against a real database and the real use case.
//
// Receiving raw material is its own screen with its own identity: a carton and a packet
// never share a scanner. A session is opened against the supplier whose delivery is on the
// floor, and every packet scanned into it is checked against that supplier.
//
// One printed label is one PACKET. The owner's rule, used throughout: RUBBER UPPER 7/10 is
// packed 2 dozen to a packet while RUBBER UPPER 4/6 is packed 3 dozen. Those are separate
// inventory_items rows because size is part of an item's attribute signature.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InMemoryEventBus,
  IssueRawMaterialScanUseCase,
  ReceiveRawMaterialScanUseCase,
  StoreEntryScanUseCase,
} from "@erp/application";
import { RAW_MATERIAL_QR_STATUS } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { UuidGenerator } from "./idGenerator.js";

const CONTEXT = { factoryId: "factory-1", workstationId: "workstation-1", deviceId: "device-1" };

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-rm-move-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "erp.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });

  const receive = new ReceiveRawMaterialScanUseCase({
    txManager: db,
    repo: db,
    eventPublisher: new InMemoryEventBus(),
    idGenerator: new UuidGenerator(),
  });

  const issue = new IssueRawMaterialScanUseCase({
    txManager: db,
    repo: db,
    eventPublisher: new InMemoryEventBus(),
    idGenerator: new UuidGenerator(),
  });

  // The carton screen, kept in the fixture only to prove it turns a packet away.
  const cartonMoveIn = new StoreEntryScanUseCase({
    txManager: db, qrLookupRepo: db, qrRegistry: db, qrMasterRepo: db,
    storeEntryEventsRepo: db, stockProjectionRepo: db, gatepassRepo: db, outboxRepo: db,
    eventPublisher: new InMemoryEventBus(), idGenerator: new UuidGenerator(),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- direct schema access for assertions
  const raw = (db as any).db;

  const configuredPacking = (itemId: string): number => {
    const row = raw.prepare("SELECT packing_quantity FROM inventory_items WHERE id = ?").get(itemId) as { packing_quantity: number | null } | undefined;
    return Number(row?.packing_quantity ?? 1);
  };

  const unitId = db.createInventoryUnit({ code: "DOZ", name: "Dozen", unitFamily: "COUNT" }) as unknown as string;
  const packing = db.createWorkSection({ name: "Packing" });
  const supplier = db.createParty({
    partyName: "SHEHZAD RUBBER TOPPING", partyType: "SUPPLIER", city: "Lahore",
    mobileNumber: "0300-1111111", status: "ACTIVE",
  });
  const otherSupplier = db.createParty({
    partyName: "AL NOOR RUBBER", partyType: "SUPPLIER", city: "Lahore",
    mobileNumber: "0300-2222222", status: "ACTIVE",
  });

  const categoryId = db.createInventoryCategory({ name: "RUBBER UPPER" });
  db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "Article", fieldType: "TEXT", required: true, sortOrder: 1 });
  db.addInventoryCategoryField({ categoryId, fieldKey: "colour", label: "Colour", fieldType: "TEXT", required: true, sortOrder: 2 });
  db.addInventoryCategoryField({ categoryId, fieldKey: "size", label: "Size", fieldType: "TEXT", required: true, sortOrder: 3 });

  const makeItem = (article: string, colour: string, size: string) =>
    db.createInventoryItem({ categoryId, values: { article, colour, size }, unitId });

  /**
   * Registers `count` labels for a material and returns their QR ids. The operator types what
   * one packet holds for every run; tests that configured a material's packing print that figure.
   */
  const labelsFor = (itemId: string, count: number, partyId: string = supplier, packetHolds?: number) =>
    db
      .generateRawMaterialQrBatch({ partyId, itemId, quantity: count, packingQuantity: packetHolds ?? configuredPacking(itemId) })
      .qrCodes.map((q) => q.id);

  // The session every scan below is received into, unless a test opens its own.
  let session = db.startRawMaterialReceivingSession({ partyId: supplier, deviceId: "device-1", startedBy: "aslam" });
  const issueSession = db.startOrResumeRawMaterialIssueSession({ deviceId: "device-1", startedBy: "aslam" });

  const stockOf = (itemId: string) => {
    const row = raw
      .prepare("SELECT quantity_on_hand FROM inventory_stock_balances WHERE item_id = ?")
      .get(itemId) as { quantity_on_hand: number } | undefined;
    return Number(row?.quantity_on_hand ?? 0);
  };

  const statusOf = (qrId: string) => {
    const row = raw
      .prepare("SELECT current_status, current_section_id FROM raw_material_qrs WHERE id = ?")
      .get(qrId) as { current_status: string; current_section_id: string | null } | undefined;
    return row ? { status: row.current_status, sectionId: row.current_section_id } : undefined;
  };

  const journeyOf = (qrId: string) =>
    (raw
      .prepare("SELECT event_type, quantity, previous_status, new_status FROM raw_material_qr_events WHERE qr_id = ? ORDER BY event_ts_local, rowid")
      .all(qrId) as Array<{ event_type: string; quantity: number; previous_status: string; new_status: string }>)
      .map((e) => `${e.event_type}:${e.quantity}:${e.previous_status}->${e.new_status}`);

  const countRows = (table: string) =>
    Number((raw.prepare(`SELECT COUNT(1) c FROM ${table}`).get() as { c: number }).c);

  const scanIn = (qrId: string) =>
    receive.execute({ rawScan: qrId, partyId: session.partyId, sessionId: session.id, context: CONTEXT, actor: "store-op" });
  const scanOutTo = (qrId: string, issuedToPartyId: string) =>
    issue.execute({ rawScan: qrId, sessionId: issueSession.id, issuedToPartyId, context: CONTEXT, actor: "store-op" });
  const scanOut = (qrId: string) =>
    issue.execute({ rawScan: qrId, sessionId: issueSession.id, issuedToPartyId: supplier, context: CONTEXT, actor: "store-op" });

  return {
    db, raw, unitId, packingSectionId: packing.id, makeItem, labelsFor,
    supplier, otherSupplier, cartonMoveIn,
    stockOf, statusOf, journeyOf, countRows, scanIn, scanOut, scanOutTo, issueSession,
    get session() { return session; },
    openSessionFor: (partyId: string) => {
      session = db.startRawMaterialReceivingSession({ partyId, deviceId: "device-1", startedBy: "aslam" });
      return session;
    },
    configure: (itemId: string, quantity: number | null) =>
      db.setRawMaterialMovementConfig(itemId, { packingQuantity: quantity, packingUnitId: quantity == null ? null : unitId}),
    cleanup: () => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); },
  };
}

/** A fully configured material with `count` labels printed for it. */
function readyMaterial(f: ReturnType<typeof createFixture>, size: string, packedDozens: number, count = 3) {
  const item = f.makeItem("SK6", "RED", size);
  f.configure(item.id, packedDozens);
  return { itemId: item.id, labels: f.labelsFor(item.id, count) };
}

// ─── Receiving a delivery ────────────────────────────────────────────────────────

test("a packet is received: stock rises by its packing, status and journey move together", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);

    const result = await f.scanIn(m.labels[0]);

    assert.equal(result.accepted, true, result.reason);
    assert.equal(result.outcome, "RECEIVED");
    assert.equal(result.itemDisplayName, "RUBBER UPPER — SK6 — RED — 7/10");
    assert.equal(result.packingQuantity, 2);
    assert.equal(result.currentStatus, RAW_MATERIAL_QR_STATUS.IN_STORE);
    assert.equal(result.sessionId, f.session.id);

    assert.equal(f.stockOf(m.itemId), 2, "one packet of 2 dozen adds exactly 2");
    assert.deepEqual(f.statusOf(m.labels[0]), { status: RAW_MATERIAL_QR_STATUS.IN_STORE, sectionId: null });
    assert.deepEqual(f.journeyOf(m.labels[0]), ["STORE_ENTRY:2:GENERATED->IN_STORE"]);
  } finally {
    f.cleanup();
  }
});

test("each size carries its own packing: 7/10 adds 2 dozen, 4/6 adds 3", async () => {
  const f = createFixture();
  try {
    const big = readyMaterial(f, "7/10", 2);
    const small = readyMaterial(f, "4/6", 3);

    await f.scanIn(big.labels[0]);
    await f.scanIn(big.labels[1]);
    await f.scanIn(small.labels[0]);

    assert.equal(f.stockOf(big.itemId), 4, "two packets of 2 dozen");
    assert.equal(f.stockOf(small.itemId), 3, "one packet of 3 dozen");
    assert.notEqual(big.itemId, small.itemId, "size makes these separate materials");
  } finally {
    f.cleanup();
  }
});

test("each label carries what its own packet holds: 5 dozen + 3 dozen is 2 packets = 8 dozen", async () => {
  const f = createFixture();
  try {
    // UPPER — RAGZINE — SK6 — BROWN — 7/10, with nothing set up about its packing at all.
    const item = f.makeItem("SK6", "BROWN", "7/10");

    const five = f.db.generateRawMaterialQrBatch({ partyId: f.supplier, itemId: item.id, quantity: 1, packingQuantity: 5 });
    const three = f.db.generateRawMaterialQrBatch({ partyId: f.supplier, itemId: item.id, quantity: 1, packingQuantity: 3 });
    assert.equal(five.batch.packingQuantity, 5);
    assert.deepEqual(f.db.listRawMaterialQrBatches({ limit: 5 }).map((b) => b.packingQuantity).sort(), [3, 5]);

    assert.equal((await f.scanIn(five.qrCodes[0].id)).accepted, true);
    assert.equal((await f.scanIn(three.qrCodes[0].id)).accepted, true);

    assert.equal(f.stockOf(item.id), 8, "5 dozen + 3 dozen");
    assert.deepEqual(f.journeyOf(three.qrCodes[0].id), ["STORE_ENTRY:3:GENERATED->IN_STORE"]);
    const config = f.db.listRawMaterialMovementConfig("").find((row) => row.itemId === item.id);
    assert.equal(config?.packetsInStore, 2, "packets are counted, not divided out of the balance");
  } finally {
    f.cleanup();
  }
});

test("a label run has to say what one packet holds", () => {
  const f = createFixture();
  try {
    const item = f.makeItem("SK6", "BROWN", "4/6");
    for (const bad of [0, -2, Number.NaN]) {
      assert.throws(
        () => f.db.generateRawMaterialQrBatch({ partyId: f.supplier, itemId: item.id, quantity: 1, packingQuantity: bad }),
        /how much one packet holds/i
      );
    }
    assert.equal(f.countRows("raw_material_qrs"), 0, "nothing registered");
  } finally {
    f.cleanup();
  }
});

// ─── The supplier check, which is the point of the session ───────────────────────

test("a packet from another supplier is refused and nothing is credited", async () => {
  const f = createFixture();
  try {
    const item = f.makeItem("SK6", "RED", "7/10");
    f.configure(item.id, 2);
    const [theirs] = f.labelsFor(item.id, 1, f.otherSupplier);

    // The session is open for SHEHZAD; this label belongs to AL NOOR.
    const result = await f.scanIn(theirs);

    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "WRONG_PARTY");
    assert.match(result.reason ?? "", /AL NOOR RUBBER/);
    assert.equal(f.stockOf(item.id), 0, "nothing credited to the wrong delivery");
    assert.deepEqual(f.statusOf(theirs), { status: RAW_MATERIAL_QR_STATUS.GENERATED, sectionId: null });
    assert.equal(f.journeyOf(theirs).length, 0);

    // Opening the right session lets the same label through.
    f.openSessionFor(f.otherSupplier);
    assert.equal((await f.scanIn(theirs)).outcome, "RECEIVED");
    assert.equal(f.stockOf(item.id), 2);
  } finally {
    f.cleanup();
  }
});

test("receiving a packet that is already in the store is refused and changes nothing", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);
    await f.scanIn(m.labels[0]);

    const again = await f.scanIn(m.labels[0]);

    assert.equal(again.accepted, false);
    assert.equal(again.outcome, "ALREADY_IN_STORE");
    assert.equal(f.stockOf(m.itemId), 2, "no second credit");
    assert.equal(f.journeyOf(m.labels[0]).length, 1, "no duplicate movement event");
  } finally {
    f.cleanup();
  }
});

test("an unregistered raw material QR is refused and nothing is created", async () => {
  const f = createFixture();
  try {
    const before = f.countRows("raw_material_qrs");
    const items = f.countRows("inventory_items");

    const result = await f.scanIn("RMQR_PTY999999_RM999999_000001");

    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "UNKNOWN_QR");
    assert.equal(f.countRows("raw_material_qrs"), before, "the scanner must never register a QR");
    assert.equal(f.countRows("inventory_items"), items, "nor invent a raw material");
    assert.equal(f.countRows("raw_material_qr_events"), 0);
  } finally {
    f.cleanup();
  }
});

// ─── Quantity model ──────────────────────────────────────────────────────────────

test("an old label that never recorded what its packet holds is refused rather than guessed at", async () => {
  const f = createFixture();
  try {
    const item = f.makeItem("SK9", "BLACK", "11/14");
    const [label] = f.labelsFor(item.id, 1);
    // Labels printed before a packet's contents were written on them, for a material with no packing.
    f.raw.prepare("UPDATE raw_material_qrs SET packing_quantity = NULL, packing_unit_id = NULL WHERE id = ?").run(label);

    const result = await f.scanIn(label);

    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "NOT_CONFIGURED");
    assert.match(result.reason ?? "", /how much one packet/i);
    assert.equal(f.stockOf(item.id), 0, "no stock invented for an unpacked material");
    assert.deepEqual(f.statusOf(label), { status: RAW_MATERIAL_QR_STATUS.GENERATED, sectionId: null });
    assert.equal(f.journeyOf(label).length, 0);
  } finally {
    f.cleanup();
  }
});

test("the packing a label was printed with survives a later packing correction", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);

    // The owner corrects the packing after the labels are already on packets.
    f.configure(m.itemId, 5);

    const result = await f.scanIn(m.labels[0]);
    assert.equal(result.packingQuantity, 2, "an already-printed label keeps meaning what it meant");
    assert.equal(f.stockOf(m.itemId), 2);
  } finally {
    f.cleanup();
  }
});

// ─── Transaction safety ──────────────────────────────────────────────────────────

test("when the stock write fails, the status change and the journey event roll back too", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);

    const original = f.db.applyRawMaterialStockChange;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate fault injection
    (f.db as any).applyRawMaterialStockChange = () => { throw new Error("stock write exploded"); };

    await assert.rejects(() => f.scanIn(m.labels[0]), /stock write exploded/);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore
    (f.db as any).applyRawMaterialStockChange = original;

    assert.equal(f.stockOf(m.itemId), 0, "no stock");
    assert.deepEqual(f.statusOf(m.labels[0]), { status: RAW_MATERIAL_QR_STATUS.GENERATED, sectionId: null }, "status rolled back");
    assert.equal(f.journeyOf(m.labels[0]).length, 0, "no orphan journey event");
    assert.equal(f.countRows("inventory_stock_events"), 0);

    assert.equal((await f.scanIn(m.labels[0])).outcome, "RECEIVED", "and the packet still works afterwards");
    assert.equal(f.stockOf(m.itemId), 2);
  } finally {
    f.cleanup();
  }
});

test("when the journey write fails, the stock change rolls back too", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);

    const original = f.db.appendRawMaterialQrEvent;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate fault injection
    (f.db as any).appendRawMaterialQrEvent = () => { throw new Error("journey write exploded"); };

    await assert.rejects(() => f.scanIn(m.labels[0]), /journey write exploded/);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore
    (f.db as any).appendRawMaterialQrEvent = original;

    assert.equal(f.stockOf(m.itemId), 0, "stock rolled back with the failed event");
    assert.deepEqual(f.statusOf(m.labels[0]), { status: RAW_MATERIAL_QR_STATUS.GENERATED, sectionId: null });
    assert.equal(f.countRows("inventory_stock_events"), 0);
  } finally {
    f.cleanup();
  }
});

// ─── The two identities stay separate ────────────────────────────────────────────

test("the carton Store Move In screen turns a packet away and moves nothing", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);

    const result = await f.cartonMoveIn.execute({ rawScan: m.labels[0], context: CONTEXT, actor: "store-op" });

    assert.equal(result.accepted, false);
    assert.equal(result.outcome, "RAW_MATERIAL_NOT_SUPPORTED");
    assert.match(result.reason ?? "", /Raw Material Input/);
    assert.equal(f.stockOf(m.itemId), 0);
    assert.equal(f.journeyOf(m.labels[0]).length, 0);
  } finally {
    f.cleanup();
  }
});

test("the Raw Material Input screen turns a carton away", async () => {
  const f = createFixture();
  try {
    const carton = await f.scanIn("SK6_RED_7/10_000001");
    assert.equal(carton.accepted, false);
    assert.equal(carton.outcome, "INVALID_FORMAT");
    assert.match(carton.reason ?? "", /Store Move In/);

    const garbage = await f.scanIn("NOT A QR AT ALL");
    assert.equal(garbage.outcome, "INVALID_FORMAT");
  } finally {
    f.cleanup();
  }
});

// ─── The session, and what gets printed ──────────────────────────────────────────

test("a session records the delivery it took in, grouped by material for printing", async () => {
  const f = createFixture();
  try {
    const big = readyMaterial(f, "7/10", 2);
    const small = readyMaterial(f, "4/6", 3);

    await f.scanIn(big.labels[0]);
    await f.scanIn(big.labels[1]);
    await f.scanIn(small.labels[0]);

    const summary = f.db.getRawMaterialReceivingSessionSummary(f.session.id);
    assert.ok(summary);
    assert.equal(summary.session.partyName, "SHEHZAD RUBBER TOPPING");
    assert.match(summary.session.code, /^RMI-\d{6}$/);
    assert.equal(summary.totalPackets, 3);
    assert.deepEqual(
      summary.byMaterial.map((row) => `${row.itemDisplayName}: ${row.packets} packets = ${row.quantity} ${row.unitCode}`),
      [
        "RUBBER UPPER — SK6 — RED — 4/6: 1 packets = 3 DOZ",
        "RUBBER UPPER — SK6 — RED — 7/10: 2 packets = 4 DOZ",
      ]
    );
    assert.deepEqual(summary.scans.map((scan) => scan.qrId), [big.labels[0], big.labels[1], small.labels[0]]);
    assert.equal(summary.scans[0].actor, "store-op");
  } finally {
    f.cleanup();
  }
});

test("opening a session for another supplier closes the one that was open", () => {
  const f = createFixture();
  try {
    const first = f.session;
    assert.equal(first.status, "OPEN");

    const second = f.openSessionFor(f.otherSupplier);
    assert.notEqual(second.id, first.id);
    assert.equal(second.status, "OPEN");
    assert.equal(f.db.getRawMaterialReceivingSession(first.id)?.status, "CLOSED");
    assert.equal(f.db.getOpenRawMaterialReceivingSession("device-1")?.id, second.id);
  } finally {
    f.cleanup();
  }
});

test("closing a session leaves it readable for reprinting", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);
    await f.scanIn(m.labels[0]);

    const closed = f.db.closeRawMaterialReceivingSession(f.session.id);
    assert.equal(closed?.status, "CLOSED");
    assert.ok(closed?.closedAt);
    assert.equal(f.db.getOpenRawMaterialReceivingSession("device-1"), null);

    const summary = f.db.getRawMaterialReceivingSessionSummary(f.session.id);
    assert.equal(summary?.totalPackets, 1, "a closed session still prints what it took in");
  } finally {
    f.cleanup();
  }
});

// ─── QR Management / QR Journey ──────────────────────────────────────────────────

test("QR Management resolves a raw material packet and tracks its stage", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);

    const registered = f.db.getQrDetail(m.labels[0]);
    assert.ok(registered);
    assert.equal(registered.kind, "RAW_MATERIAL");
    assert.equal(registered.stage, "REGISTERED");
    assert.equal(registered.article, "RUBBER UPPER — SK6 — RED — 7/10");
    assert.equal(registered.size, "2 DOZ", "the packing stands in for a carton's size");
    assert.equal(registered.supplierName, "SHEHZAD RUBBER TOPPING");
    assert.equal(registered.productVariantId, null, "a packet has no product variant");

    await f.scanIn(m.labels[0]);
    const received = f.db.getQrDetail(m.labels[0]);
    assert.equal(received?.stage, "WAREHOUSE");
    assert.equal(received?.events.length, 1);
  } finally {
    f.cleanup();
  }
});

test("QR Journey shows a packet's path in the shared journey shape", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);
    await f.scanIn(m.labels[0]);

    const journey = f.db.getQrJourney(m.labels[0]);
    assert.ok(journey);
    assert.equal(journey.kind, "RAW_MATERIAL");
    assert.equal(journey.stage, "WAREHOUSE");
    // The journey speaks the shared stage vocabulary, not the packet lifecycle words, so
    // one screen can label a carton hop and a packet hop with the same code.
    assert.equal(journey.currentStatus, "WAREHOUSE");
    assert.equal(journey.currentPlace, "WAREHOUSE", "a packet in the store is in the same place a carton is");
    assert.deepEqual(
      journey.steps.map((step) => `${step.kind}:${step.fromStatus ?? "-"}->${step.toStatus}`),
      ["REGISTERED:-->REGISTERED", "STORE_ENTRY:REGISTERED->WAREHOUSE"]
    );
    assert.match(journey.steps[1].note ?? "", /2 DOZ received into the store/);
  } finally {
    f.cleanup();
  }
});

test("QR Management search finds packets by code and by material name", () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);

    const byCode = f.db.searchQrCodes(m.labels[0], 10);
    assert.equal(byCode.length, 1);
    assert.equal(byCode[0].qrId, m.labels[0]);

    const byName = f.db.searchQrCodes("RUBBER", 10);
    assert.ok(byName.some((row) => row.qrId === m.labels[0]));

    assert.deepEqual(f.db.searchQrCodes("NOTHINGMATCHESTHIS", 10), []);
  } finally {
    f.cleanup();
  }
});

test("an unregistered raw material code has no detail and no journey", () => {
  const f = createFixture();
  try {
    assert.equal(f.db.getQrDetail("RMQR_PTY999999_RM999999_000001"), null);
    assert.equal(f.db.getQrJourney("RMQR_PTY999999_RM999999_000001"), null);
  } finally {
    f.cleanup();
  }
});

// ─── Issuing out of the store ────────────────────────────────────────────────────
// The mirror of receiving. A packet is simply taken out of the store — raw material routes
// were removed on 2026-10-07, so nothing asks or records where it goes next.

test("a packet is issued out of the store: stock falls, journey continues", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);
    await f.scanIn(m.labels[0]);

    const result = await f.scanOut(m.labels[0]);

    assert.equal(result.accepted, true, result.reason);
    assert.equal(result.outcome, "ISSUED");
    assert.equal(result.packingQuantity, 2);
    assert.equal(result.currentStatus, RAW_MATERIAL_QR_STATUS.ISSUED);

    assert.equal(f.stockOf(m.itemId), 0, "the packet left the store");
    assert.deepEqual(f.statusOf(m.labels[0]), { status: RAW_MATERIAL_QR_STATUS.ISSUED, sectionId: null });
    assert.deepEqual(f.journeyOf(m.labels[0]), ["STORE_ENTRY:2:GENERATED->IN_STORE", "STORE_EXIT:2:IN_STORE->ISSUED"]);
  } finally {
    f.cleanup();
  }
});

test("issuing a packet that is not in the store is refused and changes nothing", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);

    const neverReceived = await f.scanOut(m.labels[0]);
    assert.equal(neverReceived.accepted, false);
    assert.equal(neverReceived.outcome, "NOT_IN_STORE");
    assert.match(neverReceived.reason ?? "", /Raw Material Input/);

    await f.scanIn(m.labels[0]);
    await f.scanOut(m.labels[0]);
    // It has already left, so there is nothing in the store to take out again.
    const twice = await f.scanOut(m.labels[0]);
    assert.equal(twice.accepted, false);
    assert.equal(twice.outcome, "NOT_IN_STORE");
    assert.match(twice.reason ?? "", /Raw Material Input/);

    assert.equal(f.stockOf(m.itemId), 0, "no refusal moved stock");
    assert.equal(f.journeyOf(m.labels[0]).length, 2, "no duplicate movement event");
  } finally {
    f.cleanup();
  }
});

test("a material needs no destination to be issued — only a packing", async () => {
  const f = createFixture();
  try {
    const item = f.makeItem("SK9", "BLACK", "11/14");
    f.configure(item.id, 2);
    const [label] = f.labelsFor(item.id, 1);

    assert.equal((await f.scanIn(label)).outcome, "RECEIVED");

    const out = await f.scanOut(label);
    assert.equal(out.accepted, true, out.reason);
    assert.equal(out.outcome, "ISSUED");
    assert.equal(f.stockOf(item.id), 0, "the packet left the store");
    assert.deepEqual(f.statusOf(label), { status: RAW_MATERIAL_QR_STATUS.ISSUED, sectionId: null });
  } finally {
    f.cleanup();
  }
});

test("an unregistered code cannot be issued and creates nothing", async () => {
  const f = createFixture();
  try {
    const before = f.countRows("raw_material_qrs");
    const result = await f.scanOut("RMQR_PTY999999_RM999999_000001");
    assert.equal(result.outcome, "UNKNOWN_QR");
    assert.equal(f.countRows("raw_material_qrs"), before);
    assert.equal(f.countRows("raw_material_qr_events"), 0);
  } finally {
    f.cleanup();
  }
});

test("the Raw Material Output screen turns a carton away", async () => {
  const f = createFixture();
  try {
    const carton = await f.scanOut("SK6_RED_7/10_000001");
    assert.equal(carton.accepted, false);
    assert.equal(carton.outcome, "INVALID_FORMAT");
    assert.match(carton.reason ?? "", /Store Move Out/);
  } finally {
    f.cleanup();
  }
});

test("a packet issued and then received again nets back to stock", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);
    await f.scanIn(m.labels[0]);
    await f.scanOut(m.labels[0]);
    await f.scanIn(m.labels[0]);

    assert.equal(f.stockOf(m.itemId), 2);
    assert.deepEqual(f.journeyOf(m.labels[0]), [
      "STORE_ENTRY:2:GENERATED->IN_STORE",
      "STORE_EXIT:2:IN_STORE->ISSUED",
      "STORE_ENTRY:2:ISSUED->IN_STORE",
    ]);
  } finally {
    f.cleanup();
  }
});

test("when the issue stock write fails, the status and journey roll back too", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);
    await f.scanIn(m.labels[0]);

    const original = f.db.applyRawMaterialStockChange;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate fault injection
    (f.db as any).applyRawMaterialStockChange = () => { throw new Error("stock write exploded"); };

    await assert.rejects(() => f.scanOut(m.labels[0]), /stock write exploded/);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore
    (f.db as any).applyRawMaterialStockChange = original;

    assert.equal(f.stockOf(m.itemId), 2, "still in stock");
    assert.deepEqual(f.statusOf(m.labels[0]), { status: RAW_MATERIAL_QR_STATUS.IN_STORE, sectionId: null }, "status rolled back");
    assert.equal(f.journeyOf(m.labels[0]).length, 1, "no orphan journey event");

    assert.equal((await f.scanOut(m.labels[0])).outcome, "ISSUED", "and the packet still works afterwards");
  } finally {
    f.cleanup();
  }
});

test("an issue session records what left, grouped by destination for the slip", async () => {
  const f = createFixture();
  try {
    const upper = readyMaterial(f, "7/10", 2);
    const sole = f.makeItem("SK6", "RED", "4/6");
    f.configure(sole.id, 3);
    const soleLabels = f.labelsFor(sole.id, 2);

    for (const label of [upper.labels[0], upper.labels[1], soleLabels[0]]) await f.scanIn(label);
    for (const label of [upper.labels[0], upper.labels[1], soleLabels[0]]) await f.scanOut(label);

    const summary = f.db.getRawMaterialIssueSessionSummary(f.issueSession.id);
    assert.ok(summary);
    assert.match(summary.session.code, /^RMO-\d{6}$/);
    assert.equal(summary.totalPackets, 3);
    // Nothing carries a destination any more, so the slip is one list of what left.
    assert.deepEqual(
      summary.bySection.map((s) => `${s.sectionName}: ${s.packets}`),
      ["Out of the store: 3"]
    );
    assert.deepEqual(summary.bySection[0].materials.map((m) => `${m.itemDisplayName} ${m.packets}x = ${m.quantity} ${m.unitCode}`), [
      "RUBBER UPPER — SK6 — RED — 4/6 1x = 3 DOZ",
      "RUBBER UPPER — SK6 — RED — 7/10 2x = 4 DOZ",
    ]);
    assert.equal(summary.scans.length, 3);
    assert.equal(summary.scans[0].sectionName, null);
  } finally {
    f.cleanup();
  }
});

test("an issue session resumes on the same day and can be replaced on demand", () => {
  const f = createFixture();
  try {
    const first = f.issueSession;
    const resumed = f.db.startOrResumeRawMaterialIssueSession({ deviceId: "device-1", startedBy: "aslam" });
    assert.equal(resumed.id, first.id, "the same day resumes the open run");

    const fresh = f.db.startOrResumeRawMaterialIssueSession({ deviceId: "device-1", startedBy: "aslam", startNew: true });
    assert.notEqual(fresh.id, first.id);
    assert.equal(f.db.getRawMaterialIssueSession(first.id)?.status, "CLOSED");

    const closed = f.db.closeRawMaterialIssueSession(fresh.id);
    assert.equal(closed?.status, "CLOSED");
    assert.ok(closed?.closedAt);
  } finally {
    f.cleanup();
  }
});

test("an issued packet's journey reads in the shared stage vocabulary", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);
    await f.scanIn(m.labels[0]);
    await f.scanOut(m.labels[0]);

    const journey = f.db.getQrJourney(m.labels[0]);
    assert.ok(journey);
    assert.equal(journey.stage, "ISSUED");
    assert.equal(journey.currentStatus, "ISSUED");
    assert.deepEqual(
      journey.steps.map((step) => `${step.kind}:${step.fromStatus ?? "-"}->${step.toStatus}`),
      ["REGISTERED:-->REGISTERED", "STORE_ENTRY:REGISTERED->WAREHOUSE", "STORE_EXIT:WAREHOUSE->ISSUED"]
    );
    assert.match(journey.steps[2].note ?? "", /2 DOZ issued/);
    // Dwell lands in the shared buckets, so the page's ordered list finds it.
    assert.ok(Object.keys(journey.dwellMs).every((key) => ["REGISTERED", "WAREHOUSE", "ISSUED"].includes(key)), Object.keys(journey.dwellMs).join(","));
  } finally {
    f.cleanup();
  }
});

test("the journey names the party the packet was moved out to, and no section", async () => {
  const f = createFixture();
  try {
    const upper = readyMaterial(f, "7/10", 2);
    await f.scanIn(upper.labels[0]);
    await f.scanOut(upper.labels[0]);

    const journey = f.db.getQrJourney(upper.labels[0]);
    assert.ok(journey);
    // Since 0.3.6 Scan Out records who it went to, and the exit hop says so. Sections were
    // removed on 2026-10-07 and stay removed: the current-stage label still names none.
    assert.equal(journey.steps[2].toStatusLabel, "Issued to SHEHZAD RUBBER TOPPING");
    assert.equal(journey.stageLabel, null);
    // A packet in the store is in a place the status already names, so no override.
    assert.equal(journey.steps[1].toStatusLabel, null);
    assert.equal(journey.steps[1].toPlace, "WAREHOUSE", "the entry hop still lands in the store");

    assert.equal(f.db.getQrDetail(upper.labels[0])?.stageLabel, null);
  } finally {
    f.cleanup();
  }
});

test("a second material is issued the same way — to its party, never to a section", async () => {
  const f = createFixture();
  try {
    const ragzine = f.makeItem("RAGZINE", "BLACK", "54/54");
    f.configure(ragzine.id, 20);
    const [label] = f.labelsFor(ragzine.id, 1);

    await f.scanIn(label);
    await f.scanOut(label);

    const journey = f.db.getQrJourney(label);
    assert.equal(journey?.steps[2].toStatusLabel, "Issued to SHEHZAD RUBBER TOPPING");
    assert.equal(journey?.stageLabel, null);
  } finally {
    f.cleanup();
  }
});

// ─── Scan Out names who the packet goes to (0.3.6) ──────────────────────────────

test("scan out without a party is refused, and the packet stays in the store", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);
    await f.scanIn(m.labels[0]);
    const before = f.stockOf(m.itemId);

    for (const partyId of ["", "   "]) {
      const refused = await f.scanOutTo(m.labels[0], partyId);
      assert.equal(refused.accepted, false);
      assert.equal(refused.outcome, "NO_PARTY");
    }
    assert.equal(f.stockOf(m.itemId), before, "nothing came off the balance");
    assert.equal(f.statusOf(m.labels[0])?.status, RAW_MATERIAL_QR_STATUS.IN_STORE);
    assert.deepEqual(f.journeyOf(m.labels[0]), ["STORE_ENTRY:2:GENERATED->IN_STORE"], "no exit was recorded");
  } finally {
    f.cleanup();
  }
});

test("only an active supplier or contractor can receive a packet", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);
    await f.scanIn(m.labels[0]);
    const party = (partyName: string, partyType: string, status = "ACTIVE") =>
      f.db.createParty({ partyName, partyType, city: "Lahore", mobileNumber: "0300-9999999", status });

    const customer = party("WALK-IN CUSTOMER", "CUSTOMER");
    const retired = party("OLD CONTRACTOR", "CONTRACTOR", "INACTIVE");
    for (const refusedParty of [customer, retired, "party-nobody"]) {
      const refused = await f.scanOutTo(m.labels[0], refusedParty);
      assert.equal(refused.outcome, "NO_PARTY", `${refusedParty} must not receive raw material`);
    }
    assert.equal(f.statusOf(m.labels[0])?.status, RAW_MATERIAL_QR_STATUS.IN_STORE, "every refusal left it in the store");

    const contractor = party("ASLAM UPPER MAKER", "CONTRACTOR");
    const issued = await f.scanOutTo(m.labels[0], contractor);
    assert.equal(issued.outcome, "ISSUED", issued.reason);
    assert.equal(issued.issuedToPartyName, "ASLAM UPPER MAKER");
  } finally {
    f.cleanup();
  }
});

test("the party is kept on the packet's exit and named in its journey", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);
    await f.scanIn(m.labels[0]);
    const contractor = f.db.createParty({
      partyName: "ASLAM UPPER MAKER", partyType: "CONTRACTOR", city: "Lahore", mobileNumber: "0300-8888888", status: "ACTIVE",
    });

    assert.equal((await f.scanOutTo(m.labels[0], contractor)).outcome, "ISSUED");

    const exit = f.raw
      .prepare("SELECT metadata_json FROM raw_material_qr_events WHERE qr_id = ? AND event_type = 'STORE_EXIT'")
      .get(m.labels[0]) as { metadata_json: string };
    assert.equal(JSON.parse(exit.metadata_json).issuedToPartyId, contractor, "kept with the exit, no migration needed");

    const journey = f.db.getRawMaterialQrJourney(m.labels[0]);
    const last = journey?.steps[journey.steps.length - 1];
    assert.equal(last?.toStatusLabel, "Issued to ASLAM UPPER MAKER");
    assert.match(last?.note ?? "", /issued to ASLAM UPPER MAKER/);
  } finally {
    f.cleanup();
  }
});

// ─── ONE SESSION, ONE PARTY (0.3.8) ─────────────────────────────────────────
// Move Out starts a session only for a chosen party, and the session's party is its first packet's.

test("the open issue session is found without starting one, and none is made when there is none", () => {
  const f = createFixture();
  try {
    assert.equal(f.db.getOpenRawMaterialIssueSession("device-1")?.id, f.issueSession.id);
    f.db.closeRawMaterialIssueSession(f.issueSession.id);
    assert.equal(f.db.getOpenRawMaterialIssueSession("device-1"), null);
    assert.equal(f.countRows("raw_material_issue_sessions"), 1, "looking did not open a session");
  } finally {
    f.cleanup();
  }
});

test("a session's party is its first packet's, and a session with nothing in it has none", async () => {
  const f = createFixture();
  try {
    assert.equal(f.db.rawMaterialIssueSessionPartyId(f.issueSession.id), null);
    assert.equal(f.db.getRawMaterialIssueSessionSummary(f.issueSession.id)?.partyId, null);

    const m = readyMaterial(f, "7/10", 2);
    await f.scanIn(m.labels[0]);
    await f.scanIn(m.labels[1]);
    await f.scanOutTo(m.labels[0], f.otherSupplier);
    await f.scanOutTo(m.labels[1], f.supplier);

    assert.equal(f.db.rawMaterialIssueSessionPartyId(f.issueSession.id), f.otherSupplier, "the first packet decides");
    assert.equal(f.db.getRawMaterialIssueSessionSummary(f.issueSession.id)?.partyId, f.otherSupplier);
  } finally {
    f.cleanup();
  }
});

test("a Machine Program batch on the session, which names no party, does not decide the session's party", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);
    await f.scanIn(m.labels[0]);
    await f.scanIn(m.labels[1]);
    await f.scanOutTo(m.labels[0], f.otherSupplier);
    // A program batch rides this session with no party stamped: the first exit, recorded that way.
    f.raw
      .prepare("UPDATE raw_material_qr_events SET metadata_json = json_remove(metadata_json, '$.issuedToPartyId') WHERE qr_id = ? AND event_type = 'STORE_EXIT'")
      .run(m.labels[0]);
    assert.equal(f.db.rawMaterialIssueSessionPartyId(f.issueSession.id), null, "a program batch alone does not lock the session");

    await f.scanOutTo(m.labels[1], f.supplier);
    assert.equal(f.db.rawMaterialIssueSessionPartyId(f.issueSession.id), f.supplier, "the first scanned packet decides");
  } finally {
    f.cleanup();
  }
});

test("the Move Out slip's summary names the party and totals each material, as the Move In receipt does", async () => {
  const f = createFixture();
  try {
    const empty = f.db.getRawMaterialIssueSessionSummary(f.issueSession.id);
    assert.equal(empty?.partyName, null);
    assert.deepEqual(empty?.byMaterial, []);

    const m = readyMaterial(f, "7/10", 3);
    for (const label of m.labels) await f.scanIn(label);
    for (const label of m.labels) await f.scanOutTo(label, f.otherSupplier);

    const summary = f.db.getRawMaterialIssueSessionSummary(f.issueSession.id);
    assert.equal(summary?.partyName, f.db.getParty(f.otherSupplier)?.partyName);
    assert.equal(summary?.byMaterial.length, 1, "one material, one line");
    assert.equal(summary?.byMaterial[0].packets, 3);
    const bySectionQuantity = summary?.bySection.flatMap((section) => section.materials).reduce((sum, row) => sum + row.quantity, 0);
    assert.equal(summary?.byMaterial[0].quantity, bySectionQuantity, "the same quantity, however it is grouped");
  } finally {
    f.cleanup();
  }
});

// ─── RECEIVING FROM SUPPLIERS ONLY (owner, 0.3.9) ───────────────────────────────
// Labels are printed for suppliers alone and a packet is received only into its own supplier's
// session, so a session for anyone else could never receive. Return Upper has its own path.

test("a receiving session is only ever started for a supplier", () => {
  const f = createFixture();
  try {
    const contractor = f.db.createParty({ partyName: "ASLAM UPPER MAKER", partyType: "CONTRACTOR", city: "Lahore", mobileNumber: "0300-9999999", status: "ACTIVE" });
    const before = f.countRows("raw_material_receiving_sessions");
    assert.throws(
      () => f.db.startRawMaterialReceivingSession({ partyId: contractor, deviceId: "device-1", startedBy: "aslam" }),
      /ASLAM UPPER MAKER is not a supplier\. Nothing was started\./
    );
    assert.equal(f.countRows("raw_material_receiving_sessions"), before, "nothing was started, and no number was used");
    assert.ok(f.db.startRawMaterialReceivingSession({ partyId: f.otherSupplier, deviceId: "device-1", startedBy: "aslam" }).id);
  } finally {
    f.cleanup();
  }
});

test("material is moved in by hand only from a supplier", () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);
    const unitCode = f.db.inventoryItemStockUnit(m.itemId)?.code ?? "DOZEN";
    const contractor = f.db.createParty({ partyName: "ASLAM UPPER MAKER", partyType: "CONTRACTOR", city: "Lahore", mobileNumber: "0300-9999999", status: "ACTIVE" });

    const refused = f.db.moveRawMaterialByHand({ itemId: m.itemId, direction: "IN", quantity: 2, unitCode, partyId: contractor, actor: "aslam" });
    assert.equal(refused.outcome, "NO_SUPPLIER");
    assert.match(refused.reason ?? "", /ASLAM UPPER MAKER is not a supplier/);
    assert.equal(f.stockOf(m.itemId), 0, "nothing was moved");

    const moved = f.db.moveRawMaterialByHand({ itemId: m.itemId, direction: "IN", quantity: 2, unitCode, partyId: f.supplier, actor: "aslam" });
    assert.equal(moved.outcome, "MOVED", moved.reason);
  } finally {
    f.cleanup();
  }
});

// ─── ISSUE SESSIONS, LISTED (0.3.9): Issued today, and the last session ───────────

test("issue sessions are listed newest first, each with its party and packet count", async () => {
  const f = createFixture();
  try {
    const m = readyMaterial(f, "7/10", 2);
    for (const label of m.labels) await f.scanIn(label);
    await f.scanOutTo(m.labels[0], f.otherSupplier);
    await f.scanOutTo(m.labels[1], f.otherSupplier);
    f.db.closeRawMaterialIssueSession(f.issueSession.id);
    // Another computer's session today, with nothing in it yet.
    const elsewhere = f.db.startOrResumeRawMaterialIssueSession({ deviceId: "device-2", startedBy: "babar" });

    const today = f.db.localYmd(new Date());
    const rows = f.db.listRawMaterialIssueSessions({ dateFrom: today, dateTo: today });
    assert.deepEqual(rows.map((row) => row.session.id), [elsewhere.id, f.issueSession.id], "every computer's, newest first");
    const mine = rows[1];
    assert.equal(mine.packets, 2);
    assert.equal(mine.partyId, f.otherSupplier);
    assert.equal(mine.partyName, f.db.getParty(f.otherSupplier)?.partyName);
    assert.equal(rows[0].packets, 0);
    assert.equal(rows[0].partyName, null, "a session with nothing in it has no party yet");

    const last = f.db.listRawMaterialIssueSessions({ deviceId: "device-1", status: "CLOSED", limit: 1 });
    assert.deepEqual(last.map((row) => row.session.id), [f.issueSession.id], "this computer's last closed session");
    assert.deepEqual(f.db.listRawMaterialIssueSessions({ deviceId: "device-2", status: "CLOSED" }), []);
  } finally {
    f.cleanup();
  }
});

test("a session started yesterday is not issued today", () => {
  const f = createFixture();
  try {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    f.raw.prepare("UPDATE raw_material_issue_sessions SET started_at = ? WHERE id = ?").run(yesterday, f.issueSession.id);
    const today = f.db.localYmd(new Date());
    assert.deepEqual(f.db.listRawMaterialIssueSessions({ dateFrom: today, dateTo: today }), []);
  } finally {
    f.cleanup();
  }
});
