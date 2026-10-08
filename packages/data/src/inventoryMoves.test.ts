import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// Re-filing a category or a material. What these tests hold in place:
//
//   - categories nest as deep as the business needs, and a material may sit at any level;
//   - a category can never be filed inside itself or inside its own branch;
//   - a material's stock, code and history survive a move untouched;
//   - its display name follows the place it is filed, including when its CATEGORY moves;
//   - values travel by field key, and a move that would leave it invalid or duplicated is
//     refused — with the reason said before anything happens.

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-inventory-moves-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "moves.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });

  db.createInventoryUnit({ code: "DZN", name: "Dozen" });
  const unitId = (db.listInventoryUnits() as Array<{ id: string; code: string }>).find((u) => u.code === "DZN")!.id;

  // UPPER ▸ PVC UPPER and UPPER ▸ RUBBER UPPER both ask for ARTICLE and COLOUR, through the
  // parent. BINDING is a separate top-level kind that asks only for its own WIDTH.
  const upper = db.createInventoryCategory({ name: "UPPER" });
  db.addInventoryCategoryField({ categoryId: upper, fieldKey: "article", label: "ARTICLE", fieldType: "TEXT", required: true });
  db.addInventoryCategoryField({ categoryId: upper, fieldKey: "colour", label: "COLOUR", fieldType: "TEXT", required: true });
  const pvc = db.createInventoryCategory({ name: "PVC UPPER", parentId: upper });
  const rubber = db.createInventoryCategory({ name: "RUBBER UPPER", parentId: upper });

  const binding = db.createInventoryCategory({ name: "BINDING" });
  db.addInventoryCategoryField({ categoryId: binding, fieldKey: "width", label: "WIDTH", fieldType: "TEXT", required: true });

  const item = db.createInventoryItem({
    categoryId: pvc,
    unitId,
    stockQuantity: 25,
    values: { article: "SK6", colour: "BLACK" },
  });

  const itemRow = () =>
    db.db.prepare("SELECT item_code, display_name, category_id, signature_hash FROM inventory_items WHERE id = ?").get(item.id) as {
      item_code: string;
      display_name: string;
      category_id: string;
      signature_hash: string;
    };
  const onHand = () =>
    Number(
      (db.db.prepare("SELECT quantity_on_hand FROM inventory_stock_balances WHERE item_id = ?").get(item.id) as
        | { quantity_on_hand: number }
        | undefined)?.quantity_on_hand ?? 0
    );
  const categoryRow = (id: string) =>
    db.db.prepare("SELECT name, parent_id FROM inventory_categories WHERE id = ?").get(id) as {
      name: string;
      parent_id: string | null;
    };

  return { db, unitId, upper, pvc, rubber, binding, itemId: item.id, itemRow, onHand, categoryRow, tempDir };
}

// ─── Moving a category ───────────────────────────────────────────────────────

test("a sub-category can be promoted to the top level, and pushed back under a parent", () => {
  const { db, pvc, upper, categoryRow } = createFixture();

  db.moveInventoryCategory(pvc, null);
  assert.equal(categoryRow(pvc).parent_id, null);

  db.moveInventoryCategory(pvc, upper);
  assert.equal(categoryRow(pvc).parent_id, upper);
});

test("categories nest as deep as the business needs", () => {
  const { db, pvc, binding, upper, categoryRow } = createFixture();

  // A third level: BINDING becomes a kind of PVC UPPER, which is a kind of UPPER.
  assert.deepEqual(db.previewCategoryMove(binding, pvc).blockers, []);
  db.moveInventoryCategory(binding, pvc);
  assert.equal(categoryRow(binding).parent_id, pvc);
  assert.equal(db.categoryPathName(binding), "UPPER — PVC UPPER — BINDING");

  // And a fourth, under the third.
  const deepest = db.createInventoryCategory({ name: "INTERLOCK", parentId: binding });
  assert.equal(db.categoryPathName(deepest), "UPPER — PVC UPPER — BINDING — INTERLOCK");

  // A whole branch moves at once: everything under UPPER keeps its shape.
  db.moveInventoryCategory(pvc, null);
  assert.equal(db.categoryPathName(deepest), "PVC UPPER — BINDING — INTERLOCK");
  assert.equal(db.categoryPathName(upper), "UPPER");
});

test("a category cannot be filed inside itself or inside its own branch", () => {
  const { db, upper, pvc, binding } = createFixture();

  assert.equal(db.previewCategoryMove(pvc, pvc).blockers.some((b) => /under itself/.test(b)), true);

  // UPPER cannot go inside PVC UPPER, which is already inside UPPER.
  assert.equal(
    db.previewCategoryMove(upper, pvc).blockers.some((b) => /already inside UPPER/.test(b)),
    true
  );
  assert.throws(() => db.moveInventoryCategory(upper, pvc), /already inside/);

  // Nor inside a grandchild.
  db.moveInventoryCategory(binding, pvc);
  assert.throws(() => db.moveInventoryCategory(upper, binding), /already inside/);
});

test("a category cannot be filed under itself", () => {
  const { db, pvc } = createFixture();
  assert.equal(db.previewCategoryMove(pvc, pvc).blockers.some((b) => /under itself/.test(b)), true);
});

test("a category can hold materials and sub-categories side by side", () => {
  const { db, binding, unitId, rubber, categoryRow } = createFixture();
  db.createInventoryItem({ categoryId: binding, unitId, stockQuantity: 1, values: { width: "1 INCH" } });

  // RUBBER UPPER becomes a kind of BINDING even though BINDING already holds a material.
  assert.deepEqual(db.previewCategoryMove(rubber, binding).blockers, []);
  db.moveInventoryCategory(rubber, binding);
  assert.equal(categoryRow(rubber).parent_id, binding);

  // And a new material can still be filed directly on BINDING afterwards.
  const alongside = db.createInventoryItem({ categoryId: binding, unitId, stockQuantity: 2, values: { width: "2 INCH" } });
  assert.equal(alongside.duplicate, undefined);
});

