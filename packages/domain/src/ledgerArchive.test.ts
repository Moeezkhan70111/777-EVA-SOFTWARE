import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseDelimitedText } from "./delimitedText.js";
import {
  archiveRowIdentity,
  ledgerArchiveRowsOf,
  parseArchiveAmount,
  parseArchiveDate,
  parseArchiveQuantity,
  readArchiveFile,
  type LedgerArchiveRowInput,
} from "./ledgerArchive.js";

// THE HISTORICAL LEDGER ARCHIVE'S RULES (docs/50): amounts in exact paisa, days that exist, every running balance
// following from the one before, and the reference ledger (Behraam Shoes Karachi, 1301139) read row by row.

const HEADERS = "party_code,customer_name,transaction_date,voucher_number,transaction_type,bill_number,description,quantity,debit,credit,running_balance,sequence";

const fileOf = (lines: string[]) => {
  const sheet = parseDelimitedText([HEADERS, ...lines].join("\n"));
  return readArchiveFile(ledgerArchiveRowsOf(sheet.headers, sheet.rows));
};

test("amounts are read as printed, in exact paisa, never through a float", () => {
  assert.equal(parseArchiveAmount("30,240"), 3_024_000);
  assert.equal(parseArchiveAmount("300,000.5"), 30_000_050);
  assert.equal(parseArchiveAmount("0.07"), 7);
  assert.equal(parseArchiveAmount("-"), 0);
  assert.equal(parseArchiveAmount(""), 0);
  assert.equal(parseArchiveAmount("-480"), -48_000);
  assert.equal(parseArchiveAmount("(480)"), -48_000);
  assert.equal(parseArchiveAmount("480 Cr"), -48_000);
  assert.equal(parseArchiveAmount("480 Dr"), 48_000);
  for (const bad of ["30.240,00", "1,23", "abc", "12.345", "1e5", "Rs 10"]) assert.equal(parseArchiveAmount(bad), null, bad);
});

test("dates are DD/MM/YYYY or YYYY-MM-DD, and must exist", () => {
  assert.equal(parseArchiveDate("09/10/2026"), "2026-10-09");
  assert.equal(parseArchiveDate("9/10/2026"), "2026-10-09");
  assert.equal(parseArchiveDate("2026-10-09"), "2026-10-09");
  assert.equal(parseArchiveDate("31/09/2026"), null, "September has 30 days");
  assert.equal(parseArchiveDate("09/10/26"), null, "a two-digit year is not guessed");
  assert.equal(parseArchiveDate("10-Sep-2026"), null);
});

test("quantities may be blank, whole or a fraction of a dozen", () => {
  assert.equal(parseArchiveQuantity(""), null);
  assert.equal(parseArchiveQuantity("0"), 0);
  assert.equal(parseArchiveQuantity("1.5"), 1.5);
  assert.ok(Number.isNaN(parseArchiveQuantity("two") ?? 0));
});

test("a running balance that does not follow from the row before is refused, with the figures", () => {
  const file = fileOf([
    "C1,ALPHA,01/10/2026,0,,,Opening Balance,,-,-,1000,1",
    'C1,ALPHA,02/10/2026,5,SL,9,sale,1,"2,000",-,"3,000",2',
    'C1,ALPHA,03/10/2026,6,CV,,cash,0,-,500,"2,600",3',
  ]);
  const [statement] = file.statements;
  assert.equal(statement.problems.length, 1);
  assert.match(statement.problems[0].message, /Row 4: the balance 2,600 does not follow from the row before \(3,000 \+ 0 − 500 = 2,500\)/);
});

