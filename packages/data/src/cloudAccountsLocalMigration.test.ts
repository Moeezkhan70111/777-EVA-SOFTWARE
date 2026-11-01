import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// MIGRATION 100: password checks leave app_users, and app_users is rebuilt (docs/41 section 2).
//
// PC2 holds the company's real accounts, and every one of them must still sign in with the same
// password the morning after the upgrade. app_users is referenced by fourteen tables, and the
// rebuild runs with foreign keys off, so the upgrade is asserted the way the earlier rebuilds are
// (upgradeExistingDatabase.test.ts): build a database at 099 with real rows, carry it forward,
// then ask SQLite itself.

const SCHEMA = path.resolve(process.cwd(), "src/local-schema.sql");
const MIGRATIONS = path.resolve(process.cwd(), "../../migrations/sqlite");

/** A migrations folder holding only the files up to and including `ceiling`. */
function migrationsUpTo(ceiling: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-accounts-${ceiling}-`));
  for (const file of fs.readdirSync(MIGRATIONS)) {
    const digits = /^(\d+)/.exec(file);
    if (file.endsWith(".up.sql") && digits && Number(digits[1]) <= ceiling) {
      fs.copyFileSync(path.join(MIGRATIONS, file), path.join(dir, file));
    }
  }
  return dir;
}

/**
 * A database at 099 holding an admin, a pending user, a role assignment, a session and a workspace
 * task -- rows in tables that reference app_users. The accounts are written in 099's shape, with
 * the password columns, exactly as the code before 100 wrote them.
 */
function seedAt099(dbPath: string): { adminId: string; userId: string } {
  const older = migrationsUpTo(99);
  const before = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: older });
  try {
    const now = new Date().toISOString();
    const insertUser = before.db.prepare(
      `INSERT INTO app_users (id, username, password_hash, password_salt, role, access_status, permissions_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`
    );
    const admin = before.hashPassword("owner1234");
    const user = before.hashPassword("munshi5678");
    insertUser.run("admin-1", "Owner", admin.hash, admin.salt, "ADMIN", "APPROVED", now, now);
    insertUser.run("user-1", "Munshi", user.hash, user.salt, "USER", "PENDING", now, now);
    before.db.prepare("INSERT INTO roles (role_code, role_name, created_at, updated_at) VALUES ('munshi', 'Munshi', ?, ?)").run(now, now);
    before.db.prepare("INSERT INTO user_role_assignments (user_id, role_code, assigned_by, assigned_at, updated_at) VALUES ('user-1', 'munshi', 'admin-1', ?, ?)").run(now, now);
    before.db.prepare("INSERT INTO user_sessions (id, user_id, token, created_at, last_seen_at, login_date) VALUES ('s-1', 'admin-1', 'tok-1', ?, ?, '2026-11-01')").run(now, now);
    before.db
      .prepare("INSERT INTO workspace_tasks (id, title, assigned_to, assigned_by, created_at, updated_at) VALUES ('t-1', 'Count stock', 'user-1', 'admin-1', ?, ?)")
      .run(now, now);
    return { adminId: "admin-1", userId: "user-1" };
  } finally {
    before.close();
    fs.rmSync(older, { recursive: true, force: true });
  }
}

function withUpgradedDatabase(run: (db: SqliteDatabase) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-accounts-upgrade-"));
  const dbPath = path.join(tempDir, "accounts.db");
  seedAt099(dbPath);
  const after = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: MIGRATIONS });
  try {
    run(after);
  } finally {
    after.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("100 leaves a sound database: every row that names an account still names it", () => {
  withUpgradedDatabase((db) => {
    const integrity = db.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    assert.equal(integrity.integrity_check, "ok");
    assert.equal(db.db.prepare("PRAGMA foreign_key_check").all().length, 0, "no reference to app_users dangles");
    assert.equal((db.db.prepare("SELECT COUNT(*) AS n FROM app_users").get() as { n: number }).n, 2);
    assert.equal((db.db.prepare("SELECT user_id FROM user_role_assignments").get() as { user_id: string }).user_id, "user-1");
    assert.equal((db.db.prepare("SELECT assigned_to FROM workspace_tasks").get() as { assigned_to: string }).assigned_to, "user-1");
  });
});

test("100 moves every password check out of app_users, and nothing secret is left behind", () => {
  withUpgradedDatabase((db) => {
    const columns = (db.db.prepare("PRAGMA table_info(app_users)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!columns.includes("password_hash") && !columns.includes("password_salt"), `app_users still has ${columns.join(", ")}`);
    assert.ok(columns.includes("email") && columns.includes("credential_version"));
    const moved = db.db.prepare("SELECT user_id, credential_version, confirmed_online_at FROM user_credentials ORDER BY user_id").all();
    assert.deepEqual(
      moved.map((row) => ({ ...row })),
      [
        { user_id: "admin-1", credential_version: 1, confirmed_online_at: null },
        { user_id: "user-1", credential_version: 1, confirmed_online_at: null },
      ]
    );
  });
});

test("after 100 every existing account signs in with the password it had, and no other", () => {
  withUpgradedDatabase((db) => {
    assert.equal(db.authenticateUser("Owner", "owner1234")?.id, "admin-1");
    assert.equal(db.authenticateUser("owner", "owner1234")?.id, "admin-1", "the name still matches in any case");
    assert.equal(db.authenticateUser("Munshi", "munshi5678")?.accessStatus, "PENDING", "the waiting state survives");
    assert.equal(db.authenticateUser("Owner", "munshi5678"), null);
    assert.equal(db.authenticateUser("Owner", ""), null);
  });
});

test("after 100 a password changes in user_credentials, and the old one stops working", () => {
  withUpgradedDatabase((db) => {
    db.changePasswordForUser("user-1", "munshi5678", "fresh9999");
    assert.equal(db.authenticateUser("Munshi", "munshi5678"), null);
    assert.equal(db.authenticateUser("Munshi", "fresh9999")?.id, "user-1");
    assert.throws(() => db.changePasswordForUser("user-1", "wrong0000", "other1111"), /Current password is incorrect/);
  });
});

test("after 100 a new account is written with its password check, both or neither", () => {
  withUpgradedDatabase((db) => {
    const created = db.createUserAccount("Storekeeper", "store2468");
    assert.equal(db.authenticateUser("Storekeeper", "store2468")?.id, created.id);
    assert.throws(() => db.createUserAccount("storekeeper", "store2468"), /Username already exists/);
    assert.equal((db.db.prepare("SELECT COUNT(*) AS n FROM user_credentials").get() as { n: number }).n, 3);
  });
});

test("after 100 REVOKED is a status of its own, and emails are unique in any case", () => {
  withUpgradedDatabase((db) => {
    db.db.prepare("UPDATE app_users SET access_status = 'REVOKED' WHERE id = 'user-1'").run();
    assert.throws(() => db.db.prepare("UPDATE app_users SET access_status = 'GONE' WHERE id = 'user-1'").run(), /CHECK constraint failed/);

    const now = new Date().toISOString();
    const insert = db.db.prepare("INSERT INTO app_users (id, username, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    insert.run("cloud-1", "Ali", "ali@777.pk", now, now);
    insert.run("cloud-2", "Ali", "ali.r@777.pk", now, now);
    assert.throws(() => insert.run("cloud-3", "Ali Raza", "ALI@777.pk", now, now), /UNIQUE constraint failed/, "one email, one person");
    assert.throws(() => insert.run("local-3", "Owner", null, now, now), /UNIQUE constraint failed/, "a local sign-in name stays unique");
  });
});
