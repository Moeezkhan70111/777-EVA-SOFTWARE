import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LEASE_DOMAIN } from "@erp/domain";
import { LEASED_CHANNELS, UNLEASED_WRITE_CHANNELS, leasesFor } from "./leaseChannels";
import { IPC } from "../shared/ipcChannels";

// EVERY CHANNEL IN A MODULE THAT WRITES A LEASED DOMAIN IS CLASSIFIED.
//
// A new write in these modules must be put in LEASED_CHANNELS or UNLEASED_WRITE_CHANNELS (with its
// reason), or listed below as a read. Otherwise this fails, so a write cannot reach a leased domain
// past the gate just because nobody thought to list it.

const IPC_DIR = path.resolve(__dirname, "ipc");

/** The modules that register through the guarded ipcMain (leaseGuard.ts). */
const GUARDED_MODULES = ["rawMaterials", "rawMaterialQr", "store", "parties", "machinePrograms", "upperMoveOut", "syncWaiting", "backfill"];

/** Channels these modules register that only read. Checked by hand, one by one. */
const READS = new Set([
  // rawMaterials
  "listInventoryUnits", "listWorkSections", "listRawMaterialMovementConfig", "getRawMaterialSetupTemplate",
  "listInventoryUnitConversions", "listInventoryCategories", "inventoryFieldOptionUsage", "inventoryItemDeleteBlockers",
  "listInventoryItems", "getInventoryImportColumns", "previewCategoryMove", "previewInventoryItemMove",
  "getInventoryItemUnitLadder", "listInventoryItemUnitLadders", "itemRemovalBlockers", "inventoryItemColourSiblings",
  "listUnitLadderPresets", "categoryRemovalBlockers", "listRemovalRequestsForTarget", "listStockCorrectionRequests",
  "listStockCorrectionRequestsForItem", "listInventoryStockEvents", "queryInventoryStock",
  // rawMaterialQr
  "rawMaterialQrBatchDeleteBlockers", "listRawMaterialQrBatches", "listRawMaterialQrsForBatch", "getRawMaterialQrLabel",
  "getRawMaterialQrSequenceState",
  // store
  "getOpenRawMaterialReceivingSession", "getRawMaterialReceivingSessionSummary", "listRawMaterialReceivingSessions",
  "getRawMaterialIssueSessionSummary", "getOpenRawMaterialIssueSession", "listRawMaterialIssueSessions", "openMachineProgramStoreOut", "machineProgramStoreOutCheckScan",
  "listMachineProgramIssueBatches", "listMachineProgramCartonPackets", "getMachineProgramReconciliation",
  "listMachineProgramDanaOptions", "listMachineProgramDanaIssues", "getRawMaterialHandMoveOptions",
  "storeReceivingSessionSummary", "storeMoveOutSessionSummary", "getStoreDailyReport",
  // parties
  "listPartyGroups", "listParties", "getParty", "getNextPartyCode", "getNextProductCode", "getCurrentPartyBalance",
  "getCustomerLedger", "listCustomerBalances", "listCities",
  // machinePrograms
  "listMachines", "listMachineProgramDana", "listMachineDayPrograms", "listCartonProgramBatches", "listReconcilablePrograms",
  "listOpenMachinePrograms",
  // upperMoveOut
  "listUpperStock",
  // syncWaiting
  "getSyncWaiting", "getFactorySyncHealth",
  // backfill
  "getBackfillPlan",
]);

const channelValue = (name: string): string => {
  const value = (IPC as Readonly<Record<string, string>>)[name];
  if (value === undefined) throw new Error(`IPC.${name} does not exist`);
  return value;
};

/** The IPC.<name> channels a module registers, through ipcMain.handle or its read/write helpers. */
function registeredIn(module: string): string[] {
  const source = fs.readFileSync(path.join(IPC_DIR, `${module}.ts`), "utf8").replace(/\s+/g, " ");
  return [...source.matchAll(/(?:ipcMain\.handle|write|read(?:<[^>]*>)?)\(\s*IPC\.([A-Za-z]+)/g)].map((match) => match[1] ?? "");
}

describe("lease classification", () => {
  it("classifies every channel the guarded modules register", () => {
    const unclassified: string[] = [];
    for (const module of GUARDED_MODULES) {
      for (const name of registeredIn(module)) {
        const channel = channelValue(name);
        const known = channel in LEASED_CHANNELS || channel in UNLEASED_WRITE_CHANNELS || READS.has(name);
        if (!known) unclassified.push(`${module}: IPC.${name}`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  it("registers every leased channel through the guarded ipcMain, never Electron's", () => {
    const guarded = new Set(GUARDED_MODULES.flatMap((module) => registeredIn(module).map(channelValue)));
    for (const channel of Object.keys(LEASED_CHANNELS)) {
      expect(guarded.has(channel), `${channel} is leased but registered outside the guarded modules`).toBe(true);
    }
    for (const module of GUARDED_MODULES) {
      const source = fs.readFileSync(path.join(IPC_DIR, `${module}.ts`), "utf8");
      expect(source, `${module} must take ipcMain from the lease guard`).toMatch(/import \{ ipcMain \} from "\.\.\/leaseGuard";/);
      expect(source).not.toMatch(/import \{[^}]*\bipcMain\b[^}]*\} from "electron"/);
    }
  });

  it("no module outside the guarded ones registers a leased channel", () => {
    const others = fs.readdirSync(IPC_DIR)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => file.replace(/\.ts$/, ""))
      .filter((module) => !GUARDED_MODULES.includes(module));
    for (const module of others) {
      for (const name of registeredIn(module)) {
        const channel = (IPC as Readonly<Record<string, string>>)[name];
        if (channel === undefined) continue;
        expect(leasesFor(channel), `${module} registers ${name}, which is leased`).toEqual([]);
      }
    }
  });

  it("a write that rewrites stock history needs both leases", () => {
    for (const channel of [IPC.importInventoryItems, IPC.removeInventoryItemForGood, IPC.correctInventoryItemUnit, IPC.reviewRemovalRequest]) {
      expect([...leasesFor(channel)].sort()).toEqual([LEASE_DOMAIN.MASTER_DATA, LEASE_DOMAIN.RAW_MATERIAL_STORE]);
    }
    expect(leasesFor(IPC.generateRawMaterialQrBatch)).toEqual([LEASE_DOMAIN.RAW_MATERIAL_STORE]);
    expect(leasesFor(IPC.createParty)).toEqual([LEASE_DOMAIN.MASTER_DATA]);
    expect(leasesFor(IPC.storeEntryScan)).toEqual([]);
  });

  it("only Milestone 1's two domains are enforced", () => {
    const domains = new Set(Object.values(LEASED_CHANNELS).flat());
    expect([...domains].sort()).toEqual([LEASE_DOMAIN.MASTER_DATA, LEASE_DOMAIN.RAW_MATERIAL_STORE]);
  });
});
