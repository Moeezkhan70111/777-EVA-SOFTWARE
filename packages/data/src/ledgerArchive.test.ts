import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ledgerArchiveRowsOf, parseDelimitedText, type LedgerArchiveRowInput } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { readLeasedRecordPayload, snapshotRecord } from "./database/masterRecords.js";

// THE HISTORICAL LEDGER ARCHIVE (docs/50), in a real database.
//
// What these tests hold in place: a customer's old ledger is stored row for row as the old software printed it; it
// is never stored twice; an import is all or nothing; and NOTHING the live accounting reads changes because of it --
// the customer's live ledger and balance, the cash book, stock, vouchers and every other table stay exactly as they
// were.

const REFERENCE_CSV = path.resolve(process.cwd(), "../../docs/fixtures/ledger-archive/behraam-shoes-1301139.csv");
const referenceText = () => fs.readFileSync(REFERENCE_CSV, "utf8");
const fileHash = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

const rowsOf = (csv: string): LedgerArchiveRowInput[] => {
  const sheet = parseDelimitedText(csv);
  return ledgerArchiveRowsOf(sheet.headers, sheet.rows);
};

function createFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-ledger-archive-"));
  const db = new SqliteDatabase({ dbPath: path.join(tempDir, "a.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  const behraam = db.createParty({ partyName: "Behraam Shoes Karachi", partyType: "CUSTOMER", city: "Karachi", status: "ACTIVE" });
  const other = db.createParty({ partyName: "AL MADINA TRADERS", partyType: "CUSTOMER", status: "ACTIVE" });
  const supplier = db.createParty({ partyName: "SHEHZAD RUBBER", partyType: "SUPPLIER" });
  const count = (sql: string, ...args: string[]) => Number((db.db.prepare(sql).get(...args) as { n: number }).n);
  return { db, behraam, other, supplier, count, cleanup: () => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); } };
}

type Fixture = ReturnType<typeof createFixture>;

const importReference = (f: Fixture, batchId: string = crypto.randomUUID()) => {
  const text = referenceText();
  return f.db.importLedgerArchive({ batchId, fileName: "behraam-shoes-1301139.csv", fileHash: fileHash(text), statements: [{ partyId: f.behraam, rows: rowsOf(text) }], actor: "accounts" });
};

