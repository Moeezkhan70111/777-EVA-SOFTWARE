import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// Moving raw material out of the store BY HAND, for loose stock that carries no label.
//
// The owner's case: nawaar is bought in RULES and one rule of this nawaar is 975 INCH. The
// floor asks for 700 inches, the storekeeper cuts it off the roll, and the balance has to
// follow — whether they typed 700 INCH or 1 RULE, and whichever of the two the balance itself
// is kept in. What these tests hold in place is that the figure that comes off the shelf is
// the material's OWN ladder applied to what was typed, never a guess.

function createFixture(stockUnit: "RULE" | "INCH") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-manual-out-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "out.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });

  for (const [code, name] of [
    ["RULE", "Rule"],
    ["INCH", "Inch"],
    ["DOZEN", "Dozen"],
  ]) {
    db.createInventoryUnit({ code, name });
  }
  const units = db.listInventoryUnits() as Array<{ id: string; code: string }>;
  const unitId = (code: string) => units.find((unit) => unit.code === code)!.id;

  const categoryId = db.createInventoryCategory({ name: "NAWAAR" });
  db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "ARTICLE", fieldType: "TEXT", required: true });

  // 10 of whatever the stock is counted in — 10 RULE, or 10 INCH.
  const item = db.createInventoryItem({
    categoryId,
    unitId: unitId(stockUnit),
    stockQuantity: 10,
    values: { article: "5 SOOTAR" },
  });
  // The owner's figure: one rule of this nawaar is 975 inches.
  db.setInventoryItemUnitLadder({
    itemId: item.id,
    steps: [{ fromUnitId: unitId("RULE"), toUnitId: unitId("INCH"), factor: 975 }],
  });

  return { db, unitId, itemId: item.id, tempDir };
}

const onHand = (db: SqliteDatabase, itemId: string): number => db.getRawMaterialHandMoveOptions(itemId, "OUT")!.quantityOnHand;

test("both rungs are offered, and the balance says which unit it is kept in", () => {
  const { db, itemId } = createFixture("INCH");
  const options = db.getRawMaterialHandMoveOptions(itemId, "OUT")!;

  assert.deepEqual(options.units, ["RULE", "INCH"]);
  assert.equal(options.stockUnitCode, "INCH");
  assert.equal(options.blockedReason, null);
});

test("stock kept in INCH: 975 INCH out is one rule's worth, and 1 RULE out is the same move", () => {
  const { db, itemId } = createFixture("INCH");
  // Put 2 rules' worth of inches on the shelf.
  db.adjustInventoryStock({ itemId, quantity: 1940, eventType: "RECEIVE" });
  assert.equal(onHand(db, itemId), 1950);

  const inches = db.moveRawMaterialByHand({ itemId, direction: "OUT", quantity: 975, unitCode: "INCH" });
  assert.equal(inches.outcome, "MOVED");
  assert.equal(inches.quantity, 975, "975 inches came off, which IS one rule");
  assert.equal(onHand(db, itemId), 975);

  // The same move typed the other way takes the same amount off.
  const rule = db.moveRawMaterialByHand({ itemId, direction: "OUT", quantity: 1, unitCode: "RULE" });
  assert.equal(rule.outcome, "MOVED");
  assert.equal(rule.quantity, 975);
  assert.equal(rule.unitCode, "INCH", "the balance is kept in inches, so that is what moved");
  assert.equal(onHand(db, itemId), 0);
});

test("part of a rule comes off in inches, and the rest of the roll stays", () => {
  const { db, itemId } = createFixture("INCH");
  db.adjustInventoryStock({ itemId, quantity: 965, eventType: "RECEIVE" }); // 975 on the shelf

  const first = db.moveRawMaterialByHand({ itemId, direction: "OUT", quantity: 700, unitCode: "INCH" });
  assert.equal(first.outcome, "MOVED");
  assert.equal(first.quantity, 700);
  assert.equal(onHand(db, itemId), 275);

  const second = db.moveRawMaterialByHand({ itemId, direction: "OUT", quantity: 275, unitCode: "INCH" });
  assert.equal(second.outcome, "MOVED");
  assert.equal(onHand(db, itemId), 0, "700 + 275 is the whole rule");
});

