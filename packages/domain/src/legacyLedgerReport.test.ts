import test from "node:test";
import assert from "node:assert/strict";
import { readArchiveFile, type LedgerArchiveTotals } from "./ledgerArchive.js";
import { LEGACY_REPORT_BALANCE_RULE, checkLegacyPrintedTotals, legacyReportProblems, looksLikeLegacyLedgerReport, parseLegacyLedgerReport, type LegacyCell } from "./legacyLedgerReport.js";
import { archiveBalanceAtCutover } from "./partyOpeningBalance.js";

// THE PREVIOUS SOFTWARE'S LEDGER REPORT, THE RULES (docs/53). Synthetic reports laid out exactly as the real exports
// are (the six real files are read end to end in apps/desktop legacyLedgerImport.test.ts): figures read right to left
// whatever column they sit in, headers skipped on every page, and anything the reader cannot account for refused.

const HEAD: LegacyCell[][] = [
  [null, "777 EVA Shoes"],
  [null, null, null, null, null, "Supplier Ledger Report"],
  [null, null, null, "Name : 1201903 - SYNTHETIC SUPPLIER FOXTROT"],
  ["From", ":", "01/09/2026", null, null, null, null, null, null, null, null, null, null, "Page 1 of 1"],
  ["To", ":", "20/11/2026", null, null, null, null, null, null, null, null, null, "Print Date : 20/11/2026"],
  ["Date", null, "No.", "Type", "Bill.No", "Description", null, null, null, "Qty", "Debit", null, "Credit", null, "Balance"],
];
/** A data row with the figures where the real exports put them: one column further right than the headings. */
const line = (date: string, no: number, type: string, description: string, qty: number, debit: number, credit: number, balance: number): LegacyCell[] =>
  [date, null, no, type, null, description, null, null, null, qty, debit, null, credit, null, null, balance];
const OPENING: LegacyCell[] = ["2026-08-31", null, null, null, null, "Opening Balance", null, null, null, 0, null, 0, null, null, 0];
const SUPPLIER: LegacyCell[][] = [
  ...HEAD,
  OPENING,
  [],
  line("2026-10-12", 5101, "PU", "Total Qty= 140", 140, 0, 123000, -123000),
  line("2026-10-17", 5102, "PU", "Total Qty= 160", 160, 0, 150000, -273000),
  line("2026-10-20", 5103, "CV", "CLAIM 12 PAIR", 0, 40000, 0, -233000),
  line("2026-10-21", 5103, "CV", "bill no 901", 0, 0, 2000, -235000),
  [null, null, null, null, null, "Total :", null, null, 300, 40000, null, 275000, null, null, -235000],
];

const totalsOf = (grid: LegacyCell[][]): { totals: LedgerArchiveTotals; rule: string; problems: string[] } => {
  const [statement] = parseLegacyLedgerReport(grid).statements;
  const file = readArchiveFile(statement?.rows ?? [], statement?.side ?? "CUSTOMER", LEGACY_REPORT_BALANCE_RULE);
  const draft = file.statements[0];
  assert.ok(draft);
  return { totals: draft.totals, rule: draft.balanceRule, problems: [...file.rowProblems, ...draft.problems].map((p) => p.message) };
};

test("a supplier report is read whole: party, period, every line, and its Total line", () => {
  assert.equal(looksLikeLegacyLedgerReport(SUPPLIER), true);
  const report = parseLegacyLedgerReport(SUPPLIER);
  assert.deepEqual(report.problems, []);
  const [s] = report.statements;
  assert.ok(s);
  assert.deepEqual([s.side, s.partyCode, s.partyName, s.periodFrom, s.periodTo, s.problems, s.warnings], ["SUPPLIER", "1201903", "SYNTHETIC SUPPLIER FOXTROT", "2026-09-01", "2026-11-20", [], []]);
  assert.deepEqual(s.rows.map((r) => [r.transactionDate, r.voucherNumber, r.transactionType, r.debit, r.credit, r.runningBalance]), [
    ["2026-08-31", "", "", "-", "-", "0"],
    ["2026-10-12", "5101", "PU", "0", "123000", "-123000"],
    ["2026-10-17", "5102", "PU", "0", "150000", "-273000"],
    ["2026-10-20", "5103", "CV", "40000", "0", "-233000"],
    ["2026-10-21", "5103", "CV", "0", "2000", "-235000"],
  ]);
  assert.deepEqual(s.printedTotals, { quantity: "300", debit: "40000", credit: "275000", closing: "-235000" });
});

