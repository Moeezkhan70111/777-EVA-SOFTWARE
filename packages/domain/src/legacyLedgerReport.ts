// THE PREVIOUS SOFTWARE'S LEDGER REPORT (docs/53): "Customer Ledger Report" and "Supplier Ledger Report" from 777 EVA
// Shoes' old accounting software, as exported to Excel (.xls) or saved from it as CSV.
//
//   777 EVA Shoes                                   (company line)
//   Customer Ledger Report                          (title: which ledger)
//   Name : 1301901 - SYNTHETIC CUSTOMER ALPHA     (the party, with the old software's code)
//   From : 01/06/2026                Page 1 of 42   (period, page)
//   To   : 20/11/2026            Print Date : …
//   Date | No. | Type | Bill.No | Description | Qty | Debit | Credit | Balance      (repeated on every page)
//   31/05/2026  0              Opening Balance        -       -      7,422,230
//   03/06/2026  8858  SL  7743   10 Dzn K1 … Discount 3600   10  44,400  -  7,466,630
//   …
//   Total :                                       4432  24,003,000  22,438,190  8,987,040
//
// IT IS A PRINTED REPORT LAID INTO CELLS, NOT A TABLE. Headings repeat on every page, blank rows separate entries, and
// the figures sit one or two columns further right on some row types. So the figures are read RIGHT TO LEFT from the
// end of each row (Balance, Credit, Debit, Qty) and never by column position. Voucher number, type and bill number are
// read at the positions the report's own heading row gives them.
//
// ONE RULE FOR BOTH LEDGERS. The software prints every balance as the one before plus debit less credit. For a customer
// that is what they owe us. For a supplier what we owe is printed NEGATIVE (purchases are credits). The statements are
// kept exactly as printed, marked DEBIT_LESS_CREDIT, and the ERP reads a supplier's closing the right way round.
//
// NOTHING IS GUESSED. A report this reader cannot account for in full (no title, no party, an unreadable row, no totals
// line, totals that do not add up) is refused with the sheet row named. Nothing here is accounting: the rows become an
// archive, never a voucher.
//
// Pure: the import screen and the data layer read reports with the same rules.

import {
  ARCHIVE_BALANCE_RULE,
  LEDGER_ARCHIVE_SIDE,
  formatArchivePaisa,
  parseArchiveAmount,
  parseArchiveDate,
  parseArchiveQuantity,
  type LedgerArchiveRowInput,
  type LedgerArchiveSide,
  type LedgerArchiveTotals,
} from "./ledgerArchive.js";

/** One cell as a reader gives it: text, a number, or nothing. Dates arrive as text (YYYY-MM-DD or DD/MM/YYYY). */
export type LegacyCell = string | number | null | undefined;

/** The old software's balance rule, for every ledger it prints. */
export const LEGACY_REPORT_BALANCE_RULE = ARCHIVE_BALANCE_RULE.DEBIT_LESS_CREDIT;

/** Which ledger each report title is. */
const TITLES: ReadonlyArray<readonly [RegExp, LedgerArchiveSide]> = [
  [/^customer ledger report$/i, LEDGER_ARCHIVE_SIDE.CUSTOMER],
  [/^supplier ledger report$/i, LEDGER_ARCHIVE_SIDE.SUPPLIER],
];

/** The old software's account codes: 1301… customers, 1201… suppliers. Another prefix is only a warning. */
export const LEGACY_CODE_PREFIX: Readonly<Record<string, LedgerArchiveSide>> = { "1301": "CUSTOMER", "1201": "SUPPLIER" };

/** The "Total :" line, as printed. Quantity may be missing. */
export interface LegacyPrintedTotals {
  readonly quantity: string | null;
  readonly debit: string;
  readonly credit: string;
  readonly closing: string;
}

/** One party's statement read from a report: everything the archive import needs, and what the report said of itself. */
export interface LegacyStatement {
  readonly title: string;
  readonly side: LedgerArchiveSide | null;
  readonly partyCode: string;
  readonly partyName: string;
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
  /** The rows in report order, as text for the archive's own rules. rowNumber is the sheet row. */
  readonly rows: readonly LedgerArchiveRowInput[];
  readonly printedTotals: LegacyPrintedTotals | null;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

export interface LegacyReport {
  /** The grid looks like this report at all (a title in its first rows). */
  readonly recognised: boolean;
  readonly statements: readonly LegacyStatement[];
  /** Problems that belong to no one statement. */
  readonly problems: readonly string[];
}

// ─── Cells ──────────────────────────────────────────────────────────────────

/** A cell as text. Whole numbers never become "1e+21"-style text: an amount that large is refused anyway. */
export const legacyCellText = (cell: LegacyCell): string => {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "number") return Number.isFinite(cell) ? String(cell) : "";
  return cell.replace(/\s+/g, " ").trim();
};

