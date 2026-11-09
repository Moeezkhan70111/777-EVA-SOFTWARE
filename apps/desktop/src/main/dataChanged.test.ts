// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../shared/ipcChannels";
import { readDataChange } from "../shared/dataChange";

// Telling the open windows what a pass changed: every live window hears it, under one new id that
// the pass logs and the screens trace back to.

type FakeWindow = { destroyed: boolean; sent: Array<[string, unknown]> };
const windows: FakeWindow[] = [];

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () =>
      windows.map((w) => ({
        isDestroyed: () => w.destroyed,
        webContents: { isDestroyed: () => w.destroyed, send: (channel: string, payload: unknown) => w.sent.push([channel, payload]) },
      })),
  },
}));

const { announceDataChanged } = await import("./dataChanged");

beforeEach(() => {
  windows.length = 0;
});

describe("announcing a change", () => {
  it("sends the kinds and one id to every live window, on the channel the preload listens to, and says how many heard it", () => {
    windows.push({ destroyed: false, sent: [] }, { destroyed: true, sent: [] }, { destroyed: false, sent: [] });
    const announced = announceDataChanged(["CARTONS", "SYNC"]);

    expect(announced?.windows).toBe(2);
    expect(windows[1]?.sent).toEqual([]);
    for (const live of [windows[0], windows[2]]) {
      expect(live?.sent).toHaveLength(1);
      const [channel, payload] = live!.sent[0]!;
      expect(channel).toBe(IPC.dataChanged);
      // What the screen's own check makes of it: the kinds, and the same id the pass logs.
      expect(readDataChange(payload)).toEqual({ kinds: ["CARTONS", "SYNC"], id: announced?.id });
    }
  });

  it("gives every announcement its own id", () => {
    windows.push({ destroyed: false, sent: [] });
    expect(announceDataChanged(["CARTONS"])?.id).not.toBe(announceDataChanged(["CARTONS"])?.id);
  });

  it("announces nothing when nothing changed", () => {
    windows.push({ destroyed: false, sent: [] });
    expect(announceDataChanged([])).toBeNull();
    expect(windows[0]?.sent).toEqual([]);
  });
});
