// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteDatabase, StructuredLogger } from "@erp/data";
import type { AccountCall, AccountFunctionCaller, AccountFunctionName } from "@erp/sync";
import {
  ACCOUNT_MESSAGES,
  CLOUD_ACCOUNTS_SWITCH_READY,
  cloudClaim,
  cloudSignIn,
  cloudSignUp,
  personTokenFor,
  switchThisComputerToCloud,
} from "./cloudAccounts";

// THE SIGN-IN RULES UNDER CLOUD ACCOUNTS (docs/41 section 4), and the switch to them (section 7).
//
// A real database, at the newest migration. The cloud is a script: each function answers what the
// test says, and every call is recorded, so "the cache was never tried after a refusal" and "a
// project without accounts is asked once" are things the test can see.

const REPO = path.resolve(__dirname, "../../../..");
const SCHEMA = path.join(REPO, "packages/data/src/local-schema.sql");
const MIGRATIONS = path.join(REPO, "migrations/sqlite");
const TOKEN = "t".repeat(64);


class ScriptedCloud implements AccountFunctionCaller {
  readonly calls: AccountFunctionName[] = [];
  constructor(private readonly answers: Partial<Record<AccountFunctionName, AccountCall>>) {}
  async callAccountFunction(name: AccountFunctionName): Promise<AccountCall> {
    this.calls.push(name);
    return this.answers[name] ?? { kind: "UNREACHABLE", message: "no answer scripted" };
  }
}

const answered = (answer: Record<string, unknown>): AccountCall => ({ kind: "ANSWERED", answer });
const declined = (reason: string, extra: Record<string, unknown> = {}): AccountCall => answered({ ok: false, reason, ...extra });
const UNREACHABLE: AccountCall = { kind: "UNREACHABLE", message: "offline" };

const person = (overrides: Record<string, unknown> = {}) => ({
  personId: "p-ali", revision: 1, email: "ali@777.pk", displayName: "Ali", status: "APPROVED", isAdmin: false,
  roleCode: null, extraPermissions: [], jobRole: "", authorityLevel: 10, credentialVersion: 1, ...overrides,
});
const signedIn = (overrides: Record<string, unknown> = {}) =>
  answered({ ok: true, person: person(overrides), token: TOKEN, expiresAt: "2099-01-01T00:00:00+00:00" });

let db: SqliteDatabase;
let LOG: StructuredLogger;
let dir: string;

