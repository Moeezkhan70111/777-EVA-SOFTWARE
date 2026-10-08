import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-raw-material-"));
  const dbPath = path.join(tempDir, "raw.db");
  const db = new SqliteDatabase({ dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  return { db, dbPath, tempDir, cleanup: () => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); } };
}

function unitId(db: SqliteDatabase, code: string, name: string): string {
  db.createInventoryUnit({ code, name });
  return (db.listInventoryUnits() as Array<{ id: string; code: string }>).find((u) => u.code === code)!.id;
}

test("rubber upper: stock is aggregated correctly across category, article, size, and color filters", () => {
  const { db, cleanup } = createFixture();
  try {
    const dzn = unitId(db, "DZN", "Dozen");
    const categoryId = db.createInventoryCategory({ name: "Rubber Upper" });
    db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "Article", fieldType: "DROPDOWN", required: true });
    db.addInventoryCategoryField({ categoryId, fieldKey: "color", label: "Color", fieldType: "DROPDOWN", required: true });
    db.addInventoryCategoryField({ categoryId, fieldKey: "size", label: "Size", fieldType: "DROPDOWN", required: true });

    db.createInventoryItem({ categoryId, unitId: dzn, stockQuantity: 20, values: { article: "SK12", color: "BLACK", size: "7/10" } });
    db.createInventoryItem({ categoryId, unitId: dzn, stockQuantity: 10, values: { article: "SK12", color: "BLUE", size: "7/10" } });
    db.createInventoryItem({ categoryId, unitId: dzn, stockQuantity: 20, values: { article: "SK6", color: "RED", size: "4/6" } });
    db.createInventoryItem({ categoryId, unitId: dzn, stockQuantity: 40, values: { article: "SK6", color: "RED", size: "7/10" } });

    assert.equal(db.queryInventoryStock({ categoryId }).totalsByUnit[0].quantity, 90);
    assert.equal(db.queryInventoryStock({ categoryId, attributes: { article: "SK6" } }).totalsByUnit[0].quantity, 60);
    assert.equal(db.queryInventoryStock({ categoryId, attributes: { size: "7/10" } }).totalsByUnit[0].quantity, 70);
    assert.equal(db.queryInventoryStock({ categoryId, attributes: { color: "RED", article: "SK6" } }).totalsByUnit[0].quantity, 60);
    assert.equal(db.queryInventoryStock({ categoryId, attributes: { article: "SK6", color: "RED", size: "7/10" } }).totalsByUnit[0].quantity, 40);
    assert.equal(db.queryInventoryStock({ categoryId, attributes: { color: "BLUE" } }).totalsByUnit[0].quantity, 10);
    assert.equal(db.queryInventoryStock({ categoryId, attributes: { article: "SK12", color: "RED" } }).totalsByUnit.length, 0);
  } finally { cleanup(); }
});

test("buckle: filtering by article alone aggregates across all its sizes without a manual hierarchy", () => {
  const { db, cleanup } = createFixture();
  try {
    const pair = unitId(db, "PAIR", "Pair");
    const categoryId = db.createInventoryCategory({ name: "Buckle" });
    db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "Article", fieldType: "DROPDOWN", required: true });
    db.addInventoryCategoryField({ categoryId, fieldKey: "size", label: "Size", fieldType: "DROPDOWN" });

    db.createInventoryItem({ categoryId, unitId: pair, stockQuantity: 10, values: { article: "D BUCKLE", size: "LARGE" } });
    db.createInventoryItem({ categoryId, unitId: pair, stockQuantity: 20, values: { article: "D BUCKLE", size: "SMALL" } });
    db.createInventoryItem({ categoryId, unitId: pair, stockQuantity: 30, values: { article: "FLOWER BUCKLE" } });

    assert.equal(db.queryInventoryStock({ categoryId, attributes: { article: "D BUCKLE" } }).totalsByUnit[0].quantity, 30);
    assert.equal(db.queryInventoryStock({ categoryId, attributes: { article: "D BUCKLE", size: "LARGE" } }).totalsByUnit[0].quantity, 10);
    assert.equal(db.queryInventoryStock({ categoryId, attributes: { article: "D BUCKLE", size: "SMALL" } }).totalsByUnit[0].quantity, 20);
    assert.equal(db.queryInventoryStock({ categoryId, attributes: { article: "FLOWER BUCKLE" } }).totalsByUnit[0].quantity, 30);
  } finally { cleanup(); }
});

