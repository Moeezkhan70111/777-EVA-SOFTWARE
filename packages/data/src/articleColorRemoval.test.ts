import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CartonAdjustmentRefused, SqliteDatabase } from "./sqliteDatabase.js";

// REMOVING A COLOUR FROM AN ARTICLE (owner, 27 Nov 2026): every size or none, only when no carton stock and no open
// order still need it; nothing deleted, so adding it again brings back the same products.

type Raw = import("node:sqlite").DatabaseSync;
const STORE = "factory-777";

function withFixture(run: (f: { db: SqliteDatabase; raw: Raw; sku: (size: string) => string; variant: (color: string, size: string) => string; customer: string }) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-colour-removal-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  // As in the store while carton QR is on hold: a decrease may take a figure below zero (owner, 12 Nov 2026).
  db.cartonQrOnHold = true;
  db.ensureOperationalContext({
    factoryId: STORE, factoryCode: "F777", factoryName: "777", workstationId: "ws-1", workstationCode: "WS1", workstationName: "1",
    deviceId: "dev-1", deviceName: "1", appVersion: "1.0.0",
  });
  for (const size of ["7/10", "10/13"]) {
    db.createProduct({ article: "SK6", size, sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED", "BLACK"], status: "ACTIVE" });
  }
  const raw = (db as unknown as { db: Raw }).db;
  const sku = (size: string) => (raw.prepare("SELECT id FROM article_sizes WHERE article = 'SK6' AND size = ?").get(size) as { id: string }).id;
  const variant = (color: string, size: string) =>
    (raw.prepare("SELECT id FROM product_variants WHERE article = 'SK6' AND color = ? AND size = ?").get(color, size) as { id: string }).id;
  const customer = db.createParty({ partyName: "BEHRAAM SHOES", partyType: "CUSTOMER", city: "Lahore", mobileNumber: "0300-1111111", status: "ACTIVE" });
  try {
    run({ db, raw, sku, variant, customer });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const adjust = (db: SqliteDatabase, articleSizeId: string, color: string, cartons: number, direction: "IN" | "OUT") =>
  db.postCartonStockAdjustment({
    requestId: crypto.randomUUID(), kind: "ADJUSTMENT", businessDate: "2026-11-27", reason: "Count", remarks: null,
    lines: [{ articleSizeId, color, cartons, direction }], postedBy: "owner", workstationId: "ws-1", storeLocationId: STORE,
  });

const colours = (db: SqliteDatabase): string[] => [...new Set(db.cartonAdjustmentArticle("SK6").map((choice) => choice.color))].sort();

test("a colour with no stock and no open order comes off every size, kept on record, and comes back with the same ids", () => {
  withFixture(({ db, raw, variant }) => {
    const ids = [variant("BLACK", "7/10"), variant("BLACK", "10/13")];
    assert.deepEqual(db.removeColorFromArticle({ article: "sk6", color: " black ", actor: "owner" }), { color: "BLACK", removed: 2 });
    assert.deepEqual(colours(db), ["RED"]);
    const kept = raw.prepare("SELECT status, deleted_by, delete_reason FROM product_variants WHERE id = ?").get(ids[0]!) as Record<string, string>;
    assert.equal(kept.status, "DISABLED", "disabled, never deleted");
    assert.equal(kept.deleted_by, "owner");
    assert.match(kept.delete_reason ?? "", /Colour removed from SK6 by owner/);

    assert.deepEqual(db.addColorToArticle({ article: "SK6", color: "BLACK" }), { color: "BLACK", added: 2, existing: 0 });
    assert.deepEqual([variant("BLACK", "7/10"), variant("BLACK", "10/13")], ids, "the same products come back");
    assert.deepEqual(colours(db), ["BLACK", "RED"]);
  });
});

test("refused while any size holds carton stock, above or below zero; allowed once it is back to zero", () => {
  withFixture(({ db, sku }) => {
    adjust(db, sku("10/13"), "BLACK", 3, "IN");
    assert.throws(() => db.removeColorFromArticle({ article: "SK6", color: "BLACK" }), (error: unknown) =>
      error instanceof CartonAdjustmentRefused && /still has carton stock: 10\/13 \(1\.5 dozen\)/.test(error.message));
    assert.deepEqual(colours(db), ["BLACK", "RED"], "nothing changed");
    adjust(db, sku("10/13"), "BLACK", 5, "OUT");
    assert.throws(() => db.removeColorFromArticle({ article: "SK6", color: "BLACK" }), /still has carton stock: 10\/13 \(-1 dozen\)/);
    adjust(db, sku("10/13"), "BLACK", 2, "IN");
    assert.equal(db.removeColorFromArticle({ article: "SK6", color: "BLACK" }).removed, 2);
  });
});

test("refused while an open order still waits for the colour; allowed once the order is cancelled", () => {
  withFixture(({ db, variant, customer }) => {
    const order = db.saveCustomerOrder({ requestId: crypto.randomUUID(), partyId: customer, lines: [{ productVariantId: variant("BLACK", "7/10"), quantity: 4 }], actor: "clerk" }).order;
    assert.throws(() => db.removeColorFromArticle({ article: "SK6", color: "BLACK" }), /waiting on 1 open order line/);
    db.cancelCustomerOrder({ orderId: order.id, revision: order.revision, reason: "Customer changed mind", actor: "clerk" } as never);
    assert.equal(db.removeColorFromArticle({ article: "SK6", color: "BLACK" }).removed, 2);
  });
});

test("a colour the article does not have is refused in words", () => {
  withFixture(({ db }) => {
    assert.throws(() => db.removeColorFromArticle({ article: "SK6", color: "GREEN" }), /SK6 has no colour GREEN/);
    assert.throws(() => db.removeColorFromArticle({ article: "SK6", color: " " }), /Choose the colour/);
  });
});
