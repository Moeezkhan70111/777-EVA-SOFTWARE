import { copy } from "../../config/copy";
import { escapeHtml } from "../../utils/html";
import { formatClockTime, formatDashedDate } from "../../utils/dates";
import { PRINTER_ROLE } from "../../../shared/printerRole";
import { materialNameParts } from "./rawMaterial";
import { loadLogoDataUrl, openPrintDocument, printDocumentDirect } from "../../platform/print";

// THE STORE VOUCHER — the one printed layout for a store session: the company letterhead, what
// happened and with whom, the session it was done under, and what it totalled by material. The
// Move In receipt and the Move Out slip are both this voucher (0.3.8), so they cannot drift apart.
//
// It is the physical slip that goes with the goods, not a transaction log. Every packet's own scan
// (QR, exact time) already lives in QR Management/Journey; this is the summary a storekeeper hands
// over and files.
//
// IT IS A SLIP ON A ROLL (Nov 2026): 4 inches wide, as long as it needs to be, and black only, since
// a thermal head has no greys to give a shaded heading. Pressing print sends it straight to the
// store's Star TSP800II, not the computer's default printer, which QR labels keep. A computer
// without that printer, or a job it refuses, gets the same slip in a window to print from instead.

const PRINT_STYLES = `
  * { box-sizing: border-box; }
  @page { margin: 0; }
  body { font-family: "Segoe UI", Helvetica, Arial, sans-serif; width: 4in; margin: 0; padding: 2mm 3mm; color: #000; font-size: 13px; }
  .print-actions { text-align: center; margin: 10px 0 14px; }
  .print-actions button {
    padding: 8px 18px; font-size: 12px; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; background: #17365d; color: #fff; border: none; border-radius: 4px; cursor: pointer;
  }
  .doc { width: 100%; }

  .doc-head { border: 1.5px solid #000; border-radius: 6px; overflow: hidden; }
  .doc-head-logo { padding: 8px; text-align: center; border-bottom: 1.5px solid #000; }
  .doc-head-logo img { height: 40px; width: auto; filter: grayscale(1) contrast(1.4); }
  .doc-head-logo .brand-text { font-size: 18px; font-weight: 900; letter-spacing: .04em; }
  .doc-head-title { text-transform: uppercase; }
  .doc-head-title div { padding: 6px 8px; text-align: center; font-weight: 800; font-size: 13px; letter-spacing: .04em; overflow-wrap: anywhere; }
  .doc-head-title div:first-child { border-bottom: 1px solid #000; }

  .session-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  .session-table th, .session-table td { border: 1px solid #000; padding: 5px 4px; text-align: center; }
  .session-table th { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
  .session-table td { font-weight: 700; font-size: 12px; font-variant-numeric: tabular-nums; }

  .summary-heading {
    text-align: center; font-size: 13px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase;
    margin: 14px 0 6px; padding-bottom: 5px; border-bottom: 2px solid #000;
  }

  .materials-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .materials-table th, .materials-table td { border: 1px solid #000; padding: 3px 4px; overflow-wrap: anywhere; }
  .materials-table th { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; text-align: left; }
  .materials-table th.num { width: 40px; }
  .materials-table th.num:last-child { width: 72px; }
  .materials-table th.num, .materials-table td.num { text-align: center; }
  .materials-table tbody td { font-size: 12px; font-weight: 600; }
  .materials-table tfoot td { font-weight: 800; font-size: 13px; }
  .materials-table tr { break-inside: avoid; }
  /* A material's category and sub-category, after its name, on the same line when they fit. */
  .cat-badge {
    display: inline-block; margin-left: 4px; padding: 0 5px; border: 1px solid #000; border-radius: 999px;
    font-size: 9.5px; font-weight: 700; line-height: 1.4; white-space: nowrap;
  }

  /* Room above each name to sign by hand. */
  .sign { margin-top: 44px; padding-top: 6px; border-top: 1px solid #000; display: grid; grid-template-columns: 1fr 1fr 1fr; break-inside: avoid; }
  .sign div { text-align: center; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .printed-by { margin-top: 8px; text-align: right; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
  @media print { .print-actions { display: none; } }
`;

