// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteDatabase } from "@erp/data";
import type { AccountCall, AccountFunctionCaller, AccountFunctionName } from "@erp/sync";
import {
  CLOUD_ADMIN_MESSAGES,
  changeOwnPassword,
  copyRolesUp,
  resetPassword,
  rolesToCopyUp,
  saveRole,
  setAccess,
  signUpsAwaitingApproval,
  withSignUpsAsRequests,
} from "./cloudAdmin";

// ADMIN WORK UNDER CLOUD ACCOUNTS (docs/41 sections 3 and 8): what is sent to the cloud, and what is
// written here from its answer. A real database at the newest migration, and a scripted cloud that
// records every call with its arguments.

const REPO = path.resolve(__dirname, "../../../..");
const SCHEMA = path.join(REPO, "packages/data/src/local-schema.sql");
const MIGRATIONS = path.join(REPO, "migrations/sqlite");
const TOKEN = "p".repeat(64);

class ScriptedCloud implements AccountFunctionCaller {
  readonly calls: Array<{ name: AccountFunctionName; args: Record<string, unknown> }> = [];
  constructor(private readonly answers: Partial<Record<AccountFunctionName, AccountCall>>) {}
  async callAccountFunction(name: AccountFunctionName, args: Record<string, unknown>): Promise<AccountCall> {
    this.calls.push({ name, args });
    return this.answers[name] ?? { kind: "UNREACHABLE", message: "no answer scripted" };
  }
}

const answered = (answer: Record<string, unknown>): AccountCall => ({ kind: "ANSWERED", answer });
const person = (overrides: Record<string, unknown> = {}) => ({
  personId: "p-ali", revision: 1, email: "ali@777.pk", displayName: "Ali", status: "PENDING", isAdmin: false,
  roleCode: null, extraPermissions: [], jobRole: "", authorityLevel: 10, credentialVersion: 1, ...overrides,
});
const role = (overrides: Record<string, unknown> = {}) => ({
  roleCode: "munshi", revision: 1, deleted: false, name: "Munshi", description: null, loginPolicy: "ALWAYS_LOGGED_IN", permissions: ["stock"], ...overrides,
});

let db: SqliteDatabase;
let dir: string;

