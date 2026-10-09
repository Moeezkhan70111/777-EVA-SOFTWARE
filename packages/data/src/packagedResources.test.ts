import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// Opening the database from PACKAGED resources.
//
// In the repository the schema and the migrations sit at known relative positions, and the
// default option values find them. A packaged desktop installation has neither the repository
// layout nor the source tree: apps/desktop passes both locations explicitly, out of the
// installer's `resources/erp-resources` folder.
//
// These tests prove the two things that must hold for that to be safe:
//   1. migrations are discovered and applied from whatever folder is handed in, and
//   2. a missing resource stops the application instead of quietly booting on an old schema.
//
// (2) is the important one. The runner used to `return` when the folder was absent, so a
// packaging mistake produced an app that opened, looked fine, and silently ran on the base
// schema with every migration un-applied.

const REPO_SCHEMA = path.resolve(process.cwd(), "src/local-schema.sql");
const REPO_MIGRATIONS = path.resolve(process.cwd(), "../../migrations/sqlite");

const tempDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A copy of the shipped resources, laid out the way the installer lays them out. */
function stageResources(root: string): { schemaFile: string; migrationsDir: string } {
  const resources = path.join(root, "erp-resources");
  const migrationsDir = path.join(resources, "migrations", "sqlite");
  fs.mkdirSync(migrationsDir, { recursive: true });
  const schemaFile = path.join(resources, "local-schema.sql");
  fs.copyFileSync(REPO_SCHEMA, schemaFile);
  for (const file of fs.readdirSync(REPO_MIGRATIONS).filter((name) => name.endsWith(".up.sql"))) {
    fs.copyFileSync(path.join(REPO_MIGRATIONS, file), path.join(migrationsDir, file));
  }
  return { schemaFile, migrationsDir };
}

const expectedVersions = (): string[] =>
  fs
    .readdirSync(REPO_MIGRATIONS)
    .filter((name) => name.endsWith(".up.sql"))
    .map((name) => name.replace(/\.up\.sql$/, ""))
    .sort();

test("migrations are discovered and applied from an explicitly supplied resources folder", () => {
  const root = tempDir("erp-packaged-");
  try {
    const { schemaFile, migrationsDir } = stageResources(root);
    const db = new SqliteDatabase({ dbPath: path.join(root, "erp.local.sqlite"), schemaPath: schemaFile, migrationsDir });
    try {
      const applied = (db.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>)
        .map((row) => row.version);
      assert.deepEqual(applied, expectedVersions());
      assert.ok(applied.length > 0, "at least one migration must have been applied");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing migrations folder refuses to open the database instead of silently skipping it", () => {
  const root = tempDir("erp-packaged-nomig-");
  try {
    const { schemaFile } = stageResources(root);
    assert.throws(
      () =>
        new SqliteDatabase({
          dbPath: path.join(root, "erp.local.sqlite"),
          schemaPath: schemaFile,
          migrationsDir: path.join(root, "erp-resources", "migrations", "does-not-exist"),
        }),
      /Migration folder not found/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing schema file refuses to open the database", () => {
  const root = tempDir("erp-packaged-noschema-");
  try {
    const { migrationsDir } = stageResources(root);
    assert.throws(
      () =>
        new SqliteDatabase({
          dbPath: path.join(root, "erp.local.sqlite"),
          schemaPath: path.join(root, "erp-resources", "absent-schema.sql"),
          migrationsDir,
        }),
      /Database schema not found/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
