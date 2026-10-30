// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorizationError } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import { registerMachineProgramHandlers } from "./machinePrograms";
import type { IpcContext } from "./context";

// DELETING A MACHINE PROGRAM (0.3.8), at the process boundary: administrators only, whatever the
// screen shows, and the typed reason is what reaches the use case. That the use case refuses a
// missing or short reason, and audits it, is proved in @erp/data's machineProgram tests.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

const event = {} as IpcMainInvokeEvent;
const CANCELLED = { accepted: true, outcome: "CANCELLED", programId: "p-3" };
const execute = vi.fn(async () => CANCELLED);
let admin = true;

function register(): void {
  const ctx = {
    db: {},
    logger: { log: () => undefined },
    deviceId: "device-1",
    authorizer: {
      requireAdmin: () => {
        if (!admin) throw new AuthorizationError("ADMIN_REQUIRED");
        return { id: "u-owner", username: "owner", role: "ADMIN" };
      },
      requirePermission: () => ({ id: "u-owner", username: "owner", role: "ADMIN" }),
    },
    useCases: { machineProgram: { deleteProgram: { execute } } },
  } as unknown as IpcContext;
  registerMachineProgramHandlers(ctx);
}

const remove = (reason: unknown) => handlers.get(IPC.deleteMachineProgram)?.(event, "p-3", reason);

beforeEach(() => {
  handlers.clear();
  execute.mockClear();
  admin = true;
  register();
});

describe("deleting a machine program", () => {
  it("is refused for anyone but an administrator, before the use case runs", async () => {
    admin = false;
    expect(await remove("Never ran, trial only")).toMatchObject({ accepted: false, outcome: "NOT_AUTHORIZED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("hands the administrator's typed reason, and who they are, to the use case", async () => {
    expect(await remove("Never ran, trial only")).toEqual(CANCELLED);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ programId: "p-3", reason: "Never ran, trial only", actor: "owner", actorUserId: "u-owner", deviceId: "device-1" })
    );
  });

  it("sends an empty reason rather than anything else when none is a string, so the use case refuses it", async () => {
    await remove({ not: "a reason" });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ reason: "" }));
  });
});