test("stock kept in RULE: typing inches takes the right fraction of a rule off", () => {
  const { db, itemId } = createFixture("RULE");
  assert.equal(onHand(db, itemId), 10);

  // 975 INCH is exactly one rule.
  const whole = db.moveRawMaterialByHand({ itemId, direction: "OUT", quantity: 975, unitCode: "INCH" });
  assert.equal(whole.outcome, "MOVED");
  assert.equal(whole.quantity, 1);
  assert.equal(whole.unitCode, "RULE");
  assert.equal(onHand(db, itemId), 9);

  // 600 INCH is 600/975 of a rule — kept to three decimals, never rounded up to a whole one.
  const part = db.moveRawMaterialByHand({ itemId, direction: "OUT", quantity: 600, unitCode: "INCH" });
  assert.equal(part.outcome, "MOVED");
  assert.equal(part.quantity, Number((600 / 975).toFixed(3)));
  assert.equal(onHand(db, itemId), Number((9 - 600 / 975).toFixed(3)));
});

test("what the operator typed is kept on the ledger beside what it came to", () => {
  const { db, itemId } = createFixture("RULE");
  const result = db.moveRawMaterialByHand({ itemId, direction: "OUT", quantity: 975, unitCode: "INCH", note: "to the cutting table", actor: "aslam" });

  assert.equal(result.typedQuantity, 975);
  assert.equal(result.typedUnitCode, "INCH");
  const events = db.listInventoryStockEvents(itemId);
  const moveOut = events.find((event) => event.eventType === "TRANSFER_OUT")!;
  assert.match(moveOut.note ?? "", /975 INCH/, "the ledger reads back the way it was typed");
  assert.match(moveOut.note ?? "", /to the cutting table/);
  assert.equal(moveOut.quantity, -1, "and what actually left, in the unit the balance is kept in");
});

test("a unit that is not on this material's ladder is refused, never guessed at", () => {
  const { db, itemId } = createFixture("RULE");
  const result = db.moveRawMaterialByHand({ itemId, direction: "OUT", quantity: 5, unitCode: "DOZEN" });

  assert.equal(result.accepted, false);
  assert.equal(result.outcome, "UNKNOWN_UNIT");
  assert.equal(onHand(db, itemId), 10, "nothing moved");
});

test("more than is on the shelf is refused, and says what the typed figure came to", () => {
  const { db, itemId } = createFixture("RULE");
  const result = db.moveRawMaterialByHand({ itemId, direction: "OUT", quantity: 20000, unitCode: "INCH" });

  assert.equal(result.accepted, false);
  assert.equal(result.outcome, "NOT_ENOUGH_STOCK");
  assert.match(result.reason ?? "", /Only 10 RULE/);
  assert.equal(onHand(db, itemId), 10, "nothing moved");
});

test("nothing, or less than nothing, is refused", () => {
  const { db, itemId } = createFixture("RULE");
  for (const quantity of [0, -3, Number.NaN]) {
    const result = db.moveRawMaterialByHand({ itemId, direction: "OUT", quantity, unitCode: "RULE" });
    assert.equal(result.outcome, "INVALID_QUANTITY", `${quantity} should be refused`);
  }
  assert.equal(onHand(db, itemId), 10);
});

test("a material with labelled packets in the store cannot go out by hand", () => {
  const { db, itemId, tempDir } = createFixture("RULE");
  void tempDir;
  const partyId = db.createParty({ partyName: "SHEHZAD RUBBER", partyType: "SUPPLIER" });
  db.generateRawMaterialQrBatch({ partyId, itemId, quantity: 2, packingQuantity: 1 });
  // A generated label reaches the store by being scanned in; this stands in for that scan.
  db.db.prepare("UPDATE raw_material_qrs SET current_status = 'IN_STORE' WHERE item_id = ?").run(itemId);

  const options = db.getRawMaterialHandMoveOptions(itemId, "OUT")!;
  assert.equal(options.labelledPacketsInStore, 2);
  assert.match(options.blockedReason ?? "", /2 labelled packets/);

  const result = db.moveRawMaterialByHand({ itemId, direction: "OUT", quantity: 1, unitCode: "RULE" });
  assert.equal(result.accepted, false);
  assert.equal(result.outcome, "HAS_LABELLED_PACKETS");
  assert.equal(onHand(db, itemId), 10, "nothing moved — those packets must be scanned out");
});


// ─── Taking material IN by hand ──────────────────────────────────────────────
// The mirror: a delivery that carries no labels. Receiving is supplier-at-a-time, so this one
// has to name whoever brought it, label or no label.

const supplier = (db: SqliteDatabase): string => db.createParty({ partyName: "SHEHZAD RUBBER", partyType: "SUPPLIER" });

