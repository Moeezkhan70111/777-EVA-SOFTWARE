// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Authorizer, type SessionUser } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import { registerCartonCloudHandlers, type CartonCloudContext } from "./cartonCloud";

// Carton Cloud activation at the process boundary: administrators only, only for the project the screen showed, and
// every attempt logged with who made it. What activation does to the database is proved on real databases in
// @erp/sync localStockProtection.test.ts; here the database is a stand-in that answers on cue.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

vi.mock("../cloudSyncPass", () => ({ isCloudSyncConfigured: () => true }));

const windowEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
const ADMIN: SessionUser = { id: "u-admin", username: "owner", role: "ADMIN", accessStatus: "APPROVED", permissions: [] };
const CLERK: SessionUser = { ...ADMIN, id: "u-clerk", username: "babar", role: "USER" };
const PROJECT = "https://prod.supabase.co";
const STATUS = { state: "NOT_ACTIVATED", problems: [], projectKey: PROJECT, leases: [], localOnlyMarks: 4, parkedLocalStock: 0, invalidReason: null, activation: null };
const ACTIVATION = { version: 1, activatedAt: "2026-11-10T04:00:00.000Z", activatedBy: "owner", deviceId: "dev-pc2", projectKey: PROJECT, cutoff: { gatepasses: 12 }, seal: "s" };

let signedIn: SessionUser | null;
let logged: Array<{ severity: string; message: string; userId?: string }>;
let activateOutcome: unknown;
const activate = vi.fn(() => activateOutcome);

beforeEach(() => {
  handlers.clear();
  signedIn = ADMIN;
  logged = [];
  activate.mockClear();
  activateOutcome = { activated: true, activation: ACTIVATION, retiredMarks: { GATEPASS: 3 }, parked: 1 };
  const authorizer = new Authorizer(() => signedIn);
  authorizer.bind(windowEvent, "session-token");
  const ctx: CartonCloudContext = {
    db: { cartonCloudStatus: () => STATUS as never, activateCartonCloud: activate as never },
    logger: { log: (entry) => logged.push({ severity: entry.severity, message: entry.message, userId: entry.userId }) },
    authorizer,
    deviceId: "dev-pc2",
    paths: { dataRoot: "x" },
  };
  registerCartonCloudHandlers(ctx);
});

const invoke = async (channel: string, ...args: unknown[]) => (await handlers.get(channel)!(windowEvent, ...args)) as Record<string, unknown>;

describe("Carton Cloud activation at the process boundary", () => {
  it("tells every signed-in user whether Carton Cloud is active, and nobody signed out", async () => {
    signedIn = CLERK;
    expect(await invoke(IPC.getCartonCloudState)).toEqual({ accepted: true, value: { configured: true, state: "NOT_ACTIVATED" } });
    signedIn = null;
    expect(await invoke(IPC.getCartonCloudState)).toMatchObject({ accepted: false, code: "SESSION_REQUIRED" });
  });

  it("shows the status to an administrator and refuses anyone else", async () => {
    expect(await invoke(IPC.getCartonCloudStatus)).toEqual({ accepted: true, value: STATUS });
    signedIn = CLERK;
    expect(await invoke(IPC.getCartonCloudStatus)).toMatchObject({ accepted: false, code: "ADMIN_REQUIRED" });
    expect(await invoke(IPC.activateCartonCloud, PROJECT)).toMatchObject({ accepted: false, code: "ADMIN_REQUIRED" });
    expect(activate).not.toHaveBeenCalled();
  });

  it("activates only for the project the screen showed, and refuses anything else, logged", async () => {
    for (const wrong of [undefined, "", "https://test.supabase.co", 7]) {
      expect((await invoke(IPC.activateCartonCloud, wrong)).accepted).toBe(false);
    }
    expect(activate).not.toHaveBeenCalled();
    expect(logged).toHaveLength(4);
  });

  it("logs the time, device, project and cutoff of an activation, with who did it", async () => {
    expect(await invoke(IPC.activateCartonCloud, PROJECT)).toEqual({ accepted: true, value: STATUS });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ severity: "WARNING", userId: "u-admin" });
    for (const fact of ["owner ACTIVATED", "2026-11-10T04:00:00.000Z", "dev-pc2", PROJECT, '"gatepasses":12', '"GATEPASS":3', "Parked queued test events: 1"]) {
      expect(logged[0]?.message).toContain(fact);
    }
  });

  it("passes the refusal's reasons back, and logs the attempt", async () => {
    activateOutcome = { activated: false, problems: ["Nobody holds the ACCOUNTS lease yet."] };
    const answer = await invoke(IPC.activateCartonCloud, PROJECT);
    expect(answer).toMatchObject({ accepted: false, problems: ["Nobody holds the ACCOUNTS lease yet."] });
    expect(logged[0]?.message).toContain("refused");
  });
});
