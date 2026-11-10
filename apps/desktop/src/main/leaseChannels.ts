// WHICH IPC CHANNELS WRITE A LEASED DOMAIN — the one list (docs/37 section W).
//
// Under the single-writer model a write to the raw material store or to master data is made only
// on the computer holding that domain's lease. The cloud refuses anything else (cloud migrations
// 011-013). leaseGuard.ts refuses it HERE first, at the moment of the write, so an operator is told
// "read-only on this computer" instead of finding a dead letter days later.
//
// Enforced: the raw material store, master data, carton stock (docs/42), and sales and accounts now that bills
// and cash vouchers replicate (docs/43). The other two (machine programs, approvals) are enforced when
// they replicate: leasing them before then would lock a computer out of work nothing else can see.
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
const CARTONS: readonly LeaseDomain[] = [LEASE_DOMAIN.CARTON_STOCK];
const SALES: readonly LeaseDomain[] = [LEASE_DOMAIN.SALES_DISPATCH];
const ACCOUNTS: readonly LeaseDomain[] = [LEASE_DOMAIN.ACCOUNTS];
/** A gatepass moves the carton figure and is a sales document, with the bill it makes. */
const CARTONS_AND_SALES: readonly LeaseDomain[] = [LEASE_DOMAIN.CARTON_STOCK, LEASE_DOMAIN.SALES_DISPATCH];

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
  // The colour list (docs/45).
  [IPC.createColorTranslation]: MASTER,
  [IPC.updateColorTranslation]: MASTER,
  [IPC.deleteColorTranslation]: MASTER,
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

  // ── Carton stock: every movement of the carton figure (docs/42 section 6) ──
  // One writer for all four, so no two computers can take the same cartons out, and Manual
  // Production's machine-day program and contractor ledger -- which do not replicate -- are never
  // split. A gatepass is here because it takes its cartons out the moment it is made.
  [IPC.recordManualProduction]: CARTONS,
  [IPC.voidManualProduction]: CARTONS,
  [IPC.adjustCartonStock]: CARTONS,
  [IPC.createGatepass]: CARTONS_AND_SALES,
  [IPC.cancelGatepass]: CARTONS_AND_SALES,

  // ── Product master: products, their colours and prices, and how they are grouped (docs/43) ──
  [IPC.createProduct]: MASTER,
  [IPC.updateProduct]: MASTER,
  [IPC.deleteProductListEntry]: MASTER,
  [IPC.renameProductListEntry]: MASTER,
  [IPC.disableProduct]: MASTER,
  [IPC.enableProduct]: MASTER,
  [IPC.createProductGroup]: MASTER,
  [IPC.createArticleSeries]: MASTER,
  [IPC.createProductType]: MASTER,
  [IPC.createProductSubGroup]: MASTER,
  [IPC.setProductSubGroupHasNoUpper]: MASTER,
  [IPC.createMainGroup]: MASTER,

  // ── Bills: they replicate now, so one computer writes them (docs/43) ──
  [IPC.createSaleVoucher]: SALES,
  [IPC.createManualSaleVoucher]: SALES,
  [IPC.enterGatepassBill]: SALES,
  [IPC.updateSaleVoucher]: SALES,
  [IPC.addVoucherLineItem]: SALES,
  [IPC.updateVoucherLineItem]: SALES,
  [IPC.deleteVoucherLineItem]: SALES,
  [IPC.deleteSaleVoucher]: SALES,
  [IPC.saveGatepassDeliveryProof]: SALES,
  // A sale return credits the customer and is not sent to the cloud in this release: one computer records them, the
  // one holding the sales lease (owner, 9 Nov 2026; docs/44 §6). Also on the carton QR hold below: refused everywhere
  // while the hold lasts, and only on the sales holder once it is lifted.
  [IPC.returnScan]: SALES,

  // ── Cash vouchers: they replicate now, so one computer writes them (docs/43) ──
  [IPC.createCashVoucher]: ACCOUNTS,
  [IPC.updateCashVoucher]: ACCOUNTS,
  [IPC.deleteCashVoucher]: ACCOUNTS,
};

