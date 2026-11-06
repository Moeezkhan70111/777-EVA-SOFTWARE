import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SqliteDatabase,
  applyAccountRoleRevision,
  applyPersonRevision,
  enterCloudAccountsMode,
  readAccountRolePayload,
  readAccountsMode,
  readPersonPayload,
  releaseEventsHeldForSwitch,
} from "@erp/data";
import type { SyncEnvelope } from "./contract.js";
import { parkedSummary } from "./parking.js";
import { SyncPull } from "./pull.js";
import { readPullCursor } from "./pullCursor.js";
import type { SyncChange, SyncPullTransport } from "./transport.js";
import { waitingSummary } from "./waiting.js";

// ACCOUNT REVISIONS AND THE TWO KINDS OF PC (docs/41 sections 5 and 7).
//
// The real pull, on the application's own database. Found by the 4 Nov rehearsal: a PC on local
// accounts applied the cloud's roles on an ordinary pull, and a person lost a screen before anyone
// pressed the switch. And a role the cloud deleted, still held by someone only one PC knows, could
// never be deleted from that PC.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const MIGRATIONS = path.resolve(import.meta.dirname, "../../../migrations/sqlite");
const NOW = Date.parse("2026-11-04T09:00:00.000Z");

/** The cloud's log, as a pull reads it. */
class Log implements SyncPullTransport {
  private readonly changes: SyncChange[] = [];

  add(envelope: SyncEnvelope): void {
    this.changes.push({ seq: this.changes.length + 1, envelope });
  }

  async fetchChanges(afterSeq: number, limit: number): Promise<SyncChange[]> {
    return this.changes.filter((change) => change.seq > afterSeq).slice(0, limit);
  }

  get size(): number {
    return this.changes.length;
  }
}

function withPcs(names: readonly string[], run: (pcs: SqliteDatabase[]) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "erp-accounts-held-"));
  const pcs = names.map((name) => new SqliteDatabase({ dbPath: path.join(root, `${name}.db`), schemaPath: SCHEMA, migrationsDir: MIGRATIONS }));
  return run(pcs).finally(() => {
    for (const pc of pcs) pc.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
}
const withPc = (run: (pc: SqliteDatabase) => Promise<void>) => withPcs(["pc"], ([pc]) => run(pc as SqliteDatabase));

const envelope = (aggregateType: string, aggregateId: string, payload: Record<string, unknown>): SyncEnvelope => ({
  dedupeKey: `${aggregateType}:${aggregateId}:${String(payload.revision ?? "1")}`,
  aggregateType, aggregateId, operation: "INSERT", payload,
  originDeviceId: "cloud", createdAt: "2026-11-04T08:00:00.000Z",
});
const person = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  personId: "p-ali", revision: 1, email: "ali@777.pk", displayName: "Ali", status: "APPROVED", isAdmin: false,
  roleCode: null, extraPermissions: [], jobRole: "", authorityLevel: 10, credentialVersion: 1, suggestedAccess: null, ...overrides,
});
const role = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  roleCode: "billing-manager", revision: 1, deleted: false, name: "Billing Manager", description: null, loginPolicy: "ALWAYS_LOGGED_IN",
  permissions: ["customer-ledger"], ...overrides,
});
const roleEvent = (overrides: Record<string, unknown> = {}) => {
  const payload = role(overrides);
  return envelope("ACCOUNT_ROLE", String(payload.roleCode), payload);
};
const personEvent = (overrides: Record<string, unknown> = {}) => {
  const payload = person(overrides);
  return envelope("PERSON", String(payload.personId), payload);
};
const variantEvent = (variantId: string) =>
  envelope("PRODUCT_VARIANT", variantId, { variantId, article: "SK9", color: "BLACK", size: variantId, description: null, createdAt: "2026-11-04T08:00:00.000Z" });

const pullOn = (pc: SqliteDatabase, log: Log, nowMs = NOW) => new SyncPull(pc.db, log, { now: () => nowMs }).runOnce();
const rows = (pc: SqliteDatabase, sql: string, ...params: string[]) =>
  pc.db.prepare(sql).all(...params).map((row) => ({ ...(row as Record<string, unknown>) }));
const screensOf = (pc: SqliteDatabase, roleCode: string): string[] =>
  rows(pc, "SELECT permission_code AS p FROM role_permissions WHERE role_code = ? ORDER BY 1", roleCode).map((row) => String(row.p));
const permissionsOf = (pc: SqliteDatabase, userId: string): string[] =>
  (JSON.parse(String(rows(pc, "SELECT permissions_json AS p FROM app_users WHERE id = ?", userId)[0]?.p)) as string[]).sort();
