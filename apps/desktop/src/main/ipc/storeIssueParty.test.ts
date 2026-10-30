// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipcChannels";
import { registerStoreHandlers } from "./store";
import type { IpcContext } from "./context";

// ONE ISSUE SESSION, ONE PARTY (0.3.8), at the process boundary.
//
// Move Out locks the party once a session starts, but a hidden picker is not the rule: the main
// process refuses a scan for a party other than the one the session's first packet went to, before
// the scan reaches the use case. Which party that is comes from the data layer
// (rawMaterialIssueSessionPartyId, proved in @erp/data's rawMaterialMovement tests); here the
// database and the use case are stand-ins that answer on cue.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

// The scan is a store-leased write. The lease gate is proved in leaseGuard.test.ts; here the
// handler is reached directly, so this tests the party rule alone.
vi.mock("../leaseGuard", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

const event = {} as IpcMainInvokeEvent;
const OPEN = { id: "session-1", status: "OPEN" };
const ISSUED = { accepted: true, outcome: "ISSUED" };

let sessionParty: string | null = null;
const execute = vi.fn(async () => ISSUED);

function register(): void {
  const db = {
    getUserBySessionToken: () => ({ username: "store-op", accessStatus: "APPROVED", role: "ADMIN", permissions: [] }),
    getRawMaterialIssueSession: () => OPEN,
    rawMaterialIssueSessionPartyId: () => sessionParty,
    getParty: (id: string) => (id === "party-a" ? { partyName: "ABC UPPER" } : null),
    getOpenRawMaterialIssueSession: () => OPEN,
  };
  const ctx = {
    db,
    logger: { log: () => undefined },
    authorizer: {},
    scanContext: {},
    deviceId: "device-1",
    useCases: { issueRawMaterialScanUseCase: { execute } },
  } as unknown as IpcContext;
  registerStoreHandlers(ctx);
}

const scan = (issuedToPartyId: string) =>
  handlers.get(IPC.rawMaterialIssueScan)?.(event, "RM_6_10_1", { token: "t-1", sessionId: "session-1", issuedToPartyId });

beforeEach(() => {
  handlers.clear();
  execute.mockClear();
  sessionParty = null;
  register();
});

describe("a Move Out session belongs to one party", () => {
  it("lets the first packet of a session go to any eligible party", async () => {
    expect(await scan("party-b")).toEqual(ISSUED);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ issuedToPartyId: "party-b" }));
  });

  it("lets every later packet go to the session's party", async () => {
    sessionParty = "party-a";
    expect(await scan("party-a")).toEqual(ISSUED);
  });

  it("refuses a packet for another party, naming the session's, before it reaches the use case", async () => {
    sessionParty = "party-a";
    const result = await scan("party-b");
    expect(result).toMatchObject({ accepted: false, outcome: "NO_PARTY" });
    expect(String((result as { reason?: string }).reason)).toMatch(/go to ABC UPPER/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("finds the open session without starting one", () => {
    expect(handlers.get(IPC.getOpenRawMaterialIssueSession)?.(event)).toEqual(OPEN);
  });
});