const DASH = /^[-–—]$/;
const NUMERIC = /^\(?-?\s*[\d,]+(?:\.\d+)?\)?(?:\s*(?:Cr|Dr)\.?)?$/i;
/** A figure cell: a number, an amount as printed, or the dash printed for nothing. */
const isFigure = (cell: LegacyCell): boolean => typeof cell === "number" || DASH.test(legacyCellText(cell)) || NUMERIC.test(legacyCellText(cell));

const dayBefore = (iso: string): string => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) - 1)).toISOString().slice(0, 10);
};

// ─── The heading row: where No., Type and Bill.No sit ───────────────────────

interface Columns {
  readonly voucher: number;
  readonly type: number;
  readonly bill: number;
}
const DEFAULT_COLUMNS: Columns = { voucher: 2, type: 3, bill: 4 };

function headingColumns(texts: readonly string[]): Columns | null {
  const at = (re: RegExp) => texts.findIndex((t) => re.test(t));
  const date = at(/^date$/i);
  const voucher = at(/^no\.?$/i);
  const type = at(/^type$/i);
  const bill = at(/^bill\.?\s*no\.?$/i);
  if (date < 0 || voucher < 0 || type < 0 || bill < 0 || !texts.some((t) => /^balance$/i.test(t))) return null;
  return { voucher, type, bill };
}

// ─── Reading one statement's rows ───────────────────────────────────────────

interface Draft {
  title: string;
  side: LedgerArchiveSide | null;
  partyCode: string;
  partyName: string;
  periodFrom: string | null;
  periodTo: string | null;
  rows: LedgerArchiveRowInput[];
  printedTotals: LegacyPrintedTotals | null;
  problems: string[];
  warnings: string[];
  wrapped: number;
  columns: Columns | null;
}

const newDraft = (title: string, side: LedgerArchiveSide | null, partyCode: string, partyName: string): Draft => ({
  title, side, partyCode, partyName, periodFrom: null, periodTo: null, rows: [], printedTotals: null, problems: [], warnings: [], wrapped: 0, columns: null,
});

/** The figures at the end of a row, right to left, after its last word. */
function tailFigures(cells: readonly LegacyCell[], from: number): { figures: string[]; words: string[] } {
  let start = cells.length;
  while (start > from && (isFigure(cells[start - 1]) || legacyCellText(cells[start - 1]) === "")) start -= 1;
  const figures = cells.slice(start).map(legacyCellText).filter((t) => t !== "");
  const words = cells.slice(from, start).map(legacyCellText).filter((t) => t !== "");
  return { figures, words };
}

/** A dated row of the report as an archive row, or a problem. */
function readDatedRow(draft: Draft, cells: readonly LegacyCell[], sheetRow: number): void {
  const columns = draft.columns ?? DEFAULT_COLUMNS;
  const after = Math.max(columns.voucher, columns.type, columns.bill) + 1;
  const { figures, words } = tailFigures(cells, after);
  const description = words.join(" ");
  const opening = /^opening balance$/i.test(description);
  const base = {
    rowNumber: sheetRow,
    partyCode: draft.partyCode,
    customerName: draft.partyName,
    transactionDate: legacyCellText(cells[0]),
    voucherNumber: legacyCellText(cells[columns.voucher]),
    transactionType: legacyCellText(cells[columns.type]),
    billNumber: legacyCellText(cells[columns.bill]),
    description,
    sequence: String(draft.rows.length + 1),
  };
  if (opening) {
    if (figures.length < 1) { draft.problems.push(`Row ${String(sheetRow)}: the Opening Balance row has no balance.`); return; }
    draft.rows.push({ ...base, quantity: "", debit: "-", credit: "-", runningBalance: figures[figures.length - 1] ?? "" });
    return;
  }
  if (figures.length !== 4) {
    draft.problems.push(`Row ${String(sheetRow)}: expected Qty, Debit, Credit and Balance at the end of the row, found ${String(figures.length)} figure(s).`);
    return;
  }
  const [quantity, debit, credit, balance] = figures as [string, string, string, string];
  draft.rows.push({ ...base, quantity: DASH.test(quantity) ? "" : quantity, debit, credit, runningBalance: balance });
}

function readTotals(draft: Draft, cells: readonly LegacyCell[], sheetRow: number): void {
  const figures = cells.map(legacyCellText).filter((t, i) => t !== "" && isFigure(cells[i]));
  if (figures.length === 4) {
    draft.printedTotals = { quantity: figures[0] ?? null, debit: figures[1] ?? "", credit: figures[2] ?? "", closing: figures[3] ?? "" };
  } else if (figures.length === 3) {
    draft.printedTotals = { quantity: null, debit: figures[0] ?? "", credit: figures[1] ?? "", closing: figures[2] ?? "" };
  } else {
    draft.problems.push(`Row ${String(sheetRow)}: the Total line should give Debit, Credit and the closing Balance.`);
  }
}