/**
 * CARTON QR IS ON HOLD (docs/42 section 9). Every QR action that would move the carton figure. They move
 * it on this computer only, and carton stock is now shared, so one scan would put computers out of step.
 * Labels, lookups and raw material QR are not here: they do not touch the carton figure.
 */
export const CARTON_QR_HOLD_CHANNELS: ReadonlySet<string> = new Set([
  IPC.processScan,
  IPC.receiveProduction,
  IPC.dispatchScan,
  IPC.returnScan,
  IPC.storeEntryScan,
  IPC.storeExitScan,
  IPC.machineProgramCartonIn,
  IPC.markQrCodeDamaged,
  // A new carton label run opens a machine's program for the day, on any computer (docs/43).
  IPC.generateQrBatch,
]);

/**
 * Writes in the same modules that are deliberately NOT leased in Milestone 1, each with its reason.
 * Listed so the classification test can tell "decided" from "forgotten".
 */
export const UNLEASED_WRITE_CHANNELS: Readonly<Record<string, string>> = {
  [IPC.storeEntryScan]: "Carton QR flow: multi-writer by the owner's decision (docs/37 W.1).",
  [IPC.processScan]: "Carton QR production scan: on the carton QR hold in this release (CARTON_QR_HOLD_CHANNELS); its lease is decided when QR resumes.",
  [IPC.receiveProduction]: "Carton QR receiving: on the carton QR hold in this release; its lease is decided when QR resumes.",
  [IPC.dispatchScan]: "Carton QR dispatch scan: on the carton QR hold in this release; its lease is decided when QR resumes.",
  [IPC.storeExitScan]: "Carton QR flow: multi-writer.",
  [IPC.storeReceivingSession]: "Starts a carton store-in session: a carton flow, multi-writer.",
  [IPC.storeMoveOutSession]: "Starts a carton move-out session: a carton flow, multi-writer.",
  [IPC.machineProgramCartonIn]: "Carton QR flow: multi-writer.",
  [IPC.printMachineProgramCartons]: "Carton labels: multi-writer.",
  [IPC.convertMachineProgramCartonsToB]: "Carton labels: multi-writer.",
  [IPC.convertMachineProgramUpperCartonsToB]: "Carton labels: multi-writer.",
  [IPC.deleteMachineProgram]:
    "Machine programs are leased in Milestone 2, with their creation and edits. Deleting one only marks the program CANCELLED: no stock moves.",
  [IPC.saveProductImage]: "A picture file in this computer's own folder. Pictures do not travel (docs/43), and nothing about the product changes.",
  [IPC.createPartyProductGroupDiscount]: "A customer's discount rule: rules do not travel yet (docs/43), so a rule belongs to the computer it was made on.",
  [IPC.createPartyArticleSeriesDiscount]: "A customer's discount rule: rules do not travel yet (docs/43).",
  [IPC.createPartyArticleDiscount]: "A customer's discount rule: rules do not travel yet (docs/43).",
  [IPC.createPartyPriceRangeDiscount]: "A customer's discount rule: rules do not travel yet (docs/43).",
  [IPC.createItemRemovalRequest]: "A request only: approvals are leased in Milestone 2. Approving it is leased.",
  [IPC.createCategoryRemovalRequest]: "A request only: approvals are leased in Milestone 2. Approving it is leased.",
  [IPC.createStockCorrectionRequest]: "A request only: approvals are leased in Milestone 2. Approving it is leased.",
};

/** The domains this version enforces: every domain some channel above needs. */
export const ENFORCED_LEASE_DOMAINS: readonly LeaseDomain[] = [...new Set(Object.values(LEASED_CHANNELS).flat())];

/** The leases a channel needs, or none. */
export const leasesFor = (channel: string): readonly LeaseDomain[] => LEASED_CHANNELS[channel] ?? [];
