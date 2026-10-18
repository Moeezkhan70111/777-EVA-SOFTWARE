import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// Deleting a product and making it again.
//
// Reported from the floor on 2026-10-10: create a product, delete it, create it again →
// "Error processing product", and the thing the operator could not see was in the way.
//
// The cause is the gap between two halves of the schema. Deleting is a SOFT delete
// (disableProduct sets status = 'DISABLED' and deleted_at, so history keeps pointing somewhere),
// but article_sizes carries a hard UNIQUE(article, size) and product_variants a hard
// UNIQUE(article, color, size) — neither knows anything about deleted_at. The create path looked
// the row up with `deleted_at IS NULL`, missed the row holding the slot, fell through to its
// INSERT and died on the constraint.
//
// The fix is to look the row up regardless of deleted_at and bring it BACK, keeping its id and
// its product code — which is what every QR code, stock row and voucher line already pointing at
// that id requires. These tests pin that, and pin that the row is never duplicated.

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-product-recreate-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "products.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.setNumberBlock(1, "test");
  const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;

  const articleSizeRows = (article: string, size: string) =>
    raw
      .prepare("SELECT id, product_code, status, deleted_at FROM article_sizes WHERE article = ? AND size = ?")
      .all(article, size) as Array<{ id: string; product_code: string; status: string; deleted_at: string | null }>;

  const variantRows = (article: string, color: string, size: string) =>
    raw
      .prepare("SELECT id, status, deleted_at, article_size_id FROM product_variants WHERE article = ? AND color = ? AND size = ?")
      .all(article, color, size) as Array<{ id: string; status: string; deleted_at: string | null; article_size_id: string | null }>;

  /** What the Product List actually shows: its status filter defaults to ACTIVE. */
  const activeList = () => db.listProducts({ status: "ACTIVE", pageSize: 100 }).rows.map((row) => `${row.article} ${row.size}`);

  /**
   * The id the Product List deletes by.
   *
   * `listProducts` selects `ass.id`, so a row on that screen is the ARTICLE SIZE — while
   * `createProduct` returns the first colour VARIANT's id when it was given colours. Passing the
   * right one matters: disableProduct on an article size disables the product and its colours,
   * and on a variant disables only that colour.
   */
  const productId = (article: string, size: string) => articleSizeRows(article, size)[0].id;

  return {
    db,
    raw,
    articleSizeRows,
    variantRows,
    activeList,
    productId,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

const withFixture = (body: (f: ReturnType<typeof createFixture>) => void) => {
  const f = createFixture();
  try {
    body(f);
  } finally {
    f.cleanup();
  }
};

test("a deleted product can be made again, and comes back as the same product", () => {
  withFixture((f) => {
    const id = f.db.createProduct({ article: "SK9", size: "7/10", sellingPrice: 600, status: "ACTIVE" });
    const code = f.articleSizeRows("SK9", "7/10")[0].product_code;
    assert.deepEqual(f.activeList(), ["SK9 7/10"]);

    f.db.disableProduct(id, "deleted from product management");
    assert.deepEqual(f.activeList(), [], "the Product List stops showing it");
    assert.deepEqual(f.db.listUniqueArticles(), [], "and so do the Add Product dropdowns");

    // Exactly what the operator did next. This used to throw
    // "UNIQUE constraint failed: article_sizes.article, article_sizes.size".
    const again = f.db.createProduct({ article: "SK9", size: "7/10", sellingPrice: 600, status: "ACTIVE" });

    assert.equal(again, id, "the same product, not a second one");
    const rows = f.articleSizeRows("SK9", "7/10");
    assert.equal(rows.length, 1, "one row for one article and size — never a duplicate");
    assert.equal(rows[0].status, "ACTIVE");
    assert.equal(rows[0].deleted_at, null, "it is not deleted any more");
    assert.equal(rows[0].product_code, code, "and it keeps the code everything else points at");
    assert.deepEqual(f.activeList(), ["SK9 7/10"]);
    assert.deepEqual(f.db.listUniqueArticles(), ["SK9"]);
  });
});

test("making a deleted product again applies the figures it was made with the second time", () => {
  withFixture((f) => {
    const id = f.db.createProduct({ article: "SK9", size: "7/10", costPrice: 300, sellingPrice: 600, status: "ACTIVE" });
    f.db.disableProduct(id);

    f.db.createProduct({ article: "SK9", size: "7/10", costPrice: 350, sellingPrice: 700, status: "ACTIVE" });

    const product = f.db.getProduct(id);
    assert.equal(product?.sellingPrice, 700, "the price typed the second time is the price");
    assert.equal(product?.costPrice, 350);
  });
});

test("a deleted COLOUR can be made again too, without duplicating the variant", () => {
  withFixture((f) => {
    f.db.createProduct({ article: "SK9", size: "7/10", sellingPrice: 600, colors: ["BLACK", "RED"], status: "ACTIVE" });
    const blackId = f.variantRows("SK9", "BLACK", "7/10")[0].id;

    // Deleting the product from the Product List disables its colours with it.
    f.db.disableProduct(f.productId("SK9", "7/10"));
    assert.equal(f.variantRows("SK9", "BLACK", "7/10")[0].status, "DISABLED");
    assert.equal(f.variantRows("SK9", "RED", "7/10")[0].status, "DISABLED");

    // Making it again, this time only in BLACK. This used to throw
    // "UNIQUE constraint failed: product_variants.article, product_variants.color, product_variants.size".
    f.db.createProduct({ article: "SK9", size: "7/10", sellingPrice: 600, colors: ["BLACK"], status: "ACTIVE" });

    const black = f.variantRows("SK9", "BLACK", "7/10");
    assert.equal(black.length, 1, "one variant per article/colour/size");
    assert.equal(black[0].id, blackId, "the same variant, so its QR codes and stock still point at it");
    assert.equal(black[0].status, "ACTIVE");
    assert.equal(black[0].deleted_at, null);

    // RED was not named this time, so it stays as the delete left it. Re-enabling the product is
    // what brings every colour back; creating it again only promises the colours it names.
    assert.equal(f.variantRows("SK9", "RED", "7/10")[0].status, "DISABLED");
  });
});

test("adding a deleted colour through Edit Product brings it back rather than failing", () => {
  withFixture((f) => {
    f.db.createProduct({ article: "SK9", size: "7/10", sellingPrice: 600, colors: ["BLACK"], status: "ACTIVE" });
    const blackId = f.variantRows("SK9", "BLACK", "7/10")[0].id;

    // Just the colour goes, not the product — disableProduct on a variant id.
    f.db.disableProduct(blackId, "wrong colour");
    assert.notEqual(f.variantRows("SK9", "BLACK", "7/10")[0].deleted_at, null);

    f.db.updateProduct(f.productId("SK9", "7/10"), {
      article: "SK9",
      size: "7/10",
      sellingPrice: 600,
      colors: ["BLACK"],
      status: "ACTIVE",
    });

    const black = f.variantRows("SK9", "BLACK", "7/10");
    assert.equal(black.length, 1);
    assert.equal(black[0].id, blackId);
    assert.equal(black[0].deleted_at, null);
    assert.equal(black[0].status, "ACTIVE");
  });
});

test("re-enabling a deleted product is still the way to bring back everything it had", () => {
  withFixture((f) => {
    const id = f.db.createProduct({ article: "SK9", size: "7/10", sellingPrice: 600, colors: ["BLACK", "RED"], status: "ACTIVE" });
    f.db.disableProduct(id);

    f.db.enableProduct(id);

    assert.deepEqual(f.activeList(), ["SK9 7/10"]);
    assert.equal(f.variantRows("SK9", "BLACK", "7/10")[0].status, "ACTIVE");
    assert.equal(f.variantRows("SK9", "RED", "7/10")[0].status, "ACTIVE", "both colours, unlike creating it again");
  });
});

test("a live product is still never duplicated by making it again", () => {
  withFixture((f) => {
    const id = f.db.createProduct({ article: "SK9", size: "7/10", sellingPrice: 600, status: "ACTIVE" });
    const again = f.db.createProduct({ article: "SK9", size: "7/10", sellingPrice: 650, status: "ACTIVE" });

    assert.equal(again, id);
    assert.equal(f.articleSizeRows("SK9", "7/10").length, 1);
    assert.equal(f.db.getProduct(id)?.sellingPrice, 650);
  });
});
