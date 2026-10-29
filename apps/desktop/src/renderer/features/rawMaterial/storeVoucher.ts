import { copy } from "../../config/copy";
import { escapeHtml } from "../../utils/html";
import { formatClockTime, formatDashedDate } from "../../utils/dates";
import { loadLogoDataUrl, openPrintDocumentAsync } from "../../platform/print";

// THE STORE VOUCHER — the one printed layout for a store session: the company letterhead, what
// happened and with whom, the session it was done under, and what it totalled by material. The
// Move In receipt and the Move Out slip are both this voucher (0.3.8), so they cannot drift apart.
//
// It is the physical slip that goes with the goods, not a transaction log. Every packet's own scan
// (QR, exact time) already lives in QR Management/Journey; this is the summary a storekeeper hands
// over and files.

const PRINT_STYLES = `
  * { box-sizing: border-box; }
  @page { size: A4 portrait; margin: 12mm; }
  body { font-family: "Segoe UI", Helvetica, Arial, sans-serif; margin: 24px; color: #111; font-size: 13px; }
  .print-actions { text-align: center; margin-bottom: 18px; }
  .print-actions button {
    padding: 10px 26px; font-size: 13px; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; background: #17365d; color: #fff; border: none; border-radius: 4px; cursor: pointer;
  }
  .doc { max-width: 800px; margin: 5px}

  .doc-head { border: 1.5px solid #111; border-radius: 8px; overflow: hidden; }
  .doc-head-logo { padding: 12px; text-align: center; border-bottom: 1.5px solid #111; }
  .doc-head-logo img { height: 46px; width: auto; }
  .doc-head-logo .brand-text { font-size: 20px; font-weight: 900; letter-spacing: .04em; color: #17365d; }
  .doc-head-title { display: grid; grid-template-columns: 1fr 1fr; text-transform: uppercase; }
  .doc-head-title div { padding: 10px 12px; text-align: center; font-weight: 800; font-size: 13px; letter-spacing: .05em; }
  .doc-head-title div:first-child { border-right: 1.5px solid #111; }

  .session-table { width: 100%; border-collapse: collapse; margin-top: 14px; }
  .session-table th, .session-table td { border: 1px solid #111; padding: 8px 10px; text-align: center; }
  .session-table th { background: #eef2f7; font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; color: #17365d; }
  .session-table td { font-weight: 700; font-size: 13px; font-variant-numeric: tabular-nums; }

  .summary-heading {
    text-align: center; font-size: 15px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase;
    margin: 26px 0 8px; padding-bottom: 8px; border-bottom: 2px solid #111;
  }

  .materials-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  .materials-table th, .materials-table td { border: 1px solid #111; padding: 7px 10px; }
  .materials-table th { background: #eef2f7; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: #17365d; text-align: left; }
  .materials-table th.num, .materials-table td.num { text-align: center; }
  .materials-table tbody td { font-size: 13px; font-weight: 600; }
  .materials-table tfoot td { font-weight: 800; font-size: 13px; background: #f5f7fa; }

  .sign { margin-top: 70px; padding-top: 10px; border-top: 1px solid #111; display: grid; grid-template-columns: 1fr 1fr 1fr; }
  .sign div { text-align: center; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #444; }
  .printed-by { margin-top: 16px; text-align: right; font-size: 10px; color: #777; text-transform: uppercase; letter-spacing: .04em; }
  @media print { .print-actions { display: none; } body { margin: 0; } }
`;

export interface StoreVoucherMaterial {
  itemDisplayName: string;
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
const quantityTotalLine = (byMaterial: StoreVoucherMaterial[]): string => {
  const totalsByUnit = new Map<string, number>();
  for (const material of byMaterial) {
    const unit = material.unitCode || "";
    totalsByUnit.set(unit, (totalsByUnit.get(unit) ?? 0) + material.quantity);
  }
  return [...totalsByUnit.entries()].map(([unit, quantity]) => `${quantity} ${unit}`.trim()).join(" + ");
};

const materialsTable = (voucher: StoreVoucher): string => {
  const e = escapeHtml;
  const rows = voucher.byMaterial
    .map((row) => `<tr><td>${e(row.itemDisplayName)}</td><td class="num">${row.packets}</td><td class="num">${row.quantity} ${e(row.unitCode)}</td></tr>`)
    .join("");
  const total =
    voucher.byMaterial.length > 0
      ? `<tfoot><tr><td>Total</td><td class="num">${voucher.totalPackets}</td><td class="num">${e(quantityTotalLine(voucher.byMaterial))}</td></tr></tfoot>`
      : "";
  return `<table class="materials-table">
      <thead><tr><th>Material</th><th class="num">Packets</th><th class="num">Quantity</th></tr></thead>
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
  <div class="print-actions"><button onclick="window.print()">${e(copy.reports.printOrSave)}</button></div>
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

/**
 * Opens the voucher in the print window. Returns false when the popup was blocked so the
 * caller can tell the operator. The window is opened synchronously (inside the click) and
 * filled once the logo has been read, so popup blockers see a user-initiated open.
 */
export const openStoreVoucherPrintWindow = (voucher: StoreVoucher, printedBy?: string | null): boolean =>
  openPrintDocumentAsync(loadLogoDataUrl().then((logoDataUrl) => renderStoreVoucherHtml(voucher, { logoDataUrl, printedBy })));
