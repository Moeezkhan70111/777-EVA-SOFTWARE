import { leaseRefusalText } from "../shared/leaseRefusal";
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqliteDatabase } from "@erp/data";
import { IPC } from "../shared/ipcChannels";

// THE GATE IN FRONT OF LEASED CHANNELS (leaseGuard.ts).
//
// Electron is replaced by a map of registered handlers, and @erp/sync's decision by a stub, so these
// prove the WIRING: which channels are gated, that a refusal stops the handler before it runs, that
// a channel needing two leases needs both, and that the gate fails closed before it is installed.
// The decision itself is proved in packages/sync/src/leases.test.ts against a real database.

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const registered = new Map<string, Handler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      registered.set(channel, handler);
    },
  },
}));

let syncConfigured = true;
vi.mock("./cloudSyncPass", () => ({
  isCloudSyncConfigured: () => syncConfigured,
}));

type Decision =
  | { allowed: true; domain: string; epoch: number | null }
  | { allowed: false; domain: string; reason: string; holderLabel: string | null };
let decisions: Record<string, Decision> = {};
const asked: string[] = [];
vi.mock("@erp/sync", () => ({
  leaseWriteDecision: (_sql: unknown, input: { domain: string }) => {
    asked.push(input.domain);
    return decisions[input.domain] ?? { allowed: true, domain: input.domain, epoch: 1 };
  },
}));

const event = {} as IpcMainInvokeEvent;
const db = { db: {} } as unknown as SqliteDatabase;

/** A fresh copy of the module, so "not installed yet" can be tested. */
async function loadGuard() {
  vi.resetModules();
  registered.clear();
  return import("./leaseGuard");
}

beforeEach(() => {
  syncConfigured = true;
  decisions = {};
  asked.length = 0;
});