beforeEach(async () => {
  const data = await import("@erp/data");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-cloud-admin-"));
  db = new data.SqliteDatabase({ dbPath: path.join(dir, "pc.db"), schemaPath: SCHEMA, migrationsDir: MIGRATIONS });
  data.enterCloudAccountsMode(db.db, "test");
  // Ali has signed up and is waiting; the cloud already knows the Munshi role.
  db.db.exec("BEGIN");
  data.applyAccountRoleRevision(db.db, data.readAccountRolePayload(role())!);
  data.applyPersonRevision(db.db, data.readPersonPayload(person())!);
  db.db.exec("COMMIT");
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const deps = (caller: AccountFunctionCaller | null, personToken: string | null = TOKEN) => ({ db, caller, personToken });

describe("approving and changing people", () => {
  it("sends the person's whole decision, with old screen names in their one spelling, and writes the answer here", async () => {
    const cloud = new ScriptedCloud({
      admin_set_access: answered({ ok: true, person: person({ revision: 2, status: "APPROVED", roleCode: "munshi", extraPermissions: ["stock", "logs"] }) }),
    });
    const result = await setAccess(deps(cloud), "p-ali", { status: "APPROVED", roleCode: "munshi", extraPermissions: ["current stock", "logs", "logs"] });
    expect(result).toEqual({ accepted: true });
    expect(cloud.calls[0]?.args).toMatchObject({
      p_token: TOKEN, p_person_id: "p-ali", p_status: "APPROVED", p_is_admin: false, p_role_code: "munshi",
      p_extra_permissions: ["stock", "logs"], p_job_role: "", p_authority_level: 10,
    });
    expect(db.db.prepare("SELECT access_status FROM app_users WHERE id = 'p-ali'").get()).toEqual({ access_status: "APPROVED" });
  });

  it("a change to one field keeps everything else the person has", async () => {
    const cloud = new ScriptedCloud({ admin_set_access: answered({ ok: true, person: person({ revision: 2, jobRole: "Munshi" }) }) });
    await setAccess(deps(cloud), "p-ali", { jobRole: "Munshi" });
    expect(cloud.calls[0]?.args).toMatchObject({ p_status: "PENDING", p_job_role: "Munshi", p_role_code: null, p_extra_permissions: [] });
  });

  it("refuses without a person token, offline, and says why the cloud said no", async () => {
    expect(await setAccess(deps(new ScriptedCloud({}), null), "p-ali", { status: "APPROVED" })).toEqual({ accepted: false, reason: CLOUD_ADMIN_MESSAGES.SIGN_IN_AGAIN });
    expect(await setAccess(deps(null), "p-ali", { status: "APPROVED" })).toEqual({ accepted: false, reason: CLOUD_ADMIN_MESSAGES.OFFLINE });
    const own = new ScriptedCloud({ admin_set_access: answered({ ok: false, reason: "CANNOT_CHANGE_OWN_ACCESS" }) });
    expect(await setAccess(deps(own), "p-ali", { status: "REVOKED" })).toEqual({ accepted: false, reason: CLOUD_ADMIN_MESSAGES.CANNOT_CHANGE_OWN_ACCESS });
    expect(await setAccess(deps(own), "p-nobody", { status: "APPROVED" })).toEqual({ accepted: false, reason: CLOUD_ADMIN_MESSAGES.NOT_HERE });
  });

  it("lists a person waiting for approval as their own access request", () => {
    expect(signUpsAwaitingApproval(db)).toEqual([expect.objectContaining({ id: "p-ali", username: "Ali", status: "PENDING" })]);
    const members = withSignUpsAsRequests([
      { id: "p-ali", accessStatus: "PENDING", accessRequestId: null },
      { id: "p-boss", accessStatus: "APPROVED", accessRequestId: null },
    ]);
    expect(members.map((member) => member.accessRequestId)).toEqual(["p-ali", null]);
  });
});

describe("passwords", () => {
  it("an admin's reset reaches this computer at once: the old check here stops working", async () => {
    db.writeLocalCredential("p-ali", db.hashPassword("alipass12"), 1, new Date().toISOString());
    const cloud = new ScriptedCloud({ admin_reset_password: answered({ ok: true, person: person({ revision: 2, credentialVersion: 2 }) }) });
    expect(await resetPassword(deps(cloud), "p-ali", "fresh9999")).toEqual({ accepted: true });
    expect(db.checkLocalCredential("p-ali", "alipass12")).toBe(false);
  });

  it("changing one's own password remakes this computer's check, so offline sign-in still works here", async () => {
    db.writeLocalCredential("p-ali", db.hashPassword("alipass12"), 1, new Date().toISOString());
    const cloud = new ScriptedCloud({ change_password: answered({ ok: true, person: person({ revision: 2, credentialVersion: 2 }) }) });
    expect(await changeOwnPassword(deps(cloud), "alipass12", "fresh9999")).toEqual({ accepted: true });
    expect(db.checkLocalCredential("p-ali", "fresh9999")).toBe(true);
    const wrong = new ScriptedCloud({ change_password: answered({ ok: false, reason: "WRONG_PASSWORD" }) });
    expect(await changeOwnPassword(deps(wrong), "nope", "fresh9999")).toEqual({ accepted: false, reason: CLOUD_ADMIN_MESSAGES.WRONG_PASSWORD });
  });
});

describe("roles", () => {
  it("a saved role is written here from the cloud's answer", async () => {
    const cloud = new ScriptedCloud({ admin_save_role: answered({ ok: true, role: role({ roleCode: "store", name: "Store", revision: 1, permissions: ["store-scanning"] }) }) });
    expect(await saveRole(deps(cloud), { code: null, name: "Store", description: null, loginPolicy: "ALWAYS_LOGGED_IN", permissions: ["store receiving"] })).toEqual({ accepted: true });
    expect(cloud.calls[0]?.args).toMatchObject({ p_permissions: ["store-scanning"] });
    expect(db.db.prepare("SELECT role_name FROM roles WHERE role_code = 'store'").get()).toEqual({ role_name: "Store" });
  });

  it("offers this computer's roles only while the cloud has none, and stops once they are copied", async () => {
    // The cloud already has Munshi, so there is nothing to offer.
    expect(rolesToCopyUp(db)).toEqual([]);
    db.db.exec("DELETE FROM sync_record_revisions WHERE aggregate_type = 'ACCOUNT_ROLE'");
    const offered = rolesToCopyUp(db);
    expect(offered.map((r) => r.code)).toContain("munshi");

    const cloud = new ScriptedCloud({
      admin_import_roles: answered({ ok: true, imported: offered.length }),
      account_state: answered({ ok: true, roles: [role({ revision: 1 })], people: [], requests: [] }),
    });
    expect(await copyRolesUp(deps(cloud))).toEqual({ accepted: true });
    expect(cloud.calls.map((call) => call.name)).toEqual(["admin_import_roles", "account_state"]);
    expect(rolesToCopyUp(db)).toEqual([]);
  });
});
