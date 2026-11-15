import { copy } from "../../../config/copy";
import type { HandVoucher } from "../../../types/desktopApi";
import { printStoreVoucher, renderStoreVoucherHtml, type StoreVoucher, type StoreVoucherOptions, type VoucherPrintOutcome } from "../../rawMaterial/storeVoucher";

// The printed slip for one store hand voucher — the same store voucher as the Move In receipt and the Move Out slip
// (storeVoucher.ts), filled in for a typed voucher: its number, party and time, each line as it was typed, and its
// reference (in) or purpose (out).

const slipOf = (voucher: HandVoucher): StoreVoucher => ({
  title: copy.handVoucher[voucher.direction].slipTitle,
  partyName: voucher.partyName,
  session: { code: voucher.code, startedAt: voucher.createdAt, closedAt: voucher.createdAt },
  totalPackets: 0,
  byMaterial: voucher.lines.map((line) => ({ itemDisplayName: line.itemName, packets: 0, quantity: line.typedQuantity, unitCode: line.typedUnitCode })),
  nothingLine: copy.handVoucher.slipNothing,
  typed: true,
  note: voucher.note,
  noteLabel: copy.handVoucher[voucher.direction].note,
});

/** Builds the printable HTML for a voucher's slip. Exported so it can be tested without a window. */
export const renderHandSlipHtml = (voucher: HandVoucher, options: StoreVoucherOptions = {}): string =>
  renderStoreVoucherHtml(slipOf(voucher), options);

/** Sends the slip to the slip printer (storeVoucher.ts). */
export const printHandSlip = (voucher: HandVoucher, printedBy?: string | null): Promise<VoucherPrintOutcome> =>
  printStoreVoucher(slipOf(voucher), printedBy);
