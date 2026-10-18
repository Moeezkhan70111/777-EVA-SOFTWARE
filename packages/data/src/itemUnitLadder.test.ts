import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// A material's own ladder of units. The arithmetic is tested in @erp/domain; what these tests
// hold in place is the rule that protects recorded stock:
//
//   the unit the material's stock is held in must be ON the ladder,
//
// so every rung is worth a known amount of what the balance keeps, and a ladder can never
// quietly change what that balance means. Changing the UNIT is a separate, deliberate act
// (correctInventoryItemUnit) which re-labels the figure without converting it.

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-unit-ladder-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "ladder.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.setNumberBlock(1, "test");

  for (const [code, name] of [
    ["RULE", "Rule"],
    ["METER", "Meter"],
    ["INCH", "Inch"],
    ["DOZEN", "Dozen"],
  ]) {
    db.createInventoryUnit({ code, name });
  }
  const units = db.listInventoryUnits() as Array<{ id: string; code: string }>;
  const unitId = (code: string) => units.find((unit) => unit.code === code)!.id;

  const categoryId = db.createInventoryCategory({ name: "NAWAAR" });
  db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "ARTICLE", fieldType: "TEXT", required: true });
  db.addInventoryCategoryField({ categoryId, fieldKey: "colour", label: "COLOUR", fieldType: "TEXT", required: true });
  // The real material: 62 of them, counted in RULE.
  const item = db.createInventoryItem({
    categoryId,
    unitId: unitId("RULE"),
    stockQuantity: 62,
    values: { article: "5 SOOTAR", colour: "BLACK" },
  });
  // The same nawaar in another colour — what "every colour of this material" means.
  const sibling = db.createInventoryItem({
    categoryId,
    unitId: unitId("RULE"),
    stockQuantity: 10,
    values: { article: "5 SOOTAR", colour: "WHITE" },
  });
  // A different article entirely, which must NOT be swept up.
  const other = db.createInventoryItem({
    categoryId,
    unitId: unitId("RULE"),
    stockQuantity: 4,
    values: { article: "7 SOOTAR", colour: "BLACK" },
  });

  const nawaarLadder = [
    { fromUnitId: unitId("RULE"), toUnitId: unitId("METER"), factor: 975 },
    { fromUnitId: unitId("METER"), toUnitId: unitId("INCH"), factor: 39.7 },
  ];

  return { db, unitId, itemId: item.id, siblingId: sibling.id, otherId: other.id, categoryId, nawaarLadder, tempDir };
}

test("a material starts with no ladder, and still reports the unit its stock is in", () => {
  const { db, itemId } = createFixture();
  const ladder = db.getInventoryItemUnitLadder(itemId);
  assert.deepEqual(ladder.steps, []);
  assert.equal(ladder.baseUnit, null);
  assert.equal(ladder.stockUnit, "RULE");
});

test("a ladder is saved and read back biggest unit first", () => {
  const { db, itemId, nawaarLadder } = createFixture();
  const saved = db.setInventoryItemUnitLadder({ itemId, steps: nawaarLadder });

  assert.equal(saved.steps.length, 2);
  assert.deepEqual(
    saved.steps.map((step) => `1 ${step.fromUnit} = ${step.factor} ${step.toUnit}`),
    ["1 RULE = 975 METER", "1 METER = 39.7 INCH"]
  );
  assert.equal(saved.baseUnit, "INCH", "the bottom of the chain");
  assert.equal(saved.stockUnit, "RULE", "but the stock is counted at the top of it");
  assert.deepEqual(db.getInventoryItemUnitLadder(itemId), saved);
});

test("the stock unit has to appear on the ladder, anywhere on it", () => {
  const { db, itemId, unitId } = createFixture();

  // RULE at the top is fine — it does not have to be at the bottom.
  const topped = db.setInventoryItemUnitLadder({
    itemId,
    steps: [{ fromUnitId: unitId("RULE"), toUnitId: unitId("METER"), factor: 975 }],
  });
  assert.equal(topped.steps.length, 1);

  // A chain that never mentions RULE is refused.
  assert.throws(
    () =>
      db.setInventoryItemUnitLadder({
        itemId,
        steps: [{ fromUnitId: unitId("METER"), toUnitId: unitId("INCH"), factor: 39.7 }],
      }),
    /counted in RULE, so RULE has to be one of the units/
  );
});

