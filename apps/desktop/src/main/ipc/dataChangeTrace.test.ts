// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { IPC } from "../../shared/ipcChannels";

// A screen's report of how it handled a change goes to app.log, checked, under the change's id.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
vi.mock("../leaseGuard", () => ({
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, handler) },
}));

const { registerDataChangeTraceHandler } = await import("./dataChangeTrace");

const logged: Array<{ operation: string; message: string }> = [];
const call = (input: unknown) => handlers.get(IPC.traceDataChange)?.({} as IpcMainInvokeEvent, input);

beforeEach(() => {
  logged.length = 0;
  handlers.clear();
  registerDataChangeTraceHandler({ deviceId: "pc1", logger: { log: (entry) => void logged.push(entry) } });
});

describe("tracing a change on a screen", () => {
  it("logs each step under the change's id, with what the screen saw", () => {
    call({ id: "c-1", screen: "carton-stock", stage: "received", detail: "CARTONS,SYNC" });
    call({ id: "c-1", screen: "carton-stock", stage: "shown", detail: "movements=24 fingerprint=703d" });
    expect(logged.map((entry) => entry.operation)).toEqual(["data-change-trace", "data-change-trace"]);
    expect(logged[0]?.message).toBe("Change c-1: carton-stock received (CARTONS,SYNC).");
    expect(logged[1]?.message).toBe("Change c-1: carton-stock shown (movements=24 fingerprint=703d).");
  });

  it("drops anything it cannot read, and answers nothing", () => {
    expect(call({ id: "c-1", screen: "carton-stock", stage: "drop-table" })).toBeUndefined();
    call("received");
    call({ screen: "carton-stock", stage: "received" });
    expect(logged).toEqual([]);
  });
});