test("a row that cannot be read is listed, and holds back its whole statement; other customers are not affected", () => {
  const file = fileOf([
    "C1,ALPHA,01/10/2026,0,,,Opening Balance,,-,-,1000,1",
    "C1,ALPHA,31/10/2026,5,SL,9,sale,1,lots,-,1000,2",
    "C2,BETA,01/10/2026,0,,,Opening Balance,,-,-,500,1",
  ]);
  assert.deepEqual(file.rowProblems.map((problem) => problem.rowNumber), [3]);
  assert.match(file.rowProblems[0].message, /its debit "lots" is not an amount/);
  const alpha = file.statements.find((statement) => statement.partyCode === "C1");
  const beta = file.statements.find((statement) => statement.partyCode === "C2");
  assert.ok(alpha && alpha.problems.length > 0, "Alpha would have a gap: held back");
  assert.deepEqual(beta?.problems, []);
});

test("a debit and a credit on one row, a negative debit, and a repeated sequence are each refused", () => {
  const file = fileOf([
    "C1,ALPHA,01/10/2026,0,,,Opening Balance,,-,-,1000,1",
    "C1,ALPHA,02/10/2026,5,SL,9,both,1,10,10,1000,2",
    "C1,ALPHA,02/10/2026,5,SL,9,negative,1,-10,-,990,3",
  ]);
  assert.match(file.rowProblems.map((problem) => problem.message).join("\n"), /both a debit and a credit/);
  assert.match(file.rowProblems.map((problem) => problem.message).join("\n"), /debit is negative/);
  const twice = fileOf(["C1,ALPHA,01/10/2026,0,,,Opening Balance,,-,-,1000,1", "C1,ALPHA,02/10/2026,1,SL,1,again,1,0,0,1000,1"]);
  assert.match(twice.statements[0].problems.map((problem) => problem.message).join("\n"), /sequence 1 is used twice/);
});

test("a row repeated exactly is a warning to look at, not a refusal", () => {
  const file = fileOf([
    "C1,ALPHA,01/10/2026,0,,,Opening Balance,,-,-,0,1",
    "C1,ALPHA,02/10/2026,5,SL,9,sale,1,0,-,0,2",
    "C1,ALPHA,02/10/2026,5,SL,9,sale,1,0,-,0,3",
  ]);
  assert.deepEqual(file.statements[0].problems, []);
  assert.match(file.statements[0].warnings[0]?.message ?? "", /Row 4 repeats row 3 exactly/);
});

test("a description keeps its words and its line breaks; only the ends are trimmed", () => {
  const file = fileOf(['C1,ALPHA,01/10/2026,3181,CV,,"  received khawaja talal hassan\nmeezan ",0,-,0,0,1']);
  assert.equal(file.statements[0].rows[0].description, "received khawaja talal hassan\nmeezan");
});

test("rows with no sequence keep the order they have in the file", () => {
  const sheet = parseDelimitedText(["transaction_date,description,debit,credit,running_balance,customer_name", "01/10/2026,a,-,-,0,ALPHA", "01/10/2026,b,5,-,5,ALPHA"].join("\n"));
  const file = readArchiveFile(ledgerArchiveRowsOf(sheet.headers, sheet.rows));
  assert.deepEqual(file.statements[0].rows.map((row) => [row.sequence, row.description]), [[1, "a"], [2, "b"]]);
});

// ─── The reference ledger ───────────────────────────────────────────────────

/**
 * Behraam Shoes Karachi (1301139), 01/10/2026 to 14/11/2026, as the old software printed it on two pages:
 * [date, voucher, type, bill, quantity, debit, credit, balance, description]. Typed from the rendered pages.
 */
