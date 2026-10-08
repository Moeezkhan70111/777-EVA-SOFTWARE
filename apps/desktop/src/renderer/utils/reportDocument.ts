import { escapeHtml } from "./html";
import { formatDateTime } from "./dates";
import { copy } from "../config/copy";
import { loadLogoDataUrl, openPrintDocumentAsync } from "../platform/print";

// A printable report on the company letterhead — the same paper the Gatepass and the Sale
// Voucher print on, for the reports that are a table rather than a document.
//
// "PDF export" in this ERP means opening the print window and choosing Save as PDF: that is
// how every existing print-out works, there is no PDF library, and the operator gets the
// same dialog they already know. This builds the page; platform/print opens it, so nothing
// here calls window.open itself (R7 — the Android/iOS shell swaps that one module).
//
// A report is NOT the spreadsheet with a border round it. It carries the letterhead, the
// moment it was taken, the filters it was taken under, and its totals — the things that make
// a printed page worth keeping.

export interface ReportColumn {
  label: string;
  /** Right-aligns and uses tabular figures — for quantities and money. */
  numeric?: boolean;
}

export interface ReportDocument {
  /** "Raw Material Stock Report" — the heading and the window title. */
  title: string;
  /** What the figures were narrowed to. Printed under the heading, so the page is honest. */
  filters?: Array<{ label: string; value: string }>;
  columns: ReportColumn[];
  rows: string[][];
  /** Bold summary rows under the table, e.g. totals per unit. */
  totals?: Array<{ label: string; value: string }>;
  /** One line under the totals, e.g. how the figures are counted. */
  footnote?: string;
  emptyMessage?: string;
}

const STYLES = `
  * { box-sizing: border-box; }
  @page { size: A4 landscape; margin: 10mm; }
  body { font-family: "Segoe UI", Helvetica, Arial, sans-serif; margin: 22px; color: #111; font-size: 12px; }
  .print-actions { text-align: center; margin-bottom: 16px; }
  .print-actions button {
    padding: 10px 26px; font-size: 13px; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; background: #17365d; color: #fff; border: none; border-radius: 4px; cursor: pointer;
  }
  .doc { max-width: 1100px; margin: 0 auto; }
  .letterhead { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding-bottom: 10px; border-bottom: 3px solid #17365d; }
  .letterhead img { height: 48px; width: auto; }
  .letterhead .brand-text { font-size: 20px; font-weight: 900; letter-spacing: .04em; color: #17365d; }
  .letterhead .brand-text small { display: block; font-size: 10px; font-weight: 700; letter-spacing: .14em; color: #555; }
  .letterhead .doc-title { text-align: right; }
  .letterhead .doc-title h1 { margin: 0; font-size: 18px; letter-spacing: .12em; color: #17365d; }
  .letterhead .doc-title .taken { font-size: 11px; color: #555; margin-top: 3px; }
  .filters { margin: 12px 0 0; padding: 8px 12px; border: 1px solid #bbb; border-radius: 6px; font-size: 11px; color: #333; }
  .filters span { margin-right: 18px; }
  .filters b { color: #111; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; }
  th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; }
  thead th { background: #eef2f7; color: #17365d; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { padding: 24px; text-align: center; color: #666; border: 1px dashed #bbb; margin-top: 14px; }
  .totals { margin-top: 14px; display: flex; gap: 28px; flex-wrap: wrap; justify-content: flex-end; }
  .totals div { font-size: 12px; }
  .totals b { font-size: 15px; display: block; font-variant-numeric: tabular-nums; }
  .footnote { margin-top: 14px; font-size: 10.5px; color: #555; }
  @media print { .print-actions { display: none; } body { margin: 0; } }
`;

export const buildReportHtml = (report: ReportDocument, logoDataUrl: string): string => {
  const e = escapeHtml;
  const takenAt = formatDateTime(new Date().toISOString());

  const head = report.columns
    .map((column) => `<th${column.numeric ? ' class="num"' : ""}>${e(column.label)}</th>`)
    .join("");
  const body = report.rows
    .map(
      (row) =>
        `<tr>${row
          .map((value, index) => `<td${report.columns[index]?.numeric ? ' class="num"' : ""}>${e(value)}</td>`)
          .join("")}</tr>`
    )
    .join("");

  const filters = report.filters?.length
    ? `<div class="filters">${report.filters.map((filter) => `<span>${e(filter.label)}: <b>${e(filter.value)}</b></span>`).join("")}</div>`
    : "";
  const totals = report.totals?.length
    ? `<div class="totals">${report.totals.map((total) => `<div>${e(total.label)}<b>${e(total.value)}</b></div>`).join("")}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>${e(report.title)}</title><style>${STYLES}</style></head>
<body>
  <div class="print-actions"><button onclick="window.print()">${e(copy.reports.printOrSave)}</button></div>
  <div class="doc">
    <div class="letterhead">
      <div style="display:flex;align-items:center;gap:14px;">
        ${logoDataUrl ? `<img src="${logoDataUrl}" alt="" />` : ""}
        <div class="brand-text">${e(copy.app.brandLine)}<small>${e(copy.app.brandSub)}</small></div>
      </div>
      <div class="doc-title">
        <h1>${e(report.title)}</h1>
        <div class="taken">${e(copy.reports.generatedOn(takenAt))}</div>
      </div>
    </div>
    ${filters}
    ${
      report.rows.length === 0
        ? `<div class="empty">${e(report.emptyMessage ?? "Nothing matched these filters.")}</div>`
        : `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    }
    ${totals}
    ${report.footnote ? `<div class="footnote">${e(report.footnote)}</div>` : ""}
  </div>
</body></html>`;
};

/** Opens the report in the print window. Returns false when the popup was blocked. */
export const openReport = (report: ReportDocument): boolean =>
  openPrintDocumentAsync(loadLogoDataUrl().then((logo) => buildReportHtml(report, logo)));
