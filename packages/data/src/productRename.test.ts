import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// Editing a product's ARTICLE or SIZE.
//
// Reported 2026-10-11: create SK6, edit it to SK30, save — and it still says SK6. updateProduct
// saved everything except the article and the size, and said nothing about it.
//
// The article and size are the product's identity — every carton QR spells them out — so the
// rule is the one Product Lists already applies to a whole article: they may change only while no
// QR code carries them. These tests pin the rename, both refusals, and that a refused edit
// changes nothing at all.

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-product-rename-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "products.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.setNumberBlock(1, "test");
  const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  const articleSizeId = (article: string, size: string): string | undefined =>
    (raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ?").get(article, size) as { id: string } | undefined)?.id;
  const variantArticles = (id: string) =>
    (raw.prepare("SELECT article, size, color FROM product_variants WHERE article_size_id = ? ORDER BY color").all(id) as Array<{ article: string; size: string; color: string }>)
      .map((row) => `${row.article} ${row.color} ${row.size}`);
  const edit = (id: string, article: string, size: string, sellingPrice = 650) =>
    db.updateProduct(id, { article, size, sellingPrice, colors: ["BLACK", "RED"], status: "ACTIVE" });
  return { db, raw, tempDir, articleSizeId, variantArticles, edit };
}

const withFixture = (body: (f: ReturnType<typeof createFixture>) => void) => {
  const f = createFixture();
  try {
    body(f);
  } finally {
    f.db.close();
    fs.rmSync(f.tempDir, { recursive: true, force: true });
  }
};

test("editing SK6 to SK30 renames the product and every colour of it", () => {
  withFixture((f) => {
    f.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 600, colors: ["BLACK", "RED"], status: "ACTIVE" });
    const id = f.articleSizeId("SK6", "7/10")!;

    f.edit(id, "sk30", "7/10", 650);

    assert.equal(f.articleSizeId("SK6", "7/10"), undefined, "nothing is left under the old name");
    assert.equal(f.articleSizeId("SK30", "7/10"), id, "the same product, renamed — not a new one");
    assert.deepEqual(f.variantArticles(id), ["SK30 BLACK 7/10", "SK30 RED 7/10"]);
    assert.equal(f.db.getProduct(id)?.sellingPrice, 650, "the rest of the edit is saved with it");
  });
});

test("the size can be changed the same way", () => {
  withFixture((f) => {
    f.db.createProduct({ article: "SK6", size: "7/10", colors: ["BLACK"], status: "ACTIVE" });
    const id = f.articleSizeId("SK6", "7/10")!;

    f.db.updateProduct(id, { article: "SK6", size: "8/11", colors: ["BLACK"], status: "ACTIVE" });

    assert.equal(f.articleSizeId("SK6", "8/11"), id);
    assert.deepEqual(f.variantArticles(id), ["SK6 BLACK 8/11"]);
  });
});

test("a product whose QR codes are printed cannot be renamed, and the refused edit changes nothing", () => {
  withFixture((f) => {
    f.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 600, colors: ["BLACK", "RED"], status: "ACTIVE" });
    const id = f.articleSizeId("SK6", "7/10")!;
    f.db.generateQrBatch({ articleSizeId: id, color: "BLACK", quantity: 2 });

    assert.throws(() => f.edit(id, "SK30", "7/10", 999), /2 QR codes carry it in their identity/);

    assert.equal(f.articleSizeId("SK6", "7/10"), id);
    assert.equal(f.db.getProduct(id)?.sellingPrice, 600, "not even the price was saved");
  });
});

test("renaming onto a product that already exists is refused, even a disabled one", () => {
  withFixture((f) => {
    f.db.createProduct({ article: "SK6", size: "7/10", colors: ["BLACK"], status: "ACTIVE" });
    f.db.createProduct({ article: "SK30", size: "7/10", colors: ["BLACK"], status: "ACTIVE" });
    f.db.disableProduct(f.articleSizeId("SK30", "7/10")!);
    const id = f.articleSizeId("SK6", "7/10")!;

    assert.throws(() => f.edit(id, "SK30", "7/10"), /SK30 7\/10 already exists/);
    assert.equal(f.articleSizeId("SK6", "7/10"), id);
  });
});

test("an edit that sends no article or size leaves them as they are", () => {
  withFixture((f) => {
    f.db.createProduct({ article: "SK6", size: "7/10", colors: ["BLACK"], status: "ACTIVE" });
    const id = f.articleSizeId("SK6", "7/10")!;

    f.db.updateProduct(id, { article: "", size: "", sellingPrice: 700, colors: ["BLACK"], status: "ACTIVE" });

    assert.equal(f.articleSizeId("SK6", "7/10"), id);
    assert.equal(f.db.getProduct(id)?.sellingPrice, 700);
  });
});
