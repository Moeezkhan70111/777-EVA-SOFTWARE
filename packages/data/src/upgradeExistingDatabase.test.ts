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

// ─── Migrating forward across the table rebuilds ─────────────────────────────
//
// Some migrations do not add to a table, they REBUILD it: create a replacement, copy the rows,
// drop the original, rename. SQLite cannot change a CHECK in place, so 057, 067 and 073 all do
// this to machine_program_runs, and 030 did it to the money columns.
//
// A rebuild is the riskiest shape of migration there is, because other tables reference the one
// being dropped and the whole run happens with `foreign_keys = OFF`. Nothing asserted that a
// database carrying real rows came out the other side sound, which is what this does: build one
// at an older ceiling, carry it forward, then ask SQLite itself.

/** A migrations folder holding only the files up to and including `ceiling`. */
function migrationsUpTo(ceiling: number): string {
  const source = path.resolve(process.cwd(), "../../migrations/sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-upgrade-${ceiling}-`));
  for (const file of fs.readdirSync(source)) {
    if (!file.endsWith(".up.sql")) continue;
    const digits = /^(\d+)/.exec(file);
    if (digits && Number(digits[1]) <= ceiling) fs.copyFileSync(path.join(source, file), path.join(dir, file));
  }
  return dir;
}

test("a database with real rows migrates forward across the table rebuilds and stays sound", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-upgrade-forward-"));
  const dbPath = path.join(tempDir, "forward.db");
  const migrations = path.resolve(process.cwd(), "../../migrations/sqlite");
  const older = migrationsUpTo(66);
  try {
    // An older build, with business data in it: a product, a party and a machine.
    const before = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: older });
    before.createProduct({ article: "SK46", size: "4/6", sellingPrice: 600, status: "ACTIVE" });
    const partyId = before.createParty({ partyName: "UPGRADE TRADERS", partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE" });
    before.createMachine({ name: "UPGRADE MACHINE" });
    before.close();

    // The current build opens the same file and carries it forward, 067 through 076 included.
    const after = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: migrations });
    try {
      const raw = after.db;
      const integrity = raw.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
      assert.equal(integrity?.integrity_check, "ok", "the rebuilt tables left a sound database");
      assert.equal(raw.prepare("PRAGMA foreign_key_check").all().length, 0, "no dangling reference survived the rebuilds");

      // The data is still there, and still reachable the way the application reads it.
      assert.equal(after.listProducts({ status: "ACTIVE", pageSize: 10 }).rows.length, 1, "the product survived");
      assert.ok(after.getParty(partyId), "the party survived");
      assert.equal(after.listMachines().length, 1, "the machine survived");

      // And the rebuilt table has the shape the later migration gave it.
      const runsSql = (raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'machine_program_runs'").get() as { sql: string }).sql;
      assert.match(runsSql, /inner_sole_colour IS NOT NULL AND injector_no IS NULL/, "073's CHECK is in place");
    } finally {
      after.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(older, { recursive: true, force: true });
  }
});
