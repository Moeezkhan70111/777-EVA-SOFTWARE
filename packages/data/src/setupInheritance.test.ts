import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// DANA — EVA — BLACK, RED and BLUE are one material in three colours: the same unit, the same
// bag, the same machine. So a sub-category is asked what its materials are already set up as,
// and a new one starts there instead of being configured by hand a fourth time.
//
// The answer is DERIVED from the materials themselves, never stored as a category default:
// there is then no second place to keep the packing, and no way for a "default" to drift away
// from what the materials in the category actually use.

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-inherit-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "inherit.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.setNumberBlock(1, "test");

  db.createInventoryUnit({ code: "KG", name: "Kilogram", unitFamily: "WEIGHT" });
  const kg = (db.listInventoryUnits() as Array<{ id: string; code: string }>).find((u) => u.code === "KG")!.id;

  const dana = db.createInventoryCategory({ name: "DANA" });
  const eva = db.createInventoryCategory({ name: "EVA", parentId: dana });
  const pvc = db.createInventoryCategory({ name: "PVC", parentId: dana });
  db.addInventoryCategoryField({ categoryId: dana, fieldKey: "colour", label: "COLOUR", fieldType: "TEXT", required: true });

  const mixing = db.createWorkSection({ name: "Mixing" });
  const machine = db.createWorkSection({ name: "Machine" });

  return {
    db,
    kg,
    eva,
    pvc,
    mixing: mixing.id,
    machine: machine.id,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/** The first colour of a sub-category, set up by hand the way an operator would. */
function configuredBlack(f: ReturnType<typeof createFixture>) {
  const black = f.db.createInventoryItem({ categoryId: f.eva, values: { colour: "BLACK" }, unitId: f.kg });
  f.db.setRawMaterialMovementConfig(black.id, {
    packName: "BAG",
    packingQuantity: 25,
    packingUnitId: f.kg,
  });
  return black;
}

test("a sub-category with nothing set up yet has no template", () => {
  const f = createFixture();
  try {
    assert.equal(f.db.rawMaterialSetupTemplate(f.eva), null);

    // A material with no packing is not a template either — there is nothing to inherit.
    f.db.createInventoryItem({ categoryId: f.eva, values: { colour: "BLACK" }, unitId: f.kg });
    assert.equal(f.db.rawMaterialSetupTemplate(f.eva), null);
  } finally {
    f.cleanup();
  }
});

test("the template is the unit and the pack of the material set up most recently", () => {
  const f = createFixture();
  try {
    const black = configuredBlack(f);

    const template = f.db.rawMaterialSetupTemplate(f.eva);
    assert.ok(template);
    assert.equal(template.sourceItemId, black.id);
    assert.equal(template.sourceDisplayName, black.displayName);
    assert.equal(template.unitId, f.kg);
    assert.equal(template.unitCode, "KG");
    assert.equal(template.packName, "BAG");
    assert.equal(template.packingQuantity, 25);
    assert.equal(template.packingUnitCode, "KG");
    assert.equal(template.materialCount, 1);
  } finally {
    f.cleanup();
  }
});

test("a template belongs to its own sub-category, not to its siblings", () => {
  const f = createFixture();
  try {
    configuredBlack(f);
    assert.equal(f.db.rawMaterialSetupTemplate(f.pvc), null, "EVA's bag says nothing about PVC");
  } finally {
    f.cleanup();
  }
});

test("creating a material applies the pack it was given", () => {
  const f = createFixture();
  try {
    configuredBlack(f);
    const template = f.db.rawMaterialSetupTemplate(f.eva)!;

    const red = f.db.createInventoryItem({
      categoryId: f.eva,
      values: { colour: "RED" },
      unitId: template.unitId ?? undefined,
      packName: template.packName,
      packingQuantity: template.packingQuantity,
      packingUnitId: template.packingUnitId,
    });

    const config = f.db.listRawMaterialMovementConfig("").find((row) => row.itemId === red.id);
    assert.ok(config);
    assert.equal(config.packName, "BAG");
    assert.equal(config.packingQuantity, 25);
    assert.equal(config.packingUnitCode, "KG");
    assert.equal(config.packingConvertsToStock, true);
    assert.equal(config.defaultSectionId, null, "a material carries no destination any more");
  } finally {
    f.cleanup();
  }
});

test("a material created without a setup is left alone", () => {
  const f = createFixture();
  try {
    const black = f.db.createInventoryItem({ categoryId: f.eva, values: { colour: "BLACK" }, unitId: f.kg });
    const config = f.db.listRawMaterialMovementConfig("").find((row) => row.itemId === black.id);
    assert.ok(config);
    assert.equal(config.packingQuantity, null);
  } finally {
    f.cleanup();
  }
});

test("the newest setup wins, so the template follows the last correction", () => {
  const f = createFixture();
  try {
    configuredBlack(f);
    const red = f.db.createInventoryItem({ categoryId: f.eva, values: { colour: "RED" }, unitId: f.kg });
    f.db.setRawMaterialMovementConfig(red.id, {
      packName: "SACK",
      packingQuantity: 50,
      packingUnitId: f.kg,
    });

    const template = f.db.rawMaterialSetupTemplate(f.eva)!;
    assert.equal(template.sourceItemId, red.id);
    assert.equal(template.packName, "SACK");
    assert.equal(template.packingQuantity, 50);
    assert.equal(template.materialCount, 2);
  } finally {
    f.cleanup();
  }
});

test("applying a setup to a sub-category updates every material in it, and only it", () => {
  const f = createFixture();
  try {
    const black = configuredBlack(f);
    const red = f.db.createInventoryItem({ categoryId: f.eva, values: { colour: "RED" }, unitId: f.kg });
    const grey = f.db.createInventoryItem({ categoryId: f.pvc, values: { colour: "GREY" }, unitId: f.kg });

    const result = f.db.applyRawMaterialSetupToCategory(f.eva, {
      packName: "SACK",
      packingQuantity: 50,
      packingUnitId: f.kg,
    });
    assert.equal(result.updated, 2);

    const configs = f.db.listRawMaterialMovementConfig("");
    for (const itemId of [black.id, red.id]) {
      const row = configs.find((config) => config.itemId === itemId)!;
      assert.equal(row.packName, "SACK");
      assert.equal(row.packingQuantity, 50);
    }

    const untouched = configs.find((config) => config.itemId === grey.id)!;
    assert.equal(untouched.packingQuantity, null, "the other sub-category is not touched");
  } finally {
    f.cleanup();
  }
});

test("applying a setup does not change what a material is counted in", () => {
  const f = createFixture();
  try {
    const black = configuredBlack(f);
    f.db.adjustInventoryStock({ itemId: black.id, quantity: 100, note: "Opening", createdBy: "tester" });

    f.db.applyRawMaterialSetupToCategory(f.eva, {
      packName: "SACK",
      packingQuantity: 50,
      packingUnitId: f.kg,
    });

    const row = f.db.listRawMaterialMovementConfig("").find((config) => config.itemId === black.id)!;
    assert.equal(row.stockUnitCode, "KG", "the balance on the shelf still means what it meant");
    const item = f.db.listInventoryItems({}).find((entry) => String(entry.id) === black.id)!;
    assert.equal(Number(item.quantity_on_hand), 100);
    assert.equal(String(item.unit_code), "KG");
  } finally {
    f.cleanup();
  }
});

test("a failed apply leaves the whole sub-category as it was", () => {
  const f = createFixture();
  try {
    const black = configuredBlack(f);
    const red = f.db.createInventoryItem({ categoryId: f.eva, values: { colour: "RED" }, unitId: f.kg });

    // A unit that does not exist fails on the foreign key, part-way through the category.
    assert.throws(() =>
      f.db.applyRawMaterialSetupToCategory(f.eva, {
        packName: "SACK",
        packingQuantity: 50,
        packingUnitId: "no-such-unit",
      })
    );

    const configs = f.db.listRawMaterialMovementConfig("");
    const first = configs.find((config) => config.itemId === black.id)!;
    assert.equal(first.packName, "BAG", "the first material keeps the setup it had");
    assert.equal(first.packingQuantity, 25);

    const second = configs.find((config) => config.itemId === red.id)!;
    assert.equal(second.packingQuantity, null, "and the half-written one is rolled back");
  } finally {
    f.cleanup();
  }
});
