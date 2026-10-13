import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteDatabase } from "./sqliteDatabase.js";

// A database must never be opened by a build that is older than it.
//
// The database lives outside the installation (%LOCALAPPDATA%\777-erp), so it survives install,
// upgrade and uninstall. runMigrations only applies the files it HAS, so an older build finds
// nothing pending and — before this guard — would simply carry on against a schema it was never
// written for. Silent, on live inventory and accounting data.
//
// The guard compares the highest migration this build SHIPS against the highest recorded in
// schema_migrations, and refuses when the database is ahead. It never runs a down migration:
// electron-builder ships only *.up.sql because the application has no downgrade path.
//
// These tests fake an older build the only way that is faithful — by pointing migrationsDir at a
// folder holding only the first N migrations, which is exactly what an older installer shipped.

const SCHEMA = path.resolve(process.cwd(), "src/local-schema.sql");
const REAL_MIGRATIONS = path.resolve(process.cwd(), "../../migrations/sqlite");

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `erp-${prefix}-`));
}

/** A migrations folder holding only the files up to and including `ceiling`. */
function migrationsUpTo(ceiling: number): string {
  const dir = tempDir(`migrations-${ceiling}`);
  for (const file of fs.readdirSync(REAL_MIGRATIONS)) {
    if (!file.endsWith(".up.sql")) continue;
    const digits = /^(\d+)/.exec(file);
    if (digits && Number(digits[1]) <= ceiling) {
      fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(dir, file));
    }
  }
  return dir;
}

const shippedCeiling = (dir: string): number =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".up.sql"))
    .reduce((highest, f) => Math.max(highest, Number(/^(\d+)/.exec(f)?.[1] ?? 0)), 0);

const appliedCeiling = (dbPath: string): number => {
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (reader.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>).reduce(
      (highest, row) => Math.max(highest, Number(/^(\d+)/.exec(row.version)?.[1] ?? 0)),
      0
    );
  } finally {
    reader.close();
  }
};

// ─── Compatible databases are untouched ──────────────────────────────────────

test("a fresh database opens normally and is migrated to the build's ceiling", () => {
  const dir = tempDir("guard-fresh");
  const dbPath = path.join(dir, "fresh.db");
  try {
    const db = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: REAL_MIGRATIONS });
    db.close();

    assert.equal(appliedCeiling(dbPath), shippedCeiling(REAL_MIGRATIONS), "fresh databases are brought fully up to date");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reopening a database with the same build is accepted", () => {
  const dir = tempDir("guard-same");
  const dbPath = path.join(dir, "same.db");
  try {
    new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: REAL_MIGRATIONS }).close();
    // Second open: applied === supported, so the guard is a no-op.
    const again = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: REAL_MIGRATIONS });
    assert.ok(again.getSettings(), "the database opened and is usable");
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a database behind the build is migrated forward, not refused", () => {
  const dir = tempDir("guard-forward");
  const dbPath = path.join(dir, "forward.db");
  const older = migrationsUpTo(70);
  try {
    new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: older }).close();
    assert.equal(appliedCeiling(dbPath), 70, "the older build stopped at its own ceiling");

    // The current build opens the same file and carries it forward. This is the direction that
    // must keep working.
    new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: REAL_MIGRATIONS }).close();
    assert.equal(appliedCeiling(dbPath), shippedCeiling(REAL_MIGRATIONS));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(older, { recursive: true, force: true });
  }
});

// ─── A newer database is refused ─────────────────────────────────────────────

test("an older build refuses a database migrated past what it supports", () => {
  const dir = tempDir("guard-newer");
  const dbPath = path.join(dir, "newer.db");
  const older = migrationsUpTo(70);
  try {
    // Current build migrates the database to today's ceiling...
    new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: REAL_MIGRATIONS }).close();
    const ahead = appliedCeiling(dbPath);
    assert.ok(ahead > 70, "the database is ahead of the older build");

    // ...then the older installer is put back on the machine. The database stayed where it was.
    assert.throws(
      () => new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: older }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /newer version of 777 ERP/);
        assert.match(error.message, new RegExp(`Database schema level : ${ahead}`));
        assert.match(error.message, /This version supports : 70/);
        assert.match(error.message, /Nothing has been changed/);
        return true;
      }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(older, { recursive: true, force: true });
  }
});

test("the refusal names the database file, so an operator can say which one", () => {
  const dir = tempDir("guard-path");
  const dbPath = path.join(dir, "named.db");
  const older = migrationsUpTo(60);
  try {
    new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: REAL_MIGRATIONS }).close();
    assert.throws(
      () => new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: older }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(dbPath), "the message quotes the database path");
        return true;
      }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(older, { recursive: true, force: true });
  }
});

// ─── It refuses BEFORE anything is written ───────────────────────────────────

test("the refused database is left exactly as it was — no compatibility or default-role writes", () => {
  const dir = tempDir("guard-nowrite");
  const dbPath = path.join(dir, "untouched.db");
  const older = migrationsUpTo(70);
  try {
    new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: REAL_MIGRATIONS }).close();

    // Everything ensureSchemaCompatibility and ensureDefaultRoles would change, recorded first.
    const before = new DatabaseSync(dbPath, { readOnly: true });
    const snapshot = {
      objects: before.prepare("SELECT type, name FROM sqlite_master ORDER BY type, name").all(),
      migrations: before.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      roles: before.prepare("SELECT COUNT(*) AS c FROM roles").get(),
    };
    before.close();
    const bytes = fs.readFileSync(dbPath).length;

    assert.throws(() => new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: older }), /newer version of 777 ERP/);

    const after = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.deepEqual(
        after.prepare("SELECT type, name FROM sqlite_master ORDER BY type, name").all(),
        snapshot.objects,
        "no table, index or column was added"
      );
      assert.deepEqual(
        after.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
        snapshot.migrations,
        "no migration was recorded or removed"
      );
      assert.deepEqual(after.prepare("SELECT COUNT(*) AS c FROM roles").get(), snapshot.roles, "no default role was written");
      const integrity = after.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
      assert.equal(integrity?.integrity_check, "ok");
    } finally {
      after.close();
    }
    assert.equal(fs.readFileSync(dbPath).length, bytes, "the file did not even change size");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(older, { recursive: true, force: true });
  }
});

test("a refused open leaves no connection holding the file", () => {
  const dir = tempDir("guard-handle");
  const dbPath = path.join(dir, "handle.db");
  const older = migrationsUpTo(70);
  try {
    new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: REAL_MIGRATIONS }).close();
    assert.throws(() => new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: older }), /newer version of 777 ERP/);

    // On Windows a leaked handle keeps the file locked, which is how this would show up.
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(fs.existsSync(dbPath), false, "the file could be removed, so nothing held it open");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(older, { recursive: true, force: true });
  }
});
