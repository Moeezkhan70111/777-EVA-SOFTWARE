// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION } from "@erp/domain";
import { AuthorizationError } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import { registerStoreHandlers } from "./store";
import { registerMachineProgramHandlers } from "./machinePrograms";
import type { IpcContext } from "./context";

// THE STORE PAGE'S TWO NEW READS (0.3.9), at the process boundary.
//
//   Issue sessions: "this computer" is resolved here, never sent by the screen.
//   Open machine programs: a store operator may read them for the Machine programs pick-list.
//
// What the lists hold is proved in @erp/data (rawMaterialMovement, machineProgram tests).

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

const event = {} as IpcMainInvokeEvent;
const OPEN_PROGRAMS = [{ programId: "p-3", code: "MP-000003", programDate: "2026-10-13", machineName: "MACHINE 2", contractorName: "BABAR" }];
const listRawMaterialIssueSessions = vi.fn(() => []);
let granted: readonly string[] = [];

function register(): void {
  const ctx = {
    db: { listRawMaterialIssueSessions, listOpenMachinePrograms: () => OPEN_PROGRAMS },
    logger: { log: () => undefined },
    deviceId: "device-1",
    scanContext: {},
    useCases: {},
    authorizer: {
      requireAnyPermission: (_event: IpcMainInvokeEvent, permissions: readonly string[]) => {
        if (!permissions.some((permission) => granted.includes(permission))) throw new AuthorizationError("PERMISSION_DENIED");
        return { id: "u-1", username: "store", role: "USER" };
      },
      requirePermission: () => ({ id: "u-1", username: "store", role: "USER" }),
      requireAdmin: () => ({ id: "u-1", username: "store", role: "USER" }),
    },
  } as unknown as IpcContext;
  registerStoreHandlers(ctx);
  registerMachineProgramHandlers(ctx);
}

beforeEach(() => {
  handlers.clear();
  listRawMaterialIssueSessions.mockClear();
  granted = [];
  register();
});

describe("issue sessions, listed", () => {
  it("reads every computer's sessions unless this computer's alone are asked for", async () => {
    await handlers.get(IPC.listRawMaterialIssueSessions)?.(event, { dateFrom: "2026-10-30", dateTo: "2026-10-30" });
    expect(listRawMaterialIssueSessions).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: undefined, dateFrom: "2026-10-30" }));

    await handlers.get(IPC.listRawMaterialIssueSessions)?.(event, { thisComputerOnly: true, status: "CLOSED", limit: 1 });
    expect(listRawMaterialIssueSessions).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: "device-1", status: "CLOSED", limit: 1 }));
  });

  it("never takes a computer named by the screen", async () => {
    await handlers.get(IPC.listRawMaterialIssueSessions)?.(event, { deviceId: "someone-else" });
    expect(listRawMaterialIssueSessions).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: undefined }));
  });
});

describe("open machine programs, read from the store", () => {
  it("are listed for a store operator", async () => {
    granted = [PERMISSION.STORE_SCANNING];
    expect(await handlers.get(IPC.listOpenMachinePrograms)?.(event)).toEqual({ accepted: true, rows: OPEN_PROGRAMS });
  });

  it("are listed for whoever holds Machine Program, as before", async () => {
    granted = [PERMISSION.MACHINE_PROGRAM];
    expect(await handlers.get(IPC.listOpenMachinePrograms)?.(event)).toMatchObject({ accepted: true });
  });

  it("are refused to anyone else", async () => {
    granted = [PERMISSION.STOCK];
    expect(await handlers.get(IPC.listOpenMachinePrograms)?.(event)).toMatchObject({ accepted: false, rows: [] });
  });
});