const accountRevisions = (pc: SqliteDatabase) =>
  rows(pc, "SELECT 1 FROM sync_record_revisions WHERE aggregate_type IN ('PERSON', 'ACCOUNT_ROLE', 'PERMISSION_REQUEST')").length;
const clearedAudit = (pc: SqliteDatabase) => rows(pc, "SELECT entity_id, payload_json FROM audit_log WHERE event_type = 'ROLE_ASSIGNMENT_CLEARED'");

/** This PC's own people: an admin, and someone holding a role with a screen added here. */
function seedLocalPeople(pc: SqliteDatabase, name = "Biller"): { adminId: string; billerId: string; screens: string[] } {
  const admin = pc.bootstrapFirstAdmin("Owner", "owner1234");
  const biller = pc.createUserAccount(name, "biller1234");
  pc.db.prepare("UPDATE app_users SET access_status = 'APPROVED' WHERE id = ?").run(biller.id);
  pc.updateRolePermissions("billing-manager", [...screensOf(pc, "billing-manager"), "logs"]);
  pc.assignUserRole(biller.id, "billing-manager", admin.id);
  return { adminId: admin.id, billerId: biller.id, screens: screensOf(pc, "billing-manager") };
}

/** What the switch does, for a PC here: the account state through the same writes, then the mode. */
function switchWithState(pc: SqliteDatabase, roles: Array<Record<string, unknown>>, people: Array<Record<string, unknown>> = []): void {
  for (const payload of roles) {
    const read = readAccountRolePayload(payload);
    assert.ok(read);
    applyAccountRoleRevision(pc.db, read);
  }
  for (const payload of people) {
    const read = readPersonPayload(payload);
    assert.ok(read);
    applyPersonRevision(pc.db, read);
  }
  enterCloudAccountsMode(pc.db, "test");
  releaseEventsHeldForSwitch(pc.db);
}

// ─── A PC on local accounts ─────────────────────────────────────────────────

test("on local accounts a pull leaves the PC's roles, screens, people and assignments alone", async () => {
  await withPc(async (pc) => {
    const local = seedLocalPeople(pc);
    const usersBefore = rows(pc, "SELECT id, username, role, access_status FROM app_users ORDER BY id");
    const assignmentsBefore = rows(pc, "SELECT user_id, role_code FROM user_role_assignments ORDER BY user_id");
    const permissionsBefore = permissionsOf(pc, local.billerId);
    const log = new Log();
    log.add(roleEvent({ name: "Billing Desk" }));
    log.add(personEvent({ roleCode: "billing-manager" }));

    await pullOn(pc, log);

    assert.equal(readAccountsMode(pc.db), "LOCAL");
    assert.deepEqual(screensOf(pc, "billing-manager"), local.screens, "the screen added here stays");
    assert.equal(rows(pc, "SELECT role_name FROM roles WHERE role_code = 'billing-manager'")[0]?.role_name, "Billing Manager");
    assert.deepEqual(permissionsOf(pc, local.billerId), permissionsBefore);
    assert.deepEqual(rows(pc, "SELECT id, username, role, access_status FROM app_users ORDER BY id"), usersBefore, "no cloud person appears");
    assert.deepEqual(rows(pc, "SELECT user_id, role_code FROM user_role_assignments ORDER BY user_id"), assignmentsBefore);
    assert.equal(accountRevisions(pc), 0, "and nothing says this PC holds a revision it did not write");
  });
});

test("on local accounts other replicated data keeps arriving, and the cursor passes the held events", async () => {
  await withPc(async (pc) => {
    const log = new Log();
    log.add(variantEvent("v-1"));
    log.add(roleEvent());
    log.add(variantEvent("v-2"));

    const pulled = await pullOn(pc, log);

    assert.equal(pulled.applied, 2);
    assert.equal(rows(pc, "SELECT 1 FROM product_variants WHERE id IN ('v-1', 'v-2')").length, 2);
    assert.equal(readPullCursor(pc.db), log.size, "nothing behind a held event waits for it");
    assert.deepEqual(pulled.refused, []);
  });
});

test("a held revision is kept, once, and is no fault: nothing warns, however long the PC stays local", async () => {
  await withPc(async (pc) => {
    const log = new Log();
    log.add(roleEvent());
    log.add(personEvent());
    await pullOn(pc, log);
    const aMonthOn = NOW + 30 * 24 * 60 * 60 * 1000;
    await pullOn(pc, log, aMonthOn);

    const held = parkedSummary(pc.db);
    assert.equal(held.heldForSwitch, 2, "both still here, one row each, after being tried again");
    assert.equal(held.count, 0);
    assert.equal(held.oldest, null);
    assert.equal(waitingSummary(pc.db, aMonthOn).entries.length, 0, "no stuck or stale notice for a PC working as it should");
  });
});

