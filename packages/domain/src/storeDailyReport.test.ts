import test from "node:test";
import assert from "node:assert/strict";
import {
  STOCK_EVENT_NOTE,
  STORE_DIRECTION,
  STORE_MOVEMENT_SOURCE,
  buildStoreDailyReport,
  isScanStockEvent,
  stockEventDirection,
  stockEventSource,
  type StoreDayCartonEntry,
  type StoreDayMaterialEntry,
} from "./index.js";

// The store's daily report: which way each stock event moved, what kind of movement it was, and
// the day's totals.

const material = (overrides: Partial<StoreDayMaterialEntry> = {}): StoreDayMaterialEntry => ({
  kind: "MATERIAL",
  id: "m1",
  source: STORE_MOVEMENT_SOURCE.SCAN,
  at: "2026-10-13T09:00:00.000",
  itemId: "dana",
  itemDisplayName: "DANA EVA BLACK",
  quantity: 25,
  unitCode: "KG",
  qrId: null,
  partyName: null,
  sectionName: null,
  programCode: null,
  note: null,
  actor: null,
  ...overrides,
});

const carton = (overrides: Partial<StoreDayCartonEntry> = {}): StoreDayCartonEntry => ({
  kind: "CARTON",
  id: "c1",
  source: STORE_MOVEMENT_SOURCE.CARTON,
  at: "2026-10-13T10:00:00.000",
  qrId: "Q1",
  article: "SK6",
  color: "BLACK",
  size: "7/10",
  programCode: null,
  actor: null,
  ...overrides,
});

test("direction comes from the event type, not the sign — a scanned packet out is written positive", () => {
  assert.equal(stockEventDirection("RECEIVE", 10), STORE_DIRECTION.IN);
  assert.equal(stockEventDirection("TRANSFER_OUT", 5), STORE_DIRECTION.OUT, "scan out: positive quantity, still out");
  assert.equal(stockEventDirection("TRANSFER_OUT", -5), STORE_DIRECTION.OUT, "typed out: negative quantity");
  assert.equal(stockEventDirection("CONSUME", -1), STORE_DIRECTION.OUT);
  assert.equal(stockEventDirection("ADJUST", 3), STORE_DIRECTION.IN, "a correction up adds to the store");
  assert.equal(stockEventDirection("ADJUST", -3), STORE_DIRECTION.OUT);
  assert.equal(stockEventDirection("ADJUST", 0), null, "a correction of nothing moved nothing");
});

test("a scan's own stock event is recognised, so a scan is never counted twice", () => {
  assert.equal(isScanStockEvent(`${STOCK_EVENT_NOTE.SCAN_IN} RMQ-1`), true);
  assert.equal(isScanStockEvent(`${STOCK_EVENT_NOTE.SCAN_OUT} RMQ-1`), true);
  assert.equal(isScanStockEvent(`${STOCK_EVENT_NOTE.MANUAL_OUT} — 5 KG`), false);
  assert.equal(isScanStockEvent(null), false);
});

test("each typed movement says what it was", () => {
  const source = (eventType: string, note: string | null, machineProgramId: string | null = null) => stockEventSource({ eventType, note, machineProgramId });
  assert.equal(source("TRANSFER_OUT", `${STOCK_EVENT_NOTE.MANUAL_OUT} — 700 INCH`), STORE_MOVEMENT_SOURCE.MANUAL);
  assert.equal(source("RECEIVE", `${STOCK_EVENT_NOTE.MANUAL_IN} — 2 RULE`), STORE_MOVEMENT_SOURCE.MANUAL);
  assert.equal(source("TRANSFER_OUT", "Dana for MP-000012 — 50 KG", "program-1"), STORE_MOVEMENT_SOURCE.DANA);
  assert.equal(source("ADJUST", "Counted wrong (SC-000001, approved by admin)"), STORE_MOVEMENT_SOURCE.CORRECTION);
  assert.equal(source("RECEIVE", STOCK_EVENT_NOTE.OPENING), STORE_MOVEMENT_SOURCE.OPENING);
  assert.equal(source("RECEIVE", `${STOCK_EVENT_NOTE.CUT_SIZE} — MP-000012`), STORE_MOVEMENT_SOURCE.CUT_SIZE);
  assert.equal(source("RECEIVE", null), STORE_MOVEMENT_SOURCE.OTHER, "unknown is shown, not hidden");
});