const BEHRAAM: ReadonlyArray<readonly [string, string, string, string, string, number, number, number, string]> = [
  ["30/09/2026", "0", "", "", "", 0, 0, 202_200, "Opening Balance"],
  ["09/10/2026", "11802", "SL", "14302", "4", 30_240, 0, 232_440, "4 Dzn HR-1 7/10 EVR Gents@7920 Discount 1440"],
  ["09/10/2026", "11802", "SL", "14302", "7", 52_920, 0, 285_360, "7 Dzn HR-2 7/10 EVR Gents@7920 Discount 2520"],
  ["09/10/2026", "11802", "SL", "14302", "2", 15_120, 0, 300_480, "2 Dzn HR-3 7/10 EVR Gents@7920 Discount 720"],
  ["17/10/2026", "3181", "CV", "", "0", 0, 300_000, 480, "received khawaja talal hassan meezan"],
  ["17/10/2026", "1307", "JV", "", "0", 0, 480, 0, "LEDGER NILL"],
  ["29/10/2026", "12046", "SL", "14509", "1", 4_320, 0, 4_320, "1 Dzn SK46 11/13 EVR Gents@4680 Discount 360"],
  ["29/10/2026", "12046", "SL", "14509", "1", 3_960, 0, 8_280, "1 Dzn SK46 8/10 EVR Gents@4320 Discount 360"],
  ["29/10/2026", "12046", "SL", "14509", "2", 12_000, 0, 20_280, "2 Dzn SK6 7/10 EVR Gents@6360 Discount 720"],
  ["29/10/2026", "12046", "SL", "14509", "2", 10_320, 0, 30_600, "2 Dzn SK6 4/6 EVR Gents@5520 Discount 720"],
  ["29/10/2026", "12046", "SL", "14509", "2", 9_360, 0, 39_960, "2 Dzn SK6 1/3 EVR Gents@5040 Discount 720"],
  ["29/10/2026", "12046", "SL", "14509", "2", 8_640, 0, 48_600, "2 Dzn SK6 11/13 EVR Gents@4680 Discount 720"],
  ["29/10/2026", "12046", "SL", "14509", "2", 7_920, 0, 56_520, "2 Dzn SK6 8/10 EVR Gents@4320 Discount 720"],
  ["29/10/2026", "12046", "SL", "14509", "2", 9_840, 0, 66_360, "2 Dzn SK38 4/6 EVR Gents@5280 Discount 720"],
  ["29/10/2026", "12046", "SL", "14509", "2", 9_120, 0, 75_480, "2 Dzn SK38 1/3 EVR Gents@4920 Discount 720"],
  ["29/10/2026", "12046", "SL", "14509", "2", 15_120, 0, 90_600, "2 Dzn HR-2 7/10 EVR Gents@7920 Discount 720"],
  ["29/10/2026", "12046", "SL", "14509", "3", 22_680, 0, 113_280, "3 Dzn HR-1 7/10 EVR Gents@7920 Discount 1080"],
  ["29/10/2026", "12046", "SL", "14509", "2", 10_560, 0, 123_840, "2 Dzn SK30 4/6 EVR Gents@5640 Discount 720"],
  ["29/10/2026", "12046", "SL", "14509", "2", 9_360, 0, 133_200, "2 Dzn SK30 1/3 EVR Gents@5040 Discount 720"],
  ["29/10/2026", "12046", "SL", "14509", "2", 8_640, 0, 141_840, "2 Dzn SK30 11/13 EVR Gents@4680 Discount 720"],
  ["29/10/2026", "12046", "SL", "14509", "2", 7_920, 0, 149_760, "2 Dzn SK30 8/10 EVR Gents@4320 Discount 720"],
  ["29/10/2026", "12046", "SL", "14509", "1", 5_280, 0, 155_040, "1 Dzn SK46 4/6 EVR Gents@5640 Discount 360"],
  ["29/10/2026", "12046", "SL", "14509", "1", 4_680, 0, 159_720, "1 Dzn SK46 1/3 EVR Gents@5040 Discount 360"],
  ["04/11/2026", "12132", "SL", "14535", "3", 17_280, 0, 177_000, "3 Dzn SK26 7/10 EVR Gents@6120 Discount 1080"],
  ["04/11/2026", "12132", "SL", "14535", "3", 17_640, 0, 194_640, "3 Dzn SK32 7/10 EVR Gents@6240 Discount 1080"],
  ["04/11/2026", "12132", "SL", "14535", "2", 8_880, 0, 203_520, "2 Dzn K1 24/29 @4800 Discount 720"],
  ["04/11/2026", "12132", "SL", "14535", "3", 18_000, 0, 221_520, "3 Dzn SK6 7/10 EVR Gents@6360 Discount 1080"],
  ["04/11/2026", "12132", "SL", "14535", "3", 17_640, 0, 239_160, "3 Dzn SK34 7/10 EVR Gents@6240 Discount 1080"],
  ["04/11/2026", "12132", "SL", "14535", "2", 17_760, 0, 256_920, "2 Dzn X2 7/10 EVR Gents@9240 Discount 720"],
  ["04/11/2026", "12132", "SL", "14535", "2", 15_120, 0, 272_040, "2 Dzn AR-4 7/10 EVR Gents@7920 Discount 720"],
  ["04/11/2026", "12132", "SL", "14535", "1", 5_160, 0, 277_200, "1 Dzn SK6 4/6 EVR Gents@5520 Discount 360"],
  ["04/11/2026", "12132", "SL", "14535", "1", 4_680, 0, 281_880, "1 Dzn SK6 1/3 EVR Gents@5040 Discount 360"],
  ["13/11/2026", "12306", "SL", "13384", "1", 4_920, 0, 286_800, "1 Dzn SK26 4/6 EVR Gents@5280 Discount 360"],
  ["13/11/2026", "12306", "SL", "13384", "1", 4_560, 0, 291_360, "1 Dzn SK26 1/3 EVR Gents@4920 Discount 360"],
  ["13/11/2026", "12306", "SL", "13384", "3", 17_640, 0, 309_000, "3 Dzn SK38 7/10 EVR Gents@6240 Discount 1080"],
  ["13/11/2026", "12306", "SL", "13384", "1", 5_160, 0, 314_160, "1 Dzn SK10 4/6 EVR Gents@5520 Discount 360"],
  ["13/11/2026", "12306", "SL", "13384", "1", 4_680, 0, 318_840, "1 Dzn SK10 1/3 EVR Gents@5040 Discount 360"],
  ["13/11/2026", "12306", "SL", "13384", "1", 4_920, 0, 323_760, "1 Dzn SK34 4/6 EVR Gents@5280 Discount 360"],
  ["13/11/2026", "12306", "SL", "13384", "1", 4_560, 0, 328_320, "1 Dzn SK34 1/3 EVR Gents@4920 Discount 360"],
  ["13/11/2026", "12306", "SL", "13384", "1", 4_200, 0, 332_520, "1 Dzn SK34 11/13 EVR Gents@4560 Discount 360"],
  ["13/11/2026", "12306", "SL", "13384", "1", 3_840, 0, 336_360, "1 Dzn SK34 8/10 EVR Gents@4200 Discount 360"],
  ["13/11/2026", "12306", "SL", "13384", "1", 4_920, 0, 341_280, "1 Dzn SK32 4/6 EVR Gents@5280 Discount 360"],
  ["13/11/2026", "12306", "SL", "13384", "1", 4_560, 0, 345_840, "1 Dzn SK32 1/3 EVR Gents@4920 Discount 360"],
  ["13/11/2026", "12306", "SL", "13384", "1", 4_200, 0, 350_040, "1 Dzn SK32 11/13 EVR Gents@4560 Discount 360"],
  ["13/11/2026", "12306", "SL", "13384", "1", 3_840, 0, 353_880, "1 Dzn SK32 8/10 EVR Gents@4200 Discount 360"],
];

