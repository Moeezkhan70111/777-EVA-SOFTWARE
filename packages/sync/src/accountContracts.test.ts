import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LOCAL_ROLE_NAME_SUFFIX,
  SqliteDatabase,
  enterCloudAccountsMode,
  readAccountRolePayload,
  readPermissionRequestPayload,
  readPersonPayload,
} from "@erp/data";
import { applyEnvelope } from "./applyEnvelope.js";
import type { SyncEnvelope } from "./contract.js";

// CLOUD ACCOUNTS ARRIVING ON A PC (docs/41 sections 5 and 8; cloud migrations 020 and 021).
//
// The database is the application's own, at the newest migration, with foreign keys on. Envelopes
// are shaped exactly as the cloud's snapshot functions build them, and the first test holds the two
// together: the field names below are read out of 020 and 021, so a renamed field on either side
// fails here rather than as a permanently refused event on a real PC.

const SCHEMA_PATH = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const CLOUD = path.resolve(import.meta.dirname, "../../../migrations/supabase");

function withDatabase(run: (db: SqliteDatabase) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "erp-accounts-sync-"));
  const db = new SqliteDatabase({ dbPath: path.join(root, "pc.db"), schemaPath: SCHEMA_PATH });
  try {
    run(db);
  } finally {
    db.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

let seq = 0;
function envelope(aggregateType: string, aggregateId: string, payload: Record<string, unknown>): SyncEnvelope {
  seq += 1;
  return {
    dedupeKey: `${aggregateType}:${aggregateId}:${String(payload.revision)}`,
    aggregateType, aggregateId, operation: "INSERT", payload,
    originDeviceId: "cloud", createdAt: `2026-11-01T10:00:${String(seq % 60).padStart(2, "0")}.000Z`,
  };
}

const person = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  personId: "p-ali", revision: 1, email: "ali@777.pk", displayName: "Ali", status: "PENDING", isAdmin: false,
  roleCode: null, extraPermissions: [], jobRole: "", authorityLevel: 10, credentialVersion: 1, suggestedAccess: null, ...overrides,
});
const role = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  roleCode: "munshi", revision: 1, deleted: false, name: "Munshi", description: null, loginPolicy: "ALWAYS_LOGGED_IN",
  permissions: ["stock", "gatepass"], ...overrides,
});
const request = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  requestId: "r-1", revision: 1, personId: "p-ali", permissionCode: "logs", reason: "audit", status: "PENDING",
  requestedAt: "2026-11-01T10:00:00.123456+00:00", reviewedAt: null, reviewedBy: null, reviewNotes: null, ...overrides,
});

/**
 * Arrivals on a PC on cloud accounts, the only kind that applies them (accountsHeldForSwitch.test.ts
 * has the other). It switches at the first arrival, so a test can still seed this PC's own people.
 */
const apply = (db: SqliteDatabase, type: string, id: string, payload: Record<string, unknown>) => {
  enterCloudAccountsMode(db.db, "test");
  return applyEnvelope(db.db, envelope(type, id, payload));
};
const row = (db: SqliteDatabase, sql: string, ...params: string[]) => db.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
const permissionsOf = (db: SqliteDatabase, id: string): string[] =>
  (JSON.parse(String(row(db, "SELECT permissions_json FROM app_users WHERE id = ?", id)?.permissions_json)) as string[]).sort();

/** The keys a cloud snapshot function builds, read out of its jsonb_build_object. */
function snapshotKeys(file: string, fn: string): string[] {
  const sql = fs.readFileSync(path.join(CLOUD, file), "utf8");
  const body = sql.slice(sql.indexOf(`function public.${fn}(`));
  const built = body.slice(body.indexOf("jsonb_build_object("), body.indexOf("$$;"));
  return [...built.matchAll(/'([A-Za-z]+)',/g)].map((match) => match[1] ?? "").sort();
}

