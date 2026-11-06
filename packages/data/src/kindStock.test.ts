// Upper Stock and Dana Stock, against a real database: each page holds its own kind and only that,
// the balance is the one every other screen reads, and a role's grant is what decides who gets in.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PERMISSION, RAW_MATERIAL_KIND } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-kind-stock-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "erp.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.setNumberBlock(1, "test");
  const dozen = db.createInventoryUnit({ code: "DOZEN", name: "Dozen" });
  const kg = db.createInventoryUnit({ code: "KG", name: "Kilogram" });

  const category = (name: string, parentId?: string) => {
    const id = db.createInventoryCategory({ name, parentId });
    if (!parentId) db.addInventoryCategoryField({ categoryId: id, fieldKey: "name", label: "Name", fieldType: "TEXT", required: true });
    return id;
  };
  const material = (categoryId: string, name: string, unitId: string, stockQuantity: number, costPrice?: number) =>
    db.createInventoryItem({ categoryId, values: { name }, unitId, stockQuantity, costPrice, createdBy: "test" }).id;

  return { db, dozen, kg, category, material, cleanup: () => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); } };
}

test("each kind holds its own materials, sub-categories included, and no one else's", () => {
  const { db, dozen, kg, category, material, cleanup } = createFixture();
  try {
    const upper = category("UPPER");
    const rubber = category("RUBBER UPPER", upper);
    const dana = category("DANA");
    const carton = category("CARTON");
    material(upper, "PLAIN", dozen, 12);
    material(rubber, "BLACK", dozen, 30);
    material(dana, "VOTS EVA", kg, 250);
    material(carton, "BOX", dozen, 99);

    const uppers = db.listKindStock(RAW_MATERIAL_KIND.UPPER);
    assert.equal(uppers.itemCount, 2);
    assert.deepEqual(uppers.items.map((row) => row.quantity).sort((a, b) => a - b), [12, 30]);
    assert.equal(uppers.items.find((row) => row.quantity === 30)?.subCategory, "RUBBER UPPER");
    assert.deepEqual(uppers.totalsByUnit.map(({ unitCode, quantity }) => ({ unitCode, quantity })), [{ unitCode: "DOZEN", quantity: 42 }]);

    const danas = db.listKindStock(RAW_MATERIAL_KIND.DANA);
    assert.equal(danas.itemCount, 1);
    assert.equal(danas.items[0]?.unitCode, "KG");
  } finally {
    cleanup();
  }
});

test("reads the same balance as the stock screens, and adds units up separately", () => {
  const { db, dozen, kg, category, material, cleanup } = createFixture();
  try {
    const dana = category("DANA");
    material(dana, "SPECIAL EVR", kg, 100);
    material(dana, "LOOSE", dozen, 4);

    const page = db.listKindStock(RAW_MATERIAL_KIND.DANA);
    const screen = db.queryInventoryStock({ categoryId: dana });
    assert.deepEqual(page.totalsByUnit, screen.totalsByUnit);
    assert.equal(page.itemCount, screen.itemCount);
    assert.equal(page.totalsByUnit.length, 2);
  } finally {
    cleanup();
  }
});

test("gives the page what it shows and not the cost price", () => {
  const { db, kg, category, material, cleanup } = createFixture();
  try {
    material(category("DANA"), "FAST EVA", kg, 10, 450);
    const [row] = db.listKindStock(RAW_MATERIAL_KIND.DANA).items;
    assert.deepEqual(Object.keys(row ?? {}).sort(), ["code", "id", "name", "quantity", "subCategory", "unitCode"]);
  } finally {
    cleanup();
  }
});

