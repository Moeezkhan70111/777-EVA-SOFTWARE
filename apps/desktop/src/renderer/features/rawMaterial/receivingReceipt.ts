import type { RawMaterialReceivingSessionSummary } from "../../types/desktopApi";
import { openStoreVoucherPrintWindow, renderStoreVoucherHtml, type StoreVoucher, type StoreVoucherOptions } from "./storeVoucher";

// The printed voucher for one supplier's delivery — the store voucher (storeVoucher.ts) filled in
// for Move In. The Move Out slip is the same voucher (issueSlip.ts).
//
// Lifted out of RawMaterialInputPage so the Raw Material workspace can re-print a past
// delivery from the Receipts tab without a second copy of this markup drifting away from the
// one the store actually hands over.

export type ReceivingReceiptOptions = StoreVoucherOptions;

const receivingVoucher = (summary: RawMaterialReceivingSessionSummary): StoreVoucher => ({
  title: "Raw Material Received",
  partyName: summary.session.partyName,
  session: summary.session,
  totalPackets: summary.totalPackets,
  byMaterial: summary.byMaterial,
  nothingLine: "Nothing was received in this session.",
});

/** Builds the printable HTML for a receiving session's voucher. Exported so it can be tested without a window. */
export const renderReceivingReceiptHtml = (summary: RawMaterialReceivingSessionSummary, options: ReceivingReceiptOptions = {}): string =>
  renderStoreVoucherHtml(receivingVoucher(summary), options);

/** Opens the voucher in the print window. Returns false when the popup was blocked. */
export const openReceivingReceiptPrintWindow = (summary: RawMaterialReceivingSessionSummary, printedBy?: string | null): boolean =>
  openStoreVoucherPrintWindow(receivingVoucher(summary), printedBy);
