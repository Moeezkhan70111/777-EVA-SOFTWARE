import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { changesNothing, reportMemberAccess, settleMemberAccess, type MemberAccessReport } from "./database/memberAccess.js";
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

test("a null job role leaves it as it is, and a held role stays when it is sent back", () => {
  withDatabase((db) => {
    const admin = db.bootstrapFirstAdmin("Owner", "owner1234");
    const person = db.createUserAccount("Aslam", "aslam1234");
    db.saveMemberAccess(person.id, admin.id, { roleCode: "store-operator", jobRole: "Store Operator", authorityLevel: 20, extraPermissions: [] });
    db.saveMemberAccess(person.id, admin.id, { roleCode: "store-operator", jobRole: null, authorityLevel: 30, extraPermissions: ["logs"] });
    assert.deepEqual(accessOf(db, person.id), { roleCode: "store-operator", jobRole: "Store Operator", authorityLevel: 30, extras: ["logs"] });
  });
});

// "NO ROLE ASSIGNED" TAKES THE ROLE AWAY (rehearsal, 5 Nov). The dropdown offered it, the save kept
// the role and said "Changes saved". And the save now answers with what it did, not what it assumed.

function withRoleHolder(run: (db: SqliteDatabase, ids: { admin: string; person: string }, role: { code: string; name: string; screen: string }) => void): void {
  withDatabase((db) => {
    const admin = db.bootstrapFirstAdmin("Owner", "owner1234");
    const person = db.createUserAccount("Aslam", "aslam1234");
    const role = db.listRoles().find((candidate) => candidate.code === "store-operator");
    assert.ok(role);
    const screen = role.permissions[0];
    assert.ok(screen, "the role has a screen to lose");
    db.saveMemberAccess(person.id, admin.id, { roleCode: role.code, jobRole: role.name, authorityLevel: 20, extraPermissions: ["logs"] });
    run(db, { admin: admin.id, person: person.id }, { code: role.code, name: role.name, screen });
  });
}

const outcomes = (report: MemberAccessReport) => Object.fromEntries(report.fields.map((result) => [result.field, result.outcome]));

test("no role takes the role away, and its screens go with it, on this computer's stored list too", () => {
  withRoleHolder((db, ids, role) => {
    assert.ok(db.recalculateEffectivePermissions(ids.person).includes(role.screen));

    db.saveMemberAccess(ids.person, ids.admin, { roleCode: null, jobRole: role.name, authorityLevel: 20, extraPermissions: ["logs"] });

    assert.equal(accessOf(db, ids.person).roleCode, null);
    assert.deepEqual(db.recalculateEffectivePermissions(ids.person), ["logs"]);
    const stored = db.db.prepare("SELECT permissions_json FROM app_users WHERE id = ?").get(ids.person) as { permissions_json: string };
    assert.deepEqual(JSON.parse(stored.permissions_json), ["logs"]);
  });
});

test("the job role that was only the role's name goes with it, so the list stops showing the role", () => {
  withRoleHolder((db, ids, role) => {
    const report = db.saveMemberAccess(ids.person, ids.admin, { roleCode: null, jobRole: role.name, authorityLevel: 20, extraPermissions: ["logs"] });
    assert.equal(accessOf(db, ids.person).jobRole, "");
    assert.equal(outcomes(report).ROLE, "CHANGED");
    assert.equal(outcomes(report).JOB_ROLE, "CHANGED");
    const listed = db.listMembers().find((member) => member.id === ids.person);
    assert.equal(listed?.jobRole, "");
  });
});

test("a job role set apart from the role stays when the role goes", () => {
  withRoleHolder((db, ids, role) => {
    db.db.prepare("UPDATE app_users SET job_role = 'Senior Cutter' WHERE id = ?").run(ids.person);
    db.saveMemberAccess(ids.person, ids.admin, { roleCode: null, jobRole: role.name, authorityLevel: 20, extraPermissions: ["logs"] });
    assert.equal(accessOf(db, ids.person).jobRole, "Senior Cutter");
  });
});

test("a person with no role who stays that way is not reported as changed", () => {
  withDatabase((db) => {
    const admin = db.bootstrapFirstAdmin("Owner", "owner1234");
    const person = db.createUserAccount("Aslam", "aslam1234");
    const report = db.saveMemberAccess(person.id, admin.id, { roleCode: null, jobRole: null, authorityLevel: accessOf(db, person.id).authorityLevel, extraPermissions: [] });
    assert.deepEqual(new Set(Object.values(outcomes(report))), new Set(["UNCHANGED"]));
  });
});