test("the cloud's snapshots and this PC's readers name the same fields, and every one is required or checked", () => {
  const cases = [
    { keys: snapshotKeys("023_suggested_access.up.sql", "person_snapshot"), sample: person(), read: readPersonPayload },
    { keys: snapshotKeys("020_cloud_accounts.up.sql", "account_role_snapshot"), sample: role(), read: readAccountRolePayload },
    { keys: snapshotKeys("021_permission_requests.up.sql", "permission_request_snapshot"), sample: request(), read: readPermissionRequestPayload },
  ];
  for (const { keys, sample, read } of cases) {
    assert.deepEqual(keys, Object.keys(sample).sort(), "the cloud builds exactly the fields this PC reads");
    assert.ok(read(sample), "a well-formed snapshot is read");
    for (const key of keys) {
      const broken = { ...sample, [key]: 12.5 };
      assert.equal(read(broken), null, `a snapshot whose ${key} is nonsense is refused, not defaulted`);
    }
  }
});

test("a person arrives, waits for their role, and gets the role's screens plus their own", () => {
  withDatabase((db) => {
    const waiting = apply(db, "PERSON", "p-ali", person({ status: "APPROVED", roleCode: "munshi", extraPermissions: ["logs"] }));
    assert.equal(waiting.status, "REJECTED");
    assert.equal(waiting.permanent, false, "a missing role is a wait, never a refusal");
    assert.match(String(waiting.reason), /WAITING_FOR:ACCOUNT_ROLE:munshi/);

    assert.equal(apply(db, "ACCOUNT_ROLE", "munshi", role()).status, "APPLIED");
    assert.equal(apply(db, "PERSON", "p-ali", person({ status: "APPROVED", roleCode: "munshi", extraPermissions: ["logs"] })).status, "APPLIED");

    const ali = row(db, "SELECT username, email, role, access_status FROM app_users WHERE id = 'p-ali'");
    assert.deepEqual({ ...ali }, { username: "Ali", email: "ali@777.pk", role: "USER", access_status: "APPROVED" });
    assert.deepEqual(permissionsOf(db, "p-ali"), ["gatepass", "logs", "stock"]);
    assert.equal(apply(db, "PERSON", "p-ali", person({ status: "PENDING" })).status, "DUPLICATE", "an older revision never overtakes");
  });
});

test("a role's new screens reach everyone who holds it, at once", () => {
  withDatabase((db) => {
    apply(db, "ACCOUNT_ROLE", "munshi", role());
    apply(db, "PERSON", "p-ali", person({ status: "APPROVED", roleCode: "munshi" }));
    apply(db, "ACCOUNT_ROLE", "munshi", role({ revision: 2, permissions: ["stock"] }));
    assert.deepEqual(permissionsOf(db, "p-ali"), ["stock"]);
  });
});

test("a role is deleted only after its last holder has moved off it", () => {
  withDatabase((db) => {
    apply(db, "ACCOUNT_ROLE", "munshi", role());
    apply(db, "PERSON", "p-ali", person({ status: "APPROVED", roleCode: "munshi" }));
    const early = apply(db, "ACCOUNT_ROLE", "munshi", role({ revision: 2, deleted: true }));
    assert.equal(early.permanent, false);
    apply(db, "PERSON", "p-ali", person({ revision: 2, status: "APPROVED", roleCode: null }));
    assert.equal(apply(db, "ACCOUNT_ROLE", "munshi", role({ revision: 2, deleted: true })).status, "APPLIED");
    assert.equal(row(db, "SELECT 1 AS here FROM roles WHERE role_code = 'munshi'"), undefined);
  });
});

// ─── Role names: this PC's own roles against the cloud's ──────────────────────
//
// Every PC is born with the built-in roles (sqliteDatabase ensureDefaultRoles), and a PC that switched
// without copying its roles up keeps them, though the cloud never sent them. The cloud keeps role
// names unique among ITS roles only, so one of its roles can carry a built-in's name under another
// code. That must not wait for ever, and must not turn the built-in into the cloud's role.

const BUILT_IN = "billing-manager";
const screensOf = (db: SqliteDatabase, roleCode: string): string[] =>
  (db.db.prepare("SELECT permission_code FROM role_permissions WHERE role_code = ?").all(roleCode) as Array<{ permission_code: string }>)
    .map((r) => r.permission_code)
    .sort();

