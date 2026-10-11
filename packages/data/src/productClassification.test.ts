// Product Type and Product Sub Group — the two classifications added on 2026-10-11.
//
//   Main Group        CHAPPAL
//   Product Group     GENTS
//   Product Sub Group GENTS CASUAL     belongs to GENTS
//   Article Series    SK
//   Product Type      MOULDED          a list of its own
//
// The owner settled the shape: a TYPE is a flat list like the main group, and a SUB GROUP
// belongs to a product group. These tests pin that difference, because it is the whole reason
// the two are not one implementation.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-classification-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "erp.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;

  const gents = db.createProductGroup({ groupName: "GENTS" });
  const ladies = db.createProductGroup({ groupName: "LADIES" });

  const articleSizeRow = (article: string, size: string) =>
    raw
      .prepare("SELECT id, product_type_id, product_sub_group_id FROM article_sizes WHERE article = ? AND size = ?")
      .get(article, size) as { id: string; product_type_id: string | null; product_sub_group_id: string | null };

  return {
    db,
    raw,
    gents,
    ladies,
    articleSizeRow,
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

test("a product type is a flat list, and adding one that exists returns the one that exists", () => {
  withFixture((f) => {
    const moulded = f.db.createProductType({ name: "MOULDED" });
    f.db.createProductType({ name: "STITCHED" });

    assert.deepEqual(
      f.db.listProductTypes().map((row) => row.name),
      ["MOULDED", "STITCHED"],
      "listed by name"
    );

    // The "+" on the product form is a fast path: typing a name already there means that one.
    assert.equal(f.db.createProductType({ name: "moulded" }), moulded, "matched without regard to case");
    assert.equal(f.db.listProductTypes().length, 2, "and never duplicated");
  });
});

test("a sub group belongs to a product group, and is only listed under it", () => {
  withFixture((f) => {
    const gentsCasual = f.db.createProductSubGroup({ productGroupId: f.gents, name: "CASUAL" });
    f.db.createProductSubGroup({ productGroupId: f.gents, name: "FORMAL" });
    const ladiesCasual = f.db.createProductSubGroup({ productGroupId: f.ladies, name: "CASUAL" });

    // CASUAL under GENTS and CASUAL under LADIES are two different sub groups.
    assert.notEqual(gentsCasual, ladiesCasual);

    assert.deepEqual(
      f.db.listProductSubGroups(f.gents).map((row) => row.name),
      ["CASUAL", "FORMAL"],
      "only the chosen group's sub groups"
    );
    assert.deepEqual(f.db.listProductSubGroups(f.ladies).map((row) => row.name), ["CASUAL"]);
    // The Product Lists page asks for all of them, and each says which group it is under.
    const all = f.db.listProductSubGroups();
    assert.equal(all.length, 3);
    assert.deepEqual(
      all.filter((row) => row.name === "CASUAL").map((row) => row.productGroupName).sort(),
      ["GENTS", "LADIES"]
    );
  });
});

test("a sub group cannot be made without a real product group", () => {
  withFixture((f) => {
    assert.throws(() => f.db.createProductSubGroup({ productGroupId: "", name: "CASUAL" }), /product group/i);
    assert.throws(() => f.db.createProductSubGroup({ productGroupId: "no-such-group", name: "CASUAL" }), /no longer/i);
    assert.throws(() => f.db.createProductSubGroup({ productGroupId: f.gents, name: "   " }), /required/i);
    assert.equal(f.db.listProductSubGroups().length, 0, "nothing half-made is left behind");
  });
});

test("the same sub group name is one row within its group, however it is typed", () => {
  withFixture((f) => {
    const first = f.db.createProductSubGroup({ productGroupId: f.gents, name: "CASUAL" });
    assert.equal(f.db.createProductSubGroup({ productGroupId: f.gents, name: "casual" }), first);
    assert.equal(f.db.listProductSubGroups(f.gents).length, 1);
  });
});

test("a product keeps its type and sub group, on the master row and on its colour variants", () => {
  withFixture((f) => {
    const type = f.db.createProductType({ name: "MOULDED" });
    const subGroup = f.db.createProductSubGroup({ productGroupId: f.gents, name: "CASUAL" });

    f.db.createProduct({
      article: "SK9",
      size: "7/10",
      sellingPrice: 600,
      colors: ["BLACK"],
      productGroupId: f.gents,
      productTypeId: type,
      productSubGroupId: subGroup,
      status: "ACTIVE",
    });

    const master = f.articleSizeRow("SK9", "7/10");
    assert.equal(master.product_type_id, type);
    assert.equal(master.product_sub_group_id, subGroup);

    // The variant keeps its own copy, the way it already does for the group and the series.
    const variant = f.raw
      .prepare("SELECT product_type_id, product_sub_group_id FROM product_variants WHERE article = ? AND color = ?")
      .get("SK9", "BLACK") as { product_type_id: string | null; product_sub_group_id: string | null };
    assert.equal(variant.product_type_id, type);
    assert.equal(variant.product_sub_group_id, subGroup);

    // And it reads back on the product the Edit form loads.
    const product = f.db.getProduct(master.id);
    assert.equal(product?.productTypeId, type);
    assert.equal(product?.productSubGroupId, subGroup);
  });
});

test("editing a product changes its classification without touching anything else", () => {
  withFixture((f) => {
    const moulded = f.db.createProductType({ name: "MOULDED" });
    const stitched = f.db.createProductType({ name: "STITCHED" });
    const casual = f.db.createProductSubGroup({ productGroupId: f.gents, name: "CASUAL" });

    f.db.createProduct({
      article: "SK9", size: "7/10", sellingPrice: 600,
      productGroupId: f.gents, productTypeId: moulded, status: "ACTIVE",
    });
    const id = f.articleSizeRow("SK9", "7/10").id;

    f.db.updateProduct(id, {
      article: "SK9", size: "7/10", sellingPrice: 600,
      productGroupId: f.gents, productTypeId: stitched, productSubGroupId: casual, status: "ACTIVE",
    });

    const after = f.articleSizeRow("SK9", "7/10");
    assert.equal(after.product_type_id, stitched);
    assert.equal(after.product_sub_group_id, casual, "a classification left blank before can be set later");
    assert.equal(f.db.getProduct(id)?.sellingPrice, 600, "the price is untouched");
  });
});

test("both lists are managed by the SAME rename and delete as the lists that were already there", () => {
  withFixture((f) => {
    const type = f.db.createProductType({ name: "MOULDED" });
    f.db.createProductSubGroup({ productGroupId: f.gents, name: "CASUAL" });

    const types = f.db.listProductListEntries("product-type");
    assert.deepEqual(types.map((entry) => entry.name), ["MOULDED"]);
    assert.equal(types[0].productCount, 0, "nothing uses it yet, so it can go");
    assert.equal(types[0].deleteBlockedReason, null);

    const subGroups = f.db.listProductListEntries("product-sub-group");
    assert.deepEqual(subGroups.map((entry) => entry.name), ["CASUAL"]);

    // Rename in place reaches the products carrying it.
    f.db.renameProductListEntry({ kind: "product-type", id: type, newName: "MOULDED PVC" });
    assert.deepEqual(f.db.listProductTypes().map((row) => row.name), ["MOULDED PVC"]);

    // A type a product is using cannot simply be deleted.
    f.db.createProduct({ article: "SK9", size: "7/10", sellingPrice: 600, productTypeId: type, status: "ACTIVE" });
    const inUse = f.db.listProductListEntries("product-type")[0];
    assert.equal(inUse.productCount, 1);
    assert.ok(inUse.deleteBlockedReason, "a classification in use is not silently removed");
  });
});