const REFERENCE_CSV = path.resolve(process.cwd(), "../../docs/fixtures/ledger-archive/behraam-shoes-1301139.csv");

const readReference = () => {
  const sheet = parseDelimitedText(fs.readFileSync(REFERENCE_CSV, "utf8"));
  return readArchiveFile(ledgerArchiveRowsOf(sheet.headers, sheet.rows));
};

test("Behraam Shoes Karachi: every row of the reference file is the row the old software printed", () => {
  const file = readReference();
  assert.deepEqual(file.rowProblems, []);
  assert.equal(file.statements.length, 1);
  const [statement] = file.statements;
  assert.deepEqual(statement.problems, [], "every running balance follows from the one before");
  assert.equal(statement.partyCode, "1301139");
  assert.equal(statement.customerName, "Behraam Shoes Karachi");
  assert.equal(statement.rows.length, BEHRAAM.length, "45 rows: the opening balance and 44 entries, none dropped or added");
  statement.rows.forEach((row, index) => {
    const [date, voucher, type, bill, quantity, debit, credit, balance, description] = BEHRAAM[index];
    const where = `row ${String(index + 1)}`;
    assert.equal(row.sequence, index + 1, where);
    assert.equal(row.dateText, date, where);
    assert.equal(row.voucherNumber, voucher, where);
    assert.equal(row.transactionType, type, where);
    assert.equal(row.billNumber, bill, where);
    assert.equal(row.quantityText, quantity, where);
    assert.equal(row.debitPaisa, debit * 100, where);
    assert.equal(row.creditPaisa, credit * 100, where);
    assert.equal(row.balancePaisa, balance * 100, where);
    assert.equal(row.description, description, where);
  });
});

