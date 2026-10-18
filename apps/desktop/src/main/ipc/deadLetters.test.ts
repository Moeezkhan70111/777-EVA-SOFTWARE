// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Authorizer, type SessionUser } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import { registerDeadLetterHandlers, type DeadLetterContext } from "./deadLetters";

// What the renderer can and cannot do to a parked sync event.
//
// Recovering one is the only way an event that stopped being sent can ever be sent again, so
// three things have to hold at the process boundary: only an administrator may look or act,
// only ONE explicitly named event moves per call, and every act is written to the log with the
// name of whoever did it. Whether a given row may be requeued is the queue's rule — proved in
// @erp/sync's productionSlice tests against a real disposable database — so here the queue is a
// stand-in that answers or refuses on cue.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

const PARKED = {
  outboxId: "outbox-1",
  dedupeKey: "QR_MASTER:SK9_BLACK_7/10_000001",
  aggregateType: "QR_MASTER",
  aggregateId: "SK9_BLACK_7/10_000001",
  attempts: 5,
  transientAttempts: 0,
  error: "42501:row-level security refused this device",
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:30:00.000Z",
};

let requeueOutcome: unknown;
let requeuedIds: string[];

vi.mock("@erp/sync", () => ({
  deadLetters: () => [PARKED],
  requeueDeadLetter: (_sql: unknown, outboxId: string) => {
    requeuedIds.push(outboxId);
    return requeueOutcome;
  },
}));

// The handlers only hand the event to the authoriser, which reads `event.sender.id` to find the
// session that window proved. A stand-in is enough, and keeps a real window out of the test.
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

let signedIn: SessionUser | null;
let logged: Array<{ severity: string; operation: string; message: string; userId?: string }>;

const build = (): DeadLetterContext => {
  const authorizer = new Authorizer(() => signedIn);
  authorizer.bind(windowEvent, "session-token");
  return {
    db: { db: {} as DeadLetterContext["db"]["db"] },
    logger: {
      log: (entry) =>
        logged.push({
          severity: entry.severity,
          operation: entry.operation,
          message: entry.message,
          userId: entry.userId,
        }),
    },
    authorizer,
    deviceId: "device-under-test",
  };
};

const invoke = async (channel: string, ...args: unknown[]): Promise<Record<string, unknown>> => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return (await handler(windowEvent, ...args)) as Record<string, unknown>;
};

const list = () => invoke(IPC.listDeadLetterEvents);
const requeue = (id?: unknown) => invoke(IPC.requeueDeadLetterEvent, id);

beforeEach(() => {
  handlers.clear();
  signedIn = ADMIN;
  logged = [];
  requeuedIds = [];
  requeueOutcome = { requeued: true, entry: PARKED };
  registerDeadLetterHandlers(build());
});

describe("parked sync events at the process boundary", () => {
  it("exposes reading the parked events and requeuing one, and nothing else", () => {
    expect([...handlers.keys()].sort()).toEqual([IPC.listDeadLetterEvents, IPC.requeueDeadLetterEvent].sort());
  });

  it("lists the parked events for an administrator, with no payload and no log entry", async () => {
    await expect(list()).resolves.toEqual({ accepted: true, entries: [PARKED] });
    expect(logged).toEqual([]);
    expect(Object.keys(PARKED)).not.toContain("payload");
  });

  it("refuses to list them for a signed-in user who is not an administrator", async () => {
    signedIn = CLERK;
    await expect(list()).resolves.toEqual({
      accepted: false,
      reason: "Administrator access required",
      code: "ADMIN_REQUIRED",
    });
  });

  it("refuses every operation when nobody is signed in", async () => {
    signedIn = null;
    await expect(list()).resolves.toMatchObject({ accepted: false, code: "SESSION_REQUIRED" });
    await expect(requeue("outbox-1")).resolves.toMatchObject({ accepted: false, code: "SESSION_REQUIRED" });
    expect(requeuedIds).toEqual([]);
  });

  it("refuses an administrator whose access has not been approved", async () => {
    signedIn = PENDING_ADMIN;
    await expect(requeue("outbox-1")).resolves.toMatchObject({
      accepted: false,
      code: "ACCESS_NOT_APPROVED",
    });
    expect(requeuedIds).toEqual([]);
  });

  it("refuses a requeue for a non-administrator and never touches the queue", async () => {
    signedIn = CLERK;
    await expect(requeue("outbox-1")).resolves.toMatchObject({ accepted: false, code: "ADMIN_REQUIRED" });
    expect(requeuedIds).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("requeues the one named event and writes who did it to the log", async () => {
    await expect(requeue("outbox-1")).resolves.toEqual({ accepted: true, entry: PARKED });
    expect(requeuedIds).toEqual(["outbox-1"]);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.operation).toBe("requeue-dead-letter");
    expect(logged[0]?.severity).toBe("WARNING");
    expect(logged[0]?.userId).toBe("u-admin");
    // The entry has to say who, what, and why it had stopped.
    expect(logged[0]?.message).toContain("owner");
    expect(logged[0]?.message).toContain("SK9_BLACK_7/10_000001");
    expect(logged[0]?.message).toContain("42501");
  });

  it("takes one id and only one: an array or a number reaches the queue as nothing", async () => {
    for (const bad of [undefined, null, "", "   ", 7, ["outbox-1", "outbox-2"], { outboxId: "outbox-1" }]) {
      const answer = await requeue(bad);
      expect(answer.accepted).toBe(false);
      expect(answer.reason).toBe("Choose the parked event to put back.");
    }
    expect(requeuedIds).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("passes the queue's refusal back as it is, and records the attempt", async () => {
    requeueOutcome = { requeued: false, reason: "NOT_FOUND" };
    const missing = await requeue("ghost");
    expect(missing.accepted).toBe(false);
    expect(missing.reason).toContain("not in this computer's queue");

    requeueOutcome = { requeued: false, reason: "NOT_DEAD_LETTERED", status: "PENDING" };
    const live = await requeue("outbox-1");
    expect(live.accepted).toBe(false);
    expect(live.reason).toContain("PENDING");
    expect(live.reason).toContain("Only a parked event can be put back");

    // A refused attempt is still an attempt, and says who made it.
    expect(logged).toHaveLength(2);
    expect(logged.every((entry) => entry.operation === "requeue-dead-letter")).toBe(true);
    expect(logged.every((entry) => entry.userId === "u-admin")).toBe(true);
  });
});
