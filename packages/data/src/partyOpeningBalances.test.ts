import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ledgerArchiveRowsOf, parseDelimitedText, groupArchiveRows, type LedgerArchiveRowInput } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { readLeasedRecordPayload, snapshotRecord } from "./database/masterRecords.js";

// SUPPLIER ARCHIVES AND OPENING BALANCES (docs/53), in a real database.
//
// What these tests hold in place: a supplier's old ledger is archived as printed, whichever way its balance ran; an
// opening balance moves the party's live balance in the right direction and NOTHING else (no cash, voucher, stock or
// archive row); it is posted once, never overwritten, and reversed or corrected only with a reason, at the version
// the person saw, with every step kept; and the reconciliation shows the archive beside it without changing either.

const FIXTURES = path.resolve(process.cwd(), "../../docs/fixtures/ledger-archive");
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const fileHash = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const rowsOf = (csv: string): LedgerArchiveRowInput[] => {
  const sheet = parseDelimitedText(csv);
  return ledgerArchiveRowsOf(sheet.headers, sheet.rows);
};

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-opening-balance-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "a.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  const behraam = db.createParty({ partyName: "Behraam Shoes Karachi", partyType: "CUSTOMER", city: "Karachi", status: "ACTIVE" });
  const rubber = db.createParty({ partyName: "Test Supplier Rubber Soles", partyType: "SUPPLIER", status: "ACTIVE" });
  const cartons = db.createParty({ partyName: "Test Supplier Packing Cartons", partyType: "SUPPLIER", status: "ACTIVE" });
  const count = (sql: string, ...args: string[]) => Number((db.db.prepare(sql).get(...args) as { n: number }).n);
  return { db, behraam, rubber, cartons, count, cleanup: () => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); } };
}
type Fixture = ReturnType<typeof createFixture>;

const importBehraam = (f: Fixture) => {
  const text = read("behraam-shoes-1301139.csv");
  return f.db.importLedgerArchive({ batchId: crypto.randomUUID(), fileName: "behraam-shoes-1301139.csv", fileHash: fileHash(text), statements: [{ partyId: f.behraam, rows: rowsOf(text) }], actor: "accounts" });
};

/** The supplier statements a batch wrote, by party: a batch lists them by name. */
function bySupplier<T extends { partyId: string }>(f: Fixture, statements: readonly T[]): [T, T] {
  const find = (partyId: string): T => {
    const found = statements.find((statement) => statement.partyId === partyId);
    assert.ok(found, "the supplier's statement was written");
    return found;
  };
  return [find(f.rubber), find(f.cartons)];
}

const importSuppliers = (f: Fixture) => {
  const text = read("test-suppliers.csv");
  const [rubberRows, cartonRows] = groupArchiveRows(rowsOf(text));
  return f.db.importLedgerArchive({
    batchId: crypto.randomUUID(), fileName: "test-suppliers.csv", fileHash: fileHash(text), side: "SUPPLIER", actor: "accounts",
    statements: [{ partyId: f.rubber, rows: rubberRows }, { partyId: f.cartons, rows: cartonRows }],
  });
};

const post = (f: Fixture, partyId: string, fields: { direction: string; amountPaisa: number; effectiveDate?: string; archiveStatementId?: string }, requestId: string = crypto.randomUUID()) =>
  f.db.postPartyOpeningBalance({ requestId, partyId, effectiveDate: "2026-11-14", sourceReference: "Old software ledger, closed 13/11/2026", actor: "admin", ...fields });