test("the same Save twice says nothing changed the second time, and tells the person nothing new", () => {
  withRoleHolder((db, ids, role) => {
    const notices = () => Number((db.db.prepare("SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = ?").get(ids.person) as { n: number }).n);
    const before = notices();
    const report = db.saveMemberAccess(ids.person, ids.admin, { roleCode: role.code, jobRole: role.name, authorityLevel: 20, extraPermissions: ["logs"] });
    assert.deepEqual(new Set(Object.values(outcomes(report))), new Set(["UNCHANGED"]));
    assert.equal(notices(), before);
  });
});

test("the report says only what changed, and carries what is stored", () => {
  withRoleHolder((db, ids, role) => {
    const report = db.saveMemberAccess(ids.person, ids.admin, { roleCode: role.code, jobRole: role.name, authorityLevel: 35, extraPermissions: ["logs"] });
    assert.deepEqual(outcomes(report), { ROLE: "UNCHANGED", JOB_ROLE: "UNCHANGED", AUTHORITY: "CHANGED", EXTRA_SCREENS: "UNCHANGED" });
    assert.equal(report.stored.authorityLevel, 35);
    assert.equal(report.stored.roleCode, role.code);
  });
});

test("a screen the role already gives is not an extra, and is not reported as lost", () => {
  withRoleHolder((db, ids, role) => {
    const report = db.saveMemberAccess(ids.person, ids.admin, { roleCode: role.code, jobRole: role.name, authorityLevel: 20, extraPermissions: ["logs", role.screen] });
    assert.equal(outcomes(report).EXTRA_SCREENS, "UNCHANGED");
    assert.deepEqual(accessOf(db, ids.person).extras, ["logs"]);
  });
});

test("whatever did not take is NOT_SAVED: the report compares what is stored, it does not assume", () => {
  const before = { roleCode: "store", jobRole: "Store", authorityLevel: 20, extraPermissions: ["logs"] };
  const wanted = { roleCode: null, jobRole: "", authorityLevel: 30, extraPermissions: ["logs", "stock"] };
  const report = reportMemberAccess(before, wanted, before);
  assert.deepEqual(outcomes(report), { ROLE: "NOT_SAVED", JOB_ROLE: "NOT_SAVED", AUTHORITY: "NOT_SAVED", EXTRA_SCREENS: "NOT_SAVED" });
  assert.deepEqual(report.stored, before);
});

test("something stored that is neither what was wanted nor what was there is NOT_SAVED too", () => {
  const before = { roleCode: null, jobRole: "", authorityLevel: 20, extraPermissions: [] };
  const report = reportMemberAccess(before, { ...before, authorityLevel: 30 }, { ...before, authorityLevel: 25 });
  assert.equal(outcomes(report).AUTHORITY, "NOT_SAVED");
});

test("the order of the screens is not a difference", () => {
  const before = { roleCode: null, jobRole: "", authorityLevel: 20, extraPermissions: ["a", "b"] };
  const report = reportMemberAccess(before, { ...before, extraPermissions: ["b", "a"] }, before);
  assert.equal(outcomes(report).EXTRA_SCREENS, "UNCHANGED");
});

test("settling a role that is not known keeps the job role asked for, and leaves refusing it to the save", () => {
  const current = { roleCode: "store", jobRole: "Store", authorityLevel: 20, extraPermissions: [] };
  const settled = settleMemberAccess(current, { roleCode: "new", jobRole: "New", authorityLevel: 20, extraPermissions: [] }, []);
  assert.equal(settled.roleCode, "new");
  assert.equal(settled.jobRole, "New");
});

test("an extra taken off in the same Save as the role does not come back", () => {
  withRoleHolder((db, ids, role) => {
    db.saveMemberAccess(ids.person, ids.admin, { roleCode: null, jobRole: role.name, authorityLevel: 20, extraPermissions: [] });
    assert.deepEqual(db.recalculateEffectivePermissions(ids.person), []);
  });
});

test("one of the old role's screens kept as an extra stays, because it was asked for", () => {
  withRoleHolder((db, ids, role) => {
    const report = db.saveMemberAccess(ids.person, ids.admin, { roleCode: null, jobRole: role.name, authorityLevel: 20, extraPermissions: ["logs", role.screen] });
    assert.equal(outcomes(report).EXTRA_SCREENS, "CHANGED");
    assert.deepEqual(db.recalculateEffectivePermissions(ids.person).sort(), ["logs", role.screen].sort());
  });
});

test("an account that predates roles keeps its screens when a Save has no role to take away", () => {
  withDatabase((db) => {
    const admin = db.bootstrapFirstAdmin("Owner", "owner1234");
    const person = db.createUserAccount("Aslam", "aslam1234");
    db.db.prepare("UPDATE app_users SET permissions_json = ? WHERE id = ?").run(JSON.stringify(["stock"]), person.id);

    db.saveMemberAccess(person.id, admin.id, { roleCode: null, jobRole: null, authorityLevel: 30, extraPermissions: [] });

    assert.ok(db.recalculateEffectivePermissions(person.id).includes("stock"));
  });
});

