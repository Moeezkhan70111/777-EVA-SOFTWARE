// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Authorizer, type SessionUser } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import { leasesFor } from "../leaseChannels";
import { registerCartonStockAdjustmentHandlers } from "./cartonStockAdjustments";

// Stock Adjustment at the process boundary (docs/46): administrators only, who posted it and where taken from the
// session and this computer, never from the screen, and a refusal said in the data layer's words. The write is
// classified under the carton lease only. What posting does to the database is proved on real databases in @erp/data
// cartonStockDocuments.test.ts and @erp/sync cartonStockDocuments.test.ts.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
vi.mock("../leaseGuard", () => ({
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, handler) },
}));

const windowEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
const ADMIN: SessionUser = { id: "u-admin", username: "owner", role: "ADMIN", accessStatus: "APPROVED", permissions: [] };
const CLERK: SessionUser = { ...ADMIN, id: "u-clerk", username: "babar", role: "USER" };

let signedIn: SessionUser | null;
const post = vi.fn();

beforeEach(() => {
  handlers.clear();
  signedIn = ADMIN;
  post.mockReset().mockReturnValue({ document: { code: "SA-000001", kind: "OPENING", cartonsIn: 20, cartonsOut: 0, lines: [{}] }, duplicate: false });
  const authorizer = new Authorizer(() => signedIn);
  authorizer.bind(windowEvent, "session-token");
  registerCartonStockAdjustmentHandlers({
    db: { postCartonStockAdjustment: post, cartonAdjustmentArticle: () => [], listCartonStockAdjustments: () => ({ documents: [], total: 0, page: 1, pages: 1 }) } as never,
    logger: { log: () => undefined } as never,
    authorizer,
    scanContext: { factoryId: "factory-777", workstationId: "ws-pc1", deviceId: "dev-pc1" },
    deviceId: "dev-pc1",
  });
});

const invoke = async (channel: string, ...args: unknown[]) => (await handlers.get(channel)!(windowEvent, ...args)) as Record<string, unknown>;

describe("Stock Adjustment at the process boundary", () => {
  it("is a write under the carton lease and nothing else", () => {
    expect(leasesFor(IPC.postCartonStockAdjustment)).toEqual(["CARTON_STOCK"]);
  });

  it("posts with who and where from the session and this computer, whatever the screen sends", async () => {
    const reply = await invoke(IPC.postCartonStockAdjustment, {
      requestId: "r-1", kind: "OPENING", businessDate: "2026-11-11", reason: "count", remarks: "", postedBy: "someone else",
      storeLocationId: "elsewhere", lines: [{ articleSizeId: "as-1", color: "RED", direction: "IN", cartons: "20" }],
    });
    expect(reply.accepted).toBe(true);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      postedBy: "owner", workstationId: "ws-pc1", storeLocationId: "factory-777",
      lines: [{ articleSizeId: "as-1", color: "RED", direction: "IN", cartons: 20 }],
    }));
  });

  it("refuses anyone but an administrator, and reads nothing for them", async () => {
    signedIn = CLERK;
    for (const channel of [IPC.postCartonStockAdjustment, IPC.getCartonAdjustmentArticle, IPC.listCartonStockAdjustments]) {
      expect(await invoke(channel, {})).toMatchObject({ accepted: false });
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("passes the data layer's refusal on as it is", async () => {
    post.mockImplementation(() => { throw new Error("SK6 7/10 RED already has opening stock. Use Stock Adjustment to correct it. Nothing was posted."); });
    expect(await invoke(IPC.postCartonStockAdjustment, { lines: [] })).toEqual({ accepted: false, reason: "SK6 7/10 RED already has opening stock. Use Stock Adjustment to correct it. Nothing was posted." });
  });
});
