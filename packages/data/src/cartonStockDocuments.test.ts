import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CartonAdjustmentRefused, SqliteDatabase } from "./sqliteDatabase.js";
import { isLocalStockRecord, readCartonCloudState, STOCK_RECORD_TYPES } from "./database/stockProtection.js";
import { activateCartonCloudForTest } from "./testing/cartonCloud.js";

// STOCK ADJUSTMENT DOCUMENTS ON ONE COMPUTER (docs/46): Opening Stock and Stock Adjustment, all or nothing, once,
// never below zero, marked for the carton lease and nothing else.

const STORE = "factory-777";

interface Fixture {
  readonly db: SqliteDatabase;
  /** article -> size -> articleSizeId */
  readonly sku: (article: string, size: string) => string;
}

function withFixture(run: (fixture: Fixture) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-carton-documents-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: STORE, factoryCode: "F777", factoryName: "777", workstationId: "ws-1", workstationCode: "WS1", workstationName: "1",
    deviceId: "dev-1", deviceName: "1", appVersion: "1.0.0",
  });
  for (const size of ["7/10", "10/13", "13/1"]) {
    db.createProduct({ article: "SK6", size, sellingPrice: 550, machineRate: 70, packingRate: 30, colors: ["RED", "BLACK"], createdBy: "owner" } as never);
  }
  db.createProduct({ article: "VK2", size: "8/9", sellingPrice: 400, machineRate: 60, packingRate: 20, colors: ["BLUE"], createdBy: "owner" } as never);
  const sku = (article: string, size: string) =>
    (db.db.prepare("SELECT id FROM article_sizes WHERE article = ? AND size = ?").get(article, size) as { id: string }).id;
  try {
    run({ db, sku });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const line = (articleSizeId: string, color: string, cartons: number, direction = "IN") => ({ articleSizeId, color, cartons, direction });
const post = (db: SqliteDatabase, kind: string, lines: ReturnType<typeof line>[], over: Record<string, unknown> = {}) =>
  db.postCartonStockAdjustment({
    requestId: crypto.randomUUID(), kind, businessDate: "2026-11-11", reason: "Physical count", remarks: null, lines,
    postedBy: "owner", workstationId: "ws-1", storeLocationId: STORE, ...over,
  });

const figureOf = (fixture: Fixture, article: string, size: string, color: string): number =>
  fixture.db.cartonAdjustmentArticle(article).find((choice) => choice.size === size && choice.color === color)?.inStore ?? NaN;
const count = (db: SqliteDatabase, sql: string): number => Number((db.db.prepare(sql).get() as { n: number }).n);
const ledgerMatchesFigure = (db: SqliteDatabase): boolean =>
  count(db, "SELECT COALESCE(SUM(balance_delta), 0) AS n FROM carton_stock_events") ===
  count(db, "SELECT COALESCE(SUM(quantity_on_hand), 0) AS n FROM stock_projection_by_location WHERE location_type = 'WAREHOUSE'");

test("opening stock: one document, size-wise lines, each one movement, the figure set", () => {
  withFixture((fixture) => {
    const { db, sku } = fixture;
    const result = post(db, "OPENING", [line(sku("SK6", "7/10"), "RED", 20), line(sku("SK6", "10/13"), "RED", 35), line(sku("SK6", "13/1"), "RED", 12)]);
    assert.equal(result.duplicate, false);
    assert.equal(result.document.code, "SA-000001");
    assert.equal(result.document.kind, "OPENING");
    assert.equal(result.document.cartonsIn, 67);
    assert.equal(result.document.lines.length, 3);
    assert.equal(figureOf(fixture, "SK6", "7/10", "RED"), 20);
    assert.equal(figureOf(fixture, "SK6", "10/13", "RED"), 35);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM carton_stock_events WHERE event_type = 'CARTON_ADJUST_IN' AND reason LIKE 'SA-000001 Opening stock: %'"), 3);
    assert.ok(db.cartonAdjustmentArticle("SK6").find((c) => c.size === "7/10" && c.color === "RED")?.hasOpening);
    assert.ok(ledgerMatchesFigure(db));
  });
});

test("opening stock is given once per colour and size: a second refuses the whole document", () => {
  withFixture((fixture) => {
    const { db, sku } = fixture;
    post(db, "OPENING", [line(sku("SK6", "7/10"), "RED", 20)]);
    assert.throws(() => post(db, "OPENING", [line(sku("SK6", "10/13"), "RED", 5), line(sku("SK6", "7/10"), "RED", 3)]), /already has opening stock/);
    assert.equal(figureOf(fixture, "SK6", "10/13", "RED"), 0, "the good line was not posted either");
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM carton_stock_adjustments"), 1);
    assert.throws(() => post(db, "OPENING", [line(sku("SK6", "13/1"), "RED", 2, "OUT")]), /only adds cartons/);
  });
});

test("an adjustment adds and takes out, and never takes the figure below zero", () => {
  withFixture((fixture) => {
    const { db, sku } = fixture;
    post(db, "OPENING", [line(sku("SK6", "7/10"), "RED", 20)]);
    const result = post(db, "ADJUSTMENT", [line(sku("SK6", "7/10"), "RED", 4, "OUT"), line(sku("SK6", "10/13"), "RED", 6, "IN")]);
    assert.equal(result.document.cartonsOut, 4);
    assert.equal(result.document.cartonsIn, 6);
    assert.equal(figureOf(fixture, "SK6", "7/10", "RED"), 16);
    assert.equal(figureOf(fixture, "SK6", "10/13", "RED"), 6);
    assert.throws(() => post(db, "ADJUSTMENT", [line(sku("SK6", "10/13"), "RED", 1, "IN"), line(sku("SK6", "7/10"), "RED", 17, "OUT")]), CartonAdjustmentRefused);
    assert.equal(figureOf(fixture, "SK6", "7/10", "RED"), 16, "rolled back whole");
    assert.equal(figureOf(fixture, "SK6", "10/13", "RED"), 6, "the line before the refused one rolled back too");
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM carton_stock_adjustment_lines"), 3);
    assert.ok(ledgerMatchesFigure(db));
  });
});

test("several articles and colours in one document", () => {
  withFixture((fixture) => {
    const { db, sku } = fixture;
    const result = post(db, "OPENING", [line(sku("SK6", "7/10"), "RED", 2), line(sku("SK6", "7/10"), "BLACK", 3), line(sku("VK2", "8/9"), "BLUE", 4)]);
    assert.deepEqual(result.document.lines.map((l) => `${l.article} ${l.size} ${l.color} ${l.cartons}`), ["SK6 7/10 RED 2", "SK6 7/10 BLACK 3", "VK2 8/9 BLUE 4"]);
    assert.equal(figureOf(fixture, "VK2", "8/9", "BLUE"), 4);
  });
});

test("bad documents are refused before anything is written", () => {
  withFixture((fixture) => {
    const { db, sku } = fixture;
    const red = sku("SK6", "7/10");
    for (const cartons of [0, -3, 2.5, Number.NaN, 1_000_000]) {
      assert.throws(() => post(db, "ADJUSTMENT", [line(red, "RED", cartons)]), CartonAdjustmentRefused, `cartons ${cartons}`);
    }
    assert.throws(() => post(db, "ADJUSTMENT", []), /at least one/);
    assert.throws(() => post(db, "ADJUSTMENT", [line(red, "RED", 1)], { reason: "  " }), /reason/);
    assert.throws(() => post(db, "ADJUSTMENT", [line(red, "RED", 1)], { businessDate: "2026-02-30" }), /date/);
    assert.throws(() => post(db, "SOMETHING", [line(red, "RED", 1)]), /Opening Stock or Stock Adjustment/);
    assert.throws(() => post(db, "ADJUSTMENT", [line(red, "RED", 1)], { requestId: "not-a-uuid" }), /identified/);
    assert.throws(() => post(db, "ADJUSTMENT", [line(red, "RED", 1), line(red, "RED", 2)]), /entered twice/);
    assert.throws(() => post(db, "ADJUSTMENT", [line(red, "GREEN", 1)]), /no active colour GREEN/);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM carton_stock_events"), 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM carton_stock_adjustments"), 0);
  });
});

