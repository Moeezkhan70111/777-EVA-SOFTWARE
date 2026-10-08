import type { Gatepass } from "../types/desktopApi";
import { buildDocumentGrid } from "./gatepassGrid";
import { escapeHtml } from "./html";
import { formatBookDate, formatDate, formatDateTime } from "./dates";
import { loadLogoDataUrl, openPrintDocumentAsync } from "../platform/print";

// Printable Gatepass, laid out like the paper book it replaces:
//
//   ┌ letterhead ──────────────────────────────────────────┐
//   │ GP No. ____   Date ____   Bilty No. ____   Via ____ │
//   │ Party  ______________________________________________│
//   ├ Article │ Size │ BLACK │ NAVY │ … │ Total ───────────┤
//   │ SK6     │ 7/10 │   1   │  2   │   │   5              │
//   ├─────────┴──────┴───────┴──────┴───┴──────────────────┤
//   │ Total                                    8           │
//   └──────────────────────────────────────────────────────┘
//
// Deliberately no rate, discount, amount or balance: this is not a bill. Bilty No. and Via
// print as blank lines when unknown, so they can be written in by hand as before.

/** A plain `YYYY-MM-DD` gatepass date is a calendar day, not an instant — formatted as such. */
export const formatGatepassDate = (ymd: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  if (!match) return ymd || "—";
  return formatDate(`${ymd}T00:00:00`, ymd);
};

/** dd/mm/yyyy, as the book is dated. */
const formatBookDay = (ymd: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  return match ? formatBookDate(`${ymd}T00:00:00`, ymd) : ymd || "";
};

export const formatGatepassDateTime = (iso: string | null | undefined): string => formatDateTime(iso, iso ?? "—");

const PRINT_STYLES = `
  * { box-sizing: border-box; }
  @page { size: A4 portrait; margin: 12mm; }
  body { font-family: "Segoe UI", Helvetica, Arial, sans-serif; margin: 24px; color: #111; font-size: 13px; }
  .print-actions { text-align: center; margin-bottom: 18px; }
  .print-actions button {
    padding: 10px 26px; font-size: 13px; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; background: #17365d; color: #fff; border: none; border-radius: 4px; cursor: pointer;
  }
  .doc { max-width: 800px; margin: 0 auto; }

  .letterhead { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding-bottom: 10px; border-bottom: 3px solid #17365d; }
  .letterhead img { height: 54px; width: auto; }
  .letterhead .brand-text { font-size: 22px; font-weight: 900; letter-spacing: .04em; color: #17365d; }
  .letterhead .brand-text small { display: block; font-size: 10px; font-weight: 700; letter-spacing: .14em; color: #555; }
  .letterhead .doc-title { text-align: right; }
  .letterhead .doc-title h1 { margin: 0; font-size: 20px; letter-spacing: .16em; color: #17365d; }
  .letterhead .doc-title .no { font-family: Consolas, "Courier New", monospace; font-size: 16px; font-weight: 700; margin-top: 2px; }
  .cancelled { display: inline-block; margin-top: 6px; padding: 2px 8px; border: 2px solid #b91c1c; color: #b91c1c; font-weight: 800; letter-spacing: .1em; font-size: 11px; }

  .head-box { margin-top: 14px; border: 1.5px solid #111; border-radius: 8px; padding: 10px 14px; }
  .head-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 20px; }
  .head-row + .head-row { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #bbb; }
  .head-row.party { grid-template-columns: 1fr; }
  .field { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .field label { flex: none; font-size: 10px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: .08em; }
  .field .val { flex: 1; min-height: 18px; border-bottom: 1px solid #111; font-weight: 700; font-size: 13px; padding: 0 4px 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .field .val.blank { border-bottom-style: dotted; }
  .field .val.party { font-size: 17px; letter-spacing: .02em; }
  .field .val.city { flex: none; font-size: 11px; font-weight: 600; color: #444; border: none; }

  .grid { width: 100%; border-collapse: collapse; margin-top: 14px; table-layout: fixed; }
  .grid th, .grid td { border: 1px solid #111; padding: 7px 6px; text-align: center; font-variant-numeric: tabular-nums; }
  .grid thead th { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; background: #eef2f7; color: #17365d; line-height: 1.2; word-break: break-word; }
  .grid th.article { text-align: left; width: 16%; }
  .grid th.size, .grid td.size { width: 11%; }
  .grid th.total, .grid td.total { width: 11%; background: #f5f7fa; }
  .grid tbody th { text-align: left; font-weight: 800; font-size: 14px; letter-spacing: .02em; }
  /* Product group under the article name. A second line inside the same cell, small enough
     to sit within the existing 34px row, so the printed grid keeps the book's geometry. */
  .grid tbody th small { display: block; font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #555; }
  .grid tbody td { font-size: 14px; font-weight: 600; height: 34px; }
  .grid tbody td.total { font-weight: 800; }
  .grid tbody td.size { font-weight: 700; }
  .grid tbody tr.blank td, .grid tbody tr.blank th { height: 30px; }
  .grid tfoot td, .grid tfoot th { font-weight: 800; font-size: 14px; background: #eef2f7; }
  .grid tfoot th { text-align: left; }
  .grid tfoot td.total { font-size: 16px; }

  .remarks { margin-top: 12px; font-size: 12px; color: #333; }
  .sign { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 40px; margin-top: 44px; }
  .sign div { border-top: 1px solid #111; padding-top: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #444; text-align: center; }
  .foot { margin-top: 22px; font-size: 10px; color: #777; text-align: center; }
  @media print {
    .print-actions { display: none; }
    body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`;

