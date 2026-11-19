import type { LedgerArchiveSide } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatMoney, formatWholeMoney } from "../../app/format";
import { escapeHtml } from "../../utils/html";
import { formatDate, formatDateTime } from "../../utils/dates";
import type { CsvSheet } from "../../utils/exportFile";
import type { LedgerExportRow } from "./unifiedLedger";

// THE CUSTOMER OR SUPPLIER LEDGER AS A DOCUMENT (docs/50, 53): the one ledger the screen shows, live entries and
// archived rows together, as a PDF and as a spreadsheet.
//
//   ┌ logo ──────────────────────────────────────────────── CUSTOMER LEDGER ┐
//   │ Customer  Behraam Shoes Karachi   Code PTY-000123   Period 01 Oct – 14 Nov │
//   │ [Live opening] [Live debit] [Live credit] [Live balance]                  │
//   │ Date │ No. │ Type │ Bill │ Description │ Qty │ Debit │ Credit │ Balance │
//   │ 09 Oct 2026 │ 11802 │ ARCHIVED Sale │ 14302 │ 4 Dzn HR-1 … │ 4 │ 30,240 │ - │ 232,440 │
//   │ Live total … / Archived total …                                          │
//   └ Rows marked ARCHIVED are … · Printed 16 Nov 2026, 6:45 PM ── Page 1 of 2 ┘
//
// Every figure comes from the screen's data; this only lays it out. Every text from the data is escaped (R9). The
// live balance and the archived balances are never added together: each row keeps its own.

const text = copy.ledgerArchive;

export interface LedgerReportInput {
  /** Whose ledger: the title and the party's label follow it. A customer's when absent. */
  side?: LedgerArchiveSide;
  customerName: string;
  customerCode: string;
  fromDate: string;
  toDate: string;
  /** The live ledger's balance before the period, in rupees. */
  liveOpening: number;
  liveClosing: number;
  rows: readonly LedgerExportRow[];
  logoDataUrl: string;
  printedAt: Date;
}

/** Rupees as the ledger prints them: whole unless there are paisa. */
const rupees = (value: number): string => (Number.isInteger(value) ? formatWholeMoney(value) : formatMoney(value));
const orDash = (value: number): string => (value === 0 ? "-" : rupees(value));

const STYLES = `
  * { box-sizing: border-box; }
  @page { size: A4 landscape; margin: 12mm 10mm 16mm; }
  body { margin: 0; font-family: "Segoe UI", Helvetica, Arial, sans-serif; color: #111; font-size: 10.5px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .letterhead { display: flex; justify-content: space-between; align-items: center; padding-bottom: 8px; border-bottom: 3px solid #17365d; }
  .letterhead img { height: 44px; }
  .brand-text { font-size: 20px; font-weight: 900; color: #17365d; }
  .letterhead h1 { margin: 0; font-size: 18px; letter-spacing: .14em; text-transform: uppercase; color: #17365d; }
  .facts { display: flex; flex-wrap: wrap; gap: 4px 26px; margin: 10px 0 8px; font-size: 11.5px; }
  .facts b { font-size: 9px; text-transform: uppercase; letter-spacing: .08em; color: #555; margin-right: 6px; }
  .figures { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 10px; }
  .figure { border: 1px solid #c9d3e0; border-radius: 6px; padding: 6px 9px; }
  .figure span { display: block; font-size: 8.5px; text-transform: uppercase; letter-spacing: .08em; color: #555; }
  .figure strong { font-size: 14px; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tfoot { display: table-row-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  th, td { border: 1px solid #b8c2cf; padding: 4px 5px; vertical-align: top; text-align: left; }
  thead th { background: #eef2f7; color: #17365d; font-size: 8.5px; text-transform: uppercase; letter-spacing: .05em; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .desc { white-space: pre-line; }
  tr.archived td { background: #f7f7f4; }
  .tag { display: inline-block; margin-right: 4px; padding: 0 4px; border: 1px solid #8a8a7a; border-radius: 3px; font-size: 7.5px; font-weight: 800; letter-spacing: .06em; color: #4a4a3a; }
  tfoot td { background: #eef2f7; font-weight: 800; }
  .note { margin-top: 8px; font-size: 9px; color: #555; }
  .foot { margin-top: 4px; font-size: 9px; color: #666; }
`;

