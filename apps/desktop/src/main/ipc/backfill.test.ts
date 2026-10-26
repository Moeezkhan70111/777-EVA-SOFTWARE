// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Authorizer, type SessionUser } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import { LEASED_CHANNELS } from "../leaseChannels";
import { registerBackfillHandlers, type BackfillContext } from "./backfill";

// Who may see and send the store's history. What the backfill marks, and when it refuses, is proved
// in @erp/data against a real database; here the database is a stand-in that answers on cue.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("../leaseGuard", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

const PLAN = {
  masterEpoch: 2, storeEpoch: 3, masterRecords: { INVENTORY_ITEM: 903 }, stockMovements: 4100,
  labelRunsToQueue: 12, packetsToQueue: 300, unstampedQueued: 0, mismatches: [],
};

const windowEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
const ADMIN: SessionUser = { id: "u-admin", username: "owner", role: "ADMIN", accessStatus: "APPROVED", permissions: [] };
const CLERK: SessionUser = { ...ADMIN, id: "u-clerk", username: "babar", role: "USER" };

let signedIn: SessionUser | null;
let runs: number;
let outcome: unknown;
let logged: string[];

const build = (): BackfillContext => {
  const authorizer = new Authorizer(() => signedIn);
  authorizer.bind(windowEvent, "session-token");
  return {
    db: {
      planBackfill: (() => PLAN) as unknown as BackfillContext["db"]["planBackfill"],
      lastBackfillAt: () => "2026-10-26T09:00:00.000Z",
      runBackfill: (() => {
        runs += 1;
        return outcome;
      }) as unknown as BackfillContext["db"]["runBackfill"],
    },
    logger: { log: (entry) => logged.push(entry.message) },
    authorizer,
    deviceId: "device-under-test",
  };
};

const invoke = async (channel: string): Promise<Record<string, unknown>> => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return (await handler(windowEvent)) as Record<string, unknown>;
};

beforeEach(() => {
  handlers.clear();
  signedIn = ADMIN;
  runs = 0;
  outcome = { done: true, plan: PLAN };
  logged = [];
  registerBackfillHandlers(build());
});

describe("the backfill at the process boundary", () => {
  it("is a write under both leases", () => {
    expect([...(LEASED_CHANNELS[IPC.runBackfill] ?? [])].sort()).toEqual(["MASTER_DATA", "RAW_MATERIAL_STORE"]);
  });

  it("shows an administrator the plan and when it last ran, and nobody else", async () => {
    await expect(invoke(IPC.getBackfillPlan)).resolves.toEqual({ accepted: true, value: { plan: PLAN, lastAt: "2026-10-26T09:00:00.000Z" } });
    signedIn = CLERK;
    await expect(invoke(IPC.getBackfillPlan)).resolves.toMatchObject({ accepted: false });
  });

  it("runs for an administrator only, and logs who", async () => {
    signedIn = CLERK;
    await expect(invoke(IPC.runBackfill)).resolves.toMatchObject({ accepted: false });
    expect(runs).toBe(0);
    signedIn = ADMIN;
    await expect(invoke(IPC.runBackfill)).resolves.toEqual({ accepted: true, plan: PLAN });
    expect(logged.at(-1)).toContain("owner sent this computer's history");
  });

  it("says why it refused, with the plan, so the materials that do not add up can be listed", async () => {
    const plan = { ...PLAN, mismatches: [{ itemId: "i-1", displayName: "Dana", balance: 7, fromMovements: 5, unitDiffers: false }] };
    outcome = { done: false, reason: "STOCK_DOES_NOT_ADD_UP", plan };
    const reply = await invoke(IPC.runBackfill);
    expect(reply).toMatchObject({ accepted: false, plan });
    expect(String(reply.reason)).toContain("do not add up");
  });
});