export interface StoreVoucherMaterial {
  itemDisplayName: string;
  /** Where it sits: "TOP — SUB". Printed as badges, and left out of the name. */
  categoryLabel?: string;
  packets: number;
  quantity: number;
  unitCode: string;
}

/** What one printed voucher says. */
export interface StoreVoucher {
  /** What happened — "Raw Material Received", "Raw Material Issued". */
  title: string;
  /** Who it happened with; null prints a dash. */
  partyName: string | null;
  session: { code: string; startedAt: string; closedAt: string | null };
  totalPackets: number;
  byMaterial: StoreVoucherMaterial[];
  /** The line printed in place of the table when the session holds nothing. */
  nothingLine: string;
}

export interface StoreVoucherOptions {
  /** Letterhead logo as a data URL; when absent the brand name is printed as text. */
  logoDataUrl?: string;
  /** The operator viewing/printing this voucher right now — may differ from who did the session. */
  printedBy?: string | null;
  /** Leaves out the on-screen Print button, for a slip going straight to the printer. */
  noPrintButton?: boolean;
}

/** Started -> closed, as one line. A session still open has no end yet, so it says so rather than guessing one. */
const sessionDateLine = (startedAt: string, closedAt: string | null): string => {
  const start = formatDashedDate(startedAt);
  if (!closedAt) return start;
  const end = formatDashedDate(closedAt);
  return start === end ? start : `${start} — ${end}`;
};

const sessionTimeLine = (startedAt: string, closedAt: string | null): string =>
  `${formatClockTime(startedAt)} - ${closedAt ? formatClockTime(closedAt) : "In progress"}`;

/**
 * Packets are always addable regardless of unit; quantity is not — 2 KG and 3 DOZEN cannot
 * become one number. Grouped by unit so a session of only one unit (the common case) still
 * shows one plain total, and a mixed one shows one total per unit instead of a wrong sum.
 */
export const quantityTotalLine = (byMaterial: StoreVoucherMaterial[]): string => {
  const totalsByUnit = new Map<string, number>();
  for (const material of byMaterial) {
    const unit = material.unitCode || "";
    totalsByUnit.set(unit, (totalsByUnit.get(unit) ?? 0) + material.quantity);
  }
  return [...totalsByUnit.entries()].map(([unit, quantity]) => `${quantity} ${unit}`.trim()).join(" + ");
};

/** A material's name for the slip: no category (its badges say that), and spaces between its parts, to keep rows short. */
export const slipMaterialName = (displayName: string, categoryLabel = ""): string =>
  materialNameParts(displayName, categoryLabel).join(" ");

/** The category and sub-category as badges. */
const categoryBadges = (categoryLabel = ""): string =>
  categoryLabel
    .split(" — ")
    .filter(Boolean)
    .map((part) => `<span class="cat-badge">${escapeHtml(part)}</span>`)
    .join("");

/**
 * The second figure on the Store page's mode switch: what a session's packets hold. A bare number
 * for one unit, "1/20". Units cannot be added together, so several are said by name.
 */
export const quantityFigure = (byMaterial: StoreVoucherMaterial[]): string => {
  const units = new Set(byMaterial.map((material) => material.unitCode || ""));
  if (units.size === 0) return "";
  if (units.size > 1) return quantityTotalLine(byMaterial);
  return String(Number(byMaterial.reduce((sum, material) => sum + material.quantity, 0).toFixed(3)));
};

