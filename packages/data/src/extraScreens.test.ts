import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STORED_SCREENS_REPAIR_SETTING_KEY, moveStoredScreensToExtrasOnce } from "./database/users.js";
import { enterCloudAccountsMode } from "./database/accountsMode.js";
import { SqliteDatabase } from "./sqliteDatabase.js";

// TAKING AN EXTRA SCREEN OFF SOMEONE WITH NO ROLE (found 5 Nov, live on every PC).
//
// The admin unticked it, the save succeeded, and the person kept the screen: with no role they are
// read as an account that predates roles, and the stored list that is read for those is also where
// their screens are cached. Nobody could lose an extra screen unless they held a role.

function withDatabase(run: (db: SqliteDatabase, adminId: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-extras-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "pc.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  try {
    run(db, db.bootstrapFirstAdmin("Owner", "owner1234").id);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const screens = (db: SqliteDatabase, userId: string) => db.recalculateEffectivePermissions(userId).sort();
const stored = (db: SqliteDatabase, userId: string) =>
  JSON.parse((db.db.prepare("SELECT permissions_json AS j FROM app_users WHERE id = ?").get(userId) as { j: string }).j) as string[];
const oldAccount = (db: SqliteDatabase, screenList: string[]) => {
  const person = db.createUserAccount("Legacy", "aslam1234");
  db.db.prepare("UPDATE app_users SET permissions_json = ? WHERE id = ?").run(JSON.stringify(screenList), person.id);
  return person.id;
};

test("an extra screen unticked for someone with no role is gone", () => {
  withDatabase((db) => {
    const { id } = db.createUserAccount("Aslam", "aslam1234");
    db.setUserAdditionalPermissions(id, ["logs", "stock"]);
    db.setUserAdditionalPermissions(id, ["stock"]);
    assert.deepEqual(screens(db, id), ["stock"]);
    assert.deepEqual(stored(db, id), ["stock"]);
  });
});

test("every extra unticked leaves them with nothing", () => {
  withDatabase((db) => {
    const { id } = db.createUserAccount("Aslam", "aslam1234");
    db.setUserAdditionalPermissions(id, ["logs", "stock"]);
    db.setUserAdditionalPermissions(id, []);
    assert.deepEqual(screens(db, id), []);
  });
});

test("it goes through the admin's own path too", () => {
  withDatabase((db, adminId) => {
    const { id } = db.createUserAccount("Aslam", "aslam1234");
    db.updateUserPermissions(id, adminId, ["logs"]);
    db.updateUserPermissions(id, adminId, []);
    assert.deepEqual(screens(db, id), []);
  });
});

test("a screen given back after being taken off is there again", () => {
  withDatabase((db) => {
    const { id } = db.createUserAccount("Aslam", "aslam1234");
    db.setUserAdditionalPermissions(id, ["logs"]);
    db.setUserAdditionalPermissions(id, []);
    db.setUserAdditionalPermissions(id, ["logs"]);
    assert.deepEqual(screens(db, id), ["logs"]);
  });
});

test("an old account keeps its own screens: a Save that takes nothing off changes nothing", () => {
  withDatabase((db) => {
    const id = oldAccount(db, ["logs", "stock"]);
    db.setUserAdditionalPermissions(id, []);
    assert.deepEqual(screens(db, id), ["logs", "stock"]);
  });
});

test("an old account given an extra and losing it keeps the rest", () => {
  withDatabase((db) => {
    const id = oldAccount(db, ["stock"]);
    db.setUserAdditionalPermissions(id, ["logs"]);
    assert.deepEqual(screens(db, id), ["logs", "stock"]);
    db.setUserAdditionalPermissions(id, []);
    assert.deepEqual(screens(db, id), ["stock"]);
  });
});

test("a screen stored under an old spelling is found when its one spelling is taken off", () => {
  withDatabase((db) => {
    const id = oldAccount(db, ["current stock"]);
    const spelled = db.recalculateEffectivePermissions(id)[0] ?? "";
    assert.notEqual(spelled, "current stock", "the old name has one spelling now");
    // An extra as an older version stored it: in the table, with the list left in its old spelling.
    db.db.prepare("INSERT INTO user_additional_permissions (user_id, permission_code, granted_at) VALUES (?, ?, ?)").run(id, spelled, "2026-01-01T00:00:00.000Z");
    db.setUserAdditionalPermissions(id, []);
    assert.deepEqual(screens(db, id), []);
  });
});

test("with a role, an extra unticked is gone as it always was, and the role's screens stay", () => {
  withDatabase((db, adminId) => {
    const { id } = db.createUserAccount("Aslam", "aslam1234");
    db.assignUserRole(id, "store-operator", adminId);
    const roleScreens = screens(db, id);
    db.setUserAdditionalPermissions(id, ["logs"]);
    db.setUserAdditionalPermissions(id, []);
    assert.deepEqual(screens(db, id), roleScreens);
  });
});

test("an unreadable stored list does not stop the Save", () => {
  withDatabase((db) => {
    const { id } = db.createUserAccount("Aslam", "aslam1234");
    db.setUserAdditionalPermissions(id, ["logs"]);
    db.db.prepare("UPDATE app_users SET permissions_json = 'not json' WHERE id = ?").run(id);
    assert.doesNotThrow(() => db.setUserAdditionalPermissions(id, []));
    assert.deepEqual(screens(db, id), []);
  });
});

// THE DIALOG SAID "NO PERMISSIONS ASSIGNED" WHILE THEY COULD OPEN SCREENS. It reads the extras table, and
// these screens were only in the stored list. Once per database they move, so the table is the truth.

const repair = (db: SqliteDatabase) => {
  db.db.prepare("DELETE FROM app_settings WHERE setting_key = ?").run(STORED_SCREENS_REPAIR_SETTING_KEY);
  return moveStoredScreensToExtrasOnce(db.db, (screen) => db.normalizePermissionCode(screen), "2026-11-06T00:00:00.000Z");
};
const listed = (db: SqliteDatabase, id: string) => db.listMembers().find((member) => member.id === id);

test("an old account's screens show as extras afterwards, and nobody gains or loses a screen", () => {
  withDatabase((db) => {
    const id = oldAccount(db, ["logs", "current stock"]);
    const before = screens(db, id);
    assert.deepEqual(listed(db, id)?.additionalPermissions, [], "the state the dialog was wrong about");

    assert.equal(repair(db), 2);

    assert.deepEqual(screens(db, id), before);
    assert.deepEqual(listed(db, id)?.additionalPermissions?.slice().sort(), before);
  });
});

test("after it, unticking an old account's screen takes it away", () => {
  withDatabase((db) => {
    const id = oldAccount(db, ["logs", "stock"]);
    repair(db);
    db.setUserAdditionalPermissions(id, ["stock"]);
    assert.deepEqual(screens(db, id), ["stock"]);
    db.setUserAdditionalPermissions(id, []);
    assert.deepEqual(screens(db, id), []);
  });
});

test("it runs once: a screen taken off later does not come back when the database opens again", () => {
  withDatabase((db) => {
    const id = oldAccount(db, ["logs"]);
    repair(db);
    db.setUserAdditionalPermissions(id, []);
    db.db.prepare("UPDATE app_users SET permissions_json = ? WHERE id = ?").run(JSON.stringify(["logs"]), id);
    assert.equal(moveStoredScreensToExtrasOnce(db.db, (screen) => screen, "2026-11-07T00:00:00.000Z"), null);
    assert.deepEqual(db.getUserAdditionalPermissions(id), []);
  });
});

test("it leaves someone with a role alone, and an administrator", () => {
  withDatabase((db, adminId) => {
    const { id } = db.createUserAccount("Aslam", "aslam1234");
    db.assignUserRole(id, "store-operator", adminId);
    repair(db);
    assert.deepEqual(db.getUserAdditionalPermissions(id), []);
    assert.deepEqual(db.getUserAdditionalPermissions(adminId), []);
  });
});

test("an unreadable stored list moves nothing and stops nothing", () => {
  withDatabase((db) => {
    const { id } = db.createUserAccount("Aslam", "aslam1234");
    db.db.prepare("UPDATE app_users SET permissions_json = 'not json' WHERE id = ?").run(id);
    assert.equal(repair(db), 0);
    assert.deepEqual(db.getUserAdditionalPermissions(id), []);
  });
});

test("it runs when a database opens: no test or caller has to ask for it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-extras-open-"));
  const options = { dbPath: path.join(dir, "pc.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") };
  const first = new SqliteDatabase(options);
  try {
    first.bootstrapFirstAdmin("Owner", "owner1234");
    const id = oldAccount(first, ["logs"]);
    first.db.prepare("DELETE FROM app_settings WHERE setting_key = ?").run(STORED_SCREENS_REPAIR_SETTING_KEY);
    first.close();
    const again = new SqliteDatabase(options);
    assert.deepEqual(again.getUserAdditionalPermissions(id), ["logs"]);
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("under cloud accounts the repair leaves everything alone: the extras here are the cloud's", () => {
  withDatabase((db) => {
    const id = oldAccount(db, ["logs"]);
    enterCloudAccountsMode(db.db, "test");
    assert.equal(repair(db), null);
    assert.deepEqual(db.getUserAdditionalPermissions(id), []);
  });
});
