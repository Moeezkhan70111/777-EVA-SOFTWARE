import type { RawMaterialIssueSessionSummary } from "../../types/desktopApi";
import { printStoreVoucher, renderStoreVoucherHtml, type StoreVoucher, type StoreVoucherOptions, type VoucherPrintOutcome } from "./storeVoucher";

// The printed slip for one Move Out session — the same store voucher as the Move In receipt
// (storeVoucher.ts), filled in for what left the store and the party it went to (0.3.8).

const issueVoucher = (summary: RawMaterialIssueSessionSummary): StoreVoucher => ({
  title: "Raw Material Issued",
  partyName: summary.partyName,
  session: summary.session,
  totalPackets: summary.totalPackets,
  byMaterial: summary.byMaterial,
  nothingLine: "Nothing was issued in this session.",
});

/** Builds the printable HTML for an issue session's slip. Exported so it can be tested without a window. */
export const renderIssueSlipHtml = (summary: RawMaterialIssueSessionSummary, options: StoreVoucherOptions = {}): string =>
  renderStoreVoucherHtml(issueVoucher(summary), options);

/** Sends the slip to the slip printer (storeVoucher.ts). */
export const printIssueSlip = (summary: RawMaterialIssueSessionSummary, printedBy?: string | null): Promise<VoucherPrintOutcome> =>
  printStoreVoucher(issueVoucher(summary), printedBy);
