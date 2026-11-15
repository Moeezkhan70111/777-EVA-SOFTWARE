import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SqliteDatabase } from "./sqliteDatabase.js";

// STORE HAND VOUCHERS (docs/49), MOVING IN: several materials that came in without labels, as one numbered voucher that can be
// printed, edited or deleted on its own day, and read back by number.
//
// What these tests hold in place: every line moves stock exactly as a hand move in does; an edit or a delete never
// rewrites a movement, it reverses it; a reversal never takes back material that has already gone out; and nothing
// is half-written.

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-hand-voucher-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "v.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(2, "test");
  for (const [code, name] of [["RULE", "Rule"], ["INCH", "Inch"], ["KG", "Kilogram"]]) db.createInventoryUnit({ code, name });
  const units = db.listInventoryUnits() as Array<{ id: string; code: string }>;
  const unitId = (code: string) => units.find((unit) => unit.code === code)!.id;
  const categoryId = db.createInventoryCategory({ name: "NAWAAR" });
  db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "ARTICLE", fieldType: "TEXT", required: true });
  // Nawaar kept in INCH, one rule of it 975 inches. Dana kept in KG.
  const nawaar = db.createInventoryItem({ categoryId, unitId: unitId("INCH"), values: { article: "5 SOOTAR" } }).id;
  db.setInventoryItemUnitLadder({ itemId: nawaar, steps: [{ fromUnitId: unitId("RULE"), toUnitId: unitId("INCH"), factor: 975 }] });
  const dana = db.createInventoryItem({ categoryId, unitId: unitId("KG"), values: { article: "DANA EVA" } }).id;
  const supplier = db.createParty({ partyName: "SHEHZAD RUBBER", partyType: "SUPPLIER" });
  const raw = (db as unknown as { db: DatabaseSync }).db;
  const onHand = (itemId: string): number => db.getRawMaterialHandMoveOptions(itemId, "IN")!.quantityOnHand;
  const count = (sql: string, ...args: string[]): number => Number((raw.prepare(sql).get(...args) as { n: number }).n);
  return { db, raw, nawaar, dana, supplier, onHand, count };
}

type Fixture = ReturnType<typeof createFixture>;

const save = (f: Fixture, lines: Array<{ itemId: string; quantity: unknown; unitCode: string }>, requestId: string = crypto.randomUUID()) =>
  f.db.saveHandVoucher({ direction: "IN", requestId, partyId: f.supplier, note: "Bilty 42", lines, actor: "aslam" });

test("one voucher moves every line in, under this computer's next number", () => {
  const f = createFixture();
  const { voucher } = save(f, [
    { itemId: f.nawaar, quantity: 3, unitCode: "RULE" },
    { itemId: f.dana, quantity: "50", unitCode: "KG" },
  ]);

  assert.equal(voucher.code, "SIV-100000", "block 2 numbers from 100,000");
  assert.equal(voucher.partyName, "SHEHZAD RUBBER");
  assert.equal(voucher.status, "POSTED");
  assert.equal(voucher.editable, true);
  assert.deepEqual(voucher.lines.map((line) => [line.lineNo, line.typedQuantity, line.typedUnitCode, line.quantity, line.stockUnitCode]), [
    [1, 3, "RULE", 2925, "INCH"],
    [2, 50, "KG", 50, "KG"],
  ]);
  assert.equal(f.onHand(f.nawaar), 2925);
  assert.equal(f.onHand(f.dana), 50);
  const first = f.raw
    .prepare("SELECT e.note FROM store_hand_voucher_lines l JOIN inventory_stock_events e ON e.id = l.stock_event_id WHERE l.line_no = 1")
    .get() as { note: string };
  assert.equal(first.note, "Manual move in — 3 RULE · SIV-100000 · Bilty 42", "the movement names the voucher, and reads as a hand move in");
});

