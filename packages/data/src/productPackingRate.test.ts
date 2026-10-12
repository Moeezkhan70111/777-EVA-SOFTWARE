// A product's packing rate entered as named attributes (migration 072), against a real database.
//
//   BOX 50 + TAPE 30 + POLY BAG 50 + LABOUR 20  =  packing_rate_paisa 15000
//
// article_sizes.packing_rate_paisa stays THE packing rate every machine program reads, so these
// tests pin down that it is always the attributes' sum — worked out by the data layer from the
// attributes, never taken from a total the caller sent.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

const withDb = (run: (db: SqliteDatabase) => void): void => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-packing-rate-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "erp.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  try {
    run(db);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

const FOUR_ATTRIBUTES = [
  { name: "BOX", rate: 50 },
  { name: "TAPE", rate: 30 },
  { name: "POLY BAG", rate: 50 },
  { name: "LABOUR", rate: 20 },
];

test("a product made with packing attributes is saved at their sum, and opens with them", () => {
  withDb((db) => {
    // The caller's own packingRate is deliberately wrong: the attributes decide.
    const id = db.createProduct({ article: "SK6", size: "7/10", machineRate: 45, packingRate: 999, printingRate: 12, packingRateItems: FOUR_ATTRIBUTES });

    const product = db.getProduct(id);
    assert.equal(product?.packingRatePaisa, 15000);
    assert.equal(product?.machineRatePaisa, 4500, "the other rates are saved as before");
    assert.deepEqual(product?.packingRateItems, [
      { name: "BOX", ratePaisa: 5000 },
      { name: "TAPE", ratePaisa: 3000 },
      { name: "POLY BAG", ratePaisa: 5000 },
      { name: "LABOUR", ratePaisa: 2000 },
    ]);
  });
});

test("editing the attributes replaces the list and the packing rate with it", () => {
  withDb((db) => {
    const id = db.createProduct({ article: "SK6", size: "7/10", packingRateItems: FOUR_ATTRIBUTES });

    db.updateProduct(id, { article: "SK6", size: "7/10", machineRate: null, packingRate: null, printingRate: null, packingRateItems: [{ name: "BOX", rate: 60 }] });

    const product = db.getProduct(id);
    assert.equal(product?.packingRatePaisa, 6000);
    assert.deepEqual(product?.packingRateItems, [{ name: "BOX", ratePaisa: 6000 }]);
  });
});

test("removing every attribute clears the breakdown and keeps a typed packing rate", () => {
  withDb((db) => {
    const id = db.createProduct({ article: "SK6", size: "7/10", packingRateItems: FOUR_ATTRIBUTES });

    db.updateProduct(id, { article: "SK6", size: "7/10", packingRate: 18, packingRateItems: [] });

    const product = db.getProduct(id);
    assert.equal(product?.packingRatePaisa, 1800);
    assert.deepEqual(product?.packingRateItems, []);
  });
});

test("a save that says nothing about rates leaves the attributes alone", () => {
  withDb((db) => {
    const id = db.createProduct({ article: "SK6", size: "7/10", packingRateItems: FOUR_ATTRIBUTES });

    // The older simple product form sends no rates at all.
    db.updateProduct(id, { article: "SK6", size: "7/10", sellingPrice: 650 });

    const product = db.getProduct(id);
    assert.equal(product?.packingRatePaisa, 15000);
    assert.equal(product?.packingRateItems?.length, 4);
  });
});

test("an attribute without a name is refused, and nothing about the product changes", () => {
  withDb((db) => {
    const id = db.createProduct({ article: "SK6", size: "7/10", packingRateItems: FOUR_ATTRIBUTES });

    assert.throws(
      () => db.updateProduct(id, { article: "SK6", size: "7/10", sellingPrice: 700, packingRateItems: [{ name: "  ", rate: 10 }] }),
      /packing attribute/
    );

    const product = db.getProduct(id);
    assert.equal(product?.sellingPrice, null, "the refused save rolled back as a whole");
    assert.equal(product?.packingRatePaisa, 15000);
    assert.equal(product?.packingRateItems?.length, 4);
  });
});