/** Every table's row count, but the archive's own and the sync marks. */
function everyOtherTable(f: Fixture): Record<string, number> {
  const tables = (f.db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
  // audit_log: the import's own audit row (docs/53), which is not accounting. Checked on its own below.
  const skip = new Set(["ledger_archive_statements", "ledger_archive_entry_pages", "ledger_archive_entries", "sync_dirty_records", "audit_log"]);
  return Object.fromEntries(tables.filter((table) => !skip.has(table)).map((table) => [table, f.count(`SELECT COUNT(*) AS n FROM "${table}"`)]));
}

test("Behraam Shoes Karachi: the reference ledger is stored row for row, with its totals, under one batch", () => {
  const f = createFixture();
  try {
    const preview = f.db.previewLedgerArchiveImport({ fileHash: fileHash(referenceText()), statements: [{ rows: rowsOf(referenceText()) }] });
    assert.equal(preview.alreadyImported, null);
    assert.equal(preview.statements[0].match?.partyId, f.behraam, "matched by its exact name: the ERP has its own party codes");
    assert.equal(preview.statements[0].match?.how, "NAME");
    assert.deepEqual(preview.statements[0].problems, []);

    const result = importReference(f);
    assert.equal(result.duplicate, false);
    const [statement] = result.statements;
    assert.equal(statement.originalPartyCode, "1301139");
    assert.equal(statement.originalPartyName, "Behraam Shoes Karachi");
    assert.equal(statement.periodFrom, "2026-09-30");
    assert.equal(statement.periodTo, "2026-11-13");
    assert.equal(statement.rowCount, 45);
    assert.equal(statement.openingBalancePaisa, 20_220_000);
    assert.equal(statement.totalDebitPaisa, 45_216_000);
    assert.equal(statement.totalCreditPaisa, 30_048_000);
    assert.equal(statement.closingBalancePaisa, 35_388_000);
    assert.equal(statement.totalQuantity, 79);
    assert.equal(statement.importedBy, "accounts");
    assert.equal(statement.sourceFileName, "behraam-shoes-1301139.csv");

    const view = f.db.ledgerArchiveForParty(f.behraam);
    assert.equal(view.entries.length, 45);
    assert.deepEqual(view.entries.map((entry) => entry.sequence), Array.from({ length: 45 }, (_, index) => index + 1), "the original order, kept");
    const jv = view.entries[5];
    assert.deepEqual(
      [jv.entryDate, jv.originalDateText, jv.voucherNumber, jv.transactionType, jv.billNumber, jv.description, jv.quantityText, jv.debitPaisa, jv.creditPaisa, jv.balancePaisa],
      ["2026-10-17", "17/10/2026", "1307", "JV", "", "LEDGER NILL", "0", 0, 48_000, 0]
    );
    const stored = f.db.db.prepare("SELECT debit_text, balance_text FROM ledger_archive_entries WHERE sequence = 2").get() as { debit_text: string; balance_text: string };
    assert.deepEqual({ ...stored }, { debit_text: "30,240", balance_text: "232,440" }, "the printed text is kept beside the paisa");
    assert.equal(view.entries.at(-1)?.balancePaisa, 35_388_000, "the last printed balance, never recalculated");

    const again = f.db.previewLedgerArchiveImport({ fileHash: "0".repeat(64), statements: [{ rows: rowsOf(referenceText()) }] });
    assert.equal(again.statements[0].match?.how, "EARLIER_IMPORT", "the old code is remembered from the first import");
    assert.equal(again.statements[0].alreadyStored?.batchId, result.batchId);
    assert.equal(again.statements[0].repeatedRows, 45);
  } finally {
    f.cleanup();
  }
});

test("a date range returns only the archived rows inside it", () => {
  const f = createFixture();
  try {
    importReference(f);
    const october = f.db.ledgerArchiveForParty(f.behraam, { fromDate: "2026-10-01", toDate: "2026-10-31" });
    assert.equal(october.entries.length, 22, "09/10 ×3, 17/10 ×2, 29/10 ×17");
    assert.ok(october.entries.every((entry) => entry.entryDate >= "2026-10-01" && entry.entryDate <= "2026-10-31"));
    assert.equal(f.db.ledgerArchiveForParty(f.other).entries.length, 0, "another customer sees none of it");
  } finally {
    f.cleanup();
  }
});

test("ACCOUNTING ISOLATION: importing changes no live ledger, balance, cash book, voucher, stock or any other table", () => {
  const f = createFixture();
  try {
    f.db.createCashVoucher({
      requestId: crypto.randomUUID(),
      partyId: f.behraam,
      voucherDate: "2026-11-15",
      description: "Received on account",
      receiptAmount: 50_000,
      lines: [{ partyId: f.behraam, description: "cash", modeOfTransfer: "Cash", receiptAmount: 50_000, paymentAmount: 0 }],
    });
    const ledgerBefore = f.db.getCustomerLedgerWithCash(f.behraam, { fromDate: "2026-01-01", toDate: "2026-12-31" });
    const allTimeBefore = f.db.getCustomerLedgerWithCash(f.behraam);
    const tablesBefore = everyOtherTable(f);

    importReference(f);

    assert.deepEqual(f.db.getCustomerLedgerWithCash(f.behraam, { fromDate: "2026-01-01", toDate: "2026-12-31" }), ledgerBefore, "the live ledger is exactly as it was");
    const allTime = f.db.getCustomerLedgerWithCash(f.behraam);
    assert.deepEqual(allTime, allTimeBefore);
    assert.equal(allTime.closingBalance, -50_000, "the live balance is the ERP's own receipt only: the archived 353,880 is not in it");
    assert.equal(allTime.entries.length, 1, "no archived row became a live entry");
    assert.deepEqual(everyOtherTable(f), tablesBefore, "no voucher, stock movement, party, balance or outbox row was written");
    assert.equal(f.count("SELECT COUNT(*) AS n FROM ledger_archive_entries"), 45);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'LEDGER_ARCHIVE_IMPORTED'"), 1, "the import is audited, once");
  } finally {
    f.cleanup();
  }
});

test("NEVER TWICE: a retried batch finds itself; the same file, the same statement or the same rows again are refused", () => {
  const f = createFixture();
  try {
    const batchId = crypto.randomUUID();
    importReference(f, batchId);
    const retry = importReference(f, batchId);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.statements.length, 1);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM ledger_archive_entries"), 45, "the retry wrote nothing");

    assert.throws(() => importReference(f), /Behraam Shoes Karachi in this file was already imported \(behraam-shoes-1301139\.csv, by accounts\)/);

    // The same rows, re-saved as a different file (another name, another hash).
    const resaved = `${referenceText()}\n`;
    assert.throws(
      () => f.db.importLedgerArchive({ batchId: crypto.randomUUID(), fileName: "copy.csv", fileHash: fileHash(resaved), statements: [{ partyId: f.behraam, rows: rowsOf(resaved) }], actor: "accounts" }),
      /statement is already archived/
    );

    // A later statement that repeats the last rows of the first.
    const lines = referenceText().trim().split("\n");
    const overlap = [lines[0], ...lines.slice(-3).map((line, index) => line.replace(/,\d+$/, `,${String(index + 1)}`))].join("\n");
    assert.throws(
      () => f.db.importLedgerArchive({ batchId: crypto.randomUUID(), fileName: "dec.csv", fileHash: fileHash(overlap), statements: [{ partyId: f.behraam, rows: rowsOf(overlap) }], actor: "accounts" }),
      /3 of Behraam Shoes Karachi's rows are already archived/
    );
    assert.equal(f.count("SELECT COUNT(*) AS n FROM ledger_archive_statements"), 1);
  } finally {
    f.cleanup();
  }
});