test("a Post retried with the same request id adds nothing", () => {
  withFixture((fixture) => {
    const { db, sku } = fixture;
    const requestId = crypto.randomUUID();
    const first = post(db, "OPENING", [line(sku("SK6", "7/10"), "RED", 20)], { requestId });
    const again = post(db, "OPENING", [line(sku("SK6", "7/10"), "RED", 20)], { requestId });
    assert.equal(again.duplicate, true);
    assert.equal(again.document.code, first.document.code);
    assert.equal(figureOf(fixture, "SK6", "7/10", "RED"), 20);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM carton_stock_events"), 1);
  });
});

test("history lists the documents newest first, with their lines and totals", () => {
  withFixture((fixture) => {
    const { db, sku } = fixture;
    post(db, "OPENING", [line(sku("SK6", "7/10"), "RED", 20)]);
    post(db, "ADJUSTMENT", [line(sku("SK6", "7/10"), "RED", 5, "OUT")], { reason: "Damaged", remarks: "Water damage" });
    const page = db.listCartonStockAdjustments({ pageSize: 10 });
    assert.equal(page.total, 2);
    assert.deepEqual(page.documents.map((d) => `${d.code} ${d.kind}`), ["SA-000002 ADJUSTMENT", "SA-000001 OPENING"]);
    assert.equal(page.documents[0]?.remarks, "Water damage");
    assert.equal(page.documents[0]?.postedBy, "owner");
    assert.equal(page.documents[0]?.workstationCode, "WS1");
  });
});

