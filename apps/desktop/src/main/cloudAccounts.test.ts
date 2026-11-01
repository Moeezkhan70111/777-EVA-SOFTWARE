// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteDatabase, StructuredLogger } from "@erp/data";
import type { AccountCall, AccountFunctionCaller, AccountFunctionName } from "@erp/sync";
import {
  ACCOUNT_MESSAGES,
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
  const deps = (caller: AccountFunctionCaller | null) => ({ db, caller, logger: LOG, deviceId: "dev-pc2" });

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
    expect(outcome).toEqual({ kind: "REFUSED", message: ACCOUNT_MESSAGES.NOT_FIRST_ADMIN("dev-pc2") });
    expect(cloud.calls).not.toContain("account_state");
    expect(await mode()).toBe("LOCAL");
    expect(db.getUserBySessionToken(ownerSession)?.id).toBe(owner.id);
  });

  it("a cloud admin who is not this computer's own account switches it with a session of their own", async () => {
    const setup = db.createUserAccount("Setup", "setup1234");
    const setupSession = db.createUserSession(setup.id);
    const boss = { personId: "p-boss", email: "boss@777.pk", displayName: "Boss", isAdmin: true };
    const cloud = new ScriptedCloud({ verify_login: signedIn(boss), account_state: STATE([person(boss)]) });
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
      [new ScriptedCloud({ verify_login: admin, account_state: STATE([person({ roleCode: "ghost" })]) }),
        ACCOUNT_MESSAGES.STATE_WAITING(`WAITING_FOR:ACCOUNT_ROLE:ghost`)],
    ];
    for (const [caller, message] of cases) {
      expect(await switchThisComputerToCloud(deps(caller), request(session, owner.id))).toEqual({ kind: "REFUSED", message });
    }
    expect(await mode()).toBe("LOCAL");
    expect(db.getUserBySessionToken(session)?.id).toBe(owner.id);
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