/** A person of this PC holding the built-in, and what the built-in is before anything arrives. */
function holdBuiltIn(db: SqliteDatabase): { holderId: string; screens: string[] } {
  const holder = db.createUserAccount("Bilal", "Password123");
  db.assignUserRole(holder.id, BUILT_IN);
  return { holderId: holder.id, screens: screensOf(db, BUILT_IN) };
}

/** The built-in kept its code, its screens, its holder and its system flag; only its name moved. */
function assertBuiltInKept(db: SqliteDatabase, before: { holderId: string; screens: string[] }, name: string): void {
  assert.deepEqual({ ...row(db, "SELECT role_name, is_system_role FROM roles WHERE role_code = ?", BUILT_IN) }, { role_name: name, is_system_role: 1 });
  assert.deepEqual(screensOf(db, BUILT_IN), before.screens, "its screens are its own, not the cloud role's");
  assert.equal(row(db, "SELECT role_code FROM user_role_assignments WHERE user_id = ?", before.holderId)?.role_code, BUILT_IN);
}

test("a cloud role named like a built-in role on this PC is written, and the built-in steps aside", () => {
  withDatabase((db) => {
    const before = holdBuiltIn(db);
    const desk = role({ roleCode: "billing-desk", name: "Billing Manager", permissions: ["stock"] });

    const outcome = apply(db, "ACCOUNT_ROLE", "billing-desk", desk);
    assert.equal(outcome.status, "APPLIED", String(outcome.reason));

    assert.equal(row(db, "SELECT role_name FROM roles WHERE role_code = 'billing-desk'")?.role_name, "Billing Manager");
    assert.deepEqual(screensOf(db, "billing-desk"), ["stock"]);
    assertBuiltInKept(db, before, `Billing Manager ${LOCAL_ROLE_NAME_SUFFIX}`);
  });
});

test("a cloud role renamed onto a built-in role's name is written, and the built-in steps aside", () => {
  withDatabase((db) => {
    const before = holdBuiltIn(db);
    assert.equal(apply(db, "ACCOUNT_ROLE", "billing-desk", role({ roleCode: "billing-desk", name: "Billing Desk" })).status, "APPLIED");

    const renamed = apply(db, "ACCOUNT_ROLE", "billing-desk", role({ roleCode: "billing-desk", revision: 2, name: "Billing Manager" }));
    assert.equal(renamed.status, "APPLIED", String(renamed.reason));

    assert.equal(row(db, "SELECT role_name FROM roles WHERE role_code = 'billing-desk'")?.role_name, "Billing Manager");
    assertBuiltInKept(db, before, `Billing Manager ${LOCAL_ROLE_NAME_SUFFIX}`);
  });
});

test("the name a built-in steps aside to is never one already taken here", () => {
  withDatabase((db) => {
    const before = holdBuiltIn(db);
    db.createRole({ name: `Billing Manager ${LOCAL_ROLE_NAME_SUFFIX}`, permissions: ["logs"] });

    assert.equal(apply(db, "ACCOUNT_ROLE", "billing-desk", role({ roleCode: "billing-desk", name: "Billing Manager" })).status, "APPLIED");
    assertBuiltInKept(db, before, `Billing Manager ${LOCAL_ROLE_NAME_SUFFIX} 2`);
    assert.deepEqual(screensOf(db, "billing-manager-this-pc"), ["logs"], "the role already called that is untouched");
  });
});

test("stepping aside happens once: the suffix is never added twice", () => {
  withDatabase((db) => {
    const before = holdBuiltIn(db);
    const stepped = `Billing Manager ${LOCAL_ROLE_NAME_SUFFIX}`;
    const desk = role({ roleCode: "billing-desk", name: "Billing Manager" });
    apply(db, "ACCOUNT_ROLE", "billing-desk", desk);

    // The same revision again: a duplicate, so nothing is renamed a second time.
    assert.equal(apply(db, "ACCOUNT_ROLE", "billing-desk", desk).status, "DUPLICATE");
    assertBuiltInKept(db, before, stepped);

    // The cloud role leaves the name and takes it back: the built-in is not in its way either time.
    apply(db, "ACCOUNT_ROLE", "billing-desk", role({ roleCode: "billing-desk", revision: 2, name: "Billing Desk" }));
    apply(db, "ACCOUNT_ROLE", "billing-desk", role({ roleCode: "billing-desk", revision: 3, name: "Billing Manager" }));
    assertBuiltInKept(db, before, stepped);

    // A cloud role takes the suffixed name itself: the built-in is numbered, not suffixed again.
    const taker = apply(db, "ACCOUNT_ROLE", "billing-copy", role({ roleCode: "billing-copy", name: stepped }));
    assert.equal(taker.status, "APPLIED", String(taker.reason));
    assertBuiltInKept(db, before, `${stepped} 2`);
  });
});