/** Empty rows keep the printed grid the height of a book page, with room to add by hand. */
const MIN_GRID_ROWS = 8;

export interface GatepassPrintOptions {
  /** Letterhead logo as a data URL; when absent the brand name is printed as text. */
  logoDataUrl?: string;
}

/** Builds the printable HTML for a gatepass. Exported so it can be tested without a window. */
export const renderGatepassPrintHtml = (gatepass: Gatepass, options: GatepassPrintOptions = {}): string => {
  const grid = buildDocumentGrid(gatepass.lines);
  const colourCount = Math.max(grid.colours.length, 1);

  const headerCells = grid.colours.map((colour) => `<th scope="col">${escapeHtml(colour)}</th>`).join("");
  const bodyRows = grid.rows
    .map(
      (row) => `<tr>
        <th scope="row">${escapeHtml(row.article)}${row.groupName ? `<small>${escapeHtml(row.groupName)}</small>` : ""}</th>
        <td class="size">${escapeHtml(row.size)}</td>
        ${grid.colours.map((colour) => `<td>${row.quantities[colour] ? escapeHtml(row.quantities[colour]) : ""}</td>`).join("")}
        <td class="total">${escapeHtml(row.total)}</td>
      </tr>`
    )
    .join("");
  const blankRows = Array.from({ length: Math.max(0, MIN_GRID_ROWS - grid.rows.length) })
    .map(() => `<tr class="blank"><th></th><td class="size"></td>${grid.colours.map(() => "<td></td>").join("") || "<td></td>"}<td class="total"></td></tr>`)
    .join("");
  const footCells = grid.colours.map((colour) => `<td>${grid.columnTotals[colour] ? escapeHtml(grid.columnTotals[colour]) : ""}</td>`).join("") || "<td></td>";

  const field = (label: string, value: string | null | undefined, extraClass = "") =>
    `<div class="field"><label>${escapeHtml(label)}</label><span class="val ${value ? "" : "blank"} ${extraClass}">${escapeHtml(value ?? "")}</span></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Gatepass ${escapeHtml(gatepass.code)}</title>
  <style>${PRINT_STYLES}</style>
</head>
<body>
  <div class="print-actions"><button onclick="window.print()">🖨 Print / Save as PDF</button></div>
  <div class="doc">
    <div class="letterhead">
      ${options.logoDataUrl ? `<img src="${options.logoDataUrl}" alt="777 Seven" />` : `<div class="brand-text">777 SEVEN<small>T&amp;T TRADERS</small></div>`}
      <div class="doc-title">
        <h1>GATE PASS</h1>
        <div class="no">${escapeHtml(gatepass.code)}</div>
        ${gatepass.status === "CANCELLED" ? `<div class="cancelled">CANCELLED</div>` : ""}
      </div>
    </div>

    <div class="head-box">
      <div class="head-row">
        ${field("GP No.", String(gatepass.gatepassNumber).padStart(5, "0"))}
        ${field("Date", formatBookDay(gatepass.gatepassDate))}
        ${field("Bilty No.", gatepass.biltyNumber)}
        ${field("Via", gatepass.transportVia)}
      </div>
      <div class="head-row party">
        <div class="field">
          <label>Party</label>
          <span class="val party">${escapeHtml(gatepass.partyName)}</span>
          ${gatepass.partyCity ? `<span class="val city">${escapeHtml(gatepass.partyCity)}</span>` : ""}
        </div>
      </div>
    </div>

    <table class="grid">
      <colgroup>
        <col style="width:16%" /><col style="width:11%" />
        ${Array.from({ length: colourCount }).map(() => `<col style="width:${(62 / colourCount).toFixed(2)}%" />`).join("")}
        <col style="width:11%" />
      </colgroup>
      <thead>
        <tr><th class="article">Article</th><th class="size">Size</th>${headerCells || "<th></th>"}<th class="total">Total</th></tr>
      </thead>
      <tbody>${bodyRows}${blankRows}</tbody>
      <tfoot>
        <tr><th colspan="2">Total cartons</th>${footCells}<td class="total">${escapeHtml(grid.total)}</td></tr>
      </tfoot>
    </table>

    ${gatepass.remarks ? `<div class="remarks"><strong>Remarks:</strong> ${escapeHtml(gatepass.remarks)}</div>` : ""}
    ${
      gatepass.status === "CANCELLED"
        ? `<div class="remarks"><strong>Cancelled:</strong> ${escapeHtml(formatGatepassDateTime(gatepass.cancelledAt))} by ${escapeHtml(gatepass.cancelledBy ?? "—")}${gatepass.cancelReason ? ` — ${escapeHtml(gatepass.cancelReason)}` : ""}</div>`
        : ""
    }
    <div class="sign">
      <div>Prepared by${gatepass.createdBy ? `<br /><span style="text-transform:none;letter-spacing:0;font-weight:600">${escapeHtml(gatepass.createdBy)}</span>` : ""}</div>
      <div>Store</div>
      <div>Gate</div>
    </div>
    <div class="foot">Quantity document only — physical movement is recorded by carton scanning at the store and gate. Printed ${escapeHtml(formatGatepassDateTime(new Date().toISOString()))}.</div>
  </div>
</body>
</html>`;
};

/**
 * Opens the print-ready window. Returns false when the popup was blocked so the caller can
 * tell the operator. The window is opened synchronously (inside the click) and filled once
 * the logo has been read, so popup blockers see a user-initiated open.
 */
export const openGatepassPrintWindow = (gatepass: Gatepass): boolean =>
  openPrintDocumentAsync(loadLogoDataUrl().then((logoDataUrl) => renderGatepassPrintHtml(gatepass, { logoDataUrl })));
