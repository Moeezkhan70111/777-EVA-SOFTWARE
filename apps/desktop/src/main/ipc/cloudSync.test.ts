// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Authorizer, type SessionUser } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { registerCloudSyncHandlers } from "./cloudSync";

// WHAT THE RENDERER CAN MAKE THIS COMPUTER DO TO THE CLOUD.
//
// A pass is not read-only: it inserts carton identities into a shared project, and the cloud log
// is append-only, so a push cannot be cleanly undone. Four things therefore have to hold at the
// process boundary, and none of them is checked anywhere else:
//
//   * only an administrator may start one
//   * a computer without all four environment variables does nothing at all
//   * two passes cannot run at once
//   * reading the status neither syncs nor touches the database
//
// @erp/sync is mocked, so nothing here reaches a network: the queue and transport behaviour it
// stands in for is proved in that package's own tests against disposable databases. The config
// is NOT mocked -- these drive the real readCloudSyncConfig through process.env, because the
// refusals it produces are the ones that keep a misconfigured computer from writing to a shared
// project.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
  app: { getVersion: () => "0.3.0" },
  // A REVERSIBLE STAND-IN FOR DPAPI, not a null one. The real safeStorage needs a running
  // Electron, but a store that cannot encrypt reports no credential at all, which would make
  // every credential assertion below vacuous. This encrypts for real -- weakly, into a temp
  // directory this file deletes -- so "the stored credential is read back" is actually proved.
  // `encryptionAvailable` lets one test take the opposite case.
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, "utf8"),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("not encrypted by this machine");
      return text.slice(4);
    },
  },
}));

interface DrainResultStub {
  synced: number;
  counts: Record<string, number>;
  transportError?: string;
}
interface PullResultStub {
  fetched: number;
  applied: number;
  duplicates: number;
  refused: Array<{ reason: string }>;
  transportError?: string;
  waitingFor?: { reason: string };
}

/** What the stubbed @erp/sync will do on the next pass. Reset in beforeEach. */
let drainResult: DrainResultStub;
let pullResult: PullResultStub;
let drainThrows: Error | null;
/** Held open to keep a pass running while a second one is attempted. */
let drainGate: Promise<void> | null;
/** Opens the gate again. Always called in afterEach: a pass left hanging would hold the
 *  module-level `running` guard and every later test would be told one is already running. */
let releaseGate: (() => void) | null;
/** The pass a test started and has not awaited yet. */
let inFlight: Promise<unknown> | null;
/** Whether the stand-in safeStorage reports OS key storage. True except where a test says so. */
let encryptionAvailable: boolean;
/** This test's data root: where DeviceCredentialStore writes device-credential.bin. */
let dataRoot: string;
let built: Array<{
  what: string;
  options?: Record<string, unknown>;
  /** Only for the auth: the callback it was handed to store a refreshed credential. */
  onSession?: (session: { userId?: string; refreshToken: string }) => void;
}>;

vi.mock("@erp/sync", () => {
  class SupabaseDeviceAuth {
    constructor(
      config: unknown,
      _now?: () => number,
      onSession?: (session: { userId?: string; refreshToken: string }) => void
    ) {
      built.push({ what: "auth", options: config as Record<string, unknown>, onSession });
    }
  }
  class SupabaseSyncTransport {
    constructor(options: unknown) {
      built.push({ what: "transport", options: options as Record<string, unknown> });
    }
    async claimDevice(request: Record<string, unknown>): Promise<Record<string, unknown>> {
      claimRequests.push(request);
      if (claimThrows !== null) throw claimThrows;
      return claimOutcome;
    }
  }
  class OutboxDrain {
    constructor(_sql: unknown, _transport: unknown, options: Record<string, unknown>) {
      built.push({ what: "drain", options });
    }
    async runOnce(): Promise<DrainResultStub> {
      if (drainGate !== null) await drainGate;
      if (drainThrows !== null) throw drainThrows;
      return drainResult;
    }
  }
  class SyncPull {
    constructor(_sql: unknown, _transport: unknown) {
      built.push({ what: "pull" });
    }
    async runOnce(): Promise<PullResultStub> {
      return pullResult;
    }
  }
  return {
    SupabaseDeviceAuth,
    SupabaseSyncTransport,
    OutboxDrain,
    SyncPull,
    SUPABASE_PUSHABLE_AGGREGATES: ["QR_MASTER"] as readonly string[],
    // The status reads the queue. These stand in for the real SELECTs, which are proved against
    // disposable databases in packages/sync; what matters here is that the handler asks for them
    // and hands the summary the transport's own sendable list.
    outboxSummary: (sql: { prepare: (text: string) => unknown }, options: Record<string, unknown>) => {
      summaryCalls.push(options);
      sql.prepare("SELECT status, COUNT(*) AS n FROM sync_outbox GROUP BY status");
      return QUEUE;
    },
    readPullCursor: (sql: { prepare: (text: string) => unknown }) => {
      sql.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1");
      return 7;
    },
    readPullDeferral: (sql: { prepare: (text: string) => unknown }) => {
      sql.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1");
      return deferral;
    },
  };
});

