import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteDatabase } from "./sqliteDatabase.js";

// Opening a database that ALREADY EXISTS.
//
// local-schema.sql is exec'd in full on every boot, BEFORE migrations run. On an existing
// database every `CREATE TABLE IF NOT EXISTS` in it is a no-op, so the tables are still in
// their old shape at that moment. Anything in that file which depends on a column a
// MIGRATION adds therefore fails with "no such column" — and because it runs at open, it
// does not fail a feature, it fails the whole application: nobody can even sign in.
//
// That happened once (an index over inventory_categories.parent_id, added for
// sub-categories). This test boots a pre-existing database of the old shape and asserts it
// comes up, migrates, and keeps what it had.

const SCHEMA = path.resolve(process.cwd(), "src/local-schema.sql");

/** A database as it looked before sub-categories: categories with table-level UNIQUEs. */
function seedOldDatabase(dbPath: string) {
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE inventory_categories (
      id TEXT PRIMARY KEY,
      category_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (status IN ('ACTIVE','INACTIVE'))
    );
  `);
  raw
    .prepare("INSERT INTO inventory_categories (id, category_code, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)")
    .run("cat-dana", "DANA", "DANA", "Granules", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  raw.close();
}

test("a database that already exists opens, migrates and keeps what it had", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-upgrade-"));
  const dbPath = path.join(tempDir, "existing.db");
  try {
    seedOldDatabase(dbPath);

    // The boot that used to throw "no such column: parent_id" before anyone could sign in.
    const db = new SqliteDatabase({ dbPath, schemaPath: SCHEMA });

    const categories = db.listInventoryCategories();
    assert.equal(categories.length, 1, "the category that was already there survived the rebuild");
    assert.equal(String(categories[0].name), "DANA");
    assert.equal(String(categories[0].description), "Granules");
    assert.equal(categories[0].parent_id, null, "an existing category is top-level");

    // And the new shape works on it: a sub-category can be added straight away.
    const eva = db.createInventoryCategory({ name: "EVA", parentId: "cat-dana" });
    assert.equal(db.categoryPathName(eva), "DANA — EVA");

    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("re-opening the same database is a no-op, not a second migration", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-reopen-"));
  const dbPath = path.join(tempDir, "existing.db");
  try {
    seedOldDatabase(dbPath);

    const first = new SqliteDatabase({ dbPath, schemaPath: SCHEMA });
    const eva = first.createInventoryCategory({ name: "EVA", parentId: "cat-dana" });
    first.close();

    // Every boot after the first re-execs the schema file and skips applied migrations.
    const second = new SqliteDatabase({ dbPath, schemaPath: SCHEMA });
    const names = second.listInventoryCategories().map((row) => String(row.path_name));
    assert.deepEqual(names.sort(), ["DANA", "DANA — EVA"], "the sub-category is still a sub-category");
    assert.equal(second.categoryPathName(eva), "DANA — EVA");
    second.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a brand new database comes up with the same shape as an upgraded one", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-fresh-"));
  try {
    const db = new SqliteDatabase({ dbPath: path.join(tempDir, "fresh.db"), schemaPath: SCHEMA });
    const dana = db.createInventoryCategory({ name: "DANA" });
    db.createInventoryCategory({ name: "EVA", parentId: dana });

    // The sibling-uniqueness index the migration creates is what enforces this.
    assert.throws(() => db.createInventoryCategory({ name: "EVA", parentId: dana }), /already has an? "EVA"/);
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
