import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// Product Lists: managing the values behind the Add / Edit Product dropdowns.

function createDbFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-lists-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "lists.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.ensureOperationalContext({
    factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });
  const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  const articleSizeId = (article: string, size: string) =>
    (raw.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ?").get(article, size) as { id: string }).id;
  return { db, raw, articleSizeId, cleanup: () => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); } };
}

const names = (db: SqliteDatabase, kind: Parameters<SqliteDatabase["listProductListEntries"]>[0]) =>
  db.listProductListEntries(kind).map((e) => e.name);

test("Product Lists: an accidental article can be renamed, and the rename reaches every product carrying it", () => {
  const f = createDbFixture();
  try {
    f.db.createProduct({ article: "SK16", size: "7/10", sellingPrice: 500, status: "ACTIVE" });
    f.db.createProduct({ article: "SK16", size: "4/6", sellingPrice: 500, status: "ACTIVE" });
    f.db.createProduct({ article: "SK12", size: "7/10", sellingPrice: 500, status: "ACTIVE" });
    // Colour variants hang off the product entries.
    f.raw.prepare("INSERT INTO product_variants (id, article, color, size, article_size_id, status, created_at, updated_at) VALUES ('v1','SK16','RED','7/10',?, 'ACTIVE', 'x', 'x')").run(f.articleSizeId("SK16", "7/10"));

    const before = f.db.listProductListEntries("article");
    assert.deepEqual(before.map((e) => [e.name, e.productCount, e.qrCount, e.renameBlockedReason]), [
      ["SK12", 1, 0, null],
      ["SK16", 2, 0, null],
    ]);

    const result = f.db.renameProductListEntry({ kind: "article", id: "SK16", newName: " sk6 " });
    assert.equal(result.name, "SK6");
    assert.equal(result.affected, 3); // 2 product entries + 1 variant
    assert.deepEqual(names(f.db, "article"), ["SK12", "SK6"]);
    assert.deepEqual(f.db.listUniqueArticles(), ["SK12", "SK6"]);
    assert.equal((f.raw.prepare("SELECT article FROM product_variants WHERE id = 'v1'").get() as { article: string }).article, "SK6");
  } finally {
    f.cleanup();
  }
});

test("Product Lists: renaming into an article/size that already exists is refused", () => {
  const f = createDbFixture();
  try {
    f.db.createProduct({ article: "SK16", size: "7/10", sellingPrice: 500, status: "ACTIVE" });
    f.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 500, status: "ACTIVE" });
    assert.throws(() => f.db.renameProductListEntry({ kind: "article", id: "SK16", newName: "SK6" }), /SK6 \/ 7\/10 already exists/);
    // Sizes: 7/1O (typo) → 7/10 clashes for SK6.
    f.db.createProduct({ article: "SK6", size: "7/1O", sellingPrice: 500, status: "ACTIVE" });
    assert.throws(() => f.db.renameProductListEntry({ kind: "size", id: "7/1O", newName: "7/10" }), /SK6 \/ 7\/10 already exists/);
    // A size used only where no clash exists renames fine.
    f.db.createProduct({ article: "SK9", size: "11/1", sellingPrice: 500, status: "ACTIVE" });
    assert.equal(f.db.renameProductListEntry({ kind: "size", id: "11/1", newName: "11/12" }).affected, 1);
    assert.deepEqual(f.db.listUniqueSizesByArticle("SK9"), ["11/12"]);
  } finally {
    f.cleanup();
  }
});

test("Product Lists: an article or size with registered QR codes can be neither renamed nor deleted", () => {
  const f = createDbFixture();
  try {
    f.db.createProduct({ article: "SK16", size: "7/10", sellingPrice: 500, status: "ACTIVE" });
    f.db.generateQrBatch({ articleSizeId: f.articleSizeId("SK16", "7/10"), color: "RED", quantity: 3 });

    const [entry] = f.db.listProductListEntries("article");
    assert.equal(entry.qrCount, 3);
    assert.match(entry.renameBlockedReason ?? "", /3 QR codes carry this article/);
    assert.match(entry.deleteBlockedReason ?? "", /3 QR codes carry this article/);
    assert.throws(() => f.db.renameProductListEntry({ kind: "article", id: "SK16", newName: "SK6" }), /QR codes carry/);
    assert.throws(() => f.db.deleteProductListEntry({ kind: "article", id: "SK16" }), /QR codes carry/);
    assert.throws(() => f.db.deleteProductListEntry({ kind: "size", id: "7/10" }), /QR codes carry/);
    // Nothing changed.
    assert.deepEqual(names(f.db, "article"), ["SK16"]);
    assert.equal(f.db.listProducts({ status: "ACTIVE" }).total, 1);
  } finally {
    f.cleanup();
  }
});

