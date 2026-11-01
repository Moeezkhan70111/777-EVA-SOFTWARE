import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";
import {
  ACCOUNTS_MODE,
  ACCOUNTS_MODE_SETTING_KEY,
  LocalAccountsClosedError,
  enterCloudAccountsMode,
  readAccountsMode,
} from "./database/accountsMode.js";

// UNDER CLOUD ACCOUNTS, NO LOCAL ADMIN DECIDES WHO GETS IN (docs/41 section 7, owner 2026-11-01).
//
// The refusal is in the data layer, so it holds whatever calls it: a screen, an IPC handler that
// forgot to check, or a future AI feature. A hidden button is not an authorisation (CLAUDE.md R9).

const SCHEMA = path.resolve(process.cwd(), "src/local-schema.sql");

function withDatabase(run: (db: SqliteDatabase, dbPath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-accounts-mode-"));
  const dbPath = path.join(dir, "pc.db");
  const db = new SqliteDatabase({ dbPath, schemaPath: SCHEMA });
  try {
    run(db, dbPath);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Every local account change, called with arguments that would otherwise get past the refusal. */
const LOCAL_ACCOUNT_CHANGES: Array<[string, (db: SqliteDatabase) => unknown]> = [
  ["bootstrapFirstAdmin", (db) => db.bootstrapFirstAdmin("Owner", "owner1234")],
  ["createUserAccount", (db) => db.createUserAccount("Someone", "some1234")],
  ["createRole", (db) => db.createRole({ name: "Spare", permissions: ["stock"] })],
  ["updateRole", (db) => db.updateRole("store-operator", { name: "Store" })],
  ["updateRolePermissions", (db) => db.updateRolePermissions("store-operator", ["logs"])],
  ["deleteRole", (db) => db.deleteRole("store-operator")],
  ["assignUserRole", (db) => db.assignUserRole("u-1", "store-operator", "u-admin")],
  ["setUserAdditionalPermissions", (db) => db.setUserAdditionalPermissions("u-1", ["logs"])],
  ["createAccessRequest", (db) => db.createAccessRequest("u-1")],
  ["reviewAccessRequest", (db) => db.reviewAccessRequest("ar-1", "u-admin", "APPROVED")],
  ["createPermissionRequest", (db) => db.createPermissionRequest("u-1", "logs")],
  ["reviewPermissionRequest", (db) => db.reviewPermissionRequest("pr-1", "u-admin", "APPROVED")],
  ["updateMemberJobRole", (db) => db.updateMemberJobRole("u-1", "u-admin", "Munshi")],
  ["updateMemberAuthorityLevel", (db) => db.updateMemberAuthorityLevel("u-1", "u-admin", 20)],
  ["updateUserPermissions", (db) => db.updateUserPermissions("u-1", "u-admin", ["logs"])],
  ["revokeUserAccess", (db) => db.revokeUserAccess("u-1", "u-admin")],
  ["changePasswordForUser", (db) => db.changePasswordForUser("u-1", "old12345", "new12345")],
];

test("a PC starts in local accounts, where its own first admin and sign-up still work", () => {
  withDatabase((db) => {
    assert.equal(readAccountsMode(db.db), ACCOUNTS_MODE.LOCAL);
    const admin = db.bootstrapFirstAdmin("Owner", "owner1234");
    assert.equal(db.authenticateUser("Owner", "owner1234")?.id, admin.id);
  });
});

test("under cloud accounts every local account change is refused, before it touches anything", () => {
  withDatabase((db) => {
    enterCloudAccountsMode(db.db, "test");
    const rolesBefore = (db.db.prepare("SELECT COUNT(*) AS n FROM roles").get() as { n: number }).n;
    for (const [name, change] of LOCAL_ACCOUNT_CHANGES) {
      assert.throws(() => change(db), LocalAccountsClosedError, `${name} was not refused`);
    }
    assert.equal((db.db.prepare("SELECT COUNT(*) AS n FROM app_users").get() as { n: number }).n, 0, "no account was made");
    assert.equal((db.db.prepare("SELECT COUNT(*) AS n FROM roles").get() as { n: number }).n, rolesBefore, "no role changed");
  });
});

test("the account mode cannot be switched back from a settings screen", () => {
  withDatabase((db) => {
    enterCloudAccountsMode(db.db, "test");
    const { dropped } = db.setOperatorSettings({ [ACCOUNTS_MODE_SETTING_KEY]: ACCOUNTS_MODE.LOCAL, "company.name": "777" }, "operator");
    assert.deepEqual(dropped, [ACCOUNTS_MODE_SETTING_KEY]);
    assert.equal(readAccountsMode(db.db), ACCOUNTS_MODE.CLOUD);
  });
});

test("under cloud accounts the built-in roles are not seeded again on start: the cloud owns the catalogue", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-accounts-seed-"));
  const dbPath = path.join(dir, "pc.db");
  try {
    const first = new SqliteDatabase({ dbPath, schemaPath: SCHEMA });
    assert.ok((first.db.prepare("SELECT COUNT(*) AS n FROM roles").get() as { n: number }).n > 0, "local mode seeds them");
    enterCloudAccountsMode(first.db, "test");
    first.db.exec("DELETE FROM role_permissions");
    first.db.exec("DELETE FROM roles");
    first.close();

    const reopened = new SqliteDatabase({ dbPath, schemaPath: SCHEMA });
    assert.equal((reopened.db.prepare("SELECT COUNT(*) AS n FROM roles").get() as { n: number }).n, 0);
    reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