beforeEach(async () => {
  const data = await import("@erp/data");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-cloud-accounts-"));
  db = new data.SqliteDatabase({ dbPath: path.join(dir, "pc.db"), schemaPath: SCHEMA, migrationsDir: MIGRATIONS });
  LOG = new data.StructuredLogger(path.join(dir, "logs"));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const mode = async () => (await import("@erp/data")).readAccountsMode(db.db);
const switched = async () => (await import("@erp/data")).enterCloudAccountsMode(db.db, "test");

describe("the switch to cloud accounts: by hand, by an admin, at this computer", () => {
  const STATE = (people: Array<Record<string, unknown>>) => answered({ ok: true, roles: [], people, requests: [] });
  const request = (sessionToken: string, localUserId: string, password = "owner1234") => ({
    sessionToken, localUserId, localUsername: "Owner", email: "boss@777.pk", password,
  });
  const deps = (caller: AccountFunctionCaller | null, switchReady = true) => ({ db, caller, logger: LOG, deviceId: "dev-pc2", switchReady });
  const ROLES_COPIED = answered({ ok: true, imported: 7 });

  it("moves the admin's own account up, keeps their session, and signs everyone else out", async () => {
    const owner = db.createUserAccount("Owner", "owner1234");
    const ownerSession = db.createUserSession(owner.id);
    const munshi = db.createUserAccount("Munshi", "munshi5678");
    const munshiSession = db.createUserSession(munshi.id);
    const boss = { personId: owner.id, email: "boss@777.pk", displayName: "Owner", isAdmin: true };
    const cloud = new ScriptedCloud({
      verify_login: declined("WRONG_CREDENTIALS"),
      claim_existing_account: signedIn(boss),
      account_state: STATE([person(boss)]),
      admin_import_roles: ROLES_COPIED,
    });

    const outcome = await switchThisComputerToCloud(deps(cloud), request(ownerSession, owner.id));
    expect(outcome).toMatchObject({ kind: "SWITCHED", userId: owner.id, sessionToken: ownerSession, people: 1 });
    expect(await mode()).toBe("CLOUD");
    expect(db.getUserBySessionToken(ownerSession)?.role).toBe("ADMIN");
    expect(db.getUserBySessionToken(munshiSession)).toBeNull();
    expect(personTokenFor(ownerSession)).toBe(TOKEN);
    expect(db.checkLocalCredential(owner.id, "owner1234")).toBe(true);
  });

  it("a claim that comes back pending switches nothing, and says how to name the first admin", async () => {
    const owner = db.createUserAccount("Owner", "owner1234");
    const ownerSession = db.createUserSession(owner.id);
    const cloud = new ScriptedCloud({
      verify_login: declined("WRONG_CREDENTIALS"),
      claim_existing_account: signedIn({ personId: owner.id, email: "boss@777.pk", status: "PENDING" }),
    });
    const outcome = await switchThisComputerToCloud(deps(cloud), request(ownerSession, owner.id));
    expect(outcome).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.NOT_FIRST_ADMIN("dev-pc2", "boss@777.pk") });
    expect(cloud.calls).not.toContain("account_state");
    expect(await mode()).toBe("LOCAL");
    expect(db.getUserBySessionToken(ownerSession)?.id).toBe(owner.id);
  });

  it("a cloud admin who is not this computer's own account switches it with a session of their own", async () => {
    const setup = db.createUserAccount("Setup", "setup1234");
    const setupSession = db.createUserSession(setup.id);
    const boss = { personId: "p-boss", email: "boss@777.pk", displayName: "Boss", isAdmin: true };
    const cloud = new ScriptedCloud({ verify_login: signedIn(boss), account_state: STATE([person(boss)]), admin_import_roles: ROLES_COPIED });
    const outcome = await switchThisComputerToCloud(deps(cloud), request(setupSession, setup.id, "bosspass1"));
    expect(outcome.kind).toBe("SWITCHED");
    if (outcome.kind !== "SWITCHED") return;
    expect(outcome.sessionToken).not.toBe(setupSession);
    expect(db.getUserBySessionToken(outcome.sessionToken)?.id).toBe("p-boss");
    expect(db.getUserBySessionToken(setupSession)).toBeNull();
  });

  it("a password that is neither the cloud's nor this account's moves nothing up", async () => {
    const owner = db.createUserAccount("Owner", "owner1234");
    const cloud = new ScriptedCloud({ verify_login: declined("WRONG_CREDENTIALS") });
    const outcome = await switchThisComputerToCloud(deps(cloud), request(db.createUserSession(owner.id), owner.id, "guess1234"));
    expect(outcome).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.WRONG_CREDENTIALS });
    expect(cloud.calls).toEqual(["verify_login"]);
  });

  it("offline, without accounts in the cloud, or when the state cannot be loaded whole, nothing changes", async () => {
    const owner = db.createUserAccount("Owner", "owner1234");
    const session = db.createUserSession(owner.id);
    const admin = signedIn({ personId: owner.id, email: "boss@777.pk", isAdmin: true });
    const cases: Array<[AccountFunctionCaller | null, string]> = [
      [null, ACCOUNT_MESSAGES.SWITCH_OFFLINE],
      [new ScriptedCloud({ verify_login: { kind: "NOT_SUPPORTED" } }), ACCOUNT_MESSAGES.CLOUD_HAS_NO_ACCOUNTS],
      [new ScriptedCloud({ verify_login: UNREACHABLE }), ACCOUNT_MESSAGES.SWITCH_OFFLINE],
      [new ScriptedCloud({ verify_login: admin, account_state: STATE([person({ roleCode: "ghost" })]), admin_import_roles: ROLES_COPIED }),
        ACCOUNT_MESSAGES.SWITCH_RECORD_MISSING],
      [new ScriptedCloud({ verify_login: admin, account_state: declined("NOT_ENROLLED") }),
        ACCOUNT_MESSAGES.STATE_WAITING(ACCOUNT_MESSAGES.STATE_DECLINED)],
    ];
    for (const [caller, message] of cases) {
      expect(await switchThisComputerToCloud(deps(caller), request(session, owner.id))).toEqual({ kind: "REFUSED", message });
    }
    expect(await mode()).toBe("LOCAL");
    expect(db.getUserBySessionToken(session)?.id).toBe(owner.id);
  });

  it("this build may NOT switch: production's cloud has no cloud accounts (Carton Stock Cloud, Phase 1)", () => {
    expect(CLOUD_ACCOUNTS_SWITCH_READY).toBe(false);
  });

  it("LOCAL accounts keep working in this build: the computer stays LOCAL and its own sign-in works", async () => {
    const owner = db.createUserAccount("Owner", "owner1234");
    expect(await mode()).toBe("LOCAL");
    const { usesCloudAccounts } = await import("./cloudAccounts");
    expect(await usesCloudAccounts(db)).toBe(false);
    const user = db.authenticateUser("Owner", "owner1234");
    expect(user?.id).toBe(owner.id);
    expect(db.authenticateUser("Owner", "wrong-password")).toBeNull();
    const session = db.createUserSession(owner.id);
    expect(db.getUserBySessionToken(session)?.id).toBe(owner.id);
    // The refused switch leaves it exactly so.
    const outcome = await switchThisComputerToCloud(deps(null, CLOUD_ACCOUNTS_SWITCH_READY), request(session, owner.id));
    expect(outcome).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.SWITCH_NOT_READY });
    expect(await mode()).toBe("LOCAL");
    expect(db.getUserBySessionToken(session)?.id).toBe(owner.id);
  });

  it("a build that cannot approve anyone refuses outright, before it asks the cloud anything", async () => {
    // The owner's rule (2026-11-01): the switch signs everyone out, so without approving there is no
    // way back in. Any build that sets CLOUD_ACCOUNTS_SWITCH_READY false gets exactly this.
    const owner = db.createUserAccount("Owner", "owner1234");
    const session = db.createUserSession(owner.id);
    const cloud = new ScriptedCloud({ verify_login: signedIn({ personId: owner.id, isAdmin: true }) });
    const outcome = await switchThisComputerToCloud(deps(cloud, false), request(session, owner.id));
    expect(outcome).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.SWITCH_NOT_READY });
    expect(cloud.calls).toEqual([]);
    expect(await mode()).toBe("LOCAL");
    expect(db.getUserBySessionToken(session)?.id).toBe(owner.id);
  });

  describe("this computer's roles go up in the same press (owner, 2 Nov: PC2 gets one go)", () => {
    const owner = () => {
      const account = db.createUserAccount("Owner", "owner1234");
      return { account, session: db.createUserSession(account.id), boss: { personId: account.id, email: "boss@777.pk", isAdmin: true } };
    };

    it("copies them up when the cloud has none, before anything here changes, then switches", async () => {
      const { account, session, boss } = owner();
      const cloud = new ScriptedCloud({ verify_login: signedIn(boss), account_state: STATE([person(boss)]), admin_import_roles: ROLES_COPIED });
      const outcome = await switchThisComputerToCloud(deps(cloud), request(session, account.id));
      expect(outcome.kind).toBe("SWITCHED");
      expect(cloud.calls).toEqual(["verify_login", "account_state", "admin_import_roles", "account_state"]);
    });

    it("copies nothing when the cloud already has roles: the first computer brought them", async () => {
      const { account, session, boss } = owner();
      const storeOperator = { roleCode: "store-operator", revision: 1, deleted: false, name: "Store Operator", description: null, loginPolicy: "ALWAYS_LOGGED_IN", permissions: ["stock"] };
      const cloud = new ScriptedCloud({
        verify_login: signedIn(boss),
        account_state: answered({ ok: true, roles: [storeOperator], people: [person(boss)], requests: [] }),
      });
      expect((await switchThisComputerToCloud(deps(cloud), request(session, account.id))).kind).toBe("SWITCHED");
      expect(cloud.calls).not.toContain("admin_import_roles");
    });

    it("a cloud role carrying one of this computer's built-in names under another code still switches it", async () => {
      // A reader's built-ins never go up, so nothing in the cloud stops a role of its own taking the name.
      const { account, session, boss } = owner();
      const desk = { roleCode: "billing-desk", revision: 1, deleted: false, name: "Billing Manager", description: null, loginPolicy: "ALWAYS_LOGGED_IN", permissions: ["stock"] };
      const cloud = new ScriptedCloud({
        verify_login: signedIn(boss),
        account_state: answered({ ok: true, roles: [desk], people: [person(boss)], requests: [] }),
      });
      expect((await switchThisComputerToCloud(deps(cloud), request(session, account.id))).kind).toBe("SWITCHED");
      const names = db.db.prepare("SELECT role_code, role_name FROM roles WHERE role_code IN ('billing-desk', 'billing-manager') ORDER BY role_code").all();
      expect(names.map((r) => ({ ...r }))).toEqual([
        { role_code: "billing-desk", role_name: "Billing Manager" },
        { role_code: "billing-manager", role_name: "Billing Manager (This PC)" },
      ]);
    });

    it("roles the cloud will not take switch nothing: everyone stays signed in, and it can be pressed again", async () => {
      const { account, session, boss } = owner();
      const munshi = db.createUserAccount("Munshi", "munshi5678");
      const munshiSession = db.createUserSession(munshi.id);
      const cloud = new ScriptedCloud({ verify_login: signedIn(boss), account_state: STATE([person(boss)]), admin_import_roles: UNREACHABLE });
      const outcome = await switchThisComputerToCloud(deps(cloud), request(session, account.id));
      expect(outcome).toMatchObject({ kind: "REFUSED", message: expect.stringContaining("roles could not be copied") });
      expect(await mode()).toBe("LOCAL");
      expect(db.getUserBySessionToken(munshiSession)?.id).toBe(munshi.id);
    });
  });

  // Found by the 4 Nov rehearsal. A role deleted in the cloud, still held by someone only this
  // computer knows, refused the switch for ever with a raw code and "try again in a moment".
  describe("a role the cloud has deleted, and a computer that fell behind", () => {
    const INTERNAL_CODE = /WAITING_FOR|STILL_IN_USE|ROLE_UNASSIGNED|ROLE_NAME|ACCOUNT_ROLE|NOT_ENROLLED/;
    const role = (overrides: Record<string, unknown> = {}) => ({
      roleCode: "gatepass-clerk", revision: 2, deleted: false, name: "Gatepass Clerk", description: null, loginPolicy: "ALWAYS_LOGGED_IN", permissions: ["gatepass"], ...overrides,
    });
    const DELETED = role({ deleted: true });
    const owner = () => {
      const account = db.createUserAccount("Owner", "owner1234");
      return { account, session: db.createUserSession(account.id), boss: { personId: account.id, email: "boss@777.pk", isAdmin: true } };
    };
    const holding = (name: string, roleCode: string) => {
      const account = db.createUserAccount(name, `${name.toLowerCase()}1234`);
      db.assignUserRole(account.id, roleCode);
      return account;
    };
    const press = (boss: Record<string, unknown>, session: string, id: string, roles: unknown[], people: unknown[] = [person(boss)], acceptLosses = false) =>
      switchThisComputerToCloud(
        deps(new ScriptedCloud({ verify_login: signedIn(boss), account_state: answered({ ok: true, roles, people, requests: [] }) })),
        { ...request(session, id), acceptLosses }
      );
    const assignmentOf = (userId: string) => db.db.prepare("SELECT role_code FROM user_role_assignments WHERE user_id = ?").get(userId);
    const held = async (roleEvent: ReturnType<typeof role>) => {
      const data = await import("@erp/data");
      const read = data.readAccountRolePayload(roleEvent);
      if (read === null) throw new Error("not a role");
      data.applyAccountRoleRevision(db.db, read);
    };

    it("a local-only holder does not block the first switch: the assignment goes, named, and it never waits", async () => {
      const { account, session, boss } = owner();
      const clerk = holding("Clerk", "gatepass-clerk");
      const storeman = holding("Storeman", "store-operator");
      const storeOperator = role({ roleCode: "store-operator", name: "Store Operator", revision: 1, permissions: ["stock"] });

      const outcome = await press(boss, session, account.id, [DELETED, storeOperator]);

      expect(outcome).toMatchObject({ kind: "SWITCHED", clearedRoles: [{ userId: clerk.id, username: "Clerk", roleName: "Gatepass Clerk" }] });
      expect(await mode()).toBe("CLOUD");
      expect(db.db.prepare("SELECT 1 FROM roles WHERE role_code = 'gatepass-clerk'").get()).toBeUndefined();
      expect(assignmentOf(clerk.id)).toBeUndefined();
      expect({ ...assignmentOf(storeman.id) }).toEqual({ role_code: "store-operator" });
      expect(db.db.prepare("SELECT entity_id FROM audit_log WHERE event_type = 'ROLE_ASSIGNMENT_CLEARED'").all().map((row) => ({ ...row }))).toEqual([{ entity_id: clerk.id }]);
      const notice = db.db.prepare("SELECT message FROM user_notifications WHERE user_id = ? AND title = 'Role removed'").get(account.id) as { message: string };
      expect(notice.message).toContain('Clerk held "Gatepass Clerk"');
    });

    describe("a role that differs in the cloud (rehearsal, 6 Nov: Biller lost History, and nothing said)", () => {
      const approved = (name: string, roleCode: string) => {
        const account = holding(name, roleCode);
        db.db.prepare("UPDATE app_users SET access_status = 'APPROVED' WHERE id = ?").run(account.id);
        return account;
      };
      const screensOf = (roleCode: string) => db.listRoles().find((candidate) => candidate.code === roleCode)?.permissions ?? [];
      const cloudRole = (permissions: string[]) => role({ roleCode: "store-operator", name: "Store Operator", revision: 1, permissions });
      const pressWith = (boss: Record<string, unknown>, session: string, id: string, roles: unknown[], acceptLosses: boolean) =>
        switchThisComputerToCloud(
          deps(new ScriptedCloud({ verify_login: signedIn(boss), account_state: answered({ ok: true, roles, people: [person(boss)], requests: [] }) })),
          { ...request(session, id), acceptLosses }
        );

      it("stops, names who loses which screens, and changes nothing at all", async () => {
        const { account, session, boss } = owner();
        const biller = approved("Biller", "store-operator");
        const bills = db.createUserSession(biller.id);
        const screens = screensOf("store-operator");
        const [kept, ...lost] = screens;
        const notices = () => db.db.prepare("SELECT COUNT(*) AS n FROM user_notifications").get();
        const before = notices();

        const outcome = await pressWith(boss, session, account.id, [cloudRole([kept ?? ""])], false);

        expect(outcome).toEqual({ kind: "WOULD_LOSE_ACCESS", losses: [{ username: "Biller", screens: expect.arrayContaining(lost) }] });
        expect(await mode()).toBe("LOCAL");
        expect(screensOf("store-operator")).toEqual(screens);
        expect(db.getUserBySessionToken(bills)?.id).toBe(biller.id);
        expect(db.getUserBySessionToken(session)?.id).toBe(account.id);
        expect(notices()).toEqual(before);
        expect(db.recalculateEffectivePermissions(biller.id).sort()).toEqual([...screens].sort());
      });

      it("the admin saying go on switches, and the screens go as they were told", async () => {
        const { account, session, boss } = owner();
        const biller = approved("Biller", "store-operator");
        const [kept] = screensOf("store-operator");

        const outcome = await pressWith(boss, session, account.id, [cloudRole([kept ?? ""])], true);

        expect(outcome.kind).toBe("SWITCHED");
        expect(await mode()).toBe("CLOUD");
        expect(db.recalculateEffectivePermissions(biller.id)).toEqual([kept]);
      });

      it("the same role, or one that only gains, says nothing", async () => {
        const { account, session, boss } = owner();
        approved("Biller", "store-operator");
        const outcome = await pressWith(boss, session, account.id, [cloudRole([...screensOf("store-operator"), "logs"])], false);
        expect(outcome.kind).toBe("SWITCHED");
      });

      it("a role the cloud has deleted is a loss too, and someone not approved has nothing to lose", async () => {
        const { account, session, boss } = owner();
        approved("Clerk", "gatepass-clerk");
        holding("Waiting", "gatepass-clerk");
        const screens = screensOf("gatepass-clerk");
        const outcome = await pressWith(boss, session, account.id, [DELETED], false);
        expect(outcome).toEqual({ kind: "WOULD_LOSE_ACCESS", losses: [{ username: "Clerk", screens }] });
      });

      it("a state that would have to wait is refused as before, not reported as a loss", async () => {
        const { account, session, boss } = owner();
        approved("Biller", "store-operator");
        const outcome = await switchThisComputerToCloud(
          deps(new ScriptedCloud({ verify_login: signedIn(boss), account_state: answered({ ok: true, roles: [], people: [person(boss), person({ personId: "p-ghost", roleCode: "ghost" })], requests: [] }), admin_import_roles: ROLES_COPIED })),
          request(session, account.id)
        );
        expect(outcome.kind).toBe("REFUSED");
        expect(await mode()).toBe("LOCAL");
      });
    });

    it("a refused switch clears nothing: the local-only holder keeps their role", async () => {
      const { account, session, boss } = owner();
      const clerk = holding("Clerk", "gatepass-clerk");
      const outcome = await press(boss, session, account.id, [DELETED], [person(boss), person({ personId: "p-ghost", roleCode: "ghost" })]);
      expect(outcome.kind).toBe("REFUSED");
      expect({ ...assignmentOf(clerk.id) }).toEqual({ role_code: "gatepass-clerk" });
      expect(db.db.prepare("SELECT 1 FROM audit_log WHERE event_type = 'ROLE_ASSIGNMENT_CLEARED'").get()).toBeUndefined();
    });

    it("a computer holding older revisions switches in one press: the state settles a rename by itself", async () => {
      // Pulled under an earlier build, while on local accounts. The log can no longer bring the rest.
      const { account, session, boss } = owner();
      await held(role({ roleCode: "billing-manager", name: "Billing Manager", revision: 1 }));
      const desk = role({ roleCode: "billing-manager", name: "Billing Desk", revision: 2 });
      const lead = role({ roleCode: "billing-lead", name: "Billing Manager", revision: 2 });

      const outcome = await press(boss, session, account.id, [lead, desk]);

      expect(outcome.kind).toBe("SWITCHED");
      const names = db.db.prepare("SELECT role_code, role_name FROM roles WHERE role_code LIKE 'billing-%' ORDER BY role_code").all();
      expect(names.map((row) => ({ ...row }))).toEqual([
        { role_code: "billing-lead", role_name: "Billing Manager" },
        { role_code: "billing-manager", role_name: "Billing Desk" },
      ]);
    });

    it("two cloud roles that swapped names do not wait for each other", async () => {
      const { account, session, boss } = owner();
      await held(role({ roleCode: "role-a", name: "First", revision: 1 }));
      await held(role({ roleCode: "role-b", name: "Second", revision: 1 }));
      const outcome = await press(boss, session, account.id, [
        role({ roleCode: "role-a", name: "Second", revision: 4 }),
        role({ roleCode: "role-b", name: "First", revision: 4 }),
      ]);
      expect(outcome.kind).toBe("SWITCHED");
      expect((db.db.prepare("SELECT role_name FROM roles WHERE role_code = 'role-a'").get() as { role_name: string }).role_name).toBe("Second");
    });

    it("a cloud person the state moved off a deleted role is not in its way: people load before deletions", async () => {
      const { account, session, boss } = owner();
      const data = await import("@erp/data");
      await held(role({ revision: 1 }));
      const old = data.readPersonPayload(person({ personId: "p-ali", roleCode: "gatepass-clerk" }));
      if (old === null) throw new Error("not a person");
      data.applyPersonRevision(db.db, old);

      const people = [person(boss), person({ personId: "p-ali", revision: 2, roleCode: null })];

      // Ali really does lose the role's screens here, so the admin is told first.
      expect(await press(boss, session, account.id, [DELETED], people)).toMatchObject({ kind: "WOULD_LOSE_ACCESS", losses: [{ screens: ["gatepass"] }] });
      const outcome = await press(boss, session, account.id, [DELETED], people, true);

      expect(outcome).toMatchObject({ kind: "SWITCHED", clearedRoles: [] });
      expect(assignmentOf("p-ali")).toBeUndefined();
    });

    it("when someone really must be reassigned it names them and the role, and pressing again after that works", async () => {
      // A person this computer has heard of but the state leaves out: nothing here can say where they went.
      const { account, session, boss } = owner();
      const data = await import("@erp/data");
      await held(role({ revision: 1 }));
      const stray = data.readPersonPayload(person({ personId: "p-stray", displayName: "Stray", email: "stray@777.pk", roleCode: "gatepass-clerk" }));
      if (stray === null) throw new Error("not a person");
      data.applyPersonRevision(db.db, stray);

      const refused = await press(boss, session, account.id, [DELETED]);

      expect(refused).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.SWITCH_ROLE_STILL_HELD("Stray", "Gatepass Clerk") });
      expect(await mode()).toBe("LOCAL");
      expect(db.getUserBySessionToken(session)?.id).toBe(account.id);

      db.assignUserRole("p-stray", "store-operator");
      expect((await press(boss, session, account.id, [DELETED])).kind).toBe("SWITCHED");
    });

    it("no refusal of the switch ever shows an internal code", () => {
      const messages = [
        ACCOUNT_MESSAGES.SWITCH_ROLE_STILL_HELD("Clerk", "Gatepass Clerk"),
        ACCOUNT_MESSAGES.SWITCH_NAME_STILL_HELD("Billing Manager"),
        ACCOUNT_MESSAGES.SWITCH_RECORD_MISSING,
        ACCOUNT_MESSAGES.STATE_WAITING(ACCOUNT_MESSAGES.STATE_DECLINED),
      ];
      for (const message of messages) expect(message).not.toMatch(INTERNAL_CODE);
    });

    it("the switch answers at once, whatever it finds, and releases what was held for it", async () => {
      const { account, session, boss } = owner();
      const sync = await import("@erp/sync");
      const data = await import("@erp/data");
      const roleEvent = role({ roleCode: "store-operator", name: "Store Operator", revision: 1 });
      sync.parkEvent(
        db.db,
        { seq: 7, nowMs: Date.now(), reason: data.HELD_FOR_SWITCH, envelope: { dedupeKey: "ACCOUNT_ROLE:store-operator:1", aggregateType: "ACCOUNT_ROLE", aggregateId: "store-operator", operation: "INSERT", payload: roleEvent, originDeviceId: "cloud", createdAt: "2026-11-04T08:00:00.000Z" } },
        { baseMs: 900_000, maxMs: 900_000 }
      );
      const started = Date.now();
      expect((await press(boss, session, account.id, [DELETED])).kind).toBe("SWITCHED");
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(db.db.prepare("SELECT next_try_at FROM sync_inbox_parked").get()).toMatchObject({ next_try_at: 0 });
    });
  });

  it("is refused on a computer that already uses cloud accounts", async () => {
    await switched();
    const outcome = await switchThisComputerToCloud(deps(new ScriptedCloud({})), request("s", "u"));
    expect(outcome).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.ALREADY_CLOUD });
  });
});