test("Product Lists: deleting an article disables its products (so it leaves the dropdown) and records who did it", () => {
  const f = createDbFixture();
  try {
    f.db.createProduct({ article: "SK16", size: "7/10", sellingPrice: 500, status: "ACTIVE" });
    f.db.createProduct({ article: "SK16", size: "4/6", sellingPrice: 500, status: "ACTIVE" });
    f.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 500, status: "ACTIVE" });

    const result = f.db.deleteProductListEntry({ kind: "article", id: "SK16", actor: "Moeezkhan123" });
    assert.equal(result.affected, 2);
    assert.deepEqual(f.db.listUniqueArticles(), ["SK6"]);
    assert.deepEqual(names(f.db, "article"), ["SK6"]);
    const row = f.raw.prepare("SELECT status, deleted_by, delete_reason FROM article_sizes WHERE article = 'SK16' AND size = '7/10'").get() as Record<string, string>;
    assert.equal(row.status, "DISABLED");
    assert.equal(row.deleted_by, "Moeezkhan123");
    assert.match(row.delete_reason, /Removed from Product Lists by Moeezkhan123/);
    // Product List's own Enable still brings it back — nothing was hard-deleted.
    f.db.enableProduct(f.articleSizeId("SK16", "7/10"));
    assert.deepEqual(f.db.listUniqueArticles(), ["SK16", "SK6"]);
  } finally {
    f.cleanup();
  }
});

test("Product Lists: groups and series rename in place, refuse duplicates, and delete only when unused", () => {
  const f = createDbFixture();
  try {
    const ladies = f.db.createMainGroup({ groupName: "LADEIS" });
    const gents = f.db.createMainGroup({ groupName: "GENTS" });
    const pg = f.db.createProductGroup({ groupName: "SCHOOL" });
    const series = f.db.createArticleSeries({ name: "SK" });
    f.db.createProduct({ article: "SK6", size: "7/10", sellingPrice: 500, status: "ACTIVE", mainGroupId: gents, productGroupId: pg, articleSeriesId: series });

    // Rename with normalisation; duplicate names refused case-insensitively.
    assert.equal(f.db.renameProductListEntry({ kind: "main-group", id: ladies, newName: "ladies" }).name, "LADIES");
    assert.deepEqual(names(f.db, "main-group"), ["GENTS", "LADIES"]);
    assert.throws(() => f.db.renameProductListEntry({ kind: "main-group", id: ladies, newName: "gents" }), /already exists/);

    // Unused → deletable; used → blocked with the reason.
    const entries = f.db.listProductListEntries("main-group");
    assert.equal(entries.find((e) => e.id === ladies)?.deleteBlockedReason, null);
    assert.match(entries.find((e) => e.id === gents)?.deleteBlockedReason ?? "", /used by 1 product/);
    assert.throws(() => f.db.deleteProductListEntry({ kind: "main-group", id: gents }), /used by 1 product/);
    assert.throws(() => f.db.deleteProductListEntry({ kind: "product-group", id: pg }), /used by 1 product/);
    assert.throws(() => f.db.deleteProductListEntry({ kind: "article-series", id: series }), /used by 1 product/);

    assert.equal(f.db.deleteProductListEntry({ kind: "main-group", id: ladies, actor: "admin" }).affected, 1);
    assert.deepEqual(names(f.db, "main-group"), ["GENTS"]);
    assert.deepEqual(f.db.listMainGroups().map((g) => g.groupName), ["GENTS"]); // gone from the dropdown source too
    assert.throws(() => f.db.deleteProductListEntry({ kind: "main-group", id: ladies }), /not found/);

    // A party discount rule also counts as usage.
    const unusedPg = f.db.createProductGroup({ groupName: "SPORTS" });
    const partyId = f.db.createParty({ partyName: "P", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300", status: "ACTIVE" });
    f.raw
      .prepare("INSERT INTO party_product_group_discounts (id, party_id, product_group_id, discount_per_pair_paisa, created_at, updated_at) VALUES ('d1', ?, ?, 500, 'x', 'x')")
      .run(partyId, unusedPg);
    assert.match(f.db.listProductListEntries("product-group").find((e) => e.id === unusedPg)?.deleteBlockedReason ?? "", /1 party discount rule/);
  } finally {
    f.cleanup();
  }
});