const figure = (label: string, value: string): string => `<div class="figure"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;

function rowHtml(row: LedgerExportRow): string {
  const type = row.archived ? `<span class="tag">${escapeHtml(text.archived.toUpperCase())}</span>${escapeHtml(row.type)}` : escapeHtml(row.type);
  return `<tr class="${row.archived ? "archived" : "live"}">
    <td>${escapeHtml(formatDate(row.date, row.date))}</td><td>${escapeHtml(row.voucherNumber || "-")}</td><td>${type}</td>
    <td>${escapeHtml(row.billNumber || "-")}</td><td class="desc">${escapeHtml(row.description || "-")}</td>
    <td class="num">${row.quantity === null ? "-" : escapeHtml(row.quantity.toLocaleString("en-US"))}</td>
    <td class="num">${orDash(row.debit)}</td><td class="num">${orDash(row.credit)}</td><td class="num">${rupees(row.balance)}</td>
  </tr>`;
}

/** Live rows' and archived rows' totals, each on its own line: they are never one figure. */
function totalsHtml(rows: readonly LedgerExportRow[]): string {
  const line = (label: string, picked: readonly LedgerExportRow[]) => {
    const quantity = picked.reduce((sum, row) => sum + Math.round((row.quantity ?? 0) * 100), 0) / 100;
    const debit = picked.reduce((sum, row) => sum + Math.round(row.debit * 100), 0) / 100;
    const credit = picked.reduce((sum, row) => sum + Math.round(row.credit * 100), 0) / 100;
    return `<tr><td colspan="5">${escapeHtml(label)}</td><td class="num">${escapeHtml(quantity.toLocaleString("en-US"))}</td><td class="num">${rupees(debit)}</td><td class="num">${rupees(credit)}</td><td></td></tr>`;
  };
  const live = rows.filter((row) => !row.archived);
  const archived = rows.filter((row) => row.archived);
  return [live.length > 0 ? line(text.liveTotals(live.length), live) : "", archived.length > 0 ? line(text.archivedTotals(archived.length), archived) : ""].join("");
}

export function ledgerReportHtml(input: LedgerReportInput): string {
  const words = text.side[input.side ?? "CUSTOMER"];
  const brand = input.logoDataUrl ? `<img src="${escapeHtml(input.logoDataUrl)}" alt="777" />` : `<div class="brand-text">777</div>`;
  const period = `${formatDate(input.fromDate, input.fromDate)} – ${formatDate(input.toDate, input.toDate)}`;
  const facts = `<div class="facts">
    <div><b>${escapeHtml(words.reportParty)}</b>${escapeHtml(input.customerName)}</div>
    <div><b>${escapeHtml(text.reportCode)}</b>${escapeHtml(input.customerCode || "-")}</div>
    <div><b>${escapeHtml(text.reportPeriod)}</b>${escapeHtml(period)}</div>
  </div>`;
  const live = input.rows.filter((row) => !row.archived);
  const figures = `<div class="figures">
    ${figure(text.reportOpening, `Rs. ${rupees(input.liveOpening)}`)}
    ${figure(text.debit, `Rs. ${rupees(live.reduce((sum, row) => sum + Math.round(row.debit * 100), 0) / 100)}`)}
    ${figure(text.credit, `Rs. ${rupees(live.reduce((sum, row) => sum + Math.round(row.credit * 100), 0) / 100)}`)}
    ${figure(text.reportLiveBalance, `Rs. ${rupees(input.liveClosing)}`)}
  </div>`;
  const head = ["Date", "No.", "Type", text.billNo, "Description", text.qty, "Debit", "Credit", "Balance"].map((label) => `<th>${escapeHtml(label)}</th>`).join("");
  const body = input.rows.length === 0 ? `<tr><td colspan="9">${escapeHtml(text.empty)}</td></tr>` : input.rows.map(rowHtml).join("");
  const note = input.rows.some((row) => row.archived) ? `<p class="note">${escapeHtml(text.reportArchivedNote)}</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8" /><title>${escapeHtml(words.reportTitle)}</title><style>${STYLES}</style></head><body>
    <div class="letterhead">${brand}<h1>${escapeHtml(words.reportTitle)}</h1></div>${facts}${figures}
    <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody><tfoot>${totalsHtml(input.rows)}</tfoot></table>
    ${note}<p class="foot">${escapeHtml(text.reportPrinted(formatDateTime(input.printedAt)))}</p></body></html>`;
}

/** The same ledger as a spreadsheet: amounts stay numbers, dates stay YYYY-MM-DD so Excel reads them as dates. */
export function ledgerSheet(input: Omit<LedgerReportInput, "logoDataUrl">): CsvSheet {
  return {
    preamble: [
      text.side[input.side ?? "CUSTOMER"].sheetTitle(input.customerName, input.customerCode),
      text.sheetPeriod(input.fromDate, input.toDate),
      text.sheetPrinted(formatDateTime(input.printedAt)),
      `${text.reportOpening}: ${String(input.liveOpening)} · ${text.reportLiveBalance}: ${String(input.liveClosing)}`,
    ],
    headers: ["Source", "Date", "Voucher No.", "Type", text.billNo, "Description", text.qty, "Debit (Rs.)", "Credit (Rs.)", "Balance (Rs.)"],
    rows: input.rows.map((row) => [
      row.archived ? text.sourceArchived : text.sourceLive,
      row.date,
      row.voucherNumber,
      row.type,
      row.billNumber,
      row.description,
      row.quantity,
      row.debit,
      row.credit,
      row.balance,
    ]),
  };
}

/** The name offered when saving. */
export const ledgerReportFileName = (customer: string, from: string, to: string, side: LedgerArchiveSide = "CUSTOMER"): string =>
  text.side[side].fileName(customer, from, to).replace(/[\\/:*?"<>|]/g, " ");