test("a Save retried with the same id finds the voucher it made, and moves nothing again", () => {
  const f = createFixture();
  const requestId = crypto.randomUUID();
  save(f, [{ itemId: f.dana, quantity: 10, unitCode: "KG" }], requestId);
  const again = save(f, [{ itemId: f.dana, quantity: 10, unitCode: "KG" }], requestId);
  assert.equal(again.duplicate, true);
  assert.equal(f.onHand(f.dana), 10);
  assert.equal(f.count("SELECT COUNT(*) AS n FROM store_hand_vouchers"), 1);
});

test("a voucher with one bad line is refused whole, and nothing moves", () => {
  const f = createFixture();
  const refused = (lines: Array<{ itemId: string; quantity: unknown; unitCode: string }>, message: RegExp) =>
    assert.throws(() => save(f, lines), message);

  refused([], /at least one material/);
  refused([{ itemId: f.dana, quantity: 5, unitCode: "KG" }, { itemId: f.dana, quantity: 2, unitCode: "KG" }], /entered twice/);
  refused([{ itemId: f.dana, quantity: 5, unitCode: "KG" }, { itemId: f.nawaar, quantity: 0, unitCode: "RULE" }], /Line 2: .*above 0/);
  refused([{ itemId: f.dana, quantity: 5, unitCode: "KG" }, { itemId: f.nawaar, quantity: 1, unitCode: "KG" }], /Line 2: KG is not one of the units/);
  const contractor = f.db.createParty({ partyName: "ASLAM", partyType: "CONTRACTOR" });
  assert.throws(() => f.db.saveHandVoucher({ direction: "IN", requestId: crypto.randomUUID(), partyId: contractor, lines: [{ itemId: f.dana, quantity: 1, unitCode: "KG" }], actor: "aslam" }), /not a supplier/);

  assert.equal(f.onHand(f.dana), 0);
  assert.equal(f.count("SELECT COUNT(*) AS n FROM store_hand_vouchers"), 0);
  assert.equal(f.count("SELECT COUNT(*) AS n FROM inventory_stock_events WHERE note LIKE '%SIV-%'"), 0);
});

test("an edit reverses the old lines and moves the new ones in: the balance and the day follow, history stays", () => {
  const f = createFixture();
  const { voucher } = save(f, [{ itemId: f.nawaar, quantity: 3, unitCode: "RULE" }, { itemId: f.dana, quantity: 50, unitCode: "KG" }]);
  const { voucher: edited, changed } = f.db.editHandVoucher({
    voucherId: voucher.id, revision: voucher.revision, partyId: f.supplier, note: "Bilty 42",
    lines: [{ itemId: f.nawaar, quantity: 2, unitCode: "RULE" }],
    actor: "bilal",
  });

  assert.equal(changed, true);
  assert.equal(edited.code, voucher.code, "an edit keeps the number");
  assert.equal(edited.revision, 2);
  assert.equal(edited.updatedBy, "bilal");
  assert.deepEqual(edited.lines.map((line) => [line.typedQuantity, line.typedUnitCode]), [[2, "RULE"]]);
  assert.equal(f.onHand(f.nawaar), 1950);
  assert.equal(f.onHand(f.dana), 0);
  // +3 RULE, -3 RULE (reversed), +2 RULE: nothing rewritten.
  const nawaarEvents = f.raw.prepare("SELECT quantity, note FROM inventory_stock_events WHERE item_id = ? ORDER BY rowid").all(f.nawaar) as Array<{ quantity: number; note: string }>;
  assert.deepEqual(nawaarEvents.map((event) => event.quantity), [2925, -2925, 1950]);
  assert.match(nawaarEvents[1]!.note, /^Manual move in — reversed 3 RULE · SIV-100000 edited$/);

  const report = f.db.getStoreDailyReport(f.db.localYmd(new Date()), "IN")!;
  const byItem = new Map(report.summary.byMaterial.map((total) => [total.itemId, total.quantity]));
  assert.equal(byItem.get(f.nawaar), 1950, "the day's receipts net the reversal out");
  assert.equal(byItem.get(f.dana), 0);
});

