import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseDelimitedText } from "./delimitedText.js";
import { archiveBalanceForSide, groupArchiveRows, ledgerArchiveRowsOf, readArchiveFile } from "./ledgerArchive.js";
import {
  naturalDirection,
  openingBalanceForSide,
  openingBalanceProblems,
  openingFromSideBalance,
  reconcilePartyLedger,
  reversalReasonProblems,
  type ReconciliationStatementInput,
} from "./partyOpeningBalance.js";

// SUPPLIER ARCHIVES AND OPENING BALANCES, THE RULES (docs/53): which way a supplier's printed balance ran, which
// direction an opening balance adds in each ledger, what a posting must say, and how a party's archive is reconciled
// with its opening balance without either being changed.

const SUPPLIERS = path.resolve(process.cwd(), "../../docs/fixtures/ledger-archive/test-suppliers.csv");
const HEADERS = "party_code,supplier_name,transaction_date,voucher_number,transaction_type,bill_number,description,quantity,debit,credit,running_balance,sequence";

const supplierFile = (lines: string[]) => {
  const sheet = parseDelimitedText([HEADERS, ...lines].join("\n"));
  return readArchiveFile(ledgerArchiveRowsOf(sheet.headers, sheet.rows), "SUPPLIER");
};

test("a supplier statement printed credit less debit is read that way, with its opening and closing as printed", () => {
  const sheet = parseDelimitedText(fs.readFileSync(SUPPLIERS, "utf8"));
  const [rubber] = groupArchiveRows(ledgerArchiveRowsOf(sheet.headers, sheet.rows));
  const draft = readArchiveFile(rubber, "SUPPLIER").statements[0];
  assert.deepEqual(draft.problems, []);
  assert.equal(draft.side, "SUPPLIER");
  assert.equal(draft.balanceRule, "CREDIT_LESS_DEBIT");
  assert.equal(draft.customerName, "Test Supplier Rubber Soles", "the supplier_name heading is the name column");
  assert.deepEqual([draft.totals.openingBalancePaisa, draft.totals.totalDebitPaisa, draft.totals.totalCreditPaisa, draft.totals.closingBalancePaisa], [15_000_000, 16_250_000, 15_000_000, 13_750_000]);
});

test("a supplier statement printed debit less credit (Cr / Dr) is read that way, and said so", () => {
  const sheet = parseDelimitedText(fs.readFileSync(SUPPLIERS, "utf8"));
  const [, cartons] = groupArchiveRows(ledgerArchiveRowsOf(sheet.headers, sheet.rows));
  const draft = readArchiveFile(cartons, "SUPPLIER").statements[0];
  assert.deepEqual(draft.problems, []);
  assert.equal(draft.balanceRule, "DEBIT_LESS_CREDIT");
  assert.ok(draft.warnings.some((warning) => warning.message.includes("debit less credit")));
  assert.equal(archiveBalanceForSide(draft.totals.closingBalancePaisa, "SUPPLIER", draft.balanceRule), -500_000, "5,000 Dr: we had paid the supplier ahead");
});

test("a supplier statement that follows neither rule is refused against the supplier rule, with the figures", () => {
  const file = supplierFile([
    "9,X,01/10/2026,1,,,Opening,,-,-,100,1",
    "9,X,02/10/2026,2,PV,,bought,,-,50,160,2",
  ]);
  assert.match(file.statements[0].problems[0].message, /100 \+ 50 − 0 = 150/);
});

test("a customer statement is always debit less credit: one that only fits credit less debit is refused", () => {
  const sheet = parseDelimitedText([HEADERS.replace("supplier_name", "customer_name"), "1,Y,01/10/2026,1,,,Opening,,-,-,100,1", "1,Y,02/10/2026,2,SL,,sold,,50,-,50,2"].join("\n"));
  const draft = readArchiveFile(ledgerArchiveRowsOf(sheet.headers, sheet.rows)).statements[0];
  assert.equal(draft.balanceRule, "DEBIT_LESS_CREDIT");
  assert.equal(draft.problems.length, 1);
});