test("a posted document is marked for the carton lease only, and stays local while Carton Cloud is off", () => {
  withFixture((fixture) => {
    const { db, sku } = fixture;
    assert.ok(STOCK_RECORD_TYPES.has("CARTON_STOCK_ADJUSTMENT"));
    const before = post(db, "OPENING", [line(sku("SK6", "7/10"), "RED", 20)]);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = 'CARTON_STOCK_ADJUSTMENT'"), 1);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type IN ('STOCK_EVENT', 'INVENTORY_ITEM', 'RAW_MATERIAL_QR', 'RAW_MATERIAL_QR_BATCH')"), 0);
    assert.equal(isLocalStockRecord(db.db, "CARTON_STOCK_ADJUSTMENT", before.document.id), true, "Carton Cloud off: test data");
  });
});

test("with Carton Cloud on, a document and its movements may travel, and the activation stays valid", () => {
  withFixture((fixture) => {
    const { db, sku } = fixture;
    activateCartonCloudForTest(db.db);
    const after = post(db, "OPENING", [line(sku("SK6", "7/10"), "RED", 2)]);
    assert.equal(isLocalStockRecord(db.db, "CARTON_STOCK_ADJUSTMENT", after.document.id), false);
    assert.equal(readCartonCloudState(db.db).state, "ACTIVE", "the new table is not in the cutoff, so the seal still matches");
    assert.equal(isLocalStockRecord(db.db, "CARTON_STOCK_EVENT", after.document.lines[0]?.eventId ?? ""), false, "its movement may travel too");
  });
});