test("a name another CLOUD role still holds is a wait, and clears when that role's rename arrives", () => {
  withDatabase((db) => {
    apply(db, "ACCOUNT_ROLE", "munshi", role());
    const clerk = role({ roleCode: "gate-clerk", name: "Munshi" });

    const early = apply(db, "ACCOUNT_ROLE", "gate-clerk", clerk);
    assert.equal(early.status, "REJECTED");
    assert.equal(early.permanent, false, "the cloud's own roles never share a name, so its rename is on its way");
    assert.match(String(early.reason), /WAITING_FOR:ROLE_NAME:Munshi/);

    apply(db, "ACCOUNT_ROLE", "munshi", role({ revision: 2, name: "Gate Munshi" }));
    assert.equal(apply(db, "ACCOUNT_ROLE", "gate-clerk", clerk).status, "APPLIED");
    assert.equal(row(db, "SELECT role_name FROM roles WHERE role_code = 'munshi'")?.role_name, "Gate Munshi", "a cloud role never steps aside");
  });
});

test("a revision this PC has already moved past is a duplicate, never a wait", () => {
  withDatabase((db) => {
    // The name it carries now belongs to another role...
    apply(db, "ACCOUNT_ROLE", "munshi", role());
    apply(db, "ACCOUNT_ROLE", "munshi", role({ revision: 2, name: "Gate Munshi" }));
    apply(db, "ACCOUNT_ROLE", "gate-clerk", role({ roleCode: "gate-clerk", name: "Munshi" }));
    assert.equal(apply(db, "ACCOUNT_ROLE", "munshi", role()).status, "DUPLICATE");

    // ...or the role it names is gone.
    apply(db, "PERSON", "p-ali", person({ status: "APPROVED", roleCode: "munshi" }));
    apply(db, "PERSON", "p-ali", person({ revision: 2, status: "APPROVED", roleCode: null }));
    apply(db, "ACCOUNT_ROLE", "munshi", role({ revision: 3, deleted: true }));
    assert.equal(apply(db, "PERSON", "p-ali", person({ status: "APPROVED", roleCode: "munshi" })).status, "DUPLICATE");
  });
});

test("revoking ends the person's sessions here and wipes this PC's check of their password", () => {
  withDatabase((db) => {
    apply(db, "PERSON", "p-ali", person({ status: "APPROVED" }));
    db.writeLocalCredential("p-ali", db.hashPassword("alipass12"), 1, "2026-11-01T09:00:00.000Z");
    const token = db.createUserSession("p-ali");
    apply(db, "PERSON", "p-ali", person({ revision: 2, status: "REVOKED", credentialVersion: 2 }));
    assert.equal(row(db, "SELECT 1 AS here FROM user_credentials WHERE user_id = 'p-ali'"), undefined);
    assert.notEqual(row(db, "SELECT revoked_at FROM user_sessions WHERE token = ?", token)?.revoked_at, null);
    assert.equal(row(db, "SELECT access_status FROM app_users WHERE id = 'p-ali'")?.access_status, "REVOKED");
  });
});

test("a password check survives a revision at its own credential version, and dies at any other", () => {
  withDatabase((db) => {
    apply(db, "PERSON", "p-ali", person({ status: "APPROVED" }));
    db.writeLocalCredential("p-ali", db.hashPassword("alipass12"), 1, "2026-11-01T09:00:00.000Z");
    apply(db, "PERSON", "p-ali", person({ revision: 2, status: "APPROVED", jobRole: "Munshi" }));
    assert.ok(db.checkLocalCredential("p-ali", "alipass12"), "a job-role change leaves the password alone");
    apply(db, "PERSON", "p-ali", person({ revision: 3, status: "APPROVED", jobRole: "Munshi", credentialVersion: 2 }));
    assert.equal(db.checkLocalCredential("p-ali", "alipass12"), false, "a changed password elsewhere makes this check stale");
  });
});

