// @vitest-environment node
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { IPC } from "../shared/ipcChannels";
import * as ipcChannels from "../shared/ipcChannels";

// The preload is the only road between a sync pass and an open screen. This runs the REAL preload
// (compiled the way the build compiles it: esbuild, TypeScript to CommonJS) against a stand-in
// ipcRenderer, and checks both directions a change travels: the main process's announcement reaching
// a screen's listener (and leaving it once the screen stops), and the screen's trace going back.

const ipcRenderer = Object.assign(new EventEmitter(), { invoke: vi.fn(async (..._args: unknown[]) => undefined) });
const exposed: Record<string, unknown> = {};
const electron = {
  contextBridge: { exposeInMainWorld: (key: string, value: unknown) => void (exposed[key] = value) },
  ipcRenderer,
  webFrame: { getZoomLevel: () => 0, setZoomLevel: () => undefined },
};

const source = readFileSync(fileURLToPath(new URL("../preload.cts", import.meta.url)), "utf8");
const { code } = transformSync(source, { loader: "ts", format: "cjs" });
const modules: Record<string, unknown> = { electron, "./shared/ipcChannels": ipcChannels };
const requireStandIn = (name: string): unknown => {
  if (!(name in modules)) throw new Error(`the preload asked for ${name}, which this test does not provide`);
  return modules[name];
};
new Function("require", "exports", "module", "process", code)(requireStandIn, {}, { exports: {} }, process);

type Bridge = {
  onDataChanged: (listener: (change: unknown) => void) => () => void;
  traceDataChange: (trace: unknown) => Promise<unknown>;
};
const api = (exposed.desktop as { api: Bridge }).api;

describe("the preload between a sync pass and an open screen", () => {
  it("hands the main process's announcement to the screen as sent, and stops when the screen stops", () => {
    const heard: unknown[] = [];
    const stop = api.onDataChanged((change) => heard.push(change));
    const announcement = { kinds: ["CARTONS", "SYNC"], id: "c-27608" };

    ipcRenderer.emit(IPC.dataChanged, { sender: "main" }, announcement);
    expect(heard).toEqual([announcement]);
    expect(ipcRenderer.listenerCount(IPC.dataChanged)).toBe(1);

    stop();
    ipcRenderer.emit(IPC.dataChanged, { sender: "main" }, announcement);
    expect(heard).toHaveLength(1);
    expect(ipcRenderer.listenerCount(IPC.dataChanged)).toBe(0);
  });

  it("sends a screen's trace on its own channel", async () => {
    const trace = { id: "c-27608", screen: "carton-stock", stage: "shown", detail: "movements=24" };
    await api.traceDataChange(trace);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(IPC.traceDataChange, trace);
  });
});
