// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// Keeping the doorbell matched to the sync pass's session (realtimeWake.ts). The doorbell's own
// protocol is proved in packages/sync (doorbell.test.ts); here it is a stand-in that records.

type Options = { url: string; ownDeviceId: string; onRing: () => void; onStatus: (status: string, detail?: string) => void };

const doorbells: Array<{ options: Options; started: boolean; stopped: boolean }> = [];
let session: { url: string; anonKey: string; deviceId: string; accessToken: () => Promise<string> } | null;

vi.mock("./cloudSyncPass", () => ({ doorbellSession: () => session }));
vi.mock("@erp/sync", () => ({
  SyncDoorbell: class {
    record: { options: Options; started: boolean; stopped: boolean };
    constructor(options: Options) {
      this.record = { options, started: false, stopped: false };
      doorbells.push(this.record);
    }
    start() {
      this.record.started = true;
    }
    stop() {
      this.record.stopped = true;
    }
  },
}));

const { refreshRealtimeWake, realtimeStatus, stopRealtimeWake } = await import("./realtimeWake");

const logged: string[] = [];
let wakes = 0;
const deps = { logger: { log: (entry: { message: string }) => logged.push(entry.message) }, deviceId: "dev-reader", wake: () => (wakes += 1) };
const project = (url: string) => ({ url, anonKey: "anon", deviceId: "dev-reader", accessToken: async () => "token" });

beforeEach(() => {
  stopRealtimeWake();
  doorbells.length = 0;
  logged.length = 0;
  wakes = 0;
  session = null;
});

describe("keeping the doorbell matched to the sync session", () => {
  it("waits for a session, then listens once, and a ring wakes the scheduler", async () => {
    await refreshRealtimeWake(deps);
    expect(doorbells).toHaveLength(0);

    session = project("https://test.supabase.co");
    await refreshRealtimeWake(deps);
    await refreshRealtimeWake(deps);
    expect(doorbells).toHaveLength(1);
    expect(doorbells[0]).toMatchObject({ started: true, options: { url: "https://test.supabase.co", ownDeviceId: "dev-reader" } });

    doorbells[0]!.options.onRing();
    expect(wakes).toBe(1);
  });

  it("starts again for another project, and stops when this computer no longer syncs", async () => {
    session = project("https://test.supabase.co");
    await refreshRealtimeWake(deps);
    session = project("https://prod.supabase.co");
    await refreshRealtimeWake(deps);
    expect(doorbells.map((d) => [d.options.url, d.stopped])).toEqual([["https://test.supabase.co", true], ["https://prod.supabase.co", false]]);

    session = null;
    await refreshRealtimeWake(deps);
    expect(doorbells[1]!.stopped).toBe(true);
  });

  it("logs a change of state once, not every report of it, and reports it to Health", async () => {
    session = project("https://test.supabase.co");
    await refreshRealtimeWake(deps);
    const { onStatus } = doorbells[0]!.options;
    onStatus("CONNECTING");
    onStatus("LISTENING");
    onStatus("LISTENING");
    onStatus("RECONNECTING", "the connection closed");
    onStatus("RECONNECTING", "the connection closed");
    expect(logged).toEqual(["Live updates connecting.", "Live updates listening.", "Live updates reconnecting: the connection closed."]);
    expect(realtimeStatus()).toBe("RECONNECTING");
  });
});
