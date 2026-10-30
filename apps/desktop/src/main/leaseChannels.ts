// WHICH IPC CHANNELS WRITE A LEASED DOMAIN — the one list (docs/37 section W).
//
// Under the single-writer model a write to the raw material store or to master data is made only
// on the computer holding that domain's lease. The cloud refuses anything else (cloud migrations
// 011-013). leaseGuard.ts refuses it HERE first, at the moment of the write, so an operator is told
// "read-only on this computer" instead of finding a dead letter days later.
//
// Milestone 1 enforces two domains. The other four (sales and dispatch, accounts, machine programs,
// approvals) are enforced when they replicate, in Milestone 2: leasing them before then would lock
// a computer out of work nothing else can see.
//
// A channel that writes BOTH -- an item import, a removal that deletes stock history -- needs both
// leases. In phase 1 one computer holds both (docs/37 W.1), so this never splits a write.
//
// leaseChannels.test.ts reads every handler module that registers through the guarded ipcMain and
// fails on any channel that is in neither list below and is not plainly a read. A new write has to
// be classified to exist.

import { LEASE_DOMAIN, type LeaseDomain } from "@erp/domain";
import { IPC } from "../shared/ipcChannels";

const STORE: readonly LeaseDomain[] = [LEASE_DOMAIN.RAW_MATERIAL_STORE];
const MASTER: readonly LeaseDomain[] = [LEASE_DOMAIN.MASTER_DATA];
const BOTH: readonly LeaseDomain[] = [LEASE_DOMAIN.MASTER_DATA, LEASE_DOMAIN.RAW_MATERIAL_STORE];

export const LEASED_CHANNELS: Readonly<Record<string, readonly LeaseDomain[]>> = {
  // ── Raw material store: label runs, receiving, issuing, Dana, hand moves, stock ──
  [IPC.generateRawMaterialQrBatch]: STORE,
  [IPC.deleteRawMaterialQrBatch]: STORE,
  [IPC.startRawMaterialReceivingSession]: STORE,
  [IPC.closeRawMaterialReceivingSession]: STORE,
  [IPC.rawMaterialReceiptScan]: STORE,
  [IPC.startRawMaterialIssueSession]: STORE,
  [IPC.closeRawMaterialIssueSession]: STORE,
  [IPC.rawMaterialIssueScan]: STORE,
  [IPC.machineProgramStoreOutSaveBatch]: STORE,
  [IPC.issueMachineProgramDana]: STORE,
  [IPC.returnMachineProgramUpper]: STORE,
  [IPC.issueUpperToMachine]: STORE,
  [IPC.moveRawMaterialByHand]: STORE,
  [IPC.adjustInventoryStock]: STORE,
  // Approving a correction changes the stock it corrects.
  [IPC.reviewStockCorrectionRequest]: STORE,

  // ── Master data: materials and their taxonomy, units, parties, machines, work sections ──
  [IPC.createWorkSection]: MASTER,
  [IPC.setRawMaterialMovementConfig]: MASTER,
  [IPC.applyRawMaterialSetupToCategory]: MASTER,
  [IPC.createInventoryUnit]: MASTER,
  [IPC.createInventoryUnitConversion]: MASTER,
  [IPC.createInventoryCategory]: MASTER,
  [IPC.updateInventoryCategory]: MASTER,
  [IPC.addInventoryCategoryField]: MASTER,
  [IPC.updateInventoryCategoryField]: MASTER,
  [IPC.removeInventoryCategoryField]: MASTER,
  [IPC.addInventoryFieldOption]: MASTER,
  [IPC.deleteInventoryFieldOption]: MASTER,
  [IPC.createInventoryItem]: MASTER,
  [IPC.setInventoryItemStatus]: MASTER,
  [IPC.moveInventoryCategory]: MASTER,
  [IPC.moveInventoryItem]: MASTER,
  [IPC.setInventoryItemUnitLadder]: MASTER,
  [IPC.applyUnitLadderToColours]: MASTER,
  [IPC.saveUnitLadderPreset]: MASTER,
  [IPC.deleteUnitLadderPreset]: MASTER,
  [IPC.removeInventoryCategory]: MASTER,
  [IPC.setInventoryItemUnit]: MASTER,
  [IPC.updateInventoryItemPrice]: MASTER,
  [IPC.createPartyGroup]: MASTER,
  [IPC.createParty]: MASTER,
  [IPC.updateParty]: MASTER,
  [IPC.deleteParty]: MASTER,
  [IPC.createMachine]: MASTER,
  [IPC.setMachineStatus]: MASTER,
  [IPC.addMachine]: MASTER,
  [IPC.assignMachineContractor]: MASTER,
  // Sending a record again is a new revision of it: only the holder may.
  [IPC.sendMasterRecordAgain]: MASTER,

  // ── Both: master data whose change rewrites stock history (docs/37 W.5) ──
  [IPC.importInventoryItems]: BOTH,
  [IPC.deleteInventoryItem]: BOTH,
  [IPC.removeInventoryItemForGood]: BOTH,
  [IPC.correctInventoryItemUnit]: BOTH,
  // Approving a removal deletes the item, or the category, with its stock history.
  [IPC.reviewRemovalRequest]: BOTH,
  // Closing a program puts its cut size back in the store: a stock movement, on a material (and
  // category) it creates the first time. Both are leased writes, so closing is too (found
  // 2026-10-26, when stock movements began to replicate). The program's other store steps --
  // store out, Dana, upper return -- were already store-leased, so its whole life is on the holder.
  [IPC.completeMachineProgramProduction]: BOTH,
  // The backfill sends master records and stock history: only the holder of both, caught up.
  [IPC.runBackfill]: BOTH,
};

/**
 * Writes in the same modules that are deliberately NOT leased in Milestone 1, each with its reason.
 * Listed so the classification test can tell "decided" from "forgotten".
 */
export const UNLEASED_WRITE_CHANNELS: Readonly<Record<string, string>> = {
  [IPC.storeEntryScan]: "Carton QR flow: multi-writer by the owner's decision (docs/37 W.1).",
  [IPC.storeExitScan]: "Carton QR flow: multi-writer.",
  [IPC.storeReceivingSession]: "Starts a carton store-in session: a carton flow, multi-writer.",
  [IPC.storeMoveOutSession]: "Starts a carton move-out session: a carton flow, multi-writer.",
  [IPC.machineProgramCartonIn]: "Carton QR flow: multi-writer.",
  [IPC.printMachineProgramCartons]: "Carton labels: multi-writer.",
  [IPC.convertMachineProgramCartonsToB]: "Carton labels: multi-writer.",
  [IPC.convertMachineProgramUpperCartonsToB]: "Carton labels: multi-writer.",
  [IPC.deleteMachineProgram]:
    "Machine programs are leased in Milestone 2, with their creation and edits. Deleting one only marks the program CANCELLED: no stock moves.",
  [IPC.createItemRemovalRequest]: "A request only: approvals are leased in Milestone 2. Approving it is leased.",
  [IPC.createCategoryRemovalRequest]: "A request only: approvals are leased in Milestone 2. Approving it is leased.",
  [IPC.createStockCorrectionRequest]: "A request only: approvals are leased in Milestone 2. Approving it is leased.",
};

/** The domains this version enforces: every domain some channel above needs. */
export const ENFORCED_LEASE_DOMAINS: readonly LeaseDomain[] = [...new Set(Object.values(LEASED_CHANNELS).flat())];

/** The leases a channel needs, or none. */
export const leasesFor = (channel: string): readonly LeaseDomain[] => LEASED_CHANNELS[channel] ?? [];