test("an edit that changes nothing writes nothing, and an edit from an out-of-date screen is refused", () => {
  const f = createFixture();
  const { voucher } = save(f, [{ itemId: f.dana, quantity: 10, unitCode: "KG" }]);
  const body = { voucherId: voucher.id, partyId: f.supplier, note: "Bilty 42", actor: "aslam" };

  const same = f.db.editHandVoucher({ ...body, revision: voucher.revision, lines: [{ itemId: f.dana, quantity: "10", unitCode: "KG" }] });
  assert.equal(same.changed, false);
  assert.equal(same.voucher.revision, 1);

  f.db.editHandVoucher({ ...body, revision: 1, lines: [{ itemId: f.dana, quantity: 12, unitCode: "KG" }] });
  assert.throws(() => f.db.editHandVoucher({ ...body, revision: 1, lines: [{ itemId: f.dana, quantity: 15, unitCode: "KG" }] }), /changed by aslam since you opened it/);
  assert.equal(f.onHand(f.dana), 12);
});

test("a delete reverses every line and keeps the voucher, its number and its lines", () => {
  const f = createFixture();
  const { voucher } = save(f, [{ itemId: f.dana, quantity: 10, unitCode: "KG" }]);
  const deleted = f.db.deleteHandVoucher({ voucherId: voucher.id, revision: voucher.revision, actor: "bilal" });

  assert.equal(deleted.status, "DELETED");
  assert.equal(deleted.deletedBy, "bilal");
  assert.equal(deleted.editable, false);
  assert.equal(deleted.lines.length, 1, "the lines stay, to show what it said");
  assert.equal(f.onHand(f.dana), 0);
  assert.throws(() => f.db.deleteHandVoucher({ voucherId: voucher.id, revision: deleted.revision, actor: "bilal" }), /has been deleted/);
  assert.equal(save(f, [{ itemId: f.dana, quantity: 1, unitCode: "KG" }]).voucher.code, "SIV-100001", "a deleted number is never reused");
});

test("a change that would take back material already gone out is refused, and nothing changes", () => {
  const f = createFixture();
  const { voucher } = save(f, [{ itemId: f.nawaar, quantity: 1, unitCode: "RULE" }]);
  f.db.moveRawMaterialByHand({ itemId: f.nawaar, direction: "OUT", quantity: 900, unitCode: "INCH", note: "cutting table" });
  assert.equal(f.onHand(f.nawaar), 75);

  assert.throws(() => f.db.deleteHandVoucher({ voucherId: voucher.id, revision: 1, actor: "aslam" }), /already been used: only 75 INCH of it is still loose/);
  assert.throws(
    () => f.db.editHandVoucher({ voucherId: voucher.id, revision: 1, partyId: f.supplier, note: "Bilty 42", lines: [{ itemId: f.nawaar, quantity: 100, unitCode: "INCH" }], actor: "aslam" }),
    /already been used/
  );
  // Lowering it by no more than is still loose is allowed: 975 -> 950 takes back 25 of the 75.
  f.db.editHandVoucher({ voucherId: voucher.id, revision: 1, partyId: f.supplier, note: "Bilty 42", lines: [{ itemId: f.nawaar, quantity: 950, unitCode: "INCH" }], actor: "aslam" });
  assert.equal(f.onHand(f.nawaar), 50);
  assert.equal(f.db.handVoucherView("IN", null).voucher?.status, "POSTED");
});

test("only today's vouchers can be edited or deleted", () => {
  const f = createFixture();
  const { voucher } = save(f, [{ itemId: f.dana, quantity: 10, unitCode: "KG" }]);
  f.raw.prepare("UPDATE store_hand_vouchers SET business_date = '2026-01-02' WHERE id = ?").run(voucher.id);

  const view = f.db.handVoucherView("IN", voucher.voucherNumber);
  assert.equal(view.voucher?.editable, false);
  assert.throws(() => f.db.deleteHandVoucher({ voucherId: voucher.id, revision: 1, actor: "aslam" }), /earlier day/);
  assert.equal(f.onHand(f.dana), 10);
});

