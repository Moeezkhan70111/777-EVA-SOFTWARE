// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Authorizer, type SessionUser } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import { LEASED_CHANNELS } from "../leaseChannels";
import { registerSyncWaitingHandlers, type SyncWaitingContext } from "./syncWaiting";

// What the renderer can learn about waits, and the one thing it can do about one.
//
// Reading this computer's waits is for every signed-in user, because the stock screen marks its
// rows from it. Other computers' reports and sending a record again are an administrator's, and
// sending again is a leased write. Which waits exist, and what marking does, are proved in
// @erp/sync and @erp/data against real databases; here they are stand-ins.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("../leaseGuard", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

let factoryHealth: unknown;
vi.mock("../cloudSyncPass", () => ({ readFactorySyncHealth: () => Promise.resolve(factoryHealth) }));

const ENTRY = {
  dedupeKey: "INVENTORY_ITEM:i-1:2", aggregateType: "INVENTORY_ITEM", aggregateId: "i-1", name: "NAWAAR",
  cause: { kind: "MISSING", record: "INVENTORY_CATEGORY", id: "c-17" }, since: "2026-10-23T00:00:00.000Z",
  ageMs: 3 * 86_400_000, tier: "STALE", itemId: "i-1",
};
const RUN = { ...ENTRY, dedupeKey: "RAW_MATERIAL_QR_BATCH:b-1:1", aggregateType: "RAW_MATERIAL_QR_BATCH", aggregateId: "b-1", itemId: "i-2" };
const OTHER = { ...ENTRY, dedupeKey: "PARTY:p-1:1", aggregateType: "PARTY", aggregateId: "p-1", itemId: null };

vi.mock("@erp/sync", () => ({
  waitingSummary: () => ({ entries: [ENTRY, RUN, OTHER], waiting: 0, stuck: 0, stale: 3, oldestSince: ENTRY.since }),
  unsentMarkCount: () => 2,
  outboxCounts: () => ({ DEAD_LETTER: 1 }),
}));

const windowEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
const ADMIN: SessionUser = { id: "u-admin", username: "owner", role: "ADMIN", accessStatus: "APPROVED", permissions: [] };
const CLERK: SessionUser = { ...ADMIN, id: "u-clerk", username: "babar", role: "USER" };

let signedIn: SessionUser | null;
let marked: Array<[string, string]>;
let markOutcome: string;
let logged: string[];

const build = (): SyncWaitingContext => {
  const authorizer = new Authorizer(() => signedIn);
  authorizer.bind(windowEvent, "session-token");
  const materials = new Set(["i-1"]);
  return {
    db: {
      db: { prepare: () => ({ get: (id: string) => (materials.has(id) ? { here: 1 } : undefined) }) } as unknown as SyncWaitingContext["db"]["db"],
      markRecordToSendAgain: ((type: string, id: string) => {
        marked.push([type, id]);
        return markOutcome;
      }) as SyncWaitingContext["db"]["markRecordToSendAgain"],
    },
    logger: { log: (entry) => logged.push(entry.message) },
    authorizer,
    deviceId: "device-under-test",
  };
};

const invoke = async (channel: string, ...args: unknown[]): Promise<Record<string, unknown>> => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return (await handler(windowEvent, ...args)) as Record<string, unknown>;
};

beforeEach(() => {
  handlers.clear();
  signedIn = CLERK;
  marked = [];
  markOutcome = "MARKED";
  logged = [];
  factoryHealth = [];
  registerSyncWaitingHandlers(build());
});

describe("waits at the process boundary", () => {
  it("gives any signed-in user this computer's waits, each saying whether its material is here", async () => {
    const reply = await invoke(IPC.getSyncWaiting);
    expect(reply.accepted).toBe(true);
    const value = reply.value as { entries: Array<{ itemHere: boolean | null }>; unsentMarks: number; deadLetters: number };
    expect(value.entries.map((entry) => entry.itemHere)).toEqual([true, false, null]);
    expect([value.unsentMarks, value.deadLetters]).toEqual([2, 1]);
  });

  it("refuses someone not signed in", async () => {
    signedIn = null;
    await expect(invoke(IPC.getSyncWaiting)).resolves.toMatchObject({ accepted: false });
  });

  it("shows other computers' reports to an administrator only, and says so before the first pass", async () => {
    await expect(invoke(IPC.getFactorySyncHealth)).resolves.toMatchObject({ accepted: false });
    signedIn = ADMIN;
    await expect(invoke(IPC.getFactorySyncHealth)).resolves.toEqual({ accepted: true, value: [] });
    factoryHealth = null;
    await expect(invoke(IPC.getFactorySyncHealth)).resolves.toMatchObject({ accepted: false, reason: expect.stringContaining("Sync once") });
  });

  it("sends one named record again, for an administrator, under the master-data lease, and logs who", async () => {
    expect(LEASED_CHANNELS[IPC.sendMasterRecordAgain]).toEqual(["MASTER_DATA"]);
    await expect(invoke(IPC.sendMasterRecordAgain, "INVENTORY_CATEGORY:c-17")).resolves.toMatchObject({ accepted: false });
    expect(marked).toEqual([]);

    signedIn = ADMIN;
    await expect(invoke(IPC.sendMasterRecordAgain, "INVENTORY_CATEGORY:c-17")).resolves.toEqual({ accepted: true });
    expect(marked).toEqual([["INVENTORY_CATEGORY", "c-17"]]);
    expect(logged.at(-1)).toContain("owner asked to send INVENTORY_CATEGORY c-17 again: MARKED");
  });

  it("refuses a malformed key, and says why a record could not be marked", async () => {
    signedIn = ADMIN;
    for (const key of [undefined, "", "c-17", ["INVENTORY_CATEGORY:c-17"]]) {
      await expect(invoke(IPC.sendMasterRecordAgain, key)).resolves.toMatchObject({ accepted: false });
    }
    expect(marked).toEqual([]);
    markOutcome = "NOT_HERE";
    await expect(invoke(IPC.sendMasterRecordAgain, "INVENTORY_CATEGORY:c-404")).resolves.toEqual({
      accepted: false,
      reason: "This computer does not have that record, so it has nothing to send.",
    });
  });
});