test("sheets: unit conversion produces an equivalent total without altering the stored stock", () => {
  const { db, cleanup } = createFixture();
  try {
    const rule = unitId(db, "RULE", "Rule");
    const meter = unitId(db, "METER", "Meter");
    db.createInventoryUnitConversion({ fromUnitId: rule, toUnitId: meter, factor: 100 });

    const categoryId = db.createInventoryCategory({ name: "Sheets" });
    db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "Article", fieldType: "TEXT", required: true });

    db.createInventoryItem({ categoryId, unitId: rule, stockQuantity: 2, values: { article: "4M RAGZINE" } });

    const stock = db.queryInventoryStock({ categoryId, targetUnitId: meter });
    assert.equal(stock.totalsByUnit[0].quantity, 2);
    assert.equal(stock.totalsByUnit[0].unitCode, "RULE");
    assert.equal(stock.equivalent?.quantity, 200);
    assert.equal(stock.equivalent?.unitCode, "METER");
  } finally { cleanup(); }
});

test("duplicate detection: same category + attributes is blocked (case-insensitively), different attributes are separate items", () => {
  const { db, cleanup } = createFixture();
  try {
    const dzn = unitId(db, "DZN", "Dozen");
    const categoryId = db.createInventoryCategory({ name: "Rubber Upper" });
    db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "Article", fieldType: "TEXT", required: true });
    db.addInventoryCategoryField({ categoryId, fieldKey: "color", label: "Color", fieldType: "TEXT", required: true });
    db.addInventoryCategoryField({ categoryId, fieldKey: "size", label: "Size", fieldType: "TEXT", required: true });

    const first = db.createInventoryItem({ categoryId, unitId: dzn, stockQuantity: 20, values: { article: "SK12", color: "BLACK", size: "7/10" } });
    assert.equal(first.duplicate, undefined);

    const sameAgain = db.createInventoryItem({ categoryId, unitId: dzn, stockQuantity: 20, values: { article: "sk12", color: "black", size: "7/10" } });
    assert.equal(sameAgain.duplicate, true);
    assert.equal(sameAgain.id, first.id);

    const differentColor = db.createInventoryItem({ categoryId, unitId: dzn, stockQuantity: 10, values: { article: "SK12", color: "BLUE", size: "7/10" } });
    assert.equal(differentColor.duplicate, undefined);
    assert.notEqual(differentColor.id, first.id);

    const differentArticle = db.createInventoryItem({ categoryId, unitId: dzn, stockQuantity: 20, values: { article: "SK6", color: "RED", size: "4/6" } });
    assert.equal(differentArticle.duplicate, undefined);

    assert.equal(db.listInventoryItems({ categoryId }).length, 3);
  } finally { cleanup(); }
});

test("dropdown options are normalized to uppercase, deduplicated case-insensitively, and survive a reconnect", () => {
  const fixture = createFixture();
  try {
    const categoryId = fixture.db.createInventoryCategory({ name: "Rubber Upper" });
    const colorFieldId = fixture.db.addInventoryCategoryField({ categoryId, fieldKey: "color", label: "Color", fieldType: "DROPDOWN" });
    fixture.db.addInventoryFieldOption({ fieldId: colorFieldId, value: "RED" });
    fixture.db.addInventoryFieldOption({ fieldId: colorFieldId, value: "BLUE" });
    fixture.db.addInventoryFieldOption({ fieldId: colorFieldId, value: "green" });

    const optionsBefore = (fixture.db.listInventoryCategories().find((c) => (c as { id: string }).id === categoryId) as { fields: Array<{ id: string; options: Array<{ option_value: string }> }> })
      .fields.find((f) => f.id === colorFieldId)!.options.map((o) => o.option_value);
    assert.deepEqual(optionsBefore.sort(), ["BLUE", "GREEN", "RED"]);

    // Restart: close and reopen against the same database file.
    fixture.db.close();
    const reopened = new SqliteDatabase({ dbPath: fixture.dbPath, schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
    const optionsAfter = (reopened.listInventoryCategories().find((c) => (c as { id: string }).id === categoryId) as { fields: Array<{ id: string; options: Array<{ option_value: string }> }> })
      .fields.find((f) => f.id === colorFieldId)!.options.map((o) => o.option_value);
    assert.deepEqual(optionsAfter.sort(), ["BLUE", "GREEN", "RED"]);

    // Adding "red" again must not create a duplicate.
    reopened.addInventoryFieldOption({ fieldId: colorFieldId, value: "red" });
    const optionsFinal = (reopened.listInventoryCategories().find((c) => (c as { id: string }).id === categoryId) as { fields: Array<{ id: string; options: Array<{ option_value: string }> }> })
      .fields.find((f) => f.id === colorFieldId)!.options;
    assert.equal(optionsFinal.filter((o) => o.option_value === "RED").length, 1);
    reopened.close();
  } finally { fs.rmSync(fixture.tempDir, { recursive: true, force: true }); }
});

test("category is a container, not a unique item: multiple distinct items may share a category", () => {
  const { db, cleanup } = createFixture();
  try {
    const pair = unitId(db, "PAIR", "Pair");
    const categoryId = db.createInventoryCategory({ name: "Buckle" });
    db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "Article", fieldType: "TEXT" });
    db.createInventoryItem({ categoryId, unitId: pair, stockQuantity: 1, values: { article: "D BUCKLE" } });
    db.createInventoryItem({ categoryId, unitId: pair, stockQuantity: 1, values: { article: "FLOWER BUCKLE" } });
    assert.equal(db.listInventoryItems({ categoryId }).length, 2);
  } finally { cleanup(); }
});

