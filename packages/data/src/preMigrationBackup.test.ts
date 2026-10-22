// THE WAY BACK FROM AN UPGRADE.
//
// Migrations run unattended on a factory PC after an automatic update, against live inventory
// and accounting data. The runner is transactional, so a migration that throws rolls back — but
// a migration that succeeds and is wrong does not, and no `.down.sql` is ever shipped or
// executed. A file-level copy of the database, taken before the first statement runs, is the
// only thing that can undo that.
//
// Every test below drives a REAL upgrade: it boots against a migrations folder with the newest
// file withheld, then boots again with it restored. That is what an update does, so it is what
// is tested — not a hand-set version number.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteDatabase } from "./sqliteDatabase.js";

const SCHEMA_PATH = path.resolve(process.cwd(), "src/local-schema.sql");
const REAL_MIGRATIONS = path.resolve(process.cwd(), "../../migrations/sqlite");

interface Fixture {
  readonly dbPath: string;
  readonly migrationsDir: string;
  readonly backupsDir: string;
  /** The migration file held back, so a later boot has exactly one thing to apply. */
  readonly withheld: string;
}

/**
 * A data folder holding every shipped migration except the newest, so the next boot against the
 * full set has real work to do.
 */
function createFixture(label: string): Fixture {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-premigration-${label}-`));
  const migrationsDir = path.join(tempDir, "migrations");
  fs.mkdirSync(migrationsDir);

  const shipped = fs
    .readdirSync(REAL_MIGRATIONS)
    .filter((file) => file.endsWith(".up.sql"))
    .sort();
  assert.ok(shipped.length > 1, "the repository must ship migrations for this test to mean anything");

  const withheld = shipped[shipped.length - 1];
  for (const file of shipped.slice(0, -1)) {
    fs.copyFileSync(path.join(REAL_MIGRATIONS, file), path.join(migrationsDir, file));
  }

  return {
    dbPath: path.join(tempDir, "erp.db"),
    migrationsDir,
    backupsDir: path.join(tempDir, "backups"),
    withheld,
  };
}

const open = (fixture: Fixture): SqliteDatabase =>
  new SqliteDatabase({ dbPath: fixture.dbPath, schemaPath: SCHEMA_PATH, migrationsDir: fixture.migrationsDir });

/** Restores the withheld migration, so the next boot is a genuine upgrade. */
function shipWithheldMigration(fixture: Fixture): void {
  fs.copyFileSync(path.join(REAL_MIGRATIONS, fixture.withheld), path.join(fixture.migrationsDir, fixture.withheld));
}

const migrationCeilingOf = (databaseFile: string): number => {
  const handle = new DatabaseSync(databaseFile);
  try {
    const rows = handle.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>;
    return rows.reduce((highest, row) => {
      const digits = /^(\d+)/.exec(String(row.version));
      return digits ? Math.max(highest, Number(digits[1])) : highest;
    }, 0);
  } finally {
    handle.close();
  }
};

const backupFiles = (fixture: Fixture): string[] =>
  fs.existsSync(fixture.backupsDir) ? fs.readdirSync(fixture.backupsDir).sort() : [];

test("a brand new database is not backed up — there is nothing yet to lose", () => {
  const fixture = createFixture("fresh");
  const db = open(fixture);
  try {
    assert.equal(db.preMigrationBackup, null);
    assert.deepEqual(backupFiles(fixture), [], "an empty database must not bury the real backups");
  } finally {
    db.close();
  }
});

test("an ordinary launch with nothing pending takes no backup", () => {
  const fixture = createFixture("noop");
  const first = open(fixture);
  first.close();

  const second = open(fixture);
  try {
    assert.equal(second.preMigrationBackup, null);
    assert.deepEqual(backupFiles(fixture), [], "copying ~16 MB on every start would be slow and useless");
  } finally {
    second.close();
  }
});

test("an upgrade copies the database first, and the copy is from BEFORE the migration", () => {
  const fixture = createFixture("upgrade");
  const before = open(fixture);
  const ceilingBefore = migrationCeilingOf(fixture.dbPath);
  before.close();

  shipWithheldMigration(fixture);

  const after = open(fixture);
  try {
    const copy = after.preMigrationBackup;
    assert.ok(copy !== null, "a pending migration must produce a backup");
    assert.equal(copy.pending, 1, "exactly one migration was withheld");
    assert.equal(copy.fromVersion, ceilingBefore);
    assert.ok(copy.toVersion > copy.fromVersion, "the upgrade must advance the ceiling");

    // THE ASSERTION THAT MATTERS: the copy is the old schema, the live file is the new one.
    assert.ok(fs.existsSync(copy.backupPath), "the backup file must be on disk");
    assert.equal(migrationCeilingOf(copy.backupPath), ceilingBefore, "the copy must predate the migration");
    assert.equal(migrationCeilingOf(fixture.dbPath), copy.toVersion, "the live database must have migrated");
  } finally {
    after.close();
  }
});

test("the backup is listed in Settings as PRE_MIGRATION, beside every other backup", () => {
  const fixture = createFixture("recorded");
  const before = open(fixture);
  before.close();

  shipWithheldMigration(fixture);

  const after = open(fixture);
  try {
    const copy = after.preMigrationBackup;
    assert.ok(copy !== null);
    assert.equal(copy.recorded, true, `the backup_history row was refused: ${copy.recordError ?? "no reason given"}`);

    const listed = after.listBackups().filter((entry) => entry.backupType === "PRE_MIGRATION");
    assert.equal(listed.length, 1, "an operator looking for a way back must find it in the list");
    assert.equal(listed[0].backupPath, copy.backupPath);
    assert.equal(listed[0].status, "VERIFIED");
    assert.equal(listed[0].verified, true);
    assert.equal(listed[0].sizeBytes, fs.statSync(copy.backupPath).size);
  } finally {
    after.close();
  }
});

test("the copy carries the business rows that existed before the upgrade", () => {
  const fixture = createFixture("rows");
  const before = open(fixture);
  before.setNumberBlock(1, "test");
  before.ensureOperationalContext({
    factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
    workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
    deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
  });
  const partyId = before.createParty({
    partyName: "ABID", partyType: "SUPPLIER", city: "Lahore", mobileNumber: "0300-1111111", status: "ACTIVE",
  });
  before.close();

  shipWithheldMigration(fixture);

  const after = open(fixture);
  try {
    const copy = after.preMigrationBackup;
    assert.ok(copy !== null);

    const handle = new DatabaseSync(copy.backupPath);
    try {
      const row = handle.prepare("SELECT party_name FROM parties WHERE id = ?").get(String(partyId)) as
        | { party_name: string }
        | undefined;
      assert.equal(row?.party_name, "ABID", "a restore has to bring the data back, not an empty schema");
    } finally {
      handle.close();
    }
  } finally {
    after.close();
  }
});

test("a second upgrade never overwrites the first upgrade's backup", () => {
  const fixture = createFixture("two");
  const before = open(fixture);
  before.close();

  shipWithheldMigration(fixture);
  const first = open(fixture);
  const firstCopy = first.preMigrationBackup;
  first.close();
  assert.ok(firstCopy !== null);

  // A migration this build has never seen, exactly as the next release will bring.
  const nextVersion = `${String(firstCopy.toVersion + 1)}_test_only_added_column`;
  fs.writeFileSync(
    path.join(fixture.migrationsDir, `${nextVersion}.up.sql`),
    "ALTER TABLE app_settings ADD COLUMN test_only_marker TEXT;\n"
  );

  const second = open(fixture);
  try {
    const secondCopy = second.preMigrationBackup;
    assert.ok(secondCopy !== null, "the second upgrade must take its own backup");
    assert.notEqual(secondCopy.backupPath, firstCopy.backupPath);
    assert.ok(fs.existsSync(firstCopy.backupPath), "the earlier way back must still exist");
    assert.equal(backupFiles(fixture).length, 2, "every upgrade keeps its own copy");
    // Each copy sits at the ceiling its own upgrade started from.
    assert.equal(migrationCeilingOf(secondCopy.backupPath), firstCopy.toVersion);
  } finally {
    second.close();
  }
});

// ─── The rollback trap ───────────────────────────────────────────────────────
//
// This test exists to pin a hazard, not a feature. restoreBackup() re-runs bootConnection(), so
// it MIGRATES whatever it restored. Restoring a pre-upgrade backup while the NEW build is still
// installed therefore does NOT return the database to the old schema — it walks it straight back
// up to the new one.
//
// The consequence for an operator: a version rollback must install the OLD build FIRST and
// replace the database file with the application closed. The in-app Restore button cannot do it.
// Written down in docs/36 as a numbered procedure.
test("restoring a pre-upgrade backup on a NEWER build migrates it forward again", () => {
  const fixture = createFixture("rollback");
  const before = open(fixture);
  const oldCeiling = migrationCeilingOf(fixture.dbPath);
  before.close();

  shipWithheldMigration(fixture);

  const upgraded = open(fixture);
  const copy = upgraded.preMigrationBackup;
  assert.ok(copy !== null);
  assert.equal(migrationCeilingOf(copy.backupPath), oldCeiling, "the backup is at the old schema");

  // Hoping to undo the upgrade. The build is still the new one.
  //
  // First: the guard refuses, and the refusal says the thing the operator has got wrong rather
  // than asking a generic "are you sure?".
  assert.throws(
    () => upgraded.restoreBackup(copy.backupPath),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      assert.match(message, /WILL NOT UNDO AN UPDATE/);
      assert.match(message, /migrate the restored data forward/);
      assert.match(message, /losing every gatepass, bill, scan/);
      assert.match(message, /docs\/36 section 4/);
      return true;
    }
  );

  // Confirmed deliberately, it proceeds — and proves why the guard is worded that way.
  upgraded.restoreBackup(copy.backupPath, { confirmSchemaRollback: true });
  try {
    assert.equal(
      migrationCeilingOf(fixture.dbPath),
      copy.toVersion,
      "restoring did NOT go back — the new build migrated the restored database forward"
    );
  } finally {
    upgraded.close();
  }
});

test("restoring a backup at the SAME schema level needs no confirmation — it is ordinary recovery", () => {
  const fixture = createFixture("same-level");
  const db = open(fixture);
  try {
    db.setNumberBlock(1, "test");
    db.ensureOperationalContext({
      factoryId: "factory-1", factoryCode: "F001", factoryName: "Factory",
      workstationId: "workstation-1", workstationCode: "WS001", workstationName: "WS",
      deviceId: "device-1", deviceName: "Device", appVersion: "1.0.0",
    });
    const manual = db.createBackup(fixture.backupsDir, "MANUAL");
    db.createParty({ partyName: "LATER", partyType: "SUPPLIER", city: "Lahore", mobileNumber: "0300-2222222", status: "ACTIVE" });

    // Restoring yesterday's data onto today's build is the normal reason to have backups, and
    // must not be buried under a warning about version rollback.
    db.restoreBackup(manual.backupPath);

    const names = db.db.prepare("SELECT party_name FROM parties").all() as Array<{ party_name: string }>;
    assert.ok(!names.some((row) => row.party_name === "LATER"), "the restore did not take effect");
  } finally {
    db.close();
  }
});

test("a corrupt file is refused rather than copied over the live database", () => {
  const fixture = createFixture("corrupt");
  const db = open(fixture);
  try {
    fs.mkdirSync(fixture.backupsDir, { recursive: true });
    const junk = path.join(fixture.backupsDir, "not-a-database.sqlite");
    fs.writeFileSync(junk, "this is not a SQLite file at all");

    assert.throws(
      () => db.restoreBackup(junk, { confirmSchemaRollback: true }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        assert.match(message, /cannot be read as a 777 ERP database/);
        assert.match(message, /Nothing has been changed/);
        return true;
      }
    );
    // Still usable: the live database was never touched.
    assert.ok(db.listBackups().length >= 0);
  } finally {
    db.close();
  }
});

test("a failed migration reports where the backup is", () => {
  const fixture = createFixture("failure");
  const before = open(fixture);
  before.close();

  shipWithheldMigration(fixture);
  const migrated = open(fixture);
  const ceiling = migrated.preMigrationBackup?.toVersion ?? 0;
  migrated.close();

  // Invalid SQL, so the runner throws and rolls back — the case where the path matters most.
  fs.writeFileSync(
    path.join(fixture.migrationsDir, `${String(ceiling + 1)}_test_only_broken.up.sql`),
    "ALTER TABLE this_table_does_not_exist ADD COLUMN nope TEXT;\n"
  );

  assert.throws(
    () => open(fixture),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /could not be upgraded/, "the operator must be told the upgrade failed");
      assert.match(message, /erp-premigration-/, "the message must name the backup file");
      assert.match(message, /rolled back/, "and say the database was not left half-migrated");
      return true;
    }
  );

  // The backup for the FAILED attempt is still on disk, which is the whole point.
  assert.ok(
    backupFiles(fixture).some((name) => name.includes("erp-premigration-")),
    "a failed upgrade must leave its backup behind"
  );
});