test("searches and pages on the data side, and totals follow the search", () => {
  const { db, kg, category, material, cleanup } = createFixture();
  try {
    const dana = category("DANA");
    for (let n = 1; n <= 7; n += 1) material(dana, `GRADE ${n}`, kg, n);
    material(dana, "SPECIAL", kg, 100);

    const first = db.listKindStock(RAW_MATERIAL_KIND.DANA, { pageSize: 3 });
    assert.equal(first.items.length, 3);
    assert.equal(first.pages, 3);
    assert.equal(first.itemCount, 8);
    assert.equal(first.totalsByUnit[0]?.quantity, 128);

    const last = db.listKindStock(RAW_MATERIAL_KIND.DANA, { pageSize: 3, page: 99 });
    assert.equal(last.page, 3);
    assert.equal(last.items.length, 2);

    const found = db.listKindStock(RAW_MATERIAL_KIND.DANA, { search: "special" });
    assert.equal(found.itemCount, 1);
    assert.equal(found.totalsByUnit[0]?.quantity, 100);
  } finally {
    cleanup();
  }
});

test("a store with none of that kind set up is an empty page, not a failure", () => {
  const { db, cleanup } = createFixture();
  try {
    assert.deepEqual(db.listKindStock(RAW_MATERIAL_KIND.UPPER), { kind: "UPPER", items: [], itemCount: 0, totalsByUnit: [], page: 1, pages: 1 });
  } finally {
    cleanup();
  }
});

test("a role keeps the dotted codes exactly, each on its own", () => {
  const { db, cleanup } = createFixture();
  try {
    const role = db.createRole({ name: "Upper Viewer", permissions: [PERMISSION.STOCK_UPPER_VIEW] });
    assert.deepEqual(role.permissions, ["stock.upper.view"]);

    db.updateRole(role.code, { permissions: [PERMISSION.STOCK_DANA_VIEW] });
    assert.deepEqual(db.listRoles().find((row) => row.code === role.code)?.permissions, ["stock.dana.view"]);

    db.updateRole(role.code, { permissions: [] });
    assert.deepEqual(db.listRoles().find((row) => row.code === role.code)?.permissions, []);
  } finally {
    cleanup();
  }
});

test("the upper matrix reads the same balances as Upper Move Out, per sub-category, by article", () => {
  const { db, dozen, category, cleanup } = createFixture();
  try {
    const upper = category("UPPER");
    const rubber = category("RUBBER UPPER", upper);
    const ragzine = category("RAGZINE UPPER", upper);
    for (const id of [rubber, ragzine]) {
      for (const fieldKey of ["article", "size", "color", "type"]) {
        db.addInventoryCategoryField({ categoryId: id, fieldKey, label: fieldKey, fieldType: "TEXT", required: false });
      }
    }
    const upperOf = (categoryId: string, article: string, size: string, color: string, stockQuantity: number, type?: string) =>
      db.createInventoryItem({ categoryId, values: { name: `${article} ${size} ${color} ${type ?? ""}`, article, size, color, type }, unitId: dozen, stockQuantity, createdBy: "test" });
    upperOf(rubber, "SK6", "7/10", "BLACK", 10);
    upperOf(rubber, "SK6", "7/10", "RED", 20);
    upperOf(rubber, "DC1", "6/7", "BLACK", 12.5, "L");
    upperOf(rubber, "DC1", "6/7", "BLACK", 12.5, "R");
    upperOf(ragzine, "HR1", "7/10", "CREAM", 7);

    const all = db.listUpperStockMatrix();
    assert.deepEqual(all.articles.map((article) => [article.article, article.total]), [["DC1", 25], ["HR1", 7], ["SK6", 30]]);
    const shown = all.articles.reduce((sum, article) => sum + article.total, 0);
    assert.equal(shown, db.listUpperStock().reduce((sum, row) => sum + row.onHand, 0));

    assert.deepEqual(all.articles[0]?.rows.map((row) => [row.type, row.quantities]), [["L", [12.5]], ["R", [12.5]]]);
    assert.deepEqual(db.listUpperStockMatrix({ category: "RAGZINE UPPER" }).articles.map((article) => article.article), ["HR1"]);
  } finally {
    cleanup();
  }
});