test("vouchers are read by number, with the numbers either side for Previous and Next", () => {
  const f = createFixture();
  assert.deepEqual(f.db.handVoucherView("IN", null), { voucher: null, previousNumber: null, nextNumber: null, latestNumber: null });
  for (let i = 0; i < 3; i += 1) save(f, [{ itemId: f.dana, quantity: 1, unitCode: "KG" }]);

  const newest = f.db.handVoucherView("IN", null);
  assert.deepEqual([newest.voucher?.voucherNumber, newest.previousNumber, newest.nextNumber, newest.latestNumber], [100002, 100001, null, 100002]);
  const middle = f.db.handVoucherView("IN", 100001);
  assert.deepEqual([middle.previousNumber, middle.nextNumber], [100000, 100002]);
  const missing = f.db.handVoucherView("IN", 7);
  assert.equal(missing.voucher, null);
  assert.deepEqual([missing.previousNumber, missing.nextNumber], [null, 100000]);
});

test("a voucher is this computer's own change: it and its edits are marked to travel as STORE_HAND_VOUCHER", () => {
  const f = createFixture();
  const { voucher } = save(f, [{ itemId: f.dana, quantity: 10, unitCode: "KG" }]);
  f.db.editHandVoucher({ voucherId: voucher.id, revision: 1, partyId: f.supplier, note: null, lines: [{ itemId: f.dana, quantity: 8, unitCode: "KG" }], actor: "aslam" });
  const dirty = f.raw.prepare("SELECT DISTINCT record_id FROM sync_dirty_records WHERE aggregate_type = 'STORE_HAND_VOUCHER'").all() as Array<{ record_id: string }>;
  assert.deepEqual(dirty.map((row) => row.record_id), [voucher.id]);
});

// ─── MOVING OUT ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Several materials going out without labels, to a supplier or contractor, saying what for. The same voucher, its own
// SOV- series; each line is a hand move out, so it is capped at what is in the store.

const issue = (f: Fixture, partyId: string, lines: Array<{ itemId: string; quantity: unknown; unitCode: string }>, note: string | null = "cutting table") =>
  f.db.saveHandVoucher({ direction: "OUT", requestId: crypto.randomUUID(), partyId, note, lines, actor: "aslam" });

const stocked = () => {
  const f = createFixture();
  save(f, [{ itemId: f.nawaar, quantity: 2, unitCode: "RULE" }, { itemId: f.dana, quantity: 100, unitCode: "KG" }]);
  const contractor = f.db.createParty({ partyName: "ASLAM", partyType: "CONTRACTOR" });
  return { f, contractor };
};

test("a Move Out voucher takes every line off the store, to its party, under its own SOV- series", () => {
  const { f, contractor } = stocked();
  const { voucher } = issue(f, contractor, [{ itemId: f.nawaar, quantity: 900, unitCode: "INCH" }, { itemId: f.dana, quantity: 30, unitCode: "KG" }]);

  assert.equal(voucher.code, "SOV-100000", "Move Out numbers are their own series");
  assert.equal(voucher.direction, "OUT");
  assert.equal(voucher.partyName, "ASLAM");
  assert.equal(f.onHand(f.nawaar), 1050);
  assert.equal(f.onHand(f.dana), 70);
  const events = f.raw
    .prepare("SELECT e.event_type, e.quantity, e.note, e.party_id FROM store_hand_voucher_lines l JOIN inventory_stock_events e ON e.id = l.stock_event_id WHERE l.voucher_id = ? ORDER BY l.line_no")
    .all(voucher.id) as Array<{ event_type: string; quantity: number; note: string; party_id: string }>;
  assert.deepEqual(events.map((event) => [event.event_type, event.quantity, event.party_id]), [["TRANSFER_OUT", -900, contractor], ["TRANSFER_OUT", -30, contractor]]);
  assert.equal(events[0]!.note, "Manual move out — 900 INCH · SOV-100000 · cutting table");
  assert.equal(f.db.handVoucherView("OUT", null).voucher?.code, "SOV-100000");
  assert.equal(f.db.handVoucherView("IN", null).voucher?.code, "SIV-100000", "the two series do not mix");
});