// ─── The whole grid ─────────────────────────────────────────────────────────

const titleOf = (joined: string): LedgerArchiveSide | null => TITLES.find(([re]) => re.test(joined))?.[1] ?? null;

/** Whether a grid looks like the old software's ledger report: a known title in its first 15 rows. */
export function looksLikeLegacyLedgerReport(grid: ReadonlyArray<ReadonlyArray<LegacyCell>>): boolean {
  return grid.slice(0, 15).some((row) => /ledger report$/i.test(row.map(legacyCellText).filter(Boolean).join(" ")));
}

interface ReadState {
  title: string;
  side: LedgerArchiveSide | null;
  current: Draft | null;
  statements: Draft[];
  stray: string[];
}

/** A header line: title, party, period, page. Returns true when the row was one. */
function readHeaderRow(state: ReadState, texts: readonly string[], cells: readonly LegacyCell[]): boolean {
  const joined = texts.filter(Boolean).join(" ");
  if (/ledger report$/i.test(joined)) {
    state.title = joined;
    state.side = titleOf(joined);
    return true;
  }
  const name = /^Name\s*:\s*(\S+)\s*-\s*(.+)$/i.exec(joined);
  if (name) {
    const code = name[1] ?? "";
    if (!state.current || state.current.partyCode !== code) {
      state.current = newDraft(state.title, state.side, code, (name[2] ?? "").trim());
      state.statements.push(state.current);
    }
    return true;
  }
  const period = /^(From|To)\b/i.exec(texts[0] ?? "");
  if (period && state.current) {
    const value = cells.slice(1).map(legacyCellText).find((t) => parseArchiveDate(t) !== null);
    if (value) state.current[period[1]?.toLowerCase() === "from" ? "periodFrom" : "periodTo"] = parseArchiveDate(value);
    return true;
  }
  if (/^777 EVA/i.test(joined) || /^Page \d+ of \d+$/i.test(joined) || /Print Date/i.test(joined)) return true;
  const columns = headingColumns(texts);
  if (columns) {
    if (state.current) state.current.columns = columns;
    return true;
  }
  return false;
}

function readRow(state: ReadState, cells: readonly LegacyCell[], sheetRow: number): void {
  const texts = cells.map(legacyCellText);
  if (texts.every((t) => t === "")) return;
  if (readHeaderRow(state, texts, cells)) return;
  const current = state.current;
  if (!current) {
    state.stray.push(`Row ${String(sheetRow)}: comes before any "Name :" line, so it belongs to no party.`);
    return;
  }
  if (/^Total\s*:?$/i.test(texts.find(Boolean) ?? "")) return readTotals(current, cells, sheetRow);
  if (parseArchiveDate(texts[0] ?? "") !== null) return readDatedRow(current, cells, sheetRow);
  // Anything else is the previous row's description carrying on (a PDF-style wrap).
  const last = current.rows[current.rows.length - 1];
  if (!last || current.printedTotals) {
    current.problems.push(`Row ${String(sheetRow)}: "${texts.filter(Boolean).join(" ").slice(0, 60)}" is not a ledger line.`);
    return;
  }
  current.rows[current.rows.length - 1] = { ...last, description: `${last.description} ${texts.filter(Boolean).join(" ")}`.trim() };
  current.wrapped += 1;
}

/** Reads a whole report: one statement per party it names. */
export function parseLegacyLedgerReport(grid: ReadonlyArray<ReadonlyArray<LegacyCell>>, firstRowNumber = 1): LegacyReport {
  const recognised = looksLikeLegacyLedgerReport(grid);
  if (!recognised) return { recognised, statements: [], problems: ["This is not a Customer or Supplier Ledger Report from the previous software."] };
  const state: ReadState = { title: "", side: null, current: null, statements: [], stray: [] };
  grid.forEach((cells, index) => readRow(state, cells, firstRowNumber + index));
  const statements = state.statements.map(finishStatement);
  const problems = [...state.stray];
  if (statements.length === 0) problems.push('The report names no party (no "Name : <code> - <name>" line).');
  return { recognised, statements, problems };
}