const TWO_CUSTOMERS = [
  "party_code,customer_name,transaction_date,voucher_number,transaction_type,bill_number,description,quantity,debit,credit,running_balance,sequence",
  "A1,AL MADINA TRADERS,01/10/2026,0,,,Opening Balance,,-,-,\"1,000\",1",
  "A1,AL MADINA TRADERS,05/10/2026,77,SL,9,\"2 Dzn X2 7/10\nEVR Gents\",2,500,-,\"1,500\",2",
  "B1,Behraam Shoes Karachi,01/10/2026,0,,,Opening Balance,,-,-,0,1",
].join("\n");

test("one file, several customers: every statement is stored, each against its own customer", () => {
  const f = createFixture();
  try {
    const rows = rowsOf(TWO_CUSTOMERS);
    const result = f.db.importLedgerArchive({
      batchId: crypto.randomUUID(),
      fileName: "two.csv",
      fileHash: fileHash(TWO_CUSTOMERS),
      statements: [
        { partyId: f.other, rows: rows.filter((row) => row.partyCode === "A1") },
        { partyId: f.behraam, rows: rows.filter((row) => row.partyCode === "B1") },
      ],
      actor: "accounts",
    });
    assert.equal(result.statements.length, 2);
    assert.equal(new Set(result.statements.map((statement) => statement.batchId)).size, 1, "one batch");
    const madina = f.db.ledgerArchiveForParty(f.other).entries;
    assert.equal(madina.length, 2);
    assert.equal(madina[1].description, "2 Dzn X2 7/10\nEVR Gents", "a description over two lines keeps both");
    assert.equal(f.db.ledgerArchiveForParty(f.behraam).entries.length, 1);
  } finally {
    f.cleanup();
  }
});

test("ALL OR NOTHING: one statement that cannot be stored leaves nothing stored", () => {
  const f = createFixture();
  try {
    const rows = rowsOf(TWO_CUSTOMERS);
    const attempt = (secondPartyId: string) =>
      f.db.importLedgerArchive({
        batchId: crypto.randomUUID(),
        fileName: "two.csv",
        fileHash: fileHash(TWO_CUSTOMERS),
        statements: [
          { partyId: f.other, rows: rows.filter((row) => row.partyCode === "A1") },
          { partyId: secondPartyId, rows: rows.filter((row) => row.partyCode === "B1") },
        ],
        actor: "accounts",
      });
    assert.throws(() => attempt(f.supplier), /SHEHZAD RUBBER is not a customer/);
    assert.throws(() => attempt("no-such-party"), /not matched to an ERP customer/);
    assert.throws(() => attempt(f.other), /matched to the same ERP customer/);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM ledger_archive_statements"), 0);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM ledger_archive_entries"), 0);
  } finally {
    f.cleanup();
  }
});

