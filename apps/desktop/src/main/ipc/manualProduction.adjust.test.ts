// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorizationError } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { registerManualProductionHandlers } from "./manualProduction";

// A CARTON ADJUSTMENT AT THE PROCESS BOUNDARY: administrators only, read from the session, whatever the
// screen sends. A refused person writes nothing and reads nothing.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("../leaseGuard", () => ({
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, handler) },
}));

const db = {
  adjustCartonStock: vi.fn(),
  cartonStockReconciliation: vi.fn(),
};
let admin: { id: string; username: string } | null;
const authorizer = {
  requireAdmin: vi.fn(() => {
    if (admin === null) throw new AuthorizationError("ADMIN_REQUIRED");
    return admin;
  }),
  requirePermission: vi.fn(),
};
const context = {
  db,
  logger: { log: vi.fn() },
  authorizer,
  scanContext: { factoryId: "factory-777" },
  deviceId: "dev-1",
} as unknown as IpcContext;

const call = (channel: string, input: unknown) => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({} as IpcMainInvokeEvent, input) as Record<string, unknown>;
};

const asked = { requestId: "r-1", articleSizeId: "as-1", color: "RED", direction: "OUT", cartons: 3, reason: "counted", adjustedBy: "someone-else", storeLocationId: "elsewhere" };

beforeEach(() => {
  handlers.clear();
  admin = { id: "u-1", username: "owner" };
  db.adjustCartonStock.mockReset().mockReturnValue({ eventId: "r-1", eventType: "CARTON_ADJUST_OUT", cartons: 3, balanceDelta: -3, duplicate: false });
  db.cartonStockReconciliation.mockReset().mockReturnValue({ rows: [] });
  registerManualProductionHandlers(context);
});

describe("adjusting carton stock", () => {
  it("is refused for anyone but an administrator, writing nothing", () => {
    admin = null;
    expect(call(IPC.adjustCartonStock, asked)).toMatchObject({ accepted: false, reason: "Administrator access required" });
    expect(db.adjustCartonStock).not.toHaveBeenCalled();
  });

  it("names who adjusted and where from the session and this computer, never from the screen", () => {
    expect(call(IPC.adjustCartonStock, asked)).toEqual({ accepted: true, duplicate: false });
    expect(db.adjustCartonStock.mock.calls[0]?.[0]).toMatchObject({ adjustedBy: "owner", storeLocationId: "factory-777", reason: "counted", direction: "OUT", cartons: 3 });
  });

  it("says a refusal in the data layer's own words", () => {
    db.adjustCartonStock.mockImplementation(() => { throw new Error("Give a reason for this adjustment."); });
    expect(call(IPC.adjustCartonStock, asked)).toMatchObject({ accepted: false, reason: "Give a reason for this adjustment." });
  });
});

describe("reading the reconciliation", () => {
  it("is for an administrator too", () => {
    admin = null;
    expect(call(IPC.getCartonStockReconciliation, { page: 1, pageSize: 25 })).toMatchObject({ accepted: false, reconciliation: null });
    expect(db.cartonStockReconciliation).not.toHaveBeenCalled();
  });

  it("hands back what the data layer read", () => {
    expect(call(IPC.getCartonStockReconciliation, { page: 2, pageSize: 25 })).toEqual({ accepted: true, reconciliation: { rows: [] } });
    expect(db.cartonStockReconciliation).toHaveBeenCalledWith({ page: 2, pageSize: 25 });
  });
});