// ─── The switch, afterwards ─────────────────────────────────────────────────

test("after the switch every held event settles, and the state's latest revisions stand", async () => {
  await withPc(async (pc) => {
    const local = seedLocalPeople(pc);
    const log = new Log();
    log.add(roleEvent({ permissions: ["stock"] }));
    log.add(roleEvent({ revision: 2, name: "Billing Desk", permissions: ["stock", "gatepass"] }));
    log.add(personEvent({ roleCode: "billing-manager" }));
    await pullOn(pc, log);
    assert.equal(parkedSummary(pc.db).heldForSwitch, 3);

    switchWithState(pc, [role({ revision: 2, name: "Billing Desk", permissions: ["stock", "gatepass"] })], [person({ roleCode: "billing-manager" })]);
    const settled = await pullOn(pc, log);

    assert.equal(parkedSummary(pc.db).heldForSwitch, 0, "none left behind");
    assert.equal(settled.duplicates, 3, "each one found superseded by the state, none lost");
    assert.equal(settled.applied, 0);
    assert.deepEqual(settled.refused, []);
    assert.deepEqual(screensOf(pc, "billing-manager"), ["gatepass", "stock"], "the cloud's latest");
    assert.deepEqual(permissionsOf(pc, "p-ali"), ["gatepass", "stock"]);
    assert.equal(rows(pc, "SELECT role_code FROM user_role_assignments WHERE user_id = ?", local.billerId)[0]?.role_code, "billing-manager");
  });
});

test("a revision logged after the switch read the state, but pulled before it committed, is not lost", async () => {
  await withPc(async (pc) => {
    const log = new Log();
    // The state below was read at revision 1; revision 2 reached the log, and this PC, just after.
    log.add(roleEvent({ revision: 2, permissions: ["stock"] }));
    await pullOn(pc, log);
    assert.equal(readPullCursor(pc.db), log.size, "the cursor is already past it: only the held event can bring it");

    switchWithState(pc, [role()]);
    assert.deepEqual(screensOf(pc, "billing-manager"), ["customer-ledger"], "the older state, for now");
    const settled = await pullOn(pc, log);

    assert.equal(settled.applied, 1, "released at the switch, so the very next pull applies it, with no backoff to wait out");
    assert.deepEqual(screensOf(pc, "billing-manager"), ["stock"]);
    assert.equal(parkedSummary(pc.db).heldForSwitch, 0);
  });
});

// ─── A role the cloud deleted ───────────────────────────────────────────────
//
// The cloud refuses to delete a role any cloud person has (020 admin_delete_role), so its deletion
// says nobody it knows holds it. Anyone still holding it here is this PC's own, and the deletion's
// revision, the event every PC already receives, is what clears them.

const switchedWithHolder = (pc: SqliteDatabase, name = "Biller") => {
  const local = seedLocalPeople(pc, name);
  pc.setUserAdditionalPermissions(local.billerId, ["dashboard"]);
  switchWithState(pc, [role()]);
  return local;
};

test("a switched PC clears its own person's assignment when the cloud deletes the role, and keeps their other access", async () => {
  await withPc(async (pc) => {
    const { adminId, billerId } = switchedWithHolder(pc);
    const log = new Log();
    log.add(roleEvent({ roleCode: "munshi", name: "Munshi" }));
    log.add(personEvent({ roleCode: "munshi" }));
    log.add(roleEvent({ revision: 2, deleted: true }));

    const pulled = await pullOn(pc, log);

    assert.equal(pulled.parked, 0, "nothing waits");
    assert.equal(rows(pc, "SELECT 1 FROM roles WHERE role_code = 'billing-manager'").length, 0);
    assert.equal(rows(pc, "SELECT 1 FROM user_role_assignments WHERE user_id = ?", billerId).length, 0);
    assert.deepEqual(permissionsOf(pc, billerId), ["dashboard"], "their extra screen is not the role's to take");
    assert.equal(rows(pc, "SELECT role_code FROM user_role_assignments WHERE user_id = 'p-ali'")[0]?.role_code, "munshi", "another role's holder is untouched");
    assert.deepEqual(screensOf(pc, "munshi"), ["customer-ledger"]);

    const audit = clearedAudit(pc);
    assert.equal(audit.length, 1, "the clearing is on the record");
    assert.equal(audit[0]?.entity_id, billerId);
    assert.deepEqual(JSON.parse(String(audit[0]?.payload_json)), { roleCode: "billing-manager", roleName: "Billing Manager", revision: 2, username: "Biller" });
    const notice = rows(pc, "SELECT message FROM user_notifications WHERE user_id = ? AND title = 'Role removed'", adminId);
    assert.match(String(notice[0]?.message), /Biller held "Billing Manager", which the cloud has removed/);
  });
});

