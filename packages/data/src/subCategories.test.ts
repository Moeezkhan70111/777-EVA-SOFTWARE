import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// Categories go exactly two levels deep: a kind of material, and the kinds of that.
//
// A sub-category is not an attribute. An attribute tells two materials of the same kind
// apart; a sub-category says they are different kinds that happen to live together. So a
// sub-category has its OWN attributes and inherits its parent's, and a material's identity
// is scoped to the sub-category it is in.

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-subcat-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "subcat.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.setNumberBlock(1, "test");
  db.createInventoryUnit({ code: "KG", name: "Kilogram" });
  const kg = (db.listInventoryUnits() as Array<{ id: string; code: string }>).find((u) => u.code === "KG")!.id;
  return {
    db,
    kg,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/** DANA, with a GRADE attribute, and two kinds of DANA underneath it. */
function danaTree(db: SqliteDatabase) {
  const dana = db.createInventoryCategory({ name: "DANA" });
  db.addInventoryCategoryField({ categoryId: dana, fieldKey: "grade", label: "GRADE", fieldType: "TEXT", required: true });
  const eva = db.createInventoryCategory({ name: "EVA", parentId: dana });
  const pvc = db.createInventoryCategory({ name: "PVC", parentId: dana });
  db.addInventoryCategoryField({ categoryId: eva, fieldKey: "density", label: "DENSITY", fieldType: "NUMBER" });
  return { dana, eva, pvc };
}

const categoryNamed = (db: SqliteDatabase, name: string) =>
  db.listInventoryCategories().find((row) => String(row.name) === name)!;

test("a sub-category inherits its parent's attributes and adds its own", () => {
  const { db, cleanup } = createFixture();
  try {
    const { eva, pvc } = danaTree(db);

    const evaFields = db.effectiveCategoryFields(eva);
    assert.deepEqual(evaFields.map((field) => String(field.label)), ["GRADE", "DENSITY"]);
    assert.equal(evaFields[0].inherited_from, "DANA", "the parent's attribute is marked as borrowed");
    assert.equal(evaFields[1].inherited_from, null, "its own is not");

    // A sibling gets the parent's, not the other sibling's.
    assert.deepEqual(db.effectiveCategoryFields(pvc).map((field) => String(field.label)), ["GRADE"]);
  } finally {
    cleanup();
  }
});

test("an attribute the parent already defines cannot be redefined underneath it", () => {
  const { db, cleanup } = createFixture();
  try {
    const { eva } = danaTree(db);
    assert.throws(
      () => db.addInventoryCategoryField({ categoryId: eva, fieldKey: "grade", label: "GRADE", fieldType: "TEXT" }),
      /already comes from DANA/
    );
  } finally {
    cleanup();
  }
});

test("the tree goes as deep as the business needs", () => {
  const { db, cleanup } = createFixture();
  try {
    const { eva } = danaTree(db);
    // A kind of a kind of a kind. The owner asked for free nesting (2026-10-07).
    const soft = db.createInventoryCategory({ name: "SOFT", parentId: eva });
    const extra = db.createInventoryCategory({ name: "EXTRA SOFT", parentId: soft });
    assert.equal(db.categoryPathName(extra), "DANA — EVA — SOFT — EXTRA SOFT");
  } finally {
    cleanup();
  }
});

test("a category deep in the tree asks for everything all of its ancestors ask for", () => {
  const { db, cleanup } = createFixture();
  try {
    const { eva } = danaTree(db);
    const soft = db.createInventoryCategory({ name: "SOFT", parentId: eva });
    db.addInventoryCategoryField({ categoryId: soft, fieldKey: "batch", label: "Batch", fieldType: "TEXT" });

    const keys = db.effectiveCategoryFields(soft).map((field) => String(field.field_key));
    assert.deepEqual(keys, ["grade", "density", "batch"], "DANA's, then EVA's, then its own");
  } finally {
    cleanup();
  }
});

test("a name only has to be unique among its siblings", () => {
  const { db, cleanup } = createFixture();
  try {
    const { dana } = danaTree(db);
    const ragzine = db.createInventoryCategory({ name: "RAGZINE" });

    // PLAIN under RAGZINE and PLAIN under DANA are different things.
    db.createInventoryCategory({ name: "PLAIN", parentId: dana });
    db.createInventoryCategory({ name: "PLAIN", parentId: ragzine });

    assert.throws(() => db.createInventoryCategory({ name: "PLAIN", parentId: dana }), /already has a "PLAIN"/);
    assert.throws(() => db.createInventoryCategory({ name: "DANA" }), /already exists/);
  } finally {
    cleanup();
  }
});

test("a material can be filed at any level, beside sub-categories or not", () => {
  const { db, kg, cleanup } = createFixture();
  try {
    const { dana, eva } = danaTree(db);

    // DANA has sub-categories AND may hold a material of its own.
    const grouped = db.createInventoryItem({ categoryId: dana, unitId: kg, values: { grade: "A" } });
    assert.equal(grouped.displayName, "DANA — A");

    const item = db.createInventoryItem({ categoryId: eva, unitId: kg, values: { grade: "A", density: "40" } });
    assert.equal(item.displayName, "DANA — EVA — A — 40", "the name says where it sits, then what tells it apart");
  } finally {
    cleanup();
  }
});

test("the same attribute values in two sub-categories are two different materials", () => {
  const { db, kg, cleanup } = createFixture();
  try {
    const { eva, pvc } = danaTree(db);

    const first = db.createInventoryItem({ categoryId: eva, unitId: kg, values: { grade: "A" } });
    const second = db.createInventoryItem({ categoryId: pvc, unitId: kg, values: { grade: "A" } });

    assert.notEqual(first.id, second.id);
    assert.equal(second.duplicate, undefined, "EVA grade A and PVC grade A are not the same thing");

    // Within one sub-category the duplicate rule still holds.
    const again = db.createInventoryItem({ categoryId: eva, unitId: kg, values: { grade: "A" } });
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
  } finally {
    cleanup();
  }
});

test("filtering by a parent shows everything under it; by a sub-category, just that one", () => {
  const { db, kg, cleanup } = createFixture();
  try {
    const { dana, eva, pvc } = danaTree(db);
    db.createInventoryItem({ categoryId: eva, unitId: kg, stockQuantity: 10, values: { grade: "A" } });
    db.createInventoryItem({ categoryId: eva, unitId: kg, stockQuantity: 20, values: { grade: "B" } });
    db.createInventoryItem({ categoryId: pvc, unitId: kg, stockQuantity: 5, values: { grade: "A" } });

    assert.equal(db.listInventoryItems({ categoryId: dana }).length, 3, "the parent means everything under it");
    assert.equal(db.listInventoryItems({ categoryId: eva }).length, 2);
    assert.equal(db.listInventoryItems({ categoryId: pvc }).length, 1);

    // Stock totals follow the same scope, through the same filter.
    assert.equal(db.queryInventoryStock({ categoryId: dana }).totalsByUnit[0].quantity, 35);
    assert.equal(db.queryInventoryStock({ categoryId: eva }).totalsByUnit[0].quantity, 30);
  } finally {
    cleanup();
  }
});

test("a listed material says both where it sits and which kind it is", () => {
  const { db, kg, cleanup } = createFixture();
  try {
    const { eva } = danaTree(db);
    db.createInventoryItem({ categoryId: eva, unitId: kg, values: { grade: "A" } });

    const row = db.listInventoryItems({})[0];
    assert.equal(row.top_category_name, "DANA");
    assert.equal(row.sub_category_name, "EVA");
    assert.equal(categoryNamed(db, "EVA").path_name, "DANA — EVA");
  } finally {
    cleanup();
  }
});

test("a category with no sub-categories still takes materials directly", () => {
  const { db, kg, cleanup } = createFixture();
  try {
    const buckle = db.createInventoryCategory({ name: "BUCKLE" });
    db.addInventoryCategoryField({ categoryId: buckle, fieldKey: "size", label: "SIZE", fieldType: "TEXT", required: true });

    const item = db.createInventoryItem({ categoryId: buckle, unitId: kg, values: { size: "20MM" } });
    assert.equal(item.displayName, "BUCKLE — 20MM");
    assert.equal(db.listInventoryItems({ categoryId: buckle })[0].sub_category_name, "");
  } finally {
    cleanup();
  }
});
