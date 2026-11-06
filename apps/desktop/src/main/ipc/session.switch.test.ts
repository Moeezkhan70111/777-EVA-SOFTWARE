// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { registerSessionHandlers } from "./session";

// THE SWITCH AT THE PROCESS BOUNDARY: only a plain yes from the screen goes past a warning that people
// would lose screens, and a warning signs nobody in.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
const switchNow = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
  app: { getVersion: () => "0.0.0" },
}));
vi.mock("../cloudSyncPass", () => ({
  isCloudSyncConfigured: () => true,
  signedInTransport: async () => ({ ok: false }),
}));
vi.mock("../cloudAccounts", async (original) => ({
  ...(await original<typeof import("../cloudAccounts")>()),
  switchThisComputerToCloud: (...args: unknown[]) => switchNow(...args),
}));

const bind = vi.fn();
const context = {
  db: {},
  logger: {},
  deviceId: "dev-1",
  authorizer: { requireAdmin: () => ({ id: "u-1", username: "Owner" }), bind },
  sessionStore: {},
  paths: { dataRoot: "x" },
  dbPath: "x",
  dataMigration: {},
  useCases: {},
} as unknown as IpcContext;

const press = (acceptLosses?: unknown) => {
  const handler = handlers.get(IPC.switchToCloudAccounts);
  if (!handler) throw new Error("no handler");
  return handler({} as IpcMainInvokeEvent, "token", "boss@777.pk", "owner1234", acceptLosses);
};
const askedToAccept = () => (switchNow.mock.calls.at(-1)?.[1] as { acceptLosses: boolean }).acceptLosses;

describe("the switch at the process boundary", () => {
  beforeEach(() => {
    handlers.clear();
    bind.mockClear();
    switchNow.mockReset().mockResolvedValue({ kind: "REFUSED", message: "stop here" });
    registerSessionHandlers(context);
  });

  it("carries the admin's yes through", async () => {
    await press(true);
    expect(askedToAccept()).toBe(true);
  });

  it("takes nothing else for a yes", async () => {
    for (const value of [undefined, false, "true", 1, {}]) {
      await press(value);
      expect(askedToAccept()).toBe(false);
    }
  });

  it("hands back who would lose what, not accepted, and signs nobody in", async () => {
    const losses = [{ username: "Biller", screens: ["stock"] }];
    switchNow.mockResolvedValue({ kind: "WOULD_LOSE_ACCESS", losses });
    expect(await press()).toEqual({ accepted: false, reason: "", accessLosses: losses });
    expect(bind).not.toHaveBeenCalled();
  });
});