test("a broken chain is refused and says where it breaks", () => {
  const { db, itemId, unitId } = createFixture();
  assert.throws(
    () =>
      db.setInventoryItemUnitLadder({
        itemId,
        steps: [
          { fromUnitId: unitId("RULE"), toUnitId: unitId("METER"), factor: 975 },
          { fromUnitId: unitId("DOZEN"), toUnitId: unitId("INCH"), factor: 39.7 },
        ],
      }),
    /starts at DOZEN, but step 1 ended at METER/
  );
});

test("a factor of zero or less is refused", () => {
  const { db, itemId, unitId } = createFixture();
  assert.throws(
    () =>
      db.setInventoryItemUnitLadder({
        itemId,
        steps: [{ fromUnitId: unitId("INCH"), toUnitId: unitId("INCH"), factor: 1 }],
      }),
    /into itself/
  );
  assert.throws(
    () =>
      db.setInventoryItemUnitLadder({
        itemId,
        steps: [{ fromUnitId: unitId("RULE"), toUnitId: unitId("METER"), factor: 0 }],
      }),
    /greater than zero/
  );
});

test("saving a ladder replaces the old one outright", () => {
  const { db, itemId, unitId, nawaarLadder } = createFixture();
  db.setInventoryItemUnitLadder({ itemId, steps: nawaarLadder });

  const shorter = db.setInventoryItemUnitLadder({
    itemId,
    steps: [{ fromUnitId: unitId("RULE"), toUnitId: unitId("METER"), factor: 975 }],
  });
  assert.equal(shorter.steps.length, 1);
  assert.equal(shorter.steps[0]!.stepOrder, 0);
});

test("an empty ladder clears it, and is always allowed", () => {
  const { db, itemId, nawaarLadder } = createFixture();
  db.setInventoryItemUnitLadder({ itemId, steps: nawaarLadder });

  const cleared = db.setInventoryItemUnitLadder({ itemId, steps: [] });
  assert.deepEqual(cleared.steps, []);
  assert.equal(cleared.baseUnit, null);
});

test("a ladder changes no stock figure — it only renames the number", () => {
  const { db, itemId, nawaarLadder } = createFixture();
  const before = db.db.prepare("SELECT quantity_on_hand, unit_id FROM inventory_stock_balances WHERE item_id = ?").get(itemId);
  db.setInventoryItemUnitLadder({ itemId, steps: nawaarLadder });
  const after = db.db.prepare("SELECT quantity_on_hand, unit_id FROM inventory_stock_balances WHERE item_id = ?").get(itemId);
  assert.deepEqual(after, before);
});

test("every ladder can be read at once, keyed by material", () => {
  const { db, itemId, nawaarLadder } = createFixture();
  db.setInventoryItemUnitLadder({ itemId, steps: nawaarLadder });

  const all = db.listInventoryItemUnitLadders();
  assert.equal(all[itemId]?.length, 2);
  assert.equal(all[itemId]?.[0]?.fromUnit, "RULE");
});

// ─── Changing the unit, saved sets, and every colour ─────────────────────────

test("the unit can be changed without the figure moving", () => {
  const { db, unitId, categoryId } = createFixture();
  // A fresh material counted in INCH when it was always rules.
  const wrong = db.createInventoryItem({
    categoryId,
    unitId: unitId("INCH"),
    stockQuantity: 62,
    values: { article: "9 SOOTAR", colour: "BLACK" },
  });

  const result = db.correctInventoryItemUnit({
    itemId: wrong.id,
    unitId: unitId("RULE"),
    reason: "entered as inches, they were always rules",
  });

  assert.equal(result.fromUnitCode, "INCH");
  assert.equal(result.toUnitCode, "RULE");
  assert.equal(result.quantityOnHand, 62, "the figure is re-labelled, never converted");
  assert.equal(db.getInventoryItemUnitLadder(wrong.id).stockUnit, "RULE");
});