const materialsTable = (voucher: StoreVoucher): string => {
  const e = escapeHtml;
  const rows = voucher.byMaterial
    .map((row) => `<tr><td>${e(slipMaterialName(row.itemDisplayName, row.categoryLabel))}${categoryBadges(row.categoryLabel)}</td><td class="num">${row.packets}</td><td class="num">${row.quantity} ${e(row.unitCode)}</td></tr>`)
    .join("");
  const total =
    voucher.byMaterial.length > 0
      // Two rows, wide cells: a session of several units has a long quantity line for a 4 inch slip.
      ? `<tfoot><tr><td>Total packets</td><td class="num" colspan="2">${voucher.totalPackets}</td></tr><tr><td>Total quantity</td><td class="num" colspan="2">${e(quantityTotalLine(voucher.byMaterial))}</td></tr></tfoot>`
      : "";
  return `<table class="materials-table">
      <thead><tr><th>Material</th><th class="num">Pkts</th><th class="num">Qty</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="3">${e(voucher.nothingLine)}</td></tr>`}</tbody>
      ${total}
    </table>`;
};

/** Builds the printable HTML for one voucher. Exported so it can be tested without a window. */
export const renderStoreVoucherHtml = (voucher: StoreVoucher, options: StoreVoucherOptions = {}): string => {
  const e = escapeHtml;
  const { session } = voucher;
  const partyName = voucher.partyName ?? "—";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${e(session.code)} — ${e(partyName)}</title>
  <style>${PRINT_STYLES}</style>
</head>
<body>
  ${options.noPrintButton ? "" : `<div class="print-actions"><button onclick="window.print()">${e(copy.reports.printOrSave)}</button></div>`}
  <div class="doc">
    <div class="doc-head">
      <div class="doc-head-logo">
        ${options.logoDataUrl ? `<img src="${options.logoDataUrl}" alt="777 Seven" />` : `<span class="brand-text">777 SEVEN</span>`}
      </div>
      <div class="doc-head-title">
        <div>${e(voucher.title)}</div>
        <div>${e(partyName)}</div>
      </div>
    </div>

    <table class="session-table">
      <thead><tr><th>Session</th><th>Date</th><th>Time</th></tr></thead>
      <tbody><tr>
        <td>${e(session.code)}</td>
        <td>${e(sessionDateLine(session.startedAt, session.closedAt))}</td>
        <td>${e(sessionTimeLine(session.startedAt, session.closedAt))}</td>
      </tr></tbody>
    </table>

    <div class="summary-heading">Summary</div>
    ${materialsTable(voucher)}

    <div class="sign">
      <div>Received by</div>
      <div>Store operator</div>
      <div>Office</div>
    </div>
    ${options.printedBy ? `<div class="printed-by">Printed by: ${e(options.printedBy)}</div>` : ""}
  </div>
</body>
</html>`;
};

/** What became of pressing print. */
export type VoucherPrintOutcome =
  | { kind: "printed" }
  /** The slip printer could not take it, for `reason`: the slip is in a window to print from. */
  | { kind: "window"; reason: string }
  /** The slip printer could not take it, and the window was blocked too. */
  | { kind: "blocked"; reason: string }
  /** The press before this one is still printing. Without this, an impatient second press is a second slip. */
  | { kind: "busy" };

let printing = false;

/** Sends the voucher to the slip printer, or failing that opens it in a window to print from. */
export const printStoreVoucher = async (voucher: StoreVoucher, printedBy?: string | null): Promise<VoucherPrintOutcome> => {
  if (printing) return { kind: "busy" };
  printing = true;
  try {
    const logoDataUrl = await loadLogoDataUrl();
    const slip = renderStoreVoucherHtml(voucher, { logoDataUrl, printedBy, noPrintButton: true });
    const direct = await printDocumentDirect(slip, undefined, PRINTER_ROLE.SLIP);
    if (direct.printed) return { kind: "printed" };
    const opened = openPrintDocument(renderStoreVoucherHtml(voucher, { logoDataUrl, printedBy })).opened;
    return { kind: opened ? "window" : "blocked", reason: direct.reason };
  } finally {
    printing = false;
  }
};

/** Tells the operator what became of pressing print. */
export const announceVoucherPrint = (
  outcome: VoucherPrintOutcome,
  push: (kind: "success" | "warning" | "error", title: string, message?: string) => void
): void => {
  if (outcome.kind === "printed") push("success", copy.storeVoucherPrint.sentTitle, copy.storeVoucherPrint.sentBody);
  if (outcome.kind === "window") push("warning", copy.storeVoucherPrint.notSentTitle, copy.storeVoucherPrint.windowBody(outcome.reason));
  if (outcome.kind === "blocked") push("error", copy.storeVoucherPrint.notSentTitle, copy.storeVoucherPrint.blockedBody(outcome.reason));
};