test("a Move Out voucher must name a supplier or contractor, say what for, and not take more than the store holds", () => {
  const { f, contractor } = stocked();
  const customer = f.db.createParty({ partyName: "MAMA CHAPPAL", partyType: "CUSTOMER" });
  assert.throws(() => issue(f, contractor, [{ itemId: f.dana, quantity: 5, unitCode: "KG" }], null), /what this is going out for/);
  assert.throws(() => issue(f, customer, [{ itemId: f.dana, quantity: 5, unitCode: "KG" }]), /supplier or contractor/);
  assert.throws(() => issue(f, contractor, [{ itemId: f.dana, quantity: 5, unitCode: "KG" }, { itemId: f.nawaar, quantity: 3, unitCode: "RULE" }]), /Line 2: Only 1950 INCH is in the store/);
  assert.equal(f.onHand(f.dana), 100, "a refused voucher moves nothing");
  assert.equal(f.count("SELECT COUNT(*) AS n FROM store_hand_vouchers WHERE direction = 'OUT'"), 0);
});

test("editing a Move Out voucher puts the old lines back first, so a line may grow by what is still in the store", () => {
  const { f, contractor } = stocked();
  const { voucher } = issue(f, contractor, [{ itemId: f.dana, quantity: 60, unitCode: "KG" }]);
  assert.equal(f.onHand(f.dana), 40);

  // 60 -> 90 needs only 30 more, and 40 are in the store.
  const edited = f.db.editHandVoucher({ voucherId: voucher.id, revision: 1, partyId: contractor, note: "cutting table", lines: [{ itemId: f.dana, quantity: 90, unitCode: "KG" }], actor: "bilal" });
  assert.equal(edited.changed, true);
  assert.equal(f.onHand(f.dana), 10);
  assert.throws(
    () => f.db.editHandVoucher({ voucherId: voucher.id, revision: 2, partyId: contractor, note: "cutting table", lines: [{ itemId: f.dana, quantity: 101, unitCode: "KG" }], actor: "bilal" }),
    /Only 100 KG is in the store/
  );
  assert.equal(f.onHand(f.dana), 10, "a refused edit changes nothing");

  const events = f.raw.prepare("SELECT event_type, quantity, note FROM inventory_stock_events WHERE item_id = ? AND note LIKE '%SOV-%' ORDER BY rowid").all(f.dana) as Array<{ event_type: string; quantity: number; note: string }>;
  assert.deepEqual(events.map((event) => [event.event_type, event.quantity]), [["TRANSFER_OUT", -60], ["TRANSFER_IN", 60], ["TRANSFER_OUT", -90]]);
  assert.equal(events[1]!.note, "Manual move out — reversed 60 KG · SOV-100000 edited");
});

test("deleting a Move Out voucher puts every line back, and the day's Move Out counts what actually left", () => {
  const { f, contractor } = stocked();
  issue(f, contractor, [{ itemId: f.dana, quantity: 20, unitCode: "KG" }]);
  const { voucher } = issue(f, contractor, [{ itemId: f.dana, quantity: 30, unitCode: "KG" }]);
  const deleted = f.db.deleteHandVoucher({ voucherId: voucher.id, revision: 1, actor: "bilal" });

  assert.equal(deleted.status, "DELETED");
  assert.equal(f.onHand(f.dana), 80);
  const out = f.db.getStoreDailyReport(f.db.localYmd(new Date()), "OUT")!;
  assert.equal(new Map(out.summary.byMaterial.map((total) => [total.itemId, total.quantity])).get(f.dana), 20, "30 out and 30 put back net to nothing");
  const into = f.db.getStoreDailyReport(f.db.localYmd(new Date()), "IN")!;
  assert.equal(new Map(into.summary.byMaterial.map((total) => [total.itemId, total.quantity])).get(f.dana), 100, "the put-back is not a receipt");
});