test("search finds items regardless of separators between tokens", () => {
  const { db, cleanup } = createFixture();
  try {
    const dzn = unitId(db, "DZN", "Dozen");
    const categoryId = db.createInventoryCategory({ name: "Rubber Upper" });
    db.addInventoryCategoryField({ categoryId, fieldKey: "article", label: "Article", fieldType: "TEXT" });
    db.addInventoryCategoryField({ categoryId, fieldKey: "color", label: "Color", fieldType: "TEXT" });
    db.addInventoryCategoryField({ categoryId, fieldKey: "size", label: "Size", fieldType: "TEXT" });
    db.createInventoryItem({ categoryId, unitId: dzn, stockQuantity: 20, values: { article: "SK12", color: "RED", size: "7/10" } });

    assert.equal(db.listInventoryItems({ search: "SK12 RED 7/10" }).length, 1);
    assert.equal(db.listInventoryItems({ search: "sk12 red" }).length, 1);
  } finally { cleanup(); }
});

// ─── What one pack IS ────────────────────────────────────────────────────────
// Packing recorded how much was on a label, never what the thing was called. So a row read
// "0 DOZEN · 25 KILOGRAM" and the store read it as "one dozen is twenty-five kilogram".
// DANA comes in a BAG. The name is a property of the material, like its packing quantity.

test("a pack carries the store's own word for it, and keeps it until it is changed", () => {
  const { db, cleanup } = createFixture();
  try {
    const kg = unitId(db, "KG", "Kilogram");
    const categoryId = db.createInventoryCategory({ name: "Dana" });
    db.addInventoryCategoryField({ categoryId, fieldKey: "grade", label: "Grade", fieldType: "TEXT", required: true });
    const item = db.createInventoryItem({ categoryId, unitId: kg, values: { grade: "EVA" } });

    const configOf = () => db.listRawMaterialMovementConfig("").find((row) => row.itemId === item.id)!;
    assert.equal(configOf().packName, null, "unnamed until somebody says what it is");

    db.setRawMaterialMovementConfig(item.id, { packName: "bag", packingQuantity: 25, packingUnitId: kg});
    assert.equal(configOf().packName, "BAG", "stored the way the store writes it");
    assert.equal(configOf().packingQuantity, 25);

    // Saving the packing again without mentioning the name leaves the name alone.
    db.setRawMaterialMovementConfig(item.id, { packingQuantity: 50, packingUnitId: kg});
    assert.equal(configOf().packName, "BAG");
    assert.equal(configOf().packingQuantity, 50);

    // An empty name clears it back to the default.
    db.setRawMaterialMovementConfig(item.id, { packName: "  ", packingQuantity: 50, packingUnitId: kg});
    assert.equal(configOf().packName, null);
  } finally { cleanup(); }
});

test("a pack measured in a unit stock cannot be counted in is reported, not left to fail at the scanner", () => {
  const { db, cleanup } = createFixture();
  try {
    const kg = unitId(db, "KG", "Kilogram");
    const dzn = unitId(db, "DZN", "Dozen");
    const categoryId = db.createInventoryCategory({ name: "Dana" });
    db.addInventoryCategoryField({ categoryId, fieldKey: "grade", label: "Grade", fieldType: "TEXT", required: true });

    // Stocked in DOZEN, packed in KILOGRAM, with no conversion between them: every scan of
    // this material would be refused by applyRawMaterialStockChange.
    const trapped = db.createInventoryItem({ categoryId, unitId: dzn, stockQuantity: 0, values: { grade: "EVA" } });
    db.setRawMaterialMovementConfig(trapped.id, { packName: "BAG", packingQuantity: 25, packingUnitId: kg});

    const configOf = (id: string) => db.listRawMaterialMovementConfig("").find((row) => row.itemId === id)!;
    assert.equal(configOf(trapped.id).stockUnitCode, "DZN");
    assert.equal(configOf(trapped.id).packingUnitCode, "KG");
    assert.equal(configOf(trapped.id).packingConvertsToStock, false);

    // Add the conversion and the same configuration becomes workable.
    db.createInventoryUnitConversion({ fromUnitId: kg, toUnitId: dzn, factor: 0.5 });
    assert.equal(configOf(trapped.id).packingConvertsToStock, true);

    // A material packed in the unit it is stocked in was never in any trouble.
    const plain = db.createInventoryItem({ categoryId, unitId: kg, stockQuantity: 0, values: { grade: "PVC" } });
    db.setRawMaterialMovementConfig(plain.id, { packName: "BAG", packingQuantity: 25, packingUnitId: kg});
    assert.equal(configOf(plain.id).packingConvertsToStock, true);
  } finally { cleanup(); }
});