test("INVALID DATA: a broken running balance, a bad date or a bad amount is refused before anything is written", () => {
  const f = createFixture();
  try {
    const header = TWO_CUSTOMERS.split("\n")[0];
    const refused = (lines: string[], message: RegExp) => {
      const csv = [header, ...lines].join("\n");
      assert.throws(
        () => f.db.importLedgerArchive({ batchId: crypto.randomUUID(), fileName: "bad.csv", fileHash: fileHash(csv), statements: [{ partyId: f.behraam, rows: rowsOf(csv) }], actor: "accounts" }),
        message
      );
    };
    refused(["B1,B,01/10/2026,0,,,Opening,,-,-,100,1", "B1,B,02/10/2026,5,SL,1,sale,1,50,-,160,2"], /does not follow from the row before/);
    refused(["B1,B,31/02/2026,0,,,Opening,,-,-,100,1"], /is not a day/);
    refused(["B1,B,01/10/2026,0,,,Opening,,abc,-,100,1"], /is not an amount/);
    assert.throws(() => f.db.importLedgerArchive({ batchId: "not-a-uuid", fileName: "x.csv", fileHash: "0".repeat(64), statements: [], actor: "accounts" }), /could not be identified/);
    assert.equal(f.count("SELECT COUNT(*) AS n FROM ledger_archive_statements"), 0);
  } finally {
    f.cleanup();
  }
});

test("SYNC: a statement is marked to travel as its header and its rows in pages of 50, and each reads back off the wire", () => {
  const f = createFixture();
  try {
    const [statement] = importReference(f).statements;
    const marks = f.db.db.prepare("SELECT record_id FROM sync_dirty_records WHERE aggregate_type = 'LEDGER_ARCHIVE_STATEMENT'").all() as Array<{ record_id: string }>;
    assert.deepEqual(marks.map((mark) => mark.record_id), [statement.id], "one mark for the statement's header");
    const pages = f.db.db.prepare("SELECT record_id FROM sync_dirty_records WHERE aggregate_type = 'LEDGER_ARCHIVE_ENTRY_PAGE' ORDER BY record_id").all() as Array<{ record_id: string }>;
    assert.deepEqual(pages.map((mark) => mark.record_id), [`${statement.id}:p1`], "45 rows are one page, named by the statement and its number");
    const otherMarks = f.count("SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type NOT IN ('LEDGER_ARCHIVE_STATEMENT', 'LEDGER_ARCHIVE_ENTRY_PAGE', 'PARTY')");
    assert.equal(otherMarks, 0, "nothing else is marked to travel");

    const header = snapshotRecord(f.db.db, "LEDGER_ARCHIVE_STATEMENT", statement.id);
    assert.deepEqual(header?.children, {}, "the header carries no rows");
    assert.ok(readLeasedRecordPayload("LEDGER_ARCHIVE_STATEMENT", { recordId: statement.id, revision: 1, deleted: false, body: header }));
    const page = snapshotRecord(f.db.db, "LEDGER_ARCHIVE_ENTRY_PAGE", `${statement.id}:p1`);
    assert.equal(page?.children.ledger_archive_entries?.length, 45);
    assert.deepEqual([page?.row.first_sequence, page?.row.last_sequence, page?.row.row_count], [1, 45, 45]);
    const read = readLeasedRecordPayload("LEDGER_ARCHIVE_ENTRY_PAGE", { recordId: `${statement.id}:p1`, revision: 1, deleted: false, body: page });
    assert.ok(read, "the page a receiver gets is valid against its spec");
    const whole = { row: header?.row ?? {}, children: { ledger_archive_entries: page?.children.ledger_archive_entries ?? [] } };
    assert.equal(readLeasedRecordPayload("LEDGER_ARCHIVE_STATEMENT", { recordId: statement.id, revision: 1, deleted: false, body: whole }), null, "a statement sent whole, the old way, is refused");
  } finally {
    f.cleanup();
  }
});