test("a write the database quietly skips is reported as not saved: the report reads the store, not the request", () => {
  withDatabase((db) => {
    const admin = db.bootstrapFirstAdmin("Owner", "owner1234");
    const stored = accessOf(db, admin.id).authorityLevel;
    const asked = stored === 30 ? 31 : 30;

    // updateMemberAuthorityLevel leaves an ADMIN's row alone, and says nothing about it.
    const report = db.saveMemberAccess(admin.id, admin.id, { roleCode: null, jobRole: null, authorityLevel: asked, extraPermissions: [] });

    assert.equal(outcomes(report).AUTHORITY, "NOT_SAVED");
    assert.equal(report.stored.authorityLevel, stored);
  });
});

test("a number moved into range below the screen is reported as not saved, not as the number asked for", () => {
  withRoleHolder((db, ids, role) => {
    const report = db.saveMemberAccess(ids.person, ids.admin, { roleCode: role.code, jobRole: role.name, authorityLevel: 150, extraPermissions: ["logs"] });
    assert.equal(outcomes(report).AUTHORITY, "NOT_SAVED");
    assert.equal(report.stored.authorityLevel, 99);
  });
});

// THE REPORT'S BLIND SPOT, CLOSED. It compared the extras table, so a screen still open from somewhere
// else was reported as saved: how the no-role gap stayed hidden (docs/41 section 13).

/** Something this code does not know about puts a screen back, whatever the save writes. */
const screenKeepsComingBack = (db: SqliteDatabase, userId: string, screen: string) =>
  db.db.exec(`CREATE TRIGGER keep_screen AFTER UPDATE OF permissions_json ON app_users
    WHEN NEW.id = '${userId}' AND NEW.permissions_json NOT LIKE '%${screen}%'
    BEGIN UPDATE app_users SET permissions_json = '["${screen}"]' WHERE id = NEW.id; END`);

test("an extra taken off that is still open is reported, though every field looks saved", () => {
  withDatabase((db) => {
    const admin = db.bootstrapFirstAdmin("Owner", "owner1234");
    const { id } = db.createUserAccount("Aslam", "aslam1234");
    db.saveMemberAccess(id, admin.id, { roleCode: null, jobRole: null, authorityLevel: 20, extraPermissions: ["logs"] });
    screenKeepsComingBack(db, id, "logs");

    const report = db.saveMemberAccess(id, admin.id, { roleCode: null, jobRole: null, authorityLevel: 20, extraPermissions: [] });

    assert.equal(outcomes(report).EXTRA_SCREENS, "CHANGED", "the table did change");
    assert.deepEqual(report.screensStillOpen, ["logs"]);
  });
});

test("a role taken away whose screen is still open is reported too", () => {
  withRoleHolder((db, ids, role) => {
    screenKeepsComingBack(db, ids.person, role.screen);
    const report = db.saveMemberAccess(ids.person, ids.admin, { roleCode: null, jobRole: null, authorityLevel: 20, extraPermissions: ["logs"] });
    assert.deepEqual(report.screensStillOpen, [role.screen]);
  });
});

test("nothing still open after a save that did what it said", () => {
  withRoleHolder((db, ids, role) => {
    const removed = db.saveMemberAccess(ids.person, ids.admin, { roleCode: null, jobRole: null, authorityLevel: 20, extraPermissions: [] });
    assert.deepEqual(removed.screensStillOpen, []);
    const back = db.saveMemberAccess(ids.person, ids.admin, { roleCode: role.code, jobRole: null, authorityLevel: 20, extraPermissions: [] });
    assert.deepEqual(back.screensStillOpen, []);
  });
});

test("a screen moved from an extra to the role is not called still open: it was never taken off", () => {
  withRoleHolder((db, ids, role) => {
    db.saveMemberAccess(ids.person, ids.admin, { roleCode: null, jobRole: null, authorityLevel: 20, extraPermissions: [role.screen] });
    const report = db.saveMemberAccess(ids.person, ids.admin, { roleCode: role.code, jobRole: null, authorityLevel: 20, extraPermissions: [] });
    assert.deepEqual(report.screensStillOpen, []);
  });
});

test("changing nothing is recognised, and any one change is not", () => {
  const state = { roleCode: "store", jobRole: "Store", authorityLevel: 20, extraPermissions: ["a", "b"] };
  assert.equal(changesNothing(state, { ...state, extraPermissions: ["b", "a"] }), true);
  assert.equal(changesNothing(state, { ...state, roleCode: null }), false);
  assert.equal(changesNothing(state, { ...state, jobRole: "" }), false);
  assert.equal(changesNothing(state, { ...state, authorityLevel: 21 }), false);
  assert.equal(changesNothing(state, { ...state, extraPermissions: ["a"] }), false);
});