/** What the stubbed queue reports. */
const QUEUE = {
  counts: { PENDING: 3, IN_FLIGHT: 0, FAILED: 1, DEAD_LETTER: 2, SYNCED: 9 },
  pushableNow: 1,
  pushableWaiting: 1,
  notPushable: 2,
  lastSyncedAt: "2026-10-01T10:00:00.000Z",
  lastFailureAt: "2026-10-01T11:00:00.000Z",
};
let deferral: { seq: number; until: number; attempts: number } | null;
let summaryCalls: Array<Record<string, unknown>>;
/** What the stubbed claim answers, and what it was asked for. */
let claimOutcome: Record<string, unknown>;
let claimThrows: Error | null;
let claimRequests: Array<Record<string, unknown>>;

const windowEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;

const ADMIN: SessionUser = {
  id: "u-admin",
  username: "owner",
  role: "ADMIN",
  accessStatus: "APPROVED",
  permissions: [],
};
const CLERK: SessionUser = { ...ADMIN, id: "u-clerk", username: "babar", role: "USER" };
const PENDING_ADMIN: SessionUser = { ...ADMIN, accessStatus: "PENDING" };

const GOOD_ENV = {
  ERP_SUPABASE_URL: "https://zzdisposable.supabase.co",
  ERP_SUPABASE_ANON_KEY: "anon-key-shaped-but-not-a-jwt",
  ERP_DEVICE_EMAIL: "device@example.test",
  ERP_DEVICE_PASSWORD: "device-password",
};

/** A JWT whose payload names the service_role. The one key that must never be accepted. */
const SERVICE_ROLE_KEY = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  Buffer.from(JSON.stringify({ role: "service_role" }), "utf8").toString("base64url"),
  "not-a-real-signature",
].join(".");

let signedIn: SessionUser | null;
let logged: Array<{ severity: string; operation: string; message: string; userId?: string }>;
/** Every SQL statement any handler prepared or executed, in order. */
let prepared: string[];

const setEnv = (values: Partial<typeof GOOD_ENV>): void => {
  for (const key of Object.keys(GOOD_ENV) as Array<keyof typeof GOOD_ENV>) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const buildContext = (): IpcContext => {
  const authorizer = new Authorizer(() => signedIn);
  authorizer.bind(windowEvent, "session-token");
  // A stand-in for the four fields these handlers actually use. The cast is the price of
  // registerCloudSyncHandlers taking the whole IpcContext; its siblings numberBlock.ts and
  // deadLetters.ts declare narrowed context types and need no cast. See the report.
  // A handle that records what it is asked to run and answers nothing. Enough for the status
  // path, which only reads, and it makes "read-only" provable rather than asserted.
  const recordingSql = {
    prepare: (statement: string) => {
      prepared.push(statement);
      return { all: () => [], get: () => undefined, run: () => ({ changes: 0, lastInsertRowid: 0 }) };
    },
    exec: (statement: string) => {
      prepared.push(statement);
    },
  };
  return {
    db: { db: recordingSql },
    logger: {
      log: (entry: { severity: string; operation: string; message: string; userId?: string }) =>
        logged.push(entry),
    },
    authorizer,
    deviceId: "device-under-test",
    // Migration 006 claims against the device AND its workstation; both already live here.
    scanContext: { factoryId: "factory-777", workstationId: "ws-prod-01", deviceId: "device-under-test" },
    // Where this computer's encrypted cloud credential lives. A real directory, emptied after
    // every test, so the credential path is exercised rather than stubbed out.
    paths: { dataRoot },
  } as unknown as IpcContext;
};

const invoke = async (channel: string): Promise<Record<string, unknown>> => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return (await handler(windowEvent)) as Record<string, unknown>;
};