test("the + beside Colour adds the colour to every active size of the article, once, upper-case", () => {
  withFixture((fixture) => {
    const { db } = fixture;
    const first = db.addColorToArticle({ article: "SK6", color: "  sky   blue " });
    assert.deepEqual(first, { color: "SKY BLUE", added: 3, existing: 0 });
    assert.deepEqual(db.cartonAdjustmentArticle("SK6").filter((c) => c.color === "SKY BLUE").map((c) => c.size).sort(), ["10/13", "13/1", "7/10"]);
    assert.deepEqual(db.addColorToArticle({ article: "SK6", color: "Sky Blue" }), { color: "SKY BLUE", added: 0, existing: 3 }, "never duplicated");
    assert.deepEqual(db.addColorToArticle({ article: "SK6", color: "red" }), { color: "RED", added: 0, existing: 3 });
    assert.throws(() => db.addColorToArticle({ article: "SK6", color: " " }), /colour's name/);
    assert.throws(() => db.addColorToArticle({ article: "NOPE", color: "RED" }), /no active sizes/);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = 'ARTICLE_SIZE'") > 0, true, "marked as product master data");
    // The new colour can take opening stock straight away.
    post(db, "OPENING", [line(fixture.sku("SK6", "7/10"), "SKY BLUE", 4)]);
    assert.equal(figureOf(fixture, "SK6", "7/10", "SKY BLUE"), 4);
  });
});

test("every size comes back for every colour of the article; a size the colour is not on is marked colorMissing", () => {
  withFixture((fixture) => {
    const { db, sku } = fixture;
    // BLACK only on 7/10, as Product Master often has a colour on some sizes only.
    db.db.prepare("UPDATE product_variants SET deleted_at = '2026-11-11T00:00:00.000Z' WHERE article = 'SK6' AND color = 'BLACK' AND size <> '7/10'").run();
    const black = db.cartonAdjustmentArticle("SK6").filter((c) => c.color === "BLACK").map((c) => `${c.size}:${c.colorMissing}`).sort();
    assert.deepEqual(black, ["10/13:true", "13/1:true", "7/10:false"]);
    assert.ok(db.cartonAdjustmentArticle("SK6").filter((c) => c.color === "RED").every((c) => !c.colorMissing));
    // Adding the colour fills in the sizes it is missing on, and they can take stock.
    assert.deepEqual(db.addColorToArticle({ article: "SK6", color: "black" }), { color: "BLACK", added: 2, existing: 1 });
    assert.ok(db.cartonAdjustmentArticle("SK6").filter((c) => c.color === "BLACK").every((c) => !c.colorMissing));
    post(db, "OPENING", [line(sku("SK6", "13/1"), "BLACK", 6)]);
    assert.equal(figureOf(fixture, "SK6", "13/1", "BLACK"), 6);
  });
});

test("a colour linked to another row of the same size, or to none, is found and takes stock (PC1, 11 Nov 2026)", () => {
  withFixture((fixture) => {
    const { db, sku } = fixture;
    // RED on 7/10 linked to the wrong size row, as a computer filled from the cloud can hold it.
    db.db.prepare("UPDATE product_variants SET article_size_id = ? WHERE article = 'SK6' AND size = '7/10' AND color = 'RED'").run(sku("SK6", "10/13"));
    // And BLACK on 10/13 pointing at no row at all.
    db.db.prepare("UPDATE product_variants SET article_size_id = NULL WHERE article = 'SK6' AND size = '10/13' AND color = 'BLACK'").run();

    const red = db.cartonAdjustmentArticle("SK6").find((c) => c.size === "7/10" && c.color === "RED");
    const black = db.cartonAdjustmentArticle("SK6").find((c) => c.size === "10/13" && c.color === "BLACK");
    assert.equal(red?.colorMissing, false, "RED on 7/10 is not shown as a new colour");
    assert.equal(black?.colorMissing, false, "BLACK on 10/13 is not shown as a new colour");
    assert.equal(db.cartonAdjustmentArticle("SK6").filter((c) => c.size === "7/10").length, 2, "one row per size and colour, never doubled");
    assert.deepEqual(db.addColorToArticle({ article: "SK6", color: "RED" }), { color: "RED", added: 0, existing: 3 }, "nothing added twice");

    const result = post(db, "OPENING", [line(sku("SK6", "7/10"), "RED", 26), line(sku("SK6", "10/13"), "BLACK", 4)]);
    assert.equal(result.document.cartonsIn, 30);
    assert.equal(figureOf(fixture, "SK6", "7/10", "RED"), 26);
    assert.equal(figureOf(fixture, "SK6", "10/13", "BLACK"), 4);
  });
});