test("every colour of the same material can be given the ladder, and nothing else is", () => {
  const { db, itemId, siblingId, otherId, nawaarLadder } = createFixture();
  db.setInventoryItemUnitLadder({ itemId, steps: nawaarLadder });

  const colours = db.inventoryItemColourSiblings(itemId);
  assert.equal(colours.length, 1, "only the same article in another colour");
  assert.equal(colours[0]!.id, siblingId);

  const outcome = db.applyUnitLadderToColours({ itemId });
  assert.equal(outcome.applied, 1);
  assert.deepEqual(outcome.skipped, []);

  assert.equal(db.getInventoryItemUnitLadder(siblingId).steps.length, 2);
  assert.equal(db.getInventoryItemUnitLadder(otherId).steps.length, 0, "a different article is left alone");
});

test("the unit can be changed on every colour at once", () => {
  const { db, unitId, categoryId } = createFixture();
  // Three colours of one article, all entered in INCH when they were always rules.
  const made = ["BLACK", "WHITE", "RED"].map((colour) =>
    db.createInventoryItem({
      categoryId,
      unitId: unitId("INCH"),
      stockQuantity: 16,
      values: { article: "13 SOOTAR", colour },
    })
  );

  const outcome = db.correctInventoryItemUnitForColours({
    itemId: made[0]!.id,
    unitId: unitId("RULE"),
    reason: "entered as inches, they were always rules",
  });

  assert.equal(outcome.applied, 2, "the other two colours");
  assert.deepEqual(outcome.skipped, []);
  for (const item of made.slice(1)) {
    const ladder = db.getInventoryItemUnitLadder(item.id);
    assert.equal(ladder.stockUnit, "RULE");
  }
  // The figure never moved on any of them.
  for (const item of made.slice(1)) {
    const balance = db.db
      .prepare("SELECT quantity_on_hand FROM inventory_stock_balances WHERE item_id = ?")
      .get(item.id) as { quantity_on_hand: number };
    assert.equal(Number(balance.quantity_on_hand), 16);
  }
});

test("a set of conversions can be saved by name and used again", () => {
  const { db, unitId, nawaarLadder, categoryId } = createFixture();

  const preset = db.saveUnitLadderPreset({ name: "NAWAAR rule to inch", steps: nawaarLadder });
  assert.equal(preset.steps.length, 2);
  assert.equal(preset.steps[0]!.fromUnit, "RULE");

  // Saving under the same name replaces it rather than making a second one.
  db.saveUnitLadderPreset({
    name: "nawaar RULE TO INCH",
    steps: [{ fromUnitId: unitId("RULE"), toUnitId: unitId("METER"), factor: 1000 }],
  });
  const all = db.listUnitLadderPresets();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.steps.length, 1);
  assert.equal(all[0]!.steps[0]!.factor, 1000);

  // And it can be put on any material.
  const another = db.createInventoryItem({
    categoryId,
    unitId: unitId("RULE"),
    stockQuantity: 1,
    values: { article: "11 SOOTAR", colour: "BLUE" },
  });
  const steps = all[0]!.steps.map((step) => ({ fromUnitId: step.fromUnitId, toUnitId: step.toUnitId, factor: step.factor }));
  assert.equal(db.setInventoryItemUnitLadder({ itemId: another.id, steps }).steps.length, 1);

  db.deleteUnitLadderPreset(all[0]!.id);
  assert.deepEqual(db.listUnitLadderPresets(), []);
});

test("a saved set with a broken chain is refused", () => {
  const { db, unitId } = createFixture();
  assert.throws(
    () =>
      db.saveUnitLadderPreset({
        name: "broken",
        steps: [
          { fromUnitId: unitId("RULE"), toUnitId: unitId("METER"), factor: 975 },
          { fromUnitId: unitId("DOZEN"), toUnitId: unitId("INCH"), factor: 39.7 },
        ],
      }),
    /starts at DOZEN/
  );
  assert.deepEqual(db.listUnitLadderPresets(), []);
});