test("Behraam Shoes Karachi: each sale row's own words agree with its figures (dozens × rate − discount = debit)", () => {
  const [statement] = readReference().statements;
  const sales = statement.rows.filter((row) => row.transactionType === "SL");
  assert.equal(sales.length, 42);
  for (const row of sales) {
    const words = /^(\d+) Dzn .*@(\d+) Discount\s+(\d+)$/.exec(row.description);
    assert.ok(words, `row ${String(row.sequence)} reads "N Dzn … @RATE Discount D"`);
    const [, dozens, rate, discount] = words.map(Number);
    assert.equal(row.quantity, dozens, `row ${String(row.sequence)}: the quantity is the dozens in its words`);
    assert.equal(row.debitPaisa, (dozens * rate - discount) * 100, `row ${String(row.sequence)}: ${String(dozens)} × ${String(rate)} − ${String(discount)}`);
  }
});

test("Behraam Shoes Karachi: the totals are the ones printed at the foot of page 2", () => {
  const [statement] = readReference().statements;
  assert.deepEqual(statement.totals, {
    rowCount: 45,
    periodFrom: "2026-09-30",
    periodTo: "2026-11-13",
    openingBalancePaisa: 20_220_000,
    closingBalancePaisa: 35_388_000,
    totalDebitPaisa: 45_216_000,
    totalCreditPaisa: 30_048_000,
    totalQuantity: 79,
  });
  assert.deepEqual(statement.warnings, [], "no row repeats another, and the dates never go backwards");
  assert.equal(new Set(statement.rows.map(archiveRowIdentity)).size, 45);
});

test("a file's headings are found whatever their case, spacing or common name", () => {
  const rows: LedgerArchiveRowInput[] = ledgerArchiveRowsOf(["Date", "No.", "Type", "Bill.No", "Description", "Qty", "Debit", "Credit", "Balance", "Name"], [
    { Date: "01/10/2026", "No.": "7", Type: "sl", "Bill.No": "9", Description: "x", Qty: "1", Debit: "5", Credit: "-", Balance: "5", Name: "ALPHA" },
  ]);
  assert.deepEqual(
    { ...rows[0] },
    { rowNumber: 2, partyCode: "", customerName: "ALPHA", transactionDate: "01/10/2026", voucherNumber: "7", transactionType: "sl", billNumber: "9", description: "x", quantity: "1", debit: "5", credit: "-", runningBalance: "5", sequence: "" }
  );
});