describe("signing in under cloud accounts", () => {
  beforeEach(switched);

  it("online, the cloud decides: the person is written here, their check cached, their token kept", async () => {
    const outcome = await cloudSignIn({ db, caller: new ScriptedCloud({ verify_login: signedIn() }) }, "ali@777.pk", "alipass12");
    expect(outcome.kind).toBe("SIGNED_IN");
    if (outcome.kind !== "SIGNED_IN") return;
    expect(personTokenFor(outcome.sessionToken)).toBe(TOKEN);
    expect(db.checkLocalCredential("p-ali", "alipass12")).toBe(true);
  });

  it("a refusal from the cloud is final: the cached check is never tried after it", async () => {
    await cloudSignIn({ db, caller: new ScriptedCloud({ verify_login: signedIn() }) }, "ali@777.pk", "alipass12");
    const refused = await cloudSignIn({ db, caller: new ScriptedCloud({ verify_login: declined("WRONG_CREDENTIALS") }) }, "ali@777.pk", "alipass12");
    expect(refused).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.WRONG_CREDENTIALS });
    const deviceRefused = await cloudSignIn({ db, caller: new ScriptedCloud({ verify_login: { kind: "REFUSED", message: "401" } }) }, "ali@777.pk", "alipass12");
    expect(deviceRefused).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.DEVICE_REFUSED });
  });

  it("a locked person is told how long to wait", async () => {
    const outcome = await cloudSignIn({ db, caller: new ScriptedCloud({ verify_login: declined("LOCKED", { retryAfterSeconds: 600 }) }) }, "ali@777.pk", "x");
    expect(outcome).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.LOCKED(10) });
  });

  it("offline, a recent check made here signs the person in, without a token for admin work", async () => {
    await cloudSignIn({ db, caller: new ScriptedCloud({ verify_login: signedIn() }) }, "ali@777.pk", "alipass12");
    const offline = await cloudSignIn({ db, caller: new ScriptedCloud({ verify_login: UNREACHABLE }) }, "ALI@777.pk", "alipass12");
    expect(offline.kind).toBe("SIGNED_IN");
    if (offline.kind === "SIGNED_IN") expect(personTokenFor(offline.sessionToken)).toBeNull();
    const wrong = await cloudSignIn({ db, caller: null }, "ali@777.pk", "nope12345");
    expect(wrong).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.WRONG_CREDENTIALS });
  });

  it("offline, the first time here needs the internet, and so does a check older than the limit", async () => {
    expect(await cloudSignIn({ db, caller: null }, "ali@777.pk", "alipass12")).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.FIRST_TIME_OFFLINE });
    await cloudSignIn({ db, caller: new ScriptedCloud({ verify_login: signedIn() }) }, "ali@777.pk", "alipass12", new Date("2026-11-01T09:00:00Z"));
    const later = new Date("2026-11-09T09:00:00Z");
    expect(await cloudSignIn({ db, caller: null }, "ali@777.pk", "alipass12", later)).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.OFFLINE_TOO_LONG });
    expect((await cloudSignIn({ db, caller: null }, "ali@777.pk", "alipass12", new Date("2026-11-07T09:00:00Z"))).kind).toBe("SIGNED_IN");
  });

  it("offline, a revoked person is refused, and told so only after their password matches", async () => {
    await cloudSignIn({ db, caller: new ScriptedCloud({ verify_login: signedIn() }) }, "ali@777.pk", "alipass12");
    db.db.prepare("UPDATE app_users SET access_status = 'REVOKED' WHERE id = 'p-ali'").run();
    expect(await cloudSignIn({ db, caller: null }, "ali@777.pk", "nope12345")).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.WRONG_CREDENTIALS });
    expect(await cloudSignIn({ db, caller: null }, "ali@777.pk", "alipass12")).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.ACCESS_REVOKED });
  });

  it("signing up needs the cloud, and says why the cloud refused", async () => {
    expect(await cloudSignUp({ db, caller: null }, "new@777.pk", "newpass12", "New")).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.SIGN_UP_OFFLINE });
    const taken = await cloudSignUp({ db, caller: new ScriptedCloud({ sign_up: declined("EMAIL_TAKEN") }) }, "ali@777.pk", "newpass12", "Ali");
    expect(taken).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.EMAIL_TAKEN });
    const made = await cloudSignUp({ db, caller: new ScriptedCloud({ sign_up: signedIn({ personId: "p-new", email: "new@777.pk", status: "PENDING" }) }) }, "new@777.pk", "newpass12", "New");
    expect(made.kind).toBe("SIGNED_IN");
    expect(db.db.prepare("SELECT access_status FROM app_users WHERE id = 'p-new'").get()).toEqual({ access_status: "PENDING" });
  });
});

describe("moving an account this computer already holds", () => {
  it("checks its password here, asks for an email, and moves it up with its own id", async () => {
    const local = db.createUserAccount("Munshi", "munshi5678");
    await switched();
    const caller = new ScriptedCloud({ claim_existing_account: signedIn({ personId: local.id, email: "munshi@777.pk", displayName: "Munshi", status: "PENDING" }) });

    expect(await cloudClaim({ db, caller }, "Munshi", "wrong0000", "munshi@777.pk")).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.WRONG_CREDENTIALS });
    expect((await cloudClaim({ db, caller }, "Munshi", "munshi5678", null)).kind).toBe("NEEDS_EMAIL");
    expect(caller.calls).toEqual([]);
    expect(await cloudClaim({ db, caller: null }, "Munshi", "munshi5678", "munshi@777.pk")).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.CLAIM_OFFLINE });

    const moved = await cloudClaim({ db, caller }, "Munshi", "munshi5678", "munshi@777.pk");
    expect(moved.kind).toBe("SIGNED_IN");
    expect(db.db.prepare("SELECT email, access_status FROM app_users WHERE id = ?").get(local.id)).toEqual({ email: "munshi@777.pk", access_status: "PENDING" });
  });
});