test("stock kept in INCH: 2 RULE in adds 1,950 inches", () => {
  const { db, itemId } = createFixture("INCH");
  const partyId = supplier(db);

  const result = db.moveRawMaterialByHand({ itemId, direction: "IN", quantity: 2, unitCode: "RULE", partyId });
  assert.equal(result.outcome, "MOVED");
  assert.equal(result.direction, "IN");
  assert.equal(result.quantity, 1950, "two 975-inch rules");
  assert.equal(result.unitCode, "INCH");
  assert.equal(onHand(db, itemId), 1960, "on top of the 10 that were there");
});

test("stock kept in RULE: 975 INCH in is one rule, and 600 INCH is the fraction of one", () => {
  const { db, itemId } = createFixture("RULE");
  const partyId = supplier(db);

  db.moveRawMaterialByHand({ itemId, direction: "IN", quantity: 975, unitCode: "INCH", partyId });
  assert.equal(onHand(db, itemId), 11);

  db.moveRawMaterialByHand({ itemId, direction: "IN", quantity: 600, unitCode: "INCH", partyId });
  assert.equal(onHand(db, itemId), Number((11 + 600 / 975).toFixed(3)));
});

test("a delivery has to name its supplier, and an unknown one is refused", () => {
  const { db, itemId } = createFixture("RULE");

  const nobody = db.moveRawMaterialByHand({ itemId, direction: "IN", quantity: 1, unitCode: "RULE" });
  assert.equal(nobody.accepted, false);
  assert.equal(nobody.outcome, "NO_SUPPLIER");

  const stranger = db.moveRawMaterialByHand({ itemId, direction: "IN", quantity: 1, unitCode: "RULE", partyId: "party-nobody" });
  assert.equal(stranger.outcome, "NO_SUPPLIER");
  assert.equal(onHand(db, itemId), 10, "nothing moved");
});

test("who delivered it is kept on the ledger, in a column, not just in the note", () => {
  const { db, itemId } = createFixture("RULE");
  const partyId = supplier(db);
  db.moveRawMaterialByHand({ itemId, direction: "IN", quantity: 975, unitCode: "INCH", partyId, note: "no labels on the roll", actor: "aslam" });

  const row = db.db
    .prepare("SELECT event_type, quantity, note, party_id FROM inventory_stock_events WHERE item_id = ? AND event_type = 'RECEIVE' ORDER BY created_at DESC LIMIT 1")
    .get(itemId) as { event_type: string; quantity: number; note: string; party_id: string };
  assert.equal(row.event_type, "RECEIVE");
  assert.equal(row.quantity, 1, "one rule came in");
  assert.equal(row.party_id, partyId, "asked for by supplier later, not read out of the text");
  assert.match(row.note, /Manual move in — 975 INCH/);
  assert.match(row.note, /no labels on the roll/);
});

test("labelled packets block a move OUT but never a move IN", () => {
  const { db, itemId } = createFixture("RULE");
  const partyId = db.createParty({ partyName: "ABC UPPER", partyType: "SUPPLIER" });
  db.generateRawMaterialQrBatch({ partyId, itemId, quantity: 2, packingQuantity: 1 });
  db.db.prepare("UPDATE raw_material_qrs SET current_status = 'IN_STORE' WHERE item_id = ?").run(itemId);

  // Out is refused, as before.
  assert.equal(db.getRawMaterialHandMoveOptions(itemId, "OUT")!.blockedReason !== null, true);
  // In is not: labelled packets and a loose remainder is simply what the shelf holds.
  assert.equal(db.getRawMaterialHandMoveOptions(itemId, "IN")!.blockedReason, null);

  const result = db.moveRawMaterialByHand({ itemId, direction: "IN", quantity: 1, unitCode: "RULE", partyId });
  assert.equal(result.outcome, "MOVED");
  assert.equal(onHand(db, itemId), 11);
});

test("a move in of nothing, or in a unit this material does not use, is refused", () => {
  const { db, itemId } = createFixture("RULE");
  const partyId = supplier(db);

  assert.equal(db.moveRawMaterialByHand({ itemId, direction: "IN", quantity: 0, unitCode: "RULE", partyId }).outcome, "INVALID_QUANTITY");
  assert.equal(db.moveRawMaterialByHand({ itemId, direction: "IN", quantity: 5, unitCode: "DOZEN", partyId }).outcome, "UNKNOWN_UNIT");
  assert.equal(onHand(db, itemId), 10);
});