test("one pack is sized in the unit stock is counted in, so a balance can be read as packs", () => {
  const { db, cleanup } = createFixture();
  try {
    const kg = unitId(db, "KG", "Kilogram");
    const dzn = unitId(db, "DZN", "Dozen");
    const pcs = unitId(db, "PCS", "Piece");
    db.createInventoryUnitConversion({ fromUnitId: dzn, toUnitId: pcs, factor: 12 });

    const categoryId = db.createInventoryCategory({ name: "Mixed" });
    db.addInventoryCategoryField({ categoryId, fieldKey: "grade", label: "Grade", fieldType: "TEXT", required: true });
    const configOf = (id: string) => db.listRawMaterialMovementConfig("").find((row) => row.itemId === id)!;

    // Counted and packed in the same unit: a bag of 25 KG is 25.
    const dana = db.createInventoryItem({ categoryId, unitId: kg, stockQuantity: 75, values: { grade: "DANA" } });
    db.setRawMaterialMovementConfig(dana.id, { packName: "BAG", packingQuantity: 25, packingUnitId: kg});
    assert.equal(configOf(dana.id).packSizeInStockUnit, 25, "75 KG on the shelf is 3 bags");

    // Counted in PIECE, packed in DOZEN: a packet of 2 dozen is 24 pieces, not 2.
    const buckle = db.createInventoryItem({ categoryId, unitId: pcs, stockQuantity: 240, values: { grade: "BUCKLE" } });
    db.setRawMaterialMovementConfig(buckle.id, { packName: "BOX", packingQuantity: 2, packingUnitId: dzn});
    assert.equal(configOf(buckle.id).packSizeInStockUnit, 24, "240 pieces is 10 boxes, not 120");

    // No conversion between the two units: there is no honest pack size.
    const trapped = db.createInventoryItem({ categoryId, unitId: kg, stockQuantity: 0, values: { grade: "TRAPPED" } });
    db.setRawMaterialMovementConfig(trapped.id, { packName: "BAG", packingQuantity: 2, packingUnitId: dzn});
    assert.equal(configOf(trapped.id).packSizeInStockUnit, null);
    assert.equal(configOf(trapped.id).packingConvertsToStock, false);

    // No packing at all: likewise nothing to divide by.
    const bare = db.createInventoryItem({ categoryId, unitId: kg, stockQuantity: 5, values: { grade: "BARE" } });
    assert.equal(configOf(bare.id).packSizeInStockUnit, null);
  } finally { cleanup(); }
});

test("a manual Urdu correction on the Colour attribute round-trips; an untouched one stays null", () => {
  const { db, cleanup } = createFixture();
  try {
    const dzn = unitId(db, "DZN", "Dozen");
    const categoryId = db.createInventoryCategory({ name: "Rubber Upper" });
    db.addInventoryCategoryField({ categoryId, fieldKey: "colour", label: "Colour", fieldType: "TEXT", required: true });
    db.addInventoryCategoryField({ categoryId, fieldKey: "size", label: "Size", fieldType: "TEXT", required: true });

    const corrected = db.createInventoryItem({
      categoryId, unitId: dzn,
      values: { colour: "MAROON", size: "7/10" },
      valuesUrdu: { colour: "گہرا لال" },
    });
    const untouched = db.createInventoryItem({
      categoryId, unitId: dzn,
      values: { colour: "BLACK", size: "7/10" },
    });

    const byId = new Map(db.listInventoryItems({ categoryId }).map((row) => [String(row.id), row]));
    const valuesOf = (id: string) => byId.get(id)!.values as Array<Record<string, unknown>>;

    const correctedColour = valuesOf(corrected.id).find((v) => v.field_key === "colour")!;
    assert.equal(correctedColour.text_value_urdu, "گہرا لال");

    const untouchedColour = valuesOf(untouched.id).find((v) => v.field_key === "colour")!;
    assert.equal(untouchedColour.text_value_urdu, null, "left null so it keeps translating automatically");

    // An override on a non-colour field is stored exactly the same way — the column itself
    // does not know or care which field is "the" colour field; that decision is the
    // renderer's (materialLabelAttributes), not the data layer's.
    const sizeField = valuesOf(corrected.id).find((v) => v.field_key === "size")!;
    assert.equal(sizeField.text_value_urdu, null);
  } finally { cleanup(); }
});
