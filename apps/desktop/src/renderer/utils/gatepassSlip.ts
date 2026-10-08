import { formatQuantityInDozens } from "@erp/domain";
import type { GatepassScanProgress } from "../types/desktopApi";
import { openReport } from "./reportDocument";
import { formatDateTime } from "./dates";

// The two operational slips a gatepass produces as it physically moves:
//
//   Store slip     these exact cartons left the store for this Gatepass
//   Dispatch slip  these exact cartons went onto the vehicle for the party
//
// Both are the same document with a different heading and a different column, because they
// prove the same thing at two gates. Built on the existing report printer (utils/reportDocument),
// which is what every other printed list in the ERP already uses — "PDF" here means the print
// window with Save as PDF, as it does everywhere else.
//
// Deliberately no rate, discount, amount or balance: the bill owns the money and a slip that
// restated it could disagree with it. The slip's whole job is what physically moved.

export interface GatepassSlipInput {
  desk: "STORE" | "DISPATCH";
  progress: GatepassScanProgress;
  operator: string;
}

export const buildGatepassSlip = ({ desk, progress, operator }: GatepassSlipInput) => {
  const store = desk === "STORE";
  const scannedOf = (line: GatepassScanProgress["lines"][number]) =>
    store ? line.storeScannedCartons : line.dispatchedCartons;
  const scannedTotal = store ? progress.storeScannedCartons : progress.dispatchedCartons;

  return {
    title: store ? "Store Slip — Gatepass" : "Dispatch Slip — Gatepass",
    filters: [
      { label: "Gatepass", value: progress.code },
      { label: "Party", value: progress.partyName },
      { label: "Bill", value: progress.voucherNumber ? `#${progress.voucherNumber}` : "—" },
      { label: store ? "Taken out by" : "Dispatched by", value: operator || "—" },
      { label: "Printed", value: formatDateTime(new Date().toISOString()) },
    ],
    columns: [
      { label: "Article" },
      { label: "Colour" },
      { label: "Size" },
      { label: "Required", numeric: true },
      { label: store ? "Taken out" : "Dispatched", numeric: true },
    ],
    rows: progress.lines.map((line) => [
      line.article,
      line.color,
      line.size,
      formatQuantityInDozens(line.requiredCartons),
      formatQuantityInDozens(scannedOf(line)),
    ]),
    totals: [
      { label: "Required", value: formatQuantityInDozens(progress.requiredCartons) },
      { label: store ? "Taken out of store" : "Dispatched", value: formatQuantityInDozens(scannedTotal) },
    ],
    footnote: store
      ? "These cartons were scanned out of the store for this Gatepass and now stand at the gate. One scanned QR is one carton."
      : "These cartons were scanned onto the vehicle for this Gatepass. One scanned QR is one carton.",
  };
};

/** Opens the slip in the print window. False when the popup was blocked. */
export const openGatepassSlipPrintWindow = (input: GatepassSlipInput): boolean => openReport(buildGatepassSlip(input));
