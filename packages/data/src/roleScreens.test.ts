import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { ROLE_SCREENS_REPAIR_SETTING_KEY } from "./database/users.js";
import { enterCloudAccountsMode } from "./database/accountsMode.js";

// TAKING A SCREEN OFF A ROLE TAKES IT FROM EVERYONE WITH THAT ROLE (rehearsal, 2 Nov). Approving
// with a role stored the role's screens among the person's additional access too, so they kept a
// screen the role no longer gave -- the admin would think they had removed it, and they had not.

const SCHEMA = path.resolve(process.cwd(), "src/local-schema.sql");

function withFolder(run: (dbPath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-role-screens-"));
  try {
    run(path.join(dir, "pc.db"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const open = (dbPath: string) => new SqliteDatabase({ dbPath, schemaPath: SCHEMA });

/** An admin and a person waiting for access, with their request's id. */
function waitingPerson(db: SqliteDatabase) {
  const admin = db.bootstrapFirstAdmin("Owner", "owner1234");
  const person = db.createUserAccount("Aslam", "aslam1234");
  db.createAccessRequest(person.id);
  const request = db.db.prepare("SELECT id FROM access_requests WHERE user_id = ?").get(person.id) as { id: string };
  return { adminId: admin.id, personId: person.id, requestId: request.id };
}

test("approving with a role stores only the screens beyond it, so taking one off the role takes it away", () => {
  withFolder((dbPath) => {
    const db = open(dbPath);
    try {
      const { adminId, personId, requestId } = waitingPerson(db);
      // As the member screen sends it: the role's screens and the extra together.
      db.reviewAccessRequest(requestId, adminId, "APPROVED", ["store-scanning", "stock", "logs"], "store-operator");
      assert.deepEqual(db.getUserAdditionalPermissions(personId), ["logs"]);

      db.updateRolePermissions("store-operator", ["stock"]);
      const now = db.recalculateEffectivePermissions(personId);
      assert.equal(now.includes("store-scanning"), false, "the screen taken off the role is gone");
      assert.equal(now.includes("stock"), true);
      assert.equal(now.includes("logs"), true, "the extra granted to them stays");
    } finally {
      db.close();
    }
  });
});

test("Save keeps a role's screens out of additional access", () => {
  withFolder((dbPath) => {
    const db = open(dbPath);
    try {
      const { adminId, personId } = waitingPerson(db);
      db.assignUserRole(personId, "store-operator", adminId);
      db.setUserAdditionalPermissions(personId, ["stock", "logs"]);
      assert.deepEqual(db.getUserAdditionalPermissions(personId), ["logs"]);
    } finally {
      db.close();
    }
  });
});

test("once, on opening: role screens already stored as extras are removed, and nobody loses a screen today", () => {
  withFolder((dbPath) => {
    let personId = "";
    let before: string[] = [];
    const first = open(dbPath);
    try {
      const people = waitingPerson(first);
      personId = people.personId;
      first.assignUserRole(personId, "store-operator", people.adminId);
      // What an approval before this fix left behind: the role's screens among the extras.
      const insert = first.db.prepare("INSERT INTO user_additional_permissions (user_id, permission_code, granted_at) VALUES (?, ?, ?)");
      for (const code of ["store-scanning", "stock", "logs"]) insert.run(personId, code, "2026-10-01T00:00:00.000Z");
      first.persistEffectivePermissions(personId);
      before = first.recalculateEffectivePermissions(personId).sort();
      first.db.prepare("DELETE FROM app_settings WHERE setting_key = ?").run(ROLE_SCREENS_REPAIR_SETTING_KEY);
    } finally {
      first.close();
    }

    const second = open(dbPath);
    try {
      assert.deepEqual(second.getUserAdditionalPermissions(personId), ["logs"]);
      assert.deepEqual(second.recalculateEffectivePermissions(personId).sort(), before);
      const marker = second.db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?").get(ROLE_SCREENS_REPAIR_SETTING_KEY) as { setting_value: string };
      assert.equal((JSON.parse(marker.setting_value) as { removed: number }).removed, 2);
      // Once only: a screen given individually and later added to the role is not touched again.
      second.db.prepare("INSERT INTO user_additional_permissions (user_id, permission_code, granted_at) VALUES (?, ?, ?)").run(personId, "stock", "2026-11-02T00:00:00.000Z");
    } finally {
      second.close();
    }

    const third = open(dbPath);
    try {
      assert.deepEqual(third.getUserAdditionalPermissions(personId).sort(), ["logs", "stock"]);
    } finally {
      third.close();
    }
  });
});

test("under cloud accounts the repair leaves additional access alone: it is the cloud's", () => {
  withFolder((dbPath) => {
    let personId = "";
    const first = open(dbPath);
    try {
      const people = waitingPerson(first);
      personId = people.personId;
      first.assignUserRole(personId, "store-operator", people.adminId);
      enterCloudAccountsMode(first.db, "test");
      const insert = first.db.prepare("INSERT INTO user_additional_permissions (user_id, permission_code, granted_at) VALUES (?, ?, ?)");
      for (const code of ["stock", "logs"]) insert.run(personId, code, "2026-10-01T00:00:00.000Z");
      first.db.prepare("DELETE FROM app_settings WHERE setting_key = ?").run(ROLE_SCREENS_REPAIR_SETTING_KEY);
    } finally {
      first.close();
    }

    const second = open(dbPath);
    try {
      assert.deepEqual(second.getUserAdditionalPermissions(personId).sort(), ["logs", "stock"]);
      assert.equal(second.db.prepare("SELECT 1 FROM app_settings WHERE setting_key = ?").get(ROLE_SCREENS_REPAIR_SETTING_KEY), undefined);
    } finally {
      second.close();
    }
  });
});