test("the day's totals: packets and typed moves per material, cartons per product, counts per source", () => {
  const report = buildStoreDailyReport({
    date: "2026-10-13",
    direction: STORE_DIRECTION.IN,
    materials: [
      material({ id: "a", quantity: 25 }),
      material({ id: "b", quantity: 25 }),
      material({ id: "c", quantity: 0.1, source: STORE_MOVEMENT_SOURCE.MANUAL }),
      material({ id: "d", quantity: 0.2, source: STORE_MOVEMENT_SOURCE.MANUAL }),
      material({ id: "e", itemId: "nawaar", itemDisplayName: "NAWAAR", quantity: 975, unitCode: "INCH", source: STORE_MOVEMENT_SOURCE.MANUAL }),
    ],
    cartons: [carton({ id: "x" }), carton({ id: "y" }), carton({ id: "z", color: "RED", source: STORE_MOVEMENT_SOURCE.GATE_RETURN })],
  });

  assert.equal(report.summary.movements, 8);
  assert.equal(report.summary.packets, 2);
  assert.equal(report.summary.cartons, 3);
  assert.deepEqual(report.summary.byMaterial, [
    { itemId: "dana", itemDisplayName: "DANA EVA BLACK", unitCode: "KG", quantity: 50.3, packets: 2, typed: 2 },
    { itemId: "nawaar", itemDisplayName: "NAWAAR", unitCode: "INCH", quantity: 975, packets: 0, typed: 1 },
  ]);
  assert.deepEqual(report.summary.byProduct, [
    { article: "SK6", color: "BLACK", size: "7/10", cartons: 2 },
    { article: "SK6", color: "RED", size: "7/10", cartons: 1 },
  ]);
  assert.deepEqual(report.summary.bySource, [
    { source: STORE_MOVEMENT_SOURCE.SCAN, count: 2 },
    { source: STORE_MOVEMENT_SOURCE.MANUAL, count: 3 },
    { source: STORE_MOVEMENT_SOURCE.CARTON, count: 2 },
    { source: STORE_MOVEMENT_SOURCE.GATE_RETURN, count: 1 },
  ]);
});

test("one material counted in two units stays two rows — KG and BAG are never added", () => {
  const report = buildStoreDailyReport({
    date: "2026-10-13",
    direction: STORE_DIRECTION.OUT,
    materials: [material({ id: "a", unitCode: "KG" }), material({ id: "b", unitCode: "BAG", quantity: 1 })],
    cartons: [],
  });
  assert.deepEqual(report.summary.byMaterial.map((row) => `${row.quantity} ${row.unitCode}`), ["1 BAG", "25 KG"]);
});

test("movements are listed newest first across both kinds, and the list is capped while the totals are not", () => {
  const report = buildStoreDailyReport({
    date: "2026-10-13",
    direction: STORE_DIRECTION.OUT,
    // A UTC instant (typed) and zone-less local times (scans) side by side.
    materials: [material({ id: "early", at: "2026-10-13T08:00:00.000" }), material({ id: "late", at: "2026-10-13T11:00:00.000" })],
    cartons: [carton({ id: "middle", at: "2026-10-13T10:00:00.000" })],
    limit: 2,
  });
  assert.deepEqual(report.entries.map((entry) => entry.id), ["late", "middle"]);
  assert.equal(report.entryCount, 3);
  assert.equal(report.summary.movements, 3);
});