/** The report's own checks: title, code, opening row, period, totals line. Figures are checked by checkLegacyFigures. */
function finishStatement(draft: Draft): LegacyStatement {
  const { problems, warnings } = draft;
  if (!draft.side) problems.push(`The title "${draft.title || "(none)"}" is not a Customer or Supplier Ledger Report.`);
  const prefixSide = LEGACY_CODE_PREFIX[draft.partyCode.slice(0, 4)];
  if (!prefixSide) warnings.push(`The old code ${draft.partyCode} is neither a customer (1301…) nor a supplier (1201…) code.`);
  else if (draft.side && prefixSide !== draft.side) problems.push(`The old code ${draft.partyCode} is a ${prefixSide.toLowerCase()} code, but the report is a ${draft.side.toLowerCase()} ledger.`);
  if (!draft.columns) warnings.push("The report's heading row (Date, No., Type, Bill.No … Balance) was not found; the usual columns were used.");
  if (draft.rows.length === 0) problems.push("The report has no ledger lines.");
  else if (!/^opening balance$/i.test(draft.rows[0]?.description ?? "")) problems.push("The report does not start with its Opening Balance line.");
  if (!draft.printedTotals) problems.push('The report has no "Total :" line, so it cannot be checked as complete.');
  checkPeriod(draft);
  if (draft.wrapped > 0) warnings.push(`${String(draft.wrapped)} description(s) continued onto a following line and were joined.`);
  const { wrapped: _wrapped, columns: _columns, ...statement } = draft;
  return statement;
}

function checkPeriod(draft: Draft): void {
  const from = draft.periodFrom;
  const to = draft.periodTo;
  if (!from || !to) { draft.problems.push("The report's From and To dates were not found."); return; }
  const first = parseArchiveDate(draft.rows[0]?.transactionDate ?? "");
  if (first && first !== dayBefore(from)) draft.warnings.push(`The Opening Balance is dated ${first}, not the day before the report starts (${from}).`);
  const outside = draft.rows.filter((row, index) => {
    const day = parseArchiveDate(row.transactionDate);
    return index > 0 && day !== null && (day < from || day > to);
  });
  if (outside.length > 0) draft.problems.push(`${String(outside.length)} line(s) are dated outside the report's period ${from} – ${to} (first: row ${String(outside[0]?.rowNumber)}).`);
}

// ─── The printed totals against the rows ────────────────────────────────────

/** Whether the rows add up to the report's own Total line, exactly. Empty when they do. */
export function checkLegacyPrintedTotals(totals: LedgerArchiveTotals, printed: LegacyPrintedTotals): string[] {
  const problems: string[] = [];
  const compare = (label: string, printedText: string, computedPaisa: number) => {
    const value = parseArchiveAmount(printedText);
    if (value === null) problems.push(`The Total line's ${label} "${printedText}" is not an amount.`);
    else if (value !== computedPaisa) problems.push(`The lines add up to a ${label} of ${formatArchivePaisa(computedPaisa)}, but the report's Total line says ${formatArchivePaisa(value)}.`);
  };
  compare("debit", printed.debit, totals.totalDebitPaisa);
  compare("credit", printed.credit, totals.totalCreditPaisa);
  compare("closing balance", printed.closing, totals.closingBalancePaisa);
  if (printed.quantity !== null) {
    const quantity = parseArchiveQuantity(printed.quantity);
    if (quantity === null || Number.isNaN(quantity)) problems.push(`The Total line's quantity "${printed.quantity}" is not a number.`);
    else if (Math.round(quantity * 100) !== Math.round(totals.totalQuantity * 100)) problems.push(`The lines add up to a quantity of ${String(totals.totalQuantity)}, but the report's Total line says ${String(quantity)}.`);
  }
  return problems;
}

/** What the data layer is told about a statement that came from a report, to check again. */
export interface LegacyReportInfo {
  readonly title: string;
  readonly side: LedgerArchiveSide;
  readonly partyCode: string;
  readonly partyName: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly printedTotals: LegacyPrintedTotals;
}

/** A report-level check the data layer repeats: the title's side is the import's, and the code agrees with it. */
export function legacyReportProblems(info: LegacyReportInfo, side: LedgerArchiveSide): string[] {
  const problems: string[] = [];
  if (titleOf(info.title) !== info.side) problems.push(`The title "${info.title}" does not say ${info.side.toLowerCase()} ledger.`);
  if (info.side !== side) problems.push(`This is a ${info.side.toLowerCase()} ledger, imported as a ${side.toLowerCase()} one.`);
  const prefixSide = LEGACY_CODE_PREFIX[info.partyCode.slice(0, 4)];
  if (prefixSide && prefixSide !== info.side) problems.push(`The old code ${info.partyCode} is a ${prefixSide.toLowerCase()} code.`);
  if (!parseArchiveDate(info.periodFrom) || !parseArchiveDate(info.periodTo)) problems.push("The report's period is missing.");
  return problems;
}