const status = () => invoke(IPC.getCloudSyncStatus);
const run = () => invoke(IPC.runCloudSync);

/** Starts a pass and holds it at the drain until releasePass() is called. */
const startHeldPass = (): Promise<Record<string, unknown>> => {
  drainGate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const pass = run();
  inFlight = pass;
  return pass;
};

/** Lets a held pass finish, and waits for it, so the running guard is clear. */
const releasePass = async (): Promise<void> => {
  releaseGate?.();
  releaseGate = null;
  drainGate = null;
  if (inFlight !== null) await inFlight.catch(() => undefined);
  inFlight = null;
};

/** Writes a credential file as DeviceCredentialStore would, for the given deviceId. */
const storeCredential = (deviceIdFor = "device-under-test"): void => {
  const credential = {
    authUserId: "auth-user-1",
    deviceId: deviceIdFor,
    refreshToken: "stored-refresh-token",
    provisionedAt: "2026-10-01T09:00:00.000Z",
  };
  fs.writeFileSync(
    path.join(dataRoot, "device-credential.bin"),
    Buffer.from(`enc:${JSON.stringify(credential)}`, "utf8")
  );
};

/** What is on disk now, or null. Never asserted against the token's value by accident. */
const readCredential = (): Record<string, unknown> | null => {
  const file = path.join(dataRoot, "device-credential.bin");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8").slice(4)) as Record<string, unknown>;
};

/** The session sink the handler passed @erp/sync, if it built an auth at all. */
const sessionSink = (): ((session: { userId?: string; refreshToken: string }) => void) | undefined =>
  built.find((entry) => entry.what === "auth")?.onSession;

beforeEach(() => {
  handlers.clear();
  encryptionAvailable = true;
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "erp-cloudsync-test-"));
  signedIn = ADMIN;
  logged = [];
  built = [];
  prepared = [];
  deferral = null;
  summaryCalls = [];
  drainThrows = null;
  drainGate = null;
  releaseGate = null;
  inFlight = null;
  claimOutcome = { ok: true, epoch: 4, holder: "holder-4" };
  claimThrows = null;
  claimRequests = [];
  drainResult = { synced: 2, counts: { PENDING: 0, SYNCED: 2 } };
  pullResult = { fetched: 3, applied: 2, duplicates: 1, refused: [] };
  setEnv(GOOD_ENV);
  registerCloudSyncHandlers(buildContext());
});

afterEach(async () => {
  // Whatever a test did, no pass is left hanging on to the guard.
  await releasePass();
  fs.rmSync(dataRoot, { recursive: true, force: true });
  setEnv({});
});