/** Every table's row count but the opening balances', the audit trail's and the sync marks'. */
function everyOtherTable(f: Fixture): Record<string, number> {
  const tables = (f.db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  const skip = new Set(["party_opening_balances", "party_opening_balance_entries", "audit_log", "sync_dirty_records"]);
  return Object.fromEntries(tables.filter((table) => !skip.has(table)).map((table) => [table, f.count(`SELECT COUNT(*) AS n FROM "${table}"`)]));
}

test("Behraam Shoes Karachi: the archive still imports, and its closing 353,880 posted as the opening balance reconciles", () => {
  const f = createFixture();
  try {
    const [statement] = importBehraam(f).statements;
    assert.equal(statement.ledgerSide, "CUSTOMER");
    assert.equal(statement.balanceRule, "DEBIT_LESS_CREDIT");
    assert.equal(statement.closingBalancePaisa, 35_388_000);
    const before = f.db.partyLedgerReconciliation("CUSTOMER").rows[0];
    assert.equal(before.status, "NO_OPENING_BALANCE", "an archive alone does not open the live ledger");
    assert.equal(before.liveBalancePaisa, 0);

    post(f, f.behraam, { direction: "DEBIT", amountPaisa: 35_388_000, archiveStatementId: statement.id });
    const [row] = f.db.partyLedgerReconciliation("CUSTOMER").rows;
    assert.equal(row.status, "MATCHED");
    assert.equal(row.archiveOpeningPaisa, 20_220_000);
    assert.equal(row.archiveDebitPaisa, 45_216_000);
    assert.equal(row.archiveCreditPaisa, 30_048_000);
    assert.equal(row.archiveClosingPaisa, 35_388_000);
    assert.equal(row.archiveConsistent, true, "every stored row follows from the one before");
    assert.equal(row.openingPaisa, 35_388_000);
    assert.equal(row.differencePaisa, 0);
    assert.equal(row.liveBalancePaisa, 35_388_000, "the live balance is now the old closing balance");
    assert.equal(f.db.ledgerArchiveForParty(f.behraam).entries.length, 45, "the archive is untouched");
  } finally {
    f.cleanup();
  }
});

test("a different opening balance is shown as a difference, never adjusted", () => {
  const f = createFixture();
  try {
    importBehraam(f);
    post(f, f.behraam, { direction: "DEBIT", amountPaisa: 35_000_000 });
    const [row] = f.db.partyLedgerReconciliation("CUSTOMER").rows;
    assert.equal(row.status, "DIFFERENT");
    assert.equal(row.differencePaisa, -388_000);
    assert.equal(row.archiveClosingPaisa, 35_388_000, "the archive's figure stays as printed");
  } finally {
    f.cleanup();
  }
});

test("SUPPLIERS: a supplier's old ledger is archived as printed, credit less debit or debit less credit, and matched only to suppliers", () => {
  const f = createFixture();
  try {
    const text = read("test-suppliers.csv");
    const statements = groupArchiveRows(rowsOf(text)).map((rows) => ({ rows }));
    const asCustomers = f.db.previewLedgerArchiveImport({ fileHash: fileHash(text), statements });
    assert.deepEqual(asCustomers.statements.map((s) => s.match), [null, null], "a supplier is never matched on the customer side");
    const preview = f.db.previewLedgerArchiveImport({ fileHash: fileHash(text), statements, side: "SUPPLIER" });
    assert.deepEqual(preview.statements.map((s) => s.match?.partyId), [f.rubber, f.cartons]);
    assert.deepEqual(preview.statements.map((s) => s.problems), [[], []]);
    assert.deepEqual(preview.statements.map((s) => s.balanceRule), ["CREDIT_LESS_DEBIT", "DEBIT_LESS_CREDIT"]);

    const [rubber, cartons] = bySupplier(f, importSuppliers(f).statements);
    assert.equal(rubber.ledgerSide, "SUPPLIER");
    assert.deepEqual([rubber.openingBalancePaisa, rubber.totalDebitPaisa, rubber.totalCreditPaisa, rubber.closingBalancePaisa], [15_000_000, 16_250_000, 15_000_000, 13_750_000]);
    assert.deepEqual([cartons.openingBalancePaisa, cartons.closingBalancePaisa, cartons.balanceRule], [-8_000_000, 500_000, "DEBIT_LESS_CREDIT"], "kept as printed: 80,000 Cr and 5,000 Dr");
    assert.equal(f.db.ledgerArchiveForParty(f.rubber).entries.length, 6);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'LEDGER_ARCHIVE_IMPORTED'"), 1, "the import is audited");
  } finally {
    f.cleanup();
  }
});

test("SUPPLIERS: a customer is refused on the supplier side, and a supplier on the customer side", () => {
  const f = createFixture();
  try {
    const text = read("test-suppliers.csv");
    const [rubberRows] = groupArchiveRows(rowsOf(text));
    const base = { fileName: "test-suppliers.csv", fileHash: fileHash(text), actor: "accounts" };
    assert.throws(() => f.db.importLedgerArchive({ ...base, batchId: crypto.randomUUID(), side: "SUPPLIER", statements: [{ partyId: f.behraam, rows: rubberRows }] }), /is not a supplier/);
    assert.throws(() => f.db.importLedgerArchive({ ...base, batchId: crypto.randomUUID(), statements: [{ partyId: f.rubber, rows: rubberRows }] }), /is not a customer|do not follow|does not follow/);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM ledger_archive_statements"), 0, "nothing was stored");
  } finally {
    f.cleanup();
  }
});

test("CUSTOMER: the opening balance is in the Current Balance, the balance list, the ledger and the balance-limit check", () => {
  const f = createFixture();
  try {
    f.db.createCashVoucher({ requestId: crypto.randomUUID(), partyId: f.behraam, voucherDate: "2026-11-15", description: "Received", receiptAmount: 50_000, lines: [{ partyId: f.behraam, description: "cash", modeOfTransfer: "Cash", receiptAmount: 50_000, paymentAmount: 0 }] });
    post(f, f.behraam, { direction: "DEBIT", amountPaisa: 35_388_000 });
    assert.equal(f.db.getCurrentPartyBalance(f.behraam), 303_880);
    assert.equal(f.db.listCustomerBalances({ asOfDate: "2026-11-30" }).rows.find((row) => row.partyId === f.behraam)?.balance, 303_880);
    assert.equal(f.db.listCustomerBalances({ asOfDate: "2026-11-30" }).rows.find((row) => row.partyId === f.behraam)?.openingBalance, 353_880);
    assert.equal(f.db.listCustomerBalances({ asOfDate: "2026-11-13" }).rows.find((row) => row.partyId === f.behraam)?.balance, 0, "not before the day it takes effect");

    const inRange = f.db.getCustomerLedgerWithCash(f.behraam, { fromDate: "2026-11-01", toDate: "2026-11-30" });
    assert.equal(inRange.openingBalance, 0);
    assert.deepEqual(inRange.entries.map((e) => [e.voucherType, e.voucherNumber, e.debitAmount, e.creditAmount, e.balance]), [["OPENING_BALANCE", "OB", 353_880, 0, 353_880], ["CASH_RECEIPT", inRange.entries[1].voucherNumber, 0, 50_000, 303_880]]);
    const after = f.db.getCustomerLedgerWithCash(f.behraam, { fromDate: "2026-11-15", toDate: "2026-11-30" });
    assert.equal(after.openingBalance, 353_880, "carried into the opening figure of a later range");
    assert.equal(after.closingBalance, 303_880);
  } finally {
    f.cleanup();
  }
});

test("CUSTOMER: a CREDIT opening balance is an advance, and lowers what they owe", () => {
  const f = createFixture();
  try {
    post(f, f.behraam, { direction: "CREDIT", amountPaisa: 1_000_000 });
    assert.equal(f.db.getCurrentPartyBalance(f.behraam), -10_000);
    const ledger = f.db.getCustomerLedgerWithCash(f.behraam);
    assert.deepEqual([ledger.entries[0].debitAmount, ledger.entries[0].creditAmount, ledger.closingBalance], [0, 10_000, -10_000]);
  } finally {
    f.cleanup();
  }
});

test("SUPPLIER: a CREDIT opening balance is what we owe; a DEBIT is what we paid ahead", () => {
  const f = createFixture();
  try {
    f.db.createCashVoucher({ requestId: crypto.randomUUID(), partyId: f.rubber, voucherDate: "2026-11-16", description: "Paid", paymentAmount: 37_500 });
    post(f, f.rubber, { direction: "CREDIT", amountPaisa: 13_750_000 });
    post(f, f.cartons, { direction: "DEBIT", amountPaisa: 500_000 });
    const rubber = f.db.getSupplierLedger(f.rubber, { fromDate: "2026-11-01", toDate: "2026-11-30" });
    assert.deepEqual(rubber.entries.map((e) => [e.voucherType, e.debitAmount, e.creditAmount, e.balance]), [["OPENING_BALANCE", 0, 137_500, 137_500], ["CASH_PAYMENT", 37_500, 0, 100_000]]);
    const balances = f.db.listSupplierBalances({ asOfDate: "2026-11-30" }).rows;
    assert.equal(balances.find((row) => row.partyId === f.rubber)?.balance, 100_000);
    assert.equal(balances.find((row) => row.partyId === f.cartons)?.balance, -5_000, "an advance to the supplier");
    assert.equal(balances.find((row) => row.partyId === f.cartons)?.openingBalance, -5_000);
    assert.equal(f.db.getSupplierLedger(f.cartons, { fromDate: "2026-12-01", toDate: "2026-12-31" }).openingBalance, -5_000);
  } finally {
    f.cleanup();
  }
});

test("SUPPLIER: the reconciliation reads each statement in its printed rule", () => {
  const f = createFixture();
  try {
    const [rubber, cartons] = bySupplier(f, importSuppliers(f).statements);
    post(f, f.rubber, { direction: "CREDIT", amountPaisa: 13_750_000, archiveStatementId: rubber.id });
    post(f, f.cartons, { direction: "DEBIT", amountPaisa: 500_000, archiveStatementId: cartons.id });
    const rows = f.db.partyLedgerReconciliation("SUPPLIER").rows;
    const byId = new Map(rows.map((row) => [row.partyId, row]));
    assert.deepEqual([byId.get(f.rubber)?.status, byId.get(f.rubber)?.differencePaisa], ["MATCHED", 0]);
    assert.deepEqual([byId.get(f.cartons)?.status, byId.get(f.cartons)?.archiveClosingPaisa, byId.get(f.cartons)?.openingPaisa], ["MATCHED", -500_000, -500_000], "5,000 Dr: we had paid ahead");
  } finally {
    f.cleanup();
  }
});

test("ACCOUNTING ISOLATION: posting, reversing and correcting writes no cash, voucher, stock, archive or any other row", () => {
  const f = createFixture();
  try {
    importBehraam(f);
    const tables = everyOtherTable(f);
    const archived = f.db.ledgerArchiveForParty(f.behraam);
    const posted = post(f, f.behraam, { direction: "DEBIT", amountPaisa: 35_388_000 });
    const reversed = f.db.reversePartyOpeningBalance({ requestId: crypto.randomUUID(), partyId: f.behraam, expectedVersion: posted.version, reason: "Posted to the wrong date", actor: "admin" });
    post(f, f.behraam, { direction: "DEBIT", amountPaisa: 35_388_000 });
    assert.equal(reversed.status, "NONE");
    assert.deepEqual(everyOtherTable(f), tables, "no voucher, cash, stock, archive, party or outbox row was written");
    assert.deepEqual(f.db.ledgerArchiveForParty(f.behraam), archived, "the archived rows are exactly as they were");
  } finally {
    f.cleanup();
  }
});

test("NEVER TWICE: a retried posting finds itself, and a second opening balance is refused", () => {
  const f = createFixture();
  try {
    const requestId = crypto.randomUUID();
    post(f, f.behraam, { direction: "DEBIT", amountPaisa: 35_388_000 }, requestId);
    const retried = post(f, f.behraam, { direction: "DEBIT", amountPaisa: 35_388_000 }, requestId);
    assert.equal(retried.history.length, 1, "the retry was answered, not repeated");
    assert.throws(() => post(f, f.behraam, { direction: "DEBIT", amountPaisa: 100 }), /already has an opening balance/);
    assert.throws(() => post(f, f.rubber, { direction: "CREDIT", amountPaisa: 100 }, requestId), /belongs to another party/);
    assert.equal(f.db.getCurrentPartyBalance(f.behraam), 353_880, "counted once");
    assert.equal(f.count("SELECT COUNT(*) AS n FROM party_opening_balances"), 1);
  } finally {
    f.cleanup();
  }
});

test("CORRECTION AND REVERSAL: only with a reason, only at the version seen, every step kept and audited", () => {
  const f = createFixture();
  try {
    const first = post(f, f.behraam, { direction: "DEBIT", amountPaisa: 35_000_000 });
    const correct = (fields: Record<string, unknown>) =>
      f.db.correctPartyOpeningBalance({ requestId: crypto.randomUUID(), partyId: f.behraam, expectedVersion: first.version, direction: "DEBIT", amountPaisa: 35_388_000, effectiveDate: "2026-11-14", sourceReference: "Old ledger 1301139, closed 13/11/2026", reason: "Typed 350,000; the ledger closes at 353,880", actor: "admin", ...fields });
    assert.throws(() => correct({ reason: " " }), /Say why/);
    assert.throws(() => correct({ expectedVersion: first.version + 5 }), /changed since you opened it/);
    assert.throws(() => correct({ amountPaisa: 35_000_000, sourceReference: "Old software ledger, closed 13/11/2026" }), /the same as the opening balance/);
    const corrected = correct({});
    assert.deepEqual(corrected.history.map((step) => [step.version, step.action, step.amountPaisa]), [[1, "POST", 35_000_000], [2, "REVERSE", 35_000_000], [3, "POST", 35_388_000]]);
    assert.equal(corrected.history[1].reason, "Typed 350,000; the ledger closes at 353,880");
    assert.equal(f.db.getCurrentPartyBalance(f.behraam), 353_880, "the corrected figure, once");

    assert.throws(() => f.db.reversePartyOpeningBalance({ requestId: crypto.randomUUID(), partyId: f.behraam, expectedVersion: first.version, reason: "stale", actor: "admin" }), /changed since you opened it/);
    const reversed = f.db.reversePartyOpeningBalance({ requestId: crypto.randomUUID(), partyId: f.behraam, expectedVersion: corrected.version, reason: "Party settled outside the ERP", actor: "admin" });
    assert.equal(reversed.current, null);
    assert.equal(f.db.getCurrentPartyBalance(f.behraam), 0);
    assert.equal(reversed.history.length, 4);
    const audit = (f.db.db.prepare("SELECT event_type FROM audit_log WHERE entity_id = ? ORDER BY rowid").all(f.behraam) as Array<{ event_type: string }>).map((row) => row.event_type);
    assert.deepEqual(audit, ["PARTY_OPENING_BALANCE_POSTED", "PARTY_OPENING_BALANCE_CORRECTED", "PARTY_OPENING_BALANCE_REVERSED"]);
  } finally {
    f.cleanup();
  }
});

test("INVALID INPUT: no amount, no direction, no date, no source, or another party's statement is refused", () => {
  const f = createFixture();
  try {
    const [supplierStatement] = bySupplier(f, importSuppliers(f).statements);
    assert.throws(() => post(f, f.behraam, { direction: "DEBIT", amountPaisa: 0 }), /above zero/);
    assert.throws(() => post(f, f.behraam, { direction: "UP", amountPaisa: 100 }), /debit or a credit/);
    assert.throws(() => post(f, f.behraam, { direction: "DEBIT", amountPaisa: 100, effectiveDate: "2026-02-30" }), /date the balance takes effect/);
    assert.throws(() => f.db.postPartyOpeningBalance({ requestId: crypto.randomUUID(), partyId: f.behraam, direction: "DEBIT", amountPaisa: 100, effectiveDate: "2026-11-14", sourceReference: "", actor: "admin" }), /where the figure comes from/);
    assert.throws(() => post(f, f.behraam, { direction: "DEBIT", amountPaisa: 100, archiveStatementId: supplierStatement.id }), /not this party's/);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM party_opening_balances"), 0);
  } finally {
    f.cleanup();
  }
});

test("SYNC: an opening balance travels whole as PARTY_OPENING_BALANCE, its history included, under ACCOUNTS", () => {
  const f = createFixture();
  try {
    const posted = post(f, f.behraam, { direction: "DEBIT", amountPaisa: 35_000_000 });
    f.db.correctPartyOpeningBalance({ requestId: crypto.randomUUID(), partyId: f.behraam, expectedVersion: posted.version, direction: "DEBIT", amountPaisa: 35_388_000, effectiveDate: "2026-11-14", sourceReference: "Old ledger", reason: "typo", actor: "admin" });
    const recordId = String((f.db.db.prepare("SELECT id FROM party_opening_balances").get() as { id: string }).id);
    const marks = f.db.db.prepare("SELECT record_id FROM sync_dirty_records WHERE aggregate_type = 'PARTY_OPENING_BALANCE'").all() as Array<{ record_id: string }>;
    assert.deepEqual(marks.map((mark) => mark.record_id), [recordId], "one mark: the record and its whole history");
    const body = snapshotRecord(f.db.db, "PARTY_OPENING_BALANCE", recordId);
    assert.equal(body?.children.party_opening_balance_entries?.length, 3);
    assert.ok(readLeasedRecordPayload("PARTY_OPENING_BALANCE", { recordId, revision: 1, deleted: false, body }));
  } finally {
    f.cleanup();
  }
});

test("A FIRST LIVE DATE is reported, so an opening balance dated after live entries can be questioned", () => {
  const f = createFixture();
  try {
    f.db.createCashVoucher({ requestId: crypto.randomUUID(), partyId: f.behraam, voucherDate: "2026-11-10", description: "Received", receiptAmount: 100, lines: [{ partyId: f.behraam, description: "cash", modeOfTransfer: "Cash", receiptAmount: 100, paymentAmount: 0 }] });
    assert.equal(f.db.getPartyOpeningBalance(f.behraam)?.firstLiveDate, "2026-11-10");
    assert.equal(f.db.getPartyOpeningBalance(f.rubber)?.firstLiveDate, null);
  } finally {
    f.cleanup();
  }
});
