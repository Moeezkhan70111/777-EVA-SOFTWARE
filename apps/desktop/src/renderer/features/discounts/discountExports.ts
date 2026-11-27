import { toPaisa } from "@erp/domain";
import { openPrintDocument } from "../../platform/print";
import { formatDate, toIsoDate } from "../../utils/dates";
import { escapeHtml } from "../../utils/html";
import { downloadCsv } from "../../utils/exportFile";
import { copy } from "../../config/copy";
import { discountText } from "./discountPolicy";
import type { DiscountMatrix } from "./discountMatrix";

// THE DISCOUNT REPORT'S DOWNLOADS (owner, 28 Nov 2026): the PDF and the Excel file are the same grid as the screen,
// one row per party and one column per group (discountMatrix.ts): "Party name | EVR GENTS | EVR KIDS | EVR LADIES".
// A party with no discount on a column has an empty cell ("—" on paper). Moved here from the page (R2, R13).

const text = copy.discountPolicy;
/** More columns than this and the page turns sideways, so the groups keep their width. */
const LANDSCAPE_AFTER_COLUMNS = 5;
const cell = (rupees: number | undefined): string => (rupees === undefined ? "" : discountText(toPaisa(rupees)));

export function downloadDiscountExcel(grid: DiscountMatrix, title: string): void {
  downloadCsv(`discount-policy-${toIsoDate()}`, {
    preamble: [title],
    headers: [text.reportPartyName, ...grid.columns.map((column) => column.label)],
    rows: grid.rows.map((row) => [row.partyName, ...grid.columns.map((column) => cell(row.cells[column.key]))]),
  });
}

export function printDiscountPdf(grid: DiscountMatrix, title: string): void {
  const e = escapeHtml;
  const landscape = grid.columns.length > LANDSCAPE_AFTER_COLUMNS;
  const head = grid.columns.map((column) => `<th class="num">${e(column.label)}</th>`).join("");
  const body = grid.rows.map((row) => `
    <tr>
      <td class="party">${e(row.partyName)}</td>
      ${grid.columns.map((column) => {
        const value = cell(row.cells[column.key]);
        return value ? `<td class="num">${e(value)}</td>` : `<td class="num none">—</td>`;
      }).join("")}
    </tr>`).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${e(title)}</title>
  <style>
    @page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 14mm; }
    body { font-family: 'Segoe UI', sans-serif; font-size: 12px; color: #111; margin: 32px; }
    h1   { font-size: 16px; font-weight: 800; margin: 0 0 4px; }
    .sub { color: #6b7280; font-size: 11px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; }
    th { background: #f3f4f6; padding: 8px 10px; text-align: left; font-size: 10px;
         text-transform: uppercase; letter-spacing: .06em; border-bottom: 2px solid #e5e7eb; }
    td { padding: 7px 10px; border-bottom: 1px solid #e5e7eb; }
    tr:last-child td { border-bottom: none; }
    .party { font-weight: 600; }
    .num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; }
    .none { color: #9ca3af; font-weight: 400; }
    @media print { body { margin: 0; } }
  </style>
</head>
<body>
  <h1>${e(title)}</h1>
  <div class="sub">${e(formatDate(new Date()))} &nbsp;·&nbsp; ${e(text.reportCount(grid.rows.length))} &nbsp;·&nbsp; ${e(text.discountColumn)}</div>
  <table>
    <thead><tr><th>${e(text.reportPartyName)}</th>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>
</body>
</html>`;

  const printed = openPrintDocument(html, { features: "width=900,height=650" });
  if (!printed.opened) return;
  printed.window.focus();
  printed.window.print();
}
