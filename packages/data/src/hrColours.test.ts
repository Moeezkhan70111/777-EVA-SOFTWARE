import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { HR_ARTICLE_COLOURS, addHrArticleColoursOnce, isHrArticle } from "./database/hrColours.js";

// EVERY HR ARTICLE IN THE EIGHT COLOURS (owner, 27 Nov 2026), once, on the computer that writes Product Master, and a
// colour held under another spacing is that colour (as a carton QR reads it), never a second one.

function withDb(run: (db: SqliteDatabase) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-hr-colours-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  try {
    for (const [article, colors] of [["HR-1", ["BLACKGREY", "BROWNMUSTARD", "BROWN"]], ["HR-10", ["BLACK"]], ["SK6", ["RED"]]] as const) {
      db.createProduct({ article, size: "7/10", sellingPrice: 550, machineRate: 70, packingRate: 30, colors: [...colors], status: "ACTIVE" });
    }
    run(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const holdProductMaster = (db: SqliteDatabase) => {
  const now = new Date().toISOString();
  db.db.prepare("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, updated_at) VALUES ('device.id', 'dev-pc1', ?)").run(now);
  db.db.prepare(
    `INSERT OR REPLACE INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
     VALUES ('MASTER_DATA', 'dev-pc1', 'PC1', 3, 0, ?, 'p', ?)`
  ).run(now, now);
};

const coloursOf = (db: SqliteDatabase, article: string): string[] =>
  (db.db.prepare("SELECT color FROM product_variants WHERE article = ? AND deleted_at IS NULL ORDER BY color").all(article) as Array<{ color: string }>).map((row) => row.color);

test("HR names: HR-1, HR 2 and HR10 are HR articles, HRX and SHR-1 are not", () => {
  assert.deepEqual(["HR-1", "hr 2", "HR10", "HRX", "SHR-1"].map(isHrArticle), [true, true, true, false, false]);
});

test("on the Product Master computer every HR article gets the eight, once, with nothing doubled and nothing else touched", () => {
  withDb((db) => {
    holdProductMaster(db);
    const added = addHrArticleColoursOnce(db, new Date().toISOString());
    assert.deepEqual(coloursOf(db, "HR-1"), ["BLACK", "BLACK MUSTARD", "BLACKGREY", "BROWN", "BROWNMUSTARD", "COMMANDO", "GREY", "SKIN", "WHITE"],
      "BLACKGREY and BROWNMUSTARD already were Black Grey and Brown Mustard; BROWN stays");
    assert.deepEqual(coloursOf(db, "HR-10"), [...HR_ARTICLE_COLOURS].sort());
    assert.deepEqual(coloursOf(db, "SK6"), ["RED"], "not an HR article");
    assert.equal(added, 6 + 7);
    assert.equal(addHrArticleColoursOnce(db, new Date().toISOString()), null, "only once");
    const marked = db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = 'ARTICLE_SIZE'").get() as { n: number };
    assert.ok(Number(marked.n) >= 2, "the changed sizes are queued to travel");
  });
});

test("anywhere else it does nothing and waits, so it still runs once the computer holds Product Master", () => {
  withDb((db) => {
    assert.equal(addHrArticleColoursOnce(db, new Date().toISOString()), null);
    assert.deepEqual(coloursOf(db, "HR-10"), ["BLACK"]);
    holdProductMaster(db);
    assert.ok((addHrArticleColoursOnce(db, new Date().toISOString()) ?? 0) > 0);
  });
});

test("adding BLACK GREY where the article holds BLACKGREY adds nothing and names the colour as held", () => {
  withDb((db) => {
    assert.deepEqual(db.addColorToArticle({ article: "HR-1", color: "black grey" }), { color: "BLACKGREY", added: 0, existing: 1 });
    assert.deepEqual(coloursOf(db, "HR-1"), ["BLACKGREY", "BROWN", "BROWNMUSTARD"]);
  });
});