test("two sub-categories of the same parent cannot share a name", () => {
  const { db, upper, binding } = createFixture();
  const other = db.createInventoryCategory({ name: "PVC UPPER", parentId: binding });

  assert.equal(
    db.previewCategoryMove(other, upper).blockers.some((b) => /already a sub-category called/i.test(b)),
    true
  );
});

test("moving a category renames every material under it, and says how many first", () => {
  const { db, pvc, itemRow } = createFixture();

  assert.equal(itemRow().display_name.startsWith("UPPER — PVC UPPER"), true);

  const preview = db.previewCategoryMove(pvc, null);
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.from, "UPPER — PVC UPPER");
  assert.equal(preview.to, "PVC UPPER");
  assert.equal(preview.renames, 1);

  db.moveInventoryCategory(pvc, null);
  assert.equal(itemRow().display_name.startsWith("PVC UPPER"), true);
  assert.equal(itemRow().display_name.includes("UPPER — PVC UPPER"), false);
});

// ─── Moving a material ───────────────────────────────────────────────────────

test("a material keeps its code, its stock and its values when it moves between sister categories", () => {
  const { db, rubber, itemId, itemRow, onHand } = createFixture();
  const before = itemRow();

  const preview = db.previewInventoryItemMove(itemId, rubber);
  assert.deepEqual(preview.blockers, []);
  assert.deepEqual(preview.dropped, []);
  assert.equal(preview.carried.length, 2, "ARTICLE and COLOUR are asked for on both sides");
  assert.equal(preview.to, "UPPER — RUBBER UPPER");

  db.moveInventoryItem({ itemId, targetCategoryId: rubber });

  const after = itemRow();
  assert.equal(after.item_code, before.item_code, "the code is the material's identity — it must not change");
  assert.equal(onHand(), 25, "stock does not move when the filing does");
  assert.equal(after.category_id, rubber);
  assert.equal(after.display_name, preview.newDisplayName);
  assert.equal(after.display_name.startsWith("UPPER — RUBBER UPPER"), true);
  assert.notEqual(after.signature_hash, before.signature_hash, "identity is taken over the category too");
});

test("its values end up pointing at the new category's own fields, not the old one's", () => {
  const { db, rubber, itemId } = createFixture();
  db.moveInventoryItem({ itemId, targetCategoryId: rubber });

  const stray = db.db
    .prepare(
      `SELECT COUNT(*) AS n FROM inventory_item_values v
       JOIN inventory_category_fields f ON f.id = v.field_id
       WHERE v.item_id = ?
         AND f.category_id NOT IN (?, (SELECT parent_id FROM inventory_categories WHERE id = ?))`
    )
    .get(itemId, rubber, rubber) as { n: number };
  assert.equal(Number(stray.n), 0);
});

test("a move that cannot answer the target's required questions is refused, and says which", () => {
  const { db, binding, itemId, itemRow } = createFixture();
  const before = itemRow();

  const preview = db.previewInventoryItemMove(itemId, binding);
  assert.deepEqual(preview.missingRequired, ["WIDTH"]);
  assert.equal(preview.dropped.length, 2, "ARTICLE and COLOUR would be let go");
  assert.equal(preview.blockers.some((b) => /asks for WIDTH/.test(b)), true);

  assert.throws(() => db.moveInventoryItem({ itemId, targetCategoryId: binding }), /asks for WIDTH/);
  assert.deepEqual(itemRow(), before, "a refused move changes nothing at all");
});

test("a move onto a material that is already there is refused by name", () => {
  const { db, rubber, unitId, itemId } = createFixture();
  db.createInventoryItem({ categoryId: rubber, unitId, stockQuantity: 5, values: { article: "SK6", colour: "BLACK" } });

  const preview = db.previewInventoryItemMove(itemId, rubber);
  assert.equal(preview.blockers.some((b) => /already holds the same material/.test(b)), true);
  assert.throws(() => db.moveInventoryItem({ itemId, targetCategoryId: rubber }), /already holds the same material/);
});

test("a material can be filed at any level, but not where it already is", () => {
  const { db, upper, pvc, itemId, itemRow } = createFixture();

  // UPPER has sub-categories and may still take the material itself.
  assert.deepEqual(db.previewInventoryItemMove(itemId, upper).blockers, []);
  db.moveInventoryItem({ itemId, targetCategoryId: upper });
  assert.equal(itemRow().category_id, upper);
  assert.equal(itemRow().display_name.startsWith("UPPER"), true);

  assert.equal(db.previewInventoryItemMove(itemId, upper).blockers.some((b) => /already filed here/.test(b)), true);
  // And back down again.
  assert.deepEqual(db.previewInventoryItemMove(itemId, pvc).blockers, []);
});

test("after a move the material is found under its new category and not the old one", () => {
  const { db, pvc, rubber, itemId } = createFixture();
  db.moveInventoryItem({ itemId, targetCategoryId: rubber });

  const inNew = db.listInventoryItems({ categoryId: rubber }) as Array<{ id: string }>;
  const inOld = db.listInventoryItems({ categoryId: pvc }) as Array<{ id: string }>;
  assert.equal(inNew.some((row) => row.id === itemId), true);
  assert.equal(inOld.some((row) => row.id === itemId), false);
});