test("the same deletion offered again changes nothing: one clearing, one notice, no retry", async () => {
  await withPc(async (pc) => {
    const { adminId } = switchedWithHolder(pc);
    const log = new Log();
    log.add(roleEvent({ revision: 2, deleted: true }));
    await pullOn(pc, log);

    log.add(roleEvent({ revision: 2, deleted: true }));
    const again = await pullOn(pc, log);

    assert.equal(again.duplicates, 1);
    assert.equal(again.parked, 0);
    assert.equal(clearedAudit(pc).length, 1);
    assert.equal(rows(pc, "SELECT 1 FROM user_notifications WHERE user_id = ? AND title = 'Role removed'", adminId).length, 1);
  });
});

test("two PCs given the same deletion each clear their own person and end the same", async () => {
  await withPcs(["pc1", "pc2"], async (pcs) => {
    const [pc1, pc2] = pcs as [SqliteDatabase, SqliteDatabase];
    const first = switchedWithHolder(pc1, "Biller One");
    const second = switchedWithHolder(pc2, "Biller Two");
    const log = new Log();
    log.add(roleEvent({ revision: 2, deleted: true }));

    await pullOn(pc1, log);
    await pullOn(pc2, log);

    for (const [pc, holder] of [[pc1, first], [pc2, second]] as const) {
      assert.equal(rows(pc, "SELECT 1 FROM roles WHERE role_code = 'billing-manager'").length, 0);
      assert.equal(rows(pc, "SELECT 1 FROM user_role_assignments WHERE user_id = ?", holder.billerId).length, 0);
      assert.deepEqual(clearedAudit(pc).map((row) => row.entity_id), [holder.billerId], "each PC's record names its own person");
      assert.equal(parkedSummary(pc.db).count, 0);
    }
  });
});

test("a cloud person still holding the role is a wait, ended by their own revision in the same pull", async () => {
  await withPc(async (pc) => {
    switchWithState(pc, [role()], [person({ roleCode: "billing-manager" })]);
    const log = new Log();
    // Out of order, as a parked person revision would leave it: the deletion first.
    log.add(roleEvent({ revision: 2, deleted: true }));
    const early = await pullOn(pc, log);
    assert.equal(early.parked, 1, "a person the cloud knows is never cleared here: their revision says where they went");
    assert.equal(rows(pc, "SELECT role_code FROM user_role_assignments WHERE user_id = 'p-ali'")[0]?.role_code, "billing-manager");

    log.add(personEvent({ revision: 2, roleCode: null }));
    const finished = await pullOn(pc, log);

    assert.equal(finished.parked, 0, "the person arriving frees it at once, with no backoff to wait out");
    assert.equal(rows(pc, "SELECT 1 FROM roles WHERE role_code = 'billing-manager'").length, 0);
    assert.equal(clearedAudit(pc).length, 0, "and nothing here was cleared: the cloud moved them");
  });
});

test("a cloud person moved off a role loses its screens here, and keeps only what the cloud says", async () => {
  await withPc(async (pc) => {
    switchWithState(pc, [role()], [person({ roleCode: "billing-manager" })]);
    assert.deepEqual(permissionsOf(pc, "p-ali"), ["customer-ledger"]);
    const log = new Log();
    log.add(personEvent({ revision: 2, roleCode: null, extraPermissions: ["dashboard"] }));

    await pullOn(pc, log);

    assert.deepEqual(permissionsOf(pc, "p-ali"), ["dashboard"], "a role taken away is taken away, on every PC");
  });
});

test("a deleted role brought back does not bring back the assignment it cleared", async () => {
  await withPc(async (pc) => {
    const { billerId } = switchedWithHolder(pc);
    const log = new Log();
    log.add(roleEvent({ revision: 2, deleted: true }));
    log.add(roleEvent({ revision: 3 }));

    const pulled = await pullOn(pc, log);

    assert.equal(pulled.applied, 2);
    assert.deepEqual(screensOf(pc, "billing-manager"), ["customer-ledger"]);
    assert.equal(rows(pc, "SELECT 1 FROM user_role_assignments WHERE user_id = ?", billerId).length, 0);
  });
});