test("what an account had before it moved up is kept while it waits, as a suggestion, and gone once decided (023)", () => {
  withDatabase((db) => {
    const had = { roleCode: "munshi", extraPermissions: ["logs"], jobRole: "Munshi", authorityLevel: 20 };
    apply(db, "PERSON", "p-ali", person({ suggestedAccess: had }));
    const waiting = db.listMembers().find((member) => member.id === "p-ali");
    assert.deepEqual(waiting?.suggestedAccess, had);
    assert.deepEqual(waiting?.additionalPermissions, [], "a suggestion is never access");

    apply(db, "PERSON", "p-ali", person({ revision: 2, status: "APPROVED", suggestedAccess: null }));
    assert.equal(db.listMembers().find((member) => member.id === "p-ali")?.suggestedAccess, null);
  });
});

test("a snapshot from before 023 has no suggestion, and is read as having none", () => {
  const before023 = person();
  delete before023.suggestedAccess;
  assert.equal(readPersonPayload(before023)?.suggestedAccess, null);
});

test("a job-role change tells the person, as the local screen does", () => {
  withDatabase((db) => {
    apply(db, "PERSON", "p-ali", person({ status: "APPROVED" }));
    apply(db, "PERSON", "p-ali", person({ revision: 2, status: "APPROVED", jobRole: "Munshi" }));
    assert.equal(row(db, "SELECT role_notification FROM app_users WHERE id = 'p-ali'")?.role_notification, "You are now Munshi");
    assert.equal(row(db, "SELECT title FROM user_notifications WHERE user_id = 'p-ali'")?.title, "Role updated");
  });
});

test("a request notifies this PC's admins, and its decision notifies the person, once", () => {
  withDatabase((db) => {
    apply(db, "PERSON", "p-boss", person({ personId: "p-boss", email: "boss@777.pk", displayName: "Boss", status: "APPROVED", isAdmin: true }));
    apply(db, "PERSON", "p-ali", person({ status: "APPROVED" }));
    const waiting = apply(db, "PERMISSION_REQUEST", "r-1", request({ personId: "p-nobody" }));
    assert.match(String(waiting.reason), /WAITING_FOR:PERSON:p-nobody/);

    assert.equal(apply(db, "PERMISSION_REQUEST", "r-1", request()).status, "APPLIED");
    assert.equal(row(db, "SELECT message FROM user_notifications WHERE user_id = 'p-boss'")?.message, 'Ali requested permission "logs"');
    assert.equal(row(db, "SELECT requested_at FROM permission_requests WHERE id = 'r-1'")?.requested_at, "2026-11-01T10:00:00.123Z");

    const decided = request({ revision: 2, status: "APPROVED", reviewedBy: "p-boss", reviewedAt: "2026-11-01T11:00:00+00:00", reviewNotes: "ok" });
    assert.equal(apply(db, "PERMISSION_REQUEST", "r-1", decided).status, "APPLIED");
    assert.equal(apply(db, "PERMISSION_REQUEST", "r-1", decided).status, "DUPLICATE");
    const notices = db.db.prepare("SELECT title FROM user_notifications WHERE user_id = 'p-ali'").all() as Array<{ title: string }>;
    assert.deepEqual(notices.map((n) => n.title), ["Permission granted"]);
  });
});

test("a decided request that says nobody decided it is refused, not repaired", () => {
  assert.equal(readPermissionRequestPayload(request({ status: "APPROVED" })), null);
  assert.equal(readPermissionRequestPayload(request({ reviewedBy: "p-boss" })), null);
  assert.equal(readPersonPayload(person({ extraPermissions: ["Stock Page"] })), null, "a screen code is a code");
  assert.equal(readPersonPayload(person({ status: "GONE" })), null);
});
