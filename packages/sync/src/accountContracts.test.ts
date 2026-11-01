import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase, readAccountRolePayload, readPermissionRequestPayload, readPersonPayload } from "@erp/data";
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
  roleCode: null, extraPermissions: [], jobRole: "", authorityLevel: 10, credentialVersion: 1, ...overrides,
});
const role = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  roleCode: "munshi", revision: 1, deleted: false, name: "Munshi", description: null, loginPolicy: "ALWAYS_LOGGED_IN",
  permissions: ["stock", "gatepass"], ...overrides,
});
const request = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  requestId: "r-1", revision: 1, personId: "p-ali", permissionCode: "logs", reason: "audit", status: "PENDING",
  requestedAt: "2026-11-01T10:00:00.123456+00:00", reviewedAt: null, reviewedBy: null, reviewNotes: null, ...overrides,
});

const apply = (db: SqliteDatabase, type: string, id: string, payload: Record<string, unknown>) =>
  applyEnvelope(db.db, envelope(type, id, payload));
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
    { keys: snapshotKeys("020_cloud_accounts.up.sql", "person_snapshot"), sample: person(), read: readPersonPayload },
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