describe("cloud sync at the process boundary", () => {
  it("exposes reading the status and running one pass, and nothing else", () => {
    expect([...handlers.keys()].sort()).toEqual([IPC.getCloudSyncStatus, IPC.runCloudSync].sort());
  });

  // ─── authorization ────────────────────────────────────────────────────────

  it("refuses to run a pass for a signed-in user who is not an administrator", async () => {
    signedIn = CLERK;
    await expect(run()).resolves.toEqual({
      accepted: false,
      reason: "Administrator access required",
      code: "ADMIN_REQUIRED",
    });
    expect(built).toEqual([]);
    expect(prepared).toEqual([]);
  });

  it("refuses to run a pass when nobody is signed in, or when access is not approved", async () => {
    signedIn = null;
    await expect(run()).resolves.toMatchObject({ accepted: false, code: "SESSION_REQUIRED" });
    signedIn = PENDING_ADMIN;
    await expect(run()).resolves.toMatchObject({ accepted: false, code: "ACCESS_NOT_APPROVED" });
    expect(built).toEqual([]);
  });

  it("lets any approved user read the status, administrator or not", async () => {
    signedIn = CLERK;
    await expect(status()).resolves.toEqual({
      configured: true,
      host: "zzdisposable.supabase.co",
      email: "device@example.test",
      running: false,
      queue: QUEUE,
      pullCursor: 7,
      waitingFor: undefined,
    });
  });

  // The status handler does NOT wrap its authorisation in the rejection shape the way
  // runCloudSync does -- it lets the error out, and Electron rejects the renderer's promise.
  // Recorded as the existing contract, not endorsed: the asymmetry is in the report.
  it("throws rather than answering when the status is read without a session", async () => {
    signedIn = null;
    await expect(status()).rejects.toThrow(/session has expired/i);
  });

  // ─── configuration ────────────────────────────────────────────────────────

  it("does nothing at all, and says which variables are missing, when none are set", async () => {
    setEnv({});
    const answer = await run();
    expect(answer.accepted).toBe(false);
    for (const key of Object.keys(GOOD_ENV)) expect(String(answer.reason)).toContain(`${key} is not set`);
    expect(built).toEqual([]);
    expect(prepared).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("refuses a partially configured computer without reaching the network", async () => {
    setEnv({ ...GOOD_ENV, ERP_DEVICE_PASSWORD: undefined });
    const answer = await run();
    expect(answer.accepted).toBe(false);
    expect(String(answer.reason)).toContain("ERP_DEVICE_PASSWORD is not set");
    expect(String(answer.reason)).not.toContain("ERP_SUPABASE_URL is not set");
    expect(built).toEqual([]);
  });

  it("refuses a service_role key, which would bypass every policy", async () => {
    setEnv({ ...GOOD_ENV, ERP_SUPABASE_ANON_KEY: SERVICE_ROLE_KEY });
    const answer = await run();
    expect(answer.accepted).toBe(false);
    expect(String(answer.reason)).toContain("service_role");
    expect(built).toEqual([]);
    // And the key itself is never echoed back to the renderer.
    expect(String(answer.reason)).not.toContain(SERVICE_ROLE_KEY);
  });

  it("refuses a plain http project address that is not loopback", async () => {
    setEnv({ ...GOOD_ENV, ERP_SUPABASE_URL: "http://zzdisposable.supabase.co" });
    const answer = await run();
    expect(answer.accepted).toBe(false);
    expect(String(answer.reason)).toContain("https");
    expect(built).toEqual([]);
  });

  it("reports an unconfigured computer through the status without a session being enough to sync", async () => {
    setEnv({});
    const answer = await status();
    expect(answer.configured).toBe(false);
    expect(answer.running).toBe(false);
    expect(Array.isArray(answer.problems)).toBe(true);
    expect(answer.host).toBeUndefined();
    expect(answer.email).toBeUndefined();
  });

  // ─── the status is inert ──────────────────────────────────────────────────

  it("reading the status starts no pass, writes nothing, and logs nothing", async () => {
    await status();
    await status();
    expect(built).toEqual([]);
    expect(logged).toEqual([]);
    // READ-ONLY, PROVED: every statement the status path ran, and every one of them is a read.
    expect(prepared.length).toBeGreaterThan(0);
    for (const statement of prepared) expect(statement.trimStart().slice(0, 6).toUpperCase()).toBe("SELECT");
  });

  it("reports the queue split by what can actually be sent, and how far the log has been read", async () => {
    const answer = await status();
    expect(answer.queue).toEqual(QUEUE);
    expect(answer.pullCursor).toBe(7);
    // The summary is asked about the transport's own list, not one of its own invention.
    expect(summaryCalls).toHaveLength(1);
    expect(summaryCalls[0]?.pushableTypes).toEqual(["QR_MASTER"]);
    expect(typeof summaryCalls[0]?.nowIso).toBe("string");
  });

  it("reports what a pull is waiting at, and says nothing when it is not waiting", async () => {
    expect((await status()).waitingFor).toBeUndefined();

    deferral = { seq: 12, until: Date.parse("2026-10-01T12:30:00.000Z"), attempts: 3 };
    expect((await status()).waitingFor).toEqual({
      seq: 12,
      attempts: 3,
      retryAfter: "2026-10-01T12:30:00.000Z",
    });
  });

  it("reports the queue even on a computer that is not set up for cloud sync", async () => {
    setEnv({});
    const answer = await status();
    expect(answer.configured).toBe(false);
    // The queue is a local fact. A computer with no cloud settings still has one, and an
    // operator still needs to see that nothing is going anywhere.
    expect(answer.queue).toEqual(QUEUE);
    expect(built).toEqual([]);
  });

  // ─── what a pass is allowed to send ───────────────────────────────────────

  it("tells the drain to claim exactly the transport's pushable list, and nothing more", async () => {
    await run();
    const drain = built.find((entry) => entry.what === "drain");
    expect(drain?.options?.deviceId).toBe("device-under-test");
    // The stub above exports ["QR_MASTER"]; the point is that whatever it exports is what arrives.
    expect(drain?.options?.aggregateTypes).toEqual(["QR_MASTER"]);

    // What this proves is the WIRING: whatever @erp/sync exports as SUPABASE_PUSHABLE_AGGREGATES
    // is what the drain is told to claim, and nothing else is -- no extra option that could widen
    // it. What the real list CONTAINS (now QR_MASTER and PRODUCTION_PRODUCED) is pinned in
    // packages/sync/src/supabaseTransport.test.ts; it cannot be re-checked here, because the real
    // module reaches node:sqlite and vite cannot load it in this environment.
    expect(Object.keys(drain?.options ?? {}).sort()).toEqual(["aggregateTypes", "deviceId"]);
  });

  // ─── one pass at a time ───────────────────────────────────────────────────

  it("refuses a second pass while one is running, and accepts one again afterwards", async () => {
    const first = startHeldPass();

    // The guard is set synchronously by the first call, before its drain resolves, so the
    // second call is refused without ever reaching the queue.
    const second = await run();
    expect(second).toEqual({
      accepted: false,
      reason: "A cloud sync is already running on this computer.",
    });

    await releasePass();
    await expect(first).resolves.toMatchObject({ accepted: true });
    // One pass ran, not two: the refused call built nothing of its own.
    expect(built.filter((entry) => entry.what === "drain")).toHaveLength(1);

    await expect(run()).resolves.toMatchObject({ accepted: true });
    expect(built.filter((entry) => entry.what === "drain")).toHaveLength(2);
  });

  it("releases the guard when a pass fails, so the computer is not stuck", async () => {
    drainThrows = new Error("the cloud could not be reached");
    await expect(run()).resolves.toMatchObject({ accepted: false });
    expect(await status()).toMatchObject({ running: false });

    drainThrows = null;
    await expect(run()).resolves.toMatchObject({ accepted: true });
  });

  it("shows a pass as not running, then running, then not running again", async () => {
    // The first read also warms the mocked @erp/sync: vitest cannot resolve a mocked module
    // from two dynamic imports racing each other, and the status read below deliberately
    // happens while the held pass is sitting inside its own import.
    expect(await status()).toMatchObject({ running: false });

    const pass = startHeldPass();
    // Let the pass get past its own dynamic import and settle on the gate first.
    await new Promise((resolve) => setImmediate(resolve));
    expect(await status()).toMatchObject({ running: true });

    await releasePass();
    await pass;
    expect(await status()).toMatchObject({ running: false });
  });

  // ─── what comes back ──────────────────────────────────────────────────────

  it("returns the counts of a completed pass and records who ran it", async () => {
    pullResult = { fetched: 3, applied: 2, duplicates: 1, refused: [] };
    await expect(run()).resolves.toEqual({
      accepted: true,
      reason: undefined,
      pushed: 2,
      fetched: 3,
      applied: 2,
      duplicates: 1,
      refused: [],
      waitingFor: undefined,
      outbox: { PENDING: 0, SYNCED: 2 },
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ severity: "INFO", operation: "cloud-sync", userId: "u-admin" });
    expect(logged[0]?.message).toContain("owner");
  });

  it("reports a transport failure as not accepted, while still handing back what did happen", async () => {
    drainResult = { synced: 1, counts: { PENDING: 4 }, transportError: "the cloud could not be reached" };
    const answer = await run();
    expect(answer.accepted).toBe(false);
    expect(answer.reason).toBe("the cloud could not be reached");
    expect(answer.pushed).toBe(1);
    expect(answer.outbox).toEqual({ PENDING: 4 });
  });

  it("passes refusals and a deferral back in the shape the renderer is typed for", async () => {
    pullResult = {
      fetched: 2,
      applied: 0,
      duplicates: 0,
      refused: [{ reason: "UNSUPPORTED_AGGREGATE_TYPE:DISPATCH_EVENT" }],
      waitingFor: { reason: "UNKNOWN_PRODUCT_VARIANT:variant-1" },
    };
    const answer = await run();
    expect(answer.refused).toEqual([{ reason: "UNSUPPORTED_AGGREGATE_TYPE:DISPATCH_EVENT" }]);
    expect(answer.waitingFor).toBe("UNKNOWN_PRODUCT_VARIANT:variant-1");
  });

  it("turns a thrown failure into a refusal and logs it as an error", async () => {
    drainThrows = new Error("getaddrinfo ENOTFOUND zzdisposable.supabase.co");
    const answer = await run();
    expect(answer).toEqual({ accepted: false, reason: "getaddrinfo ENOTFOUND zzdisposable.supabase.co" });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ severity: "ERROR", operation: "cloud-sync", userId: "u-admin" });
  });

  it("never hands the renderer the key, the password or the email of a failed sign-in", async () => {
    drainThrows = new Error("sign-in refused: invalid login credentials");
    const answer = await run();
    const serialised = JSON.stringify(answer);
    expect(serialised).not.toContain(GOOD_ENV.ERP_SUPABASE_ANON_KEY);
    expect(serialised).not.toContain(GOOD_ENV.ERP_DEVICE_PASSWORD);
    expect(JSON.stringify(logged)).not.toContain(GOOD_ENV.ERP_DEVICE_PASSWORD);
  });

  // ─── the claim comes first ──────────────────────────────────────────────

  it("claims this computer before a drain exists, naming its device and its workstation", async () => {
    await expect(run()).resolves.toMatchObject({ accepted: true });

    expect(claimRequests).toEqual([
      { deviceId: "device-under-test", workstationId: "ws-prod-01", appVersion: "0.3.0" },
    ]);
    // The ORDER is the control: a drain reclaims stale rows and leases a batch the moment it
    // runs, so it must not exist until the claim has succeeded.
    const order = built.map((entry) => entry.what);
    expect(order.indexOf("drain")).toBeGreaterThan(order.indexOf("transport"));
  });

  it("a refused claim builds no drain and changes nothing in the outbox", async () => {
    claimOutcome = { ok: false, reason: "REVOKED" };

    const answer = await run();
    expect(answer.accepted).toBe(false);
    expect(String(answer.reason)).toContain("REVOKED");
    expect(String(answer.reason)).toContain("nothing in the queue changed");

    // NOT ONE OUTBOX ROW TOUCHED: no drain was constructed, so reclaimStale and leaseBatch
    // never ran. This is what keeps a revoked device from parking its own queue.
    expect(built.filter((entry) => entry.what === "drain")).toEqual([]);
    expect(built.filter((entry) => entry.what === "pull")).toEqual([]);
    for (const statement of prepared) {
      expect(statement.trimStart().slice(0, 6).toUpperCase()).toBe("SELECT");
    }
  });

  it("names every refusal the migration can give, and treats none of them as an event failure", async () => {
    for (const reason of ["NOT_ENROLLED", "REVOKED", "BINDING_INCOMPLETE", "DEVICE_MISMATCH", "WORKSTATION_MISMATCH"]) {
      claimOutcome = { ok: false, reason };
      built = [];
      const answer = await run();
      expect(answer.accepted).toBe(false);
      expect(String(answer.reason)).toContain(reason);
      expect(built.filter((entry) => entry.what === "drain")).toEqual([]);
      // The queue is reported back so an operator can see it is intact, not lost.
      expect(answer.outbox).toEqual(QUEUE.counts);
    }
  });

  it("records a refused claim against the administrator who asked for the pass", async () => {
    claimOutcome = { ok: false, reason: "DEVICE_MISMATCH" };
    await run();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ severity: "WARNING", operation: "cloud-sync", userId: "u-admin" });
    expect(logged[0]?.message).toContain("DEVICE_MISMATCH");
    expect(logged[0]?.message).toContain("owner");
  });

  it("a claim that cannot reach the service is a refusal, not a parked queue", async () => {
    claimThrows = new Error("the cloud could not be reached");
    const answer = await run();
    expect(answer.accepted).toBe(false);
    expect(answer.reason).toBe("the cloud could not be reached");
    expect(built.filter((entry) => entry.what === "drain")).toEqual([]);
  });

  it("releases the running guard when the claim is refused", async () => {
    claimOutcome = { ok: false, reason: "REVOKED" };
    await run();
    expect(await status()).toMatchObject({ running: false });

    claimOutcome = { ok: true, epoch: 5, holder: "holder-5" };
    await expect(run()).resolves.toMatchObject({ accepted: true });
  });

  // THIS COMPUTER'S OWN CLOUD CREDENTIAL.
  //
  // The device password is a first-run input, not a permanent setting: once a refresh token for
  // this machine is stored, encrypted against the signed-in Windows user, the password has no
  // further use and should not stay in the environment. Three things have to hold for that to be
  // safe rather than merely convenient -- a credential belonging to a DIFFERENT device is worth
  // nothing, a failure to store one never fails the pass, and the token never travels back to the
  // renderer or into a log.
  describe("the stored device credential", () => {
    it("still needs the password on a computer that has never synced", async () => {
      setEnv({ ...GOOD_ENV, ERP_DEVICE_PASSWORD: undefined });
      expect((await run()).accepted).toBe(false);
      expect(built).toEqual([]);
    });

    it("runs a pass without the password once a credential for this device is stored", async () => {
      storeCredential();
      setEnv({ ...GOOD_ENV, ERP_DEVICE_EMAIL: undefined, ERP_DEVICE_PASSWORD: undefined });
      expect((await run()).accepted).toBe(true);
      const auth = built.find((entry) => entry.what === "auth");
      expect(auth?.options).toMatchObject({ refreshToken: "stored-refresh-token" });
    });

    it("says so through the status too, rather than calling the computer unconfigured", async () => {
      setEnv({ ...GOOD_ENV, ERP_DEVICE_EMAIL: undefined, ERP_DEVICE_PASSWORD: undefined });
      expect(await status()).toMatchObject({ configured: false });
      storeCredential();
      expect(await status()).toMatchObject({ configured: true });
    });

    it("ignores a credential provisioned for another device, and asks for the password again", async () => {
      // A COPIED DATA FOLDER, or a machine re-identified after a restore. Signing in with
      // another device's token would push this computer's scans as that machine.
      storeCredential("some-other-computer");
      setEnv({ ...GOOD_ENV, ERP_DEVICE_PASSWORD: undefined });
      expect((await run()).accepted).toBe(false);
      expect(built).toEqual([]);
    });

    it("does not hand the auth another device's token even when the password is present", async () => {
      storeCredential("some-other-computer");
      expect((await run()).accepted).toBe(true);
      const auth = built.find((entry) => entry.what === "auth");
      expect(auth?.options).toMatchObject({ refreshToken: undefined });
    });

    it("stores what the sign-in returned, and says the password is no longer needed", async () => {
      await run();
      sessionSink()?.({ userId: "auth-user-1", refreshToken: "fresh-token" });
      expect(readCredential()).toMatchObject({
        authUserId: "auth-user-1",
        deviceId: "device-under-test",
        refreshToken: "fresh-token",
      });
      expect(logged).toContainEqual(
        expect.objectContaining({ severity: "INFO", operation: "device-credential" })
      );
    });

    it("replaces a rotated token without announcing a first-run enrolment again", async () => {
      storeCredential();
      await run();
      logged = [];
      sessionSink()?.({ userId: "auth-user-1", refreshToken: "rotated-token" });
      expect(readCredential()).toMatchObject({ refreshToken: "rotated-token" });
      expect(logged.filter((entry) => entry.operation === "device-credential")).toEqual([]);
    });

    it("warns but does not fail the pass when this machine cannot encrypt", async () => {
      // Without OS key storage nothing is written rather than a readable token being left on
      // disk -- and the pass itself was fine, so it is not turned into a failure.
      encryptionAvailable = false;
      expect((await run()).accepted).toBe(true);
      sessionSink()?.({ userId: "auth-user-1", refreshToken: "fresh-token" });
      expect(readCredential()).toBeNull();
      expect(logged).toContainEqual(
        expect.objectContaining({ severity: "WARNING", operation: "device-credential" })
      );
    });

    it("never writes the token into a log line, whatever happens to it", async () => {
      await run();
      sessionSink()?.({ userId: "auth-user-1", refreshToken: "fresh-token" });
      encryptionAvailable = false;
      sessionSink()?.({ userId: "auth-user-1", refreshToken: "second-token" });
      for (const entry of logged) {
        expect(entry.message).not.toContain("fresh-token");
        expect(entry.message).not.toContain("second-token");
        expect(entry.message).not.toContain("device-password");
      }
    });
  });

  it("never lets a claim refusal carry a secret back to the renderer", async () => {
    claimOutcome = { ok: false, reason: "REVOKED" };
    const answer = await run();
    const serialised = JSON.stringify(answer) + JSON.stringify(logged);
    expect(serialised).not.toContain(GOOD_ENV.ERP_SUPABASE_ANON_KEY);
    expect(serialised).not.toContain(GOOD_ENV.ERP_DEVICE_PASSWORD);
  });

});
