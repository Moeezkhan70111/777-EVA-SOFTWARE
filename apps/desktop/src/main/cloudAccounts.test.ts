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
  switchToCloudAccountsIfReady,
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

describe("the switch to cloud accounts", () => {
  it("loads the whole state, then switches, once", async () => {
    const cloud = new ScriptedCloud({
      account_state: answered({
        ok: true,
        roles: [{ roleCode: "munshi", revision: 1, deleted: false, name: "Munshi", description: null, loginPolicy: "ALWAYS_LOGGED_IN", permissions: ["stock"] }],
        people: [person({ roleCode: "munshi" })],
        requests: [],
      }),
    });
    expect(await switchToCloudAccountsIfReady(db, cloud, "https://test", LOG, "dev")).toBe("SWITCHED");
    expect(await mode()).toBe("CLOUD");
    expect(db.db.prepare("SELECT email FROM app_users WHERE id = 'p-ali'").get()).toEqual({ email: "ali@777.pk" });
    expect(await switchToCloudAccountsIfReady(db, cloud, "https://test", LOG, "dev")).toBe("ALREADY_CLOUD");
    expect(cloud.calls).toEqual(["account_state"]);
  });

  it("ends the open sessions of accounts the cloud does not know, and only those", async () => {
    const local = db.createUserAccount("Munshi", "munshi5678");
    const localSession = db.createUserSession(local.id);
    const cloud = new ScriptedCloud({ account_state: answered({ ok: true, roles: [], people: [person()], requests: [] }) });
    await switchToCloudAccountsIfReady(db, cloud, "https://sessions", LOG, "dev");
    expect(db.getUserBySessionToken(localSession)).toBeNull();
    // A person the cloud knows keeps theirs: their access is the cloud's to take away.
    const cloudSession = db.createUserSession("p-ali");
    expect(db.getUserBySessionToken(cloudSession)?.id).toBe("p-ali");
  });

  it("asks a project without account functions once, and stays local", async () => {
    const cloud = new ScriptedCloud({ account_state: { kind: "NOT_SUPPORTED" } });
    expect(await switchToCloudAccountsIfReady(db, cloud, "https://old", LOG, "dev")).toBe("NOT_SUPPORTED");
    expect(await switchToCloudAccountsIfReady(db, cloud, "https://old", LOG, "dev")).toBe("NOT_SUPPORTED");
    expect(cloud.calls).toEqual(["account_state"]);
    expect(await mode()).toBe("LOCAL");
  });

  it("changes nothing when the state cannot be loaded whole", async () => {
    const waits = new ScriptedCloud({ account_state: answered({ ok: true, roles: [], people: [person({ roleCode: "ghost" })], requests: [] }) });
    expect(await switchToCloudAccountsIfReady(db, waits, "https://a", LOG, "dev")).toBe("WAITING");
    const garbled = new ScriptedCloud({ account_state: answered({ ok: true, roles: [], people: [{ personId: "x" }], requests: [] }) });
    expect(await switchToCloudAccountsIfReady(db, garbled, "https://b", LOG, "dev")).toBe("UNAVAILABLE");
    expect(await mode()).toBe("LOCAL");
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM app_users").get()).toEqual({ n: 0 });
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