describe("the lease gate", () => {
  it("registers an unleased channel exactly as Electron would", async () => {
    const { ipcMain } = await loadGuard();
    const listener = vi.fn(() => "listed");
    ipcMain.handle(IPC.listParties, listener);
    expect(registered.get(IPC.listParties)).toBe(listener);
  });

  it("fails closed: a leased channel called before the gate is installed does not run", async () => {
    const { ipcMain } = await loadGuard();
    const listener = vi.fn();
    ipcMain.handle(IPC.createParty, listener);
    await expect(registered.get(IPC.createParty)?.(event, {})).rejects.toMatchObject({ code: "LEASE_REQUIRED", reason: "NOT_READY" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("refuses a leased write on a reader, naming who writes it, before the handler runs", async () => {
    const { ipcMain, installLeaseGate } = await loadGuard();
    installLeaseGate({ db, deviceId: "desktop-office", dataRoot: "C:/erp" });
    decisions.RAW_MATERIAL_STORE = { allowed: false, domain: "RAW_MATERIAL_STORE", reason: "HELD_ELSEWHERE", holderLabel: "Store PC" };
    const listener = vi.fn();
    ipcMain.handle(IPC.generateRawMaterialQrBatch, listener);

    const refusal = registered.get(IPC.generateRawMaterialQrBatch)?.(event, { quantity: 10 });
    await expect(refusal).rejects.toMatchObject({ code: "LEASE_REQUIRED", domain: "RAW_MATERIAL_STORE", reason: "HELD_ELSEWHERE" });
    await expect(refusal).rejects.toThrow("The raw material store is written on Store PC only. It is read-only here.");
    expect(listener).not.toHaveBeenCalled();
  });

  it("lets the holder write, with the handler's own arguments and answer", async () => {
    const { ipcMain, installLeaseGate } = await loadGuard();
    installLeaseGate({ db, deviceId: "desktop-store", dataRoot: "C:/erp" });
    const listener = vi.fn((_event: IpcMainInvokeEvent, input: unknown) => ({ accepted: true, input }));
    ipcMain.handle(IPC.createParty, listener);
    await expect(registered.get(IPC.createParty)?.(event, { partyName: "Supplier" })).resolves.toEqual({
      accepted: true, input: { partyName: "Supplier" },
    });
    expect(asked).toEqual(["MASTER_DATA"]);
  });

  it("a write that needs both leases is refused if either is missing", async () => {
    const { ipcMain, installLeaseGate } = await loadGuard();
    installLeaseGate({ db, deviceId: "desktop-store", dataRoot: "C:/erp" });
    decisions.RAW_MATERIAL_STORE = { allowed: false, domain: "RAW_MATERIAL_STORE", reason: "CATCHING_UP", holderLabel: "Store PC" };
    const listener = vi.fn();
    ipcMain.handle(IPC.removeInventoryItemForGood, listener);
    await expect(registered.get(IPC.removeInventoryItemForGood)?.(event, "item-1")).rejects.toMatchObject({ reason: "CATCHING_UP" });
    expect(asked).toEqual(["MASTER_DATA", "RAW_MATERIAL_STORE"]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("carton QR on hold (docs/42 section 9)", () => {
  const HELD = [
    IPC.processScan, IPC.receiveProduction, IPC.dispatchScan, IPC.returnScan,
    IPC.storeEntryScan, IPC.storeExitScan, IPC.machineProgramCartonIn, IPC.markQrCodeDamaged,
  ];

  it("refuses every QR action that moves the carton figure, in words, before the handler runs", async () => {
    const { ipcMain, installLeaseGate, CARTON_QR_HOLD_MESSAGE } = await loadGuard();
    installLeaseGate({ db, deviceId: "desktop-store", dataRoot: "C:/erp" });
    for (const channel of HELD) {
      const listener = vi.fn();
      ipcMain.handle(channel, listener);
      await expect(Promise.resolve().then(() => registered.get(channel)?.(event, "QR-1"))).rejects.toThrow(CARTON_QR_HOLD_MESSAGE);
      expect(listener, channel).not.toHaveBeenCalled();
    }
  });

  it("is said by every screen, the way a lease refusal is", async () => {
    const { ipcMain, CARTON_QR_HOLD_MESSAGE } = await loadGuard();
    ipcMain.handle(IPC.processScan, vi.fn());
    const refused = await Promise.resolve().then(() => registered.get(IPC.processScan)?.(event, "QR-1")).catch((error: unknown) => error);
    expect(leaseRefusalText(refused)).toBe(CARTON_QR_HOLD_MESSAGE);
  });

  it("leaves labels, lookups and raw material QR working", async () => {
    const { ipcMain, installLeaseGate } = await loadGuard();
    installLeaseGate({ db, deviceId: "desktop-store", dataRoot: "C:/erp" });
    for (const channel of [IPC.generateQrBatch, IPC.searchQrCodes, IPC.getQrDetail, IPC.getQrJourney, IPC.voidQrCode, IPC.restoreQrCode, IPC.returnLookup, IPC.listProductionReceipts]) {
      const listener = vi.fn(() => "worked");
      ipcMain.handle(channel, listener);
      await expect(Promise.resolve(registered.get(channel)?.(event))).resolves.toBe("worked");
    }
  });

  it("tells the data layer at startup, so a gatepass reserves nothing for scanners", async () => {
    const { installLeaseGate } = await loadGuard();
    const database = { ...db, cartonQrOnHold: false } as typeof db & { cartonQrOnHold: boolean };
    installLeaseGate({ db: database, deviceId: "desktop-store", dataRoot: "C:/erp" });
    expect(database.cartonQrOnHold).toBe(true);
  });
});

describe("the leases this computer holds (party ledgers show only on the Accounts holder)", () => {
  const office = { db, deviceId: "desktop-office", dataRoot: "C:/erp" };

  it("holds the domains the cloud names it holder of, caught up -- an epoch is the proof", async () => {
    const { installLeaseGate, heldLeaseDomains } = await loadGuard();
    installLeaseGate(office);
    decisions.ACCOUNTS = { allowed: true, domain: "ACCOUNTS", epoch: 4 };
    decisions.RAW_MATERIAL_STORE = { allowed: false, domain: "RAW_MATERIAL_STORE", reason: "HELD_ELSEWHERE", holderLabel: "Store PC" };
    decisions.MASTER_DATA = { allowed: false, domain: "MASTER_DATA", reason: "CATCHING_UP", holderLabel: "Office" };
    expect(await heldLeaseDomains(["ACCOUNTS", "RAW_MATERIAL_STORE", "MASTER_DATA"])).toEqual(["ACCOUNTS"]);
  });

  it("holds nothing without sync, though it may write everything", async () => {
    const { installLeaseGate, heldLeaseDomains } = await loadGuard();
    installLeaseGate(office);
    syncConfigured = false;
    expect(await heldLeaseDomains(["ACCOUNTS"])).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("holds nothing on a project without leases, where writes are allowed with no epoch", async () => {
    const { installLeaseGate, heldLeaseDomains } = await loadGuard();
    installLeaseGate(office);
    decisions.ACCOUNTS = { allowed: true, domain: "ACCOUNTS", epoch: null };
    expect(await heldLeaseDomains(["ACCOUNTS"])).toEqual([]);
  });

  it("holds nothing before the gate is installed", async () => {
    const { heldLeaseDomains } = await loadGuard();
    expect(await heldLeaseDomains(["ACCOUNTS"])).toEqual([]);
  });
});
