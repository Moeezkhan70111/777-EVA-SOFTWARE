import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// THE MEMBER DETAILS' SAVE IS ONE CHANGE (rehearsal, 2 Nov). It was four calls from the screen; a
// refused role left the job role, authority and extra screens saved anyway, with nothing said.

const SCHEMA = path.resolve(process.cwd(), "src/local-schema.sql");

function withDatabase(run: (db: SqliteDatabase) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-member-access-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "pc.db"), schemaPath: SCHEMA });
  try {
    run(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function accessOf(db: SqliteDatabase, userId: string) {
  const row = db.db
    .prepare("SELECT u.job_role, u.authority_level, a.role_code FROM app_users u LEFT JOIN user_role_assignments a ON a.user_id = u.id WHERE u.id = ?")
    .get(userId) as { job_role: string; authority_level: number; role_code: string | null };
  return { roleCode: row.role_code, jobRole: row.job_role, authorityLevel: row.authority_level, extras: db.getUserAdditionalPermissions(userId) };
}

test("Save writes the role, job role, authority and extra screens together", () => {
  withDatabase((db) => {
    const admin = db.bootstrapFirstAdmin("Owner", "owner1234");
    const person = db.createUserAccount("Aslam", "aslam1234");
    db.saveMemberAccess(person.id, admin.id, { roleCode: "store-operator", jobRole: "Store Operator", authorityLevel: 20, extraPermissions: ["logs"] });
    assert.deepEqual(accessOf(db, person.id), { roleCode: "store-operator", jobRole: "Store Operator", authorityLevel: 20, extras: ["logs"] });
  });
});

test("a refused part saves nothing: an unknown role leaves job role, authority and extras as they were", () => {
  withDatabase((db) => {
    const admin = db.bootstrapFirstAdmin("Owner", "owner1234");
    const person = db.createUserAccount("Aslam", "aslam1234");
    db.saveMemberAccess(person.id, admin.id, { roleCode: "store-operator", jobRole: "Store Operator", authorityLevel: 20, extraPermissions: ["logs"] });
    const before = accessOf(db, person.id);

    assert.throws(
      () => db.saveMemberAccess(person.id, admin.id, { roleCode: "no-such-role", jobRole: "Munshi", authorityLevel: 40, extraPermissions: ["stock"] }),
      /Role not found/
    );
    assert.deepEqual(accessOf(db, person.id), before);
  });
});

test("a null role or job role leaves that one as it is", () => {
  withDatabase((db) => {
    const admin = db.bootstrapFirstAdmin("Owner", "owner1234");
    const person = db.createUserAccount("Aslam", "aslam1234");
    db.saveMemberAccess(person.id, admin.id, { roleCode: "store-operator", jobRole: "Store Operator", authorityLevel: 20, extraPermissions: [] });
    db.saveMemberAccess(person.id, admin.id, { roleCode: null, jobRole: null, authorityLevel: 30, extraPermissions: ["logs"] });
    assert.deepEqual(accessOf(db, person.id), { roleCode: "store-operator", jobRole: "Store Operator", authorityLevel: 30, extras: ["logs"] });
  });
});