test("an opening balance's direction reads in each ledger's own convention", () => {
  assert.equal(naturalDirection("CUSTOMER"), "DEBIT");
  assert.equal(naturalDirection("SUPPLIER"), "CREDIT");
  assert.equal(openingBalanceForSide("CUSTOMER", "DEBIT", 100), 100, "the customer owes us");
  assert.equal(openingBalanceForSide("CUSTOMER", "CREDIT", 100), -100, "an advance from the customer");
  assert.equal(openingBalanceForSide("SUPPLIER", "CREDIT", 100), 100, "we owe the supplier");
  assert.equal(openingBalanceForSide("SUPPLIER", "DEBIT", 100), -100, "we paid the supplier ahead");
  assert.deepEqual(openingFromSideBalance("SUPPLIER", -500_000), { direction: "DEBIT", amountPaisa: 500_000 });
  assert.equal(openingFromSideBalance("CUSTOMER", 0), null, "a zero balance has nothing to post");
});

test("a posting must have a direction, an amount above zero in whole paisa, a real date and a source", () => {
  const good = { direction: "DEBIT", amountPaisa: 35_388_000, effectiveDate: "2026-11-14", sourceReference: "Old ledger 1301139" };
  assert.deepEqual(openingBalanceProblems(good), []);
  assert.equal(openingBalanceProblems({ ...good, direction: "Dr" }).length, 1);
  assert.equal(openingBalanceProblems({ ...good, amountPaisa: 12.5 }).length, 1, "paisa are whole");
  assert.equal(openingBalanceProblems({ ...good, amountPaisa: -1 }).length, 1);
  assert.equal(openingBalanceProblems({ ...good, effectiveDate: "2026-13-01" }).length, 1);
  assert.equal(openingBalanceProblems({ ...good, sourceReference: "  " }).length, 1);
  assert.deepEqual(reversalReasonProblems("Posted twice"), []);
  assert.equal(reversalReasonProblems("").length, 1);
});

const statement = (fields: Partial<ReconciliationStatementInput>): ReconciliationStatementInput => ({
  periodFrom: "2026-09-30", periodTo: "2026-11-13", openingBalancePaisa: 20_220_000, closingBalancePaisa: 35_388_000,
  totalDebitPaisa: 45_216_000, totalCreditPaisa: 30_048_000, balanceRule: "DEBIT_LESS_CREDIT", brokenRows: 0, ...fields,
});

test("reconciliation: matched, different, missing either side, or an archive that does not add up", () => {
  const opening = { direction: "DEBIT" as const, amountPaisa: 35_388_000, effectiveDate: "2026-11-14" };
  assert.equal(reconcilePartyLedger({ side: "CUSTOMER", statements: [statement({})], opening }).status, "MATCHED");
  const different = reconcilePartyLedger({ side: "CUSTOMER", statements: [statement({})], opening: { ...opening, amountPaisa: 35_000_000 } });
  assert.deepEqual([different.status, different.differencePaisa], ["DIFFERENT", -388_000]);
  assert.equal(reconcilePartyLedger({ side: "CUSTOMER", statements: [statement({})], opening: null }).status, "NO_OPENING_BALANCE");
  assert.equal(reconcilePartyLedger({ side: "CUSTOMER", statements: [], opening }).status, "NO_ARCHIVE");
  assert.equal(reconcilePartyLedger({ side: "CUSTOMER", statements: [statement({ brokenRows: 2 })], opening }).status, "ARCHIVE_BROKEN");
  assert.equal(reconcilePartyLedger({ side: "CUSTOMER", statements: [statement({ totalDebitPaisa: 1 })], opening }).status, "ARCHIVE_BROKEN", "opening + debits − credits must be the closing");
});

test("reconciliation: statements must join up, and an archive running past the opening date is noted", () => {
  const first = statement({ periodFrom: "2026-07-01", periodTo: "2026-09-29", openingBalancePaisa: 0, closingBalancePaisa: 20_220_000, totalDebitPaisa: 20_220_000, totalCreditPaisa: 0 });
  const opening = { direction: "DEBIT" as const, amountPaisa: 35_388_000, effectiveDate: "2026-11-01" };
  const joined = reconcilePartyLedger({ side: "CUSTOMER", statements: [statement({}), first], opening });
  assert.equal(joined.status, "MATCHED");
  assert.equal(joined.archiveOpeningPaisa, 0, "the earliest statement opens the archive");
  assert.equal(joined.statementCount, 2);
  assert.ok(joined.notes.some((note) => note.includes("on or after the opening balance's date")));
  const gap = reconcilePartyLedger({ side: "CUSTOMER", statements: [statement({}), { ...first, closingBalancePaisa: 1, totalDebitPaisa: 1 }], opening });
  assert.equal(gap.status, "ARCHIVE_BROKEN");
});