test("its lines chain as debit less credit, add up to the Total line, and the payable is what we owe", () => {
  const { totals, rule, problems } = totalsOf(SUPPLIER);
  assert.deepEqual(problems, []);
  assert.equal(rule, "DEBIT_LESS_CREDIT");
  const [s] = parseLegacyLedgerReport(SUPPLIER).statements;
  assert.deepEqual(checkLegacyPrintedTotals(totals, s!.printedTotals!), []);
  assert.equal(totals.closingBalancePaisa, -23_500_000);
});

test("a Total line the lines do not reach is reported with both figures", () => {
  const { totals } = totalsOf(SUPPLIER);
  const problems = checkLegacyPrintedTotals(totals, { quantity: "300", debit: "40000", credit: "275001", closing: "-235000" });
  assert.match(problems[0] ?? "", /add up to a credit of 275,000, but the report's Total line says 275,001/);
});

test("a figure mistyped in one line breaks the chain at that line", () => {
  const broken = SUPPLIER.map((row) => (row[2] === 5102 ? line("2026-10-17", 5102, "PU", "Total Qty= 160", 160, 0, 149000, -273000) : row));
  assert.match(totalsOf(broken).problems[0] ?? "", /does not follow from the row before/);
});

test("the same report saved as CSV text (amounts with commas, brackets and dashes) reads the same", () => {
  const text = (row: LegacyCell[]): LegacyCell[] => row.map((cell) => (typeof cell === "number" ? (cell < 0 ? `(${Math.abs(cell).toLocaleString("en-US")})` : cell.toLocaleString("en-US")) : cell));
  const csv = SUPPLIER.map((row, index) => (index === 6 ? ["31/08/2026", null, "0", null, null, "Opening Balance", null, null, null, "-", null, "-", null, null, "0"] : text(row)))
    .map((row) => (typeof row[0] === "string" && /^\d{4}-/.test(row[0]) ? [row[0].split("-").reverse().join("/"), ...row.slice(1)] : row));
  const { totals, problems } = totalsOf(csv);
  assert.deepEqual(problems, []);
  assert.equal(totals.closingBalancePaisa, -23_500_000);
});

test("headings repeated on a new page, and blank rows, are skipped; a wrapped description is joined", () => {
  const paged = [...SUPPLIER.slice(0, 9), [], ...HEAD, [null, null, null, null, null, "continued words"], ...SUPPLIER.slice(9)];
  const [s] = parseLegacyLedgerReport(paged).statements;
  assert.equal(s?.rows.length, 5);
  assert.equal(s?.rows[1]?.description, "Total Qty= 140 continued words");
  assert.match(s?.warnings.join(" ") ?? "", /continued onto a following line/);
});

test("a file naming two parties gives two statements", () => {
  const second = SUPPLIER.map((row) => (row[3] === "Name : 1201903 - SYNTHETIC SUPPLIER FOXTROT" ? [null, null, null, "Name : 1201901 - SYNTHETIC SUPPLIER DELTA"] : row));
  const report = parseLegacyLedgerReport([...SUPPLIER, [], ...second]);
  assert.deepEqual(report.statements.map((s) => [s.partyCode, s.rows.length, s.problems.length]), [["1201903", 5, 0], ["1201901", 5, 0]]);
});

test("refused, saying why: no title, a customer code on a supplier report, no Total line, an unreadable line", () => {
  assert.equal(parseLegacyLedgerReport(SUPPLIER.filter((row) => row[5] !== "Supplier Ledger Report")).recognised, false);
  const wrongCode = SUPPLIER.map((row) => (row[3] === "Name : 1201903 - SYNTHETIC SUPPLIER FOXTROT" ? [null, null, null, "Name : 1301903 - FOXTROT"] : row));
  assert.match(parseLegacyLedgerReport(wrongCode).statements[0]?.problems.join(" ") ?? "", /1301903 is a customer code, but the report is a supplier ledger/);
  const noTotal = SUPPLIER.slice(0, -1);
  assert.match(parseLegacyLedgerReport(noTotal).statements[0]?.problems.join(" ") ?? "", /no "Total :" line/);
  const short = [...SUPPLIER.slice(0, 9), ["2026-10-13", null, 1, "PU", null, "x", null, null, null, 5, null, null, null, null, null, 7], ...SUPPLIER.slice(9)];
  assert.match(parseLegacyLedgerReport(short).statements[0]?.problems.join(" ") ?? "", /expected Qty, Debit, Credit and Balance/);
  const outside = [...SUPPLIER.slice(0, 9), line("2026-12-01", 9, "PU", "late", 0, 0, 0, -123000), ...SUPPLIER.slice(9)];
  assert.match(parseLegacyLedgerReport(outside).statements[0]?.problems.join(" ") ?? "", /dated outside the report's period/);
});

test("the main process repeats the report-level checks: title, side and code", () => {
  const [s] = parseLegacyLedgerReport(SUPPLIER).statements;
  const info = { title: s!.title, side: s!.side!, partyCode: s!.partyCode, partyName: s!.partyName, periodFrom: s!.periodFrom!, periodTo: s!.periodTo!, printedTotals: s!.printedTotals! };
  assert.deepEqual(legacyReportProblems(info, "SUPPLIER"), []);
  assert.match(legacyReportProblems(info, "CUSTOMER")[0] ?? "", /supplier ledger, imported as a customer one/);
  assert.match(legacyReportProblems({ ...info, title: "Customer Ledger Report" }, "SUPPLIER")[0] ?? "", /does not say supplier ledger/);
});

test("the opening balance at a cutover is the last line before it, read the side's way", () => {
  const points = [
    { statementId: "s", entryDate: "2026-10-12", balancePaisa: -12_300_000, balanceRule: "DEBIT_LESS_CREDIT" as const },
    { statementId: "s", entryDate: "2026-10-17", balancePaisa: -27_300_000, balanceRule: "DEBIT_LESS_CREDIT" as const },
    { statementId: "s", entryDate: "2026-10-20", balancePaisa: -23_300_000, balanceRule: "DEBIT_LESS_CREDIT" as const },
  ];
  assert.deepEqual(archiveBalanceAtCutover("SUPPLIER", points, "2026-10-18"), { sidePaisa: 27_300_000, statementId: "s", asOf: "2026-10-17", linesOnOrAfterCutover: 1 });
  assert.equal(archiveBalanceAtCutover("SUPPLIER", points, "2026-10-01"), null);
  assert.equal(archiveBalanceAtCutover("CUSTOMER", [{ ...points[0]!, balancePaisa: 500 }], "2026-12-01")?.sidePaisa, 500);
});

// The owner's real ledgers (28 Nov 2026): a voucher saved with no narration, and a narration typed as a number. Both
// are real rows whose figures chain; they are read and kept as printed, never refused.
test("a row with no narration is kept blank and pointed out, and a narration that is a number is read as the narration", () => {
  const grid: LegacyCell[][] = [
    ...HEAD,
    OPENING,
    line("2026-10-12", 5101, "PU", "Total Qty= 140", 140, 0, 123000, -123000),
    line("2026-10-17", 5104, "CV", "", 0, 50000, 0, -73000),
    // The narration "50000" sits in the description column as text: five figures at the end of the row.
    ["2026-10-20", null, 5105, "CV", null, "50000", null, null, null, 0, 0, null, 2000, null, null, -75000],
    [null, null, null, null, null, "Total :", null, null, 140, 50000, null, 125000, null, null, -75000],
  ];
  const [statement] = parseLegacyLedgerReport(grid).statements;
  assert.ok(statement);
  assert.deepEqual(statement.problems, []);
  assert.deepEqual(statement.rows.slice(2).map((r) => [r.voucherNumber, r.description, r.quantity, r.debit, r.credit, r.runningBalance]), [
    ["5104", "", "0", "50000", "0", "-73000"],
    ["5105", "50000", "0", "0", "2000", "-75000"],
  ]);
  const file = readArchiveFile(statement.rows, "SUPPLIER", LEGACY_REPORT_BALANCE_RULE);
  const draft = file.statements[0];
  assert.ok(draft);
  assert.deepEqual([...file.rowProblems, ...draft.problems], [], "nothing refused");
  assert.ok(draft.warnings.some((w) => /has no description, as printed/.test(w.message)), "the blank narration is pointed out");
});
