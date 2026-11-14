// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION } from "@erp/domain";
import { Authorizer, type SessionUser } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import { registerProductionDayHandlers } from "./productionDay";

// The Manual Production page's Save and "Complete today's production" at the process boundary (docs/48): Live
// Production only, who saved and where taken from the session and this computer, a refusal said in the data layer's
// words. Reading a day is open to anyone signed in. What the writes do to the database is proved on a real database
// in @erp/data productionDays.test.ts.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
vi.mock("../leaseGuard", () => ({
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, handler) },
}));

const windowEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
const OPERATOR: SessionUser = { id: "u-op", username: "aslam", role: "USER", accessStatus: "APPROVED", permissions: [PERMISSION.LIVE_PRODUCTION] };
const VIEWER: SessionUser = { ...OPERATOR, id: "u-view", username: "boss", permissions: [] };

let signedIn: SessionUser | null;
const save = vi.fn();
const complete = vi.fn();
const view = vi.fn();
const mark = vi.fn();
const MARK = { date: "2026-11-14", completedAt: "2026-11-14T13:00:00.000Z", completedBy: "aslam", cartons: 22, entries: 2 };

beforeEach(() => {
  handlers.clear();
  signedIn = OPERATOR;
  save.mockReset().mockReturnValue({ entries: [{ cartons: 20 }, { cartons: 2 }], duplicates: 0 });
  complete.mockReset().mockReturnValue({ mark: MARK, duplicate: false });
  view.mockReset().mockReturnValue({ date: "2026-11-14", completed: null, totalCartons: 0, entries: 0, machines: [], articles: [] });
  mark.mockReset().mockReturnValue(MARK);
  const authorizer = new Authorizer(() => signedIn);
  authorizer.bind(windowEvent, "session-token");
  registerProductionDayHandlers({
    db: { recordManualProductionBatch: save, completeProductionDay: complete, productionDayView: view, productionDayMark: mark } as never,
    logger: { log: () => undefined } as never,
    authorizer,
    scanContext: { factoryId: "factory-777", workstationId: "ws-pc1", deviceId: "dev-pc1" },
    deviceId: "dev-pc1",
  } as never);
});

const invoke = async (channel: string, ...args: unknown[]) => (await handlers.get(channel)!(windowEvent, ...args)) as Record<string, unknown>;
const LINE = { requestId: "r-1", machineId: "m-1", articleSizeId: "as-1", color: "RED", dozens: "10" };

describe("Manual Production's Save and the production day at the process boundary", () => {
  it("saves every line with who and where from the session and this computer, whatever the screen sends", async () => {
    const reply = await invoke(IPC.saveManualProduction, { lines: [{ ...LINE, createdBy: "someone else", cartons: 999 }], storeLocationId: "elsewhere", createdBy: "someone else" });
    expect(reply).toEqual({ accepted: true, entries: 2, cartons: 22, duplicates: 0 });
    expect(save).toHaveBeenCalledWith({ lines: [LINE], storeLocationId: "factory-777", createdBy: "aslam" });
  });

  it("refuses to save or complete without Live Production, and writes nothing", async () => {
    signedIn = VIEWER;
    expect(await invoke(IPC.saveManualProduction, { lines: [LINE] })).toMatchObject({ accepted: false });
    expect(await invoke(IPC.completeProductionDay)).toMatchObject({ accepted: false });
    expect(save).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("refuses more lines than one Save may carry before reading any", async () => {
    const reply = await invoke(IPC.saveManualProduction, { lines: Array.from({ length: 301 }, () => LINE) });
    expect(reply).toMatchObject({ accepted: false, reason: expect.stringMatching(/at most 300 lines/) });
    expect(save).not.toHaveBeenCalled();
  });

  it("passes the data layer's refusal on as it is", async () => {
    save.mockImplementation(() => { throw new Error("Line 2: SK6 7/10 PINK is disabled in Product Master. Re-enable it before recording production."); });
    expect(await invoke(IPC.saveManualProduction, { lines: [LINE] })).toEqual({ accepted: false, reason: "Line 2: SK6 7/10 PINK is disabled in Product Master. Re-enable it before recording production." });
    complete.mockImplementation(() => { throw new Error("No production has been saved today. Save the production first, then complete the day."); });
    expect(await invoke(IPC.completeProductionDay)).toEqual({ accepted: false, reason: "No production has been saved today. Save the production first, then complete the day." });
  });

  it("completes the day as the signed-in user, never a name from the screen", async () => {
    expect(await invoke(IPC.completeProductionDay, { completedBy: "someone else" })).toEqual({ accepted: true, mark: MARK, duplicate: false });
    expect(complete).toHaveBeenCalledWith({ completedBy: "aslam" });
  });

  it("lets anyone signed in read a day and its mark, and nobody signed out", async () => {
    signedIn = VIEWER;
    expect(await invoke(IPC.getProductionDay, { date: "2026-11-14" })).toMatchObject({ accepted: true, day: { date: "2026-11-14" } });
    expect(await invoke(IPC.getProductionDayMark, { date: "2026-11-14" })).toEqual({ accepted: true, mark: MARK });
    view.mockReturnValue(null);
    expect(await invoke(IPC.getProductionDay, { date: "nonsense" })).toEqual({ accepted: false, reason: "Choose a valid day." });
    signedIn = null;
    expect(await invoke(IPC.getProductionDay, { date: "2026-11-14" })).toMatchObject({ accepted: false });
    expect(await invoke(IPC.getProductionDayMark, { date: "2026-11-14" })).toMatchObject({ accepted: false });
  });
});
