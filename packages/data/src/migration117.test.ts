// MIGRATION 117 PUTS AN ARCHIVED STATEMENT'S ROWS IN PAGES, AND TAKES NOTHING AWAY (docs/50).
//
// A real database at 116 is upgraded exactly as a release would upgrade it. It holds what PC1 held on 22 Nov 2026: a
// long ledger imported whole, whose one revision the cloud refused RECORD_TOO_LARGE and parked as a dead letter.
// After 117 every row and every value is still there, each row is on its page (50 to a page, ids the same rule as
// @erp/domain's ledgerArchivePageId), the statement and its pages are marked to go under the ACCOUNTS lease held here,
// and the refused revision is retired with a note, never deleted. A computer that does not hold ACCOUNTS marks
// nothing. The down script refuses once a page has been queued.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_ARCHIVE_PAGE_ROWS, ledgerArchivePageId } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { dropCaptureTriggers } from "./database/masterCapture.js";

const SCHEMA = path.resolve(import.meta.dirname, "../src/local-schema.sql");
const MIGRATIONS = path.resolve(import.meta.dirname, "../../../migrations/sqlite");
const NOW = "2026-11-23T00:00:00.000Z";
const HEX = (char: string) => char.repeat(64);
const ROWS = 1_234;

function migrationsUpTo(dir: string, last: number): string {
  const folder = path.join(dir, `migrations-${last}`);
  if (fs.existsSync(folder)) return folder;
  fs.mkdirSync(folder);
  for (const file of fs.readdirSync(MIGRATIONS)) {
    if (file.endsWith(".up.sql") && Number(file.slice(0, 3)) <= last) fs.copyFileSync(path.join(MIGRATIONS, file), path.join(folder, file));
  }
  return folder;
}

const count = (db: SqliteDatabase, sql: string, ...params: string[]): number => Number((db.db.prepare(sql).get(...params) as { n: number }).n);

/** Every archived row, every column it had at 116, as text: what the upgrade must not change. */
const rowsAsStored = (db: SqliteDatabase): string =>
  JSON.stringify(
    db.db
      .prepare(
        `SELECT id, statement_id, sequence, entry_date, original_date_text, voucher_number, transaction_type, bill_number, description,
                quantity_text, quantity, debit_paisa, credit_paisa, balance_paisa, debit_text, credit_text, balance_text, row_hash
           FROM ledger_archive_entries ORDER BY id`
      )
      .all()
  );

/** A database at 116 holding one long statement, imported here, and its whole revision parked RECORD_TOO_LARGE. */
function seed116(dbPath: string, migrationsDir: string, holdsAccounts: boolean): void {
  const db = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir });
  // This build's triggers are 117's (a row names its page). A real upgrade migrates before installing them; here the
  // 116 rows are written as a 116 build wrote them, so the triggers are taken off first. Their marks are cleared below anyway.
  dropCaptureTriggers(db.db);
  const run = (sql: string, ...params: Array<string | number>) => db.db.prepare(sql).run(...params);
  run("INSERT OR REPLACE INTO app_settings (setting_key, setting_value, updated_at) VALUES ('device.id', 'dev-pc1', ?)", NOW);
  run(
    `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
     VALUES ('ACCOUNTS', ?, 'PC 1', 2, 0, ?, 'https://example.supabase.co', ?)`,
    holdsAccounts ? "dev-pc1" : "dev-other", NOW, NOW
  );
  run("INSERT INTO parties (id, party_code, party_name, party_type, status, created_at, updated_at) VALUES ('p-mama', 'PTY-000009', 'SYNTHETIC CUSTOMER KARACHI', 'CUSTOMER', 'ACTIVE', ?, ?)", NOW, NOW);
  run(
    `INSERT INTO ledger_archive_statements (id, batch_id, party_id, original_party_code, original_party_name, period_from, period_to, row_count,
       opening_balance_paisa, closing_balance_paisa, total_debit_paisa, total_credit_paisa, total_quantity, content_hash,
       source_file_name, source_file_hash, imported_by, imported_at, origin_device_id)
     VALUES ('st-1', 'batch-1', 'p-mama', '1301999', 'SYNTHETIC CUSTOMER KARACHI', '2020-01-01', '2026-11-20', ?, 0, ?, ?, 0, 0, ?, 'synthetic.xls', ?, 'accounts', ?, 'dev-pc1')`,
    ROWS, ROWS * 100, ROWS * 100, HEX("a"), HEX("b"), NOW
  );
  const insert = db.db.prepare(
    `INSERT INTO ledger_archive_entries (id, statement_id, sequence, entry_date, original_date_text, description, debit_paisa, credit_paisa, balance_paisa, row_hash)
     VALUES (?, 'st-1', ?, '2024-01-01', '01/01/2024', ?, 100, 0, ?, ?)`
  );
  // Stored out of sequence order, as nothing guarantees otherwise: pages follow the sequence, not the row order.
  for (let index = ROWS; index >= 1; index -= 1) insert.run(`e-${String(index).padStart(5, "0")}`, index, `Row ${String(index)}`, index * 100, HEX("c"));
  run(
    `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json, status, available_at, attempts, last_error, created_at, updated_at, lease_epoch)
     VALUES ('ob-1', 'LEDGER_ARCHIVE_STATEMENT', 'st-1', 'INSERT', 'LEDGER_ARCHIVE_STATEMENT:st-1:1', '{}', 'DEAD_LETTER', ?, 1, 'REFUSED: RECORD_TOO_LARGE', ?, ?, 2)`,
    NOW, NOW, NOW
  );
  run("INSERT INTO sync_record_revisions (aggregate_type, record_id, revision) VALUES ('LEDGER_ARCHIVE_STATEMENT', 'st-1', 1)");
  run("DELETE FROM sync_dirty_records");
  db.close();
}

function withUpgraded(holdsAccounts: boolean, check: (db: SqliteDatabase, before: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-117-"));
  const dbPath = path.join(dir, "erp.db");
  try {
    const old = migrationsUpTo(dir, 116);
    seed116(dbPath, old, holdsAccounts);
    const at116 = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: old });
    const before = rowsAsStored(at116);
    at116.close();
    const upgraded = new SqliteDatabase({ dbPath, schemaPath: SCHEMA, migrationsDir: migrationsUpTo(dir, 117) });
    try {
      check(upgraded, before);
    } finally {
      upgraded.close();
    }
  } finally {
    // A failure above can leave a handle open on Windows: the cleanup must not hide that failure.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left in the temp folder */ }
  }
}

const PAGES = Math.ceil(ROWS / LEDGER_ARCHIVE_PAGE_ROWS);

test("on the accounts computer: every row is kept and paged, the statement is sent again in pages, and the refusal is retired", () => {
  withUpgraded(true, (db, before) => {
    assert.equal(rowsAsStored(db), before, "every row and every value it held at 116 is still there");
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM ledger_archive_entry_pages"), PAGES, "1,234 rows are 25 pages of 50 (the last of 34)");
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM ledger_archive_entries WHERE page_id IS NULL"), 0);
    const page = (number: number) => db.db.prepare("SELECT * FROM ledger_archive_entry_pages WHERE id = ?").get(ledgerArchivePageId("st-1", number)) as Record<string, number>;
    assert.deepEqual([page(1).first_sequence, page(1).last_sequence, page(1).row_count], [1, 50, 50], "pages follow the statement's order, not the order rows were stored");
    assert.deepEqual([page(PAGES).first_sequence, page(PAGES).last_sequence, page(PAGES).row_count], [1_201, 1_234, 34]);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM ledger_archive_entries WHERE page_id = ? AND sequence BETWEEN 51 AND 100", ledgerArchivePageId("st-1", 2)), 50);

    const marks = db.db.prepare("SELECT aggregate_type, COUNT(*) AS n, MIN(lease_epoch) AS lo, MAX(lease_epoch) AS hi FROM sync_dirty_records GROUP BY aggregate_type ORDER BY aggregate_type").all();
    assert.deepEqual(JSON.parse(JSON.stringify(marks)), [
      { aggregate_type: "LEDGER_ARCHIVE_ENTRY_PAGE", n: PAGES, lo: 2, hi: 2 },
      { aggregate_type: "LEDGER_ARCHIVE_STATEMENT", n: 1, lo: 2, hi: 2 },
    ], "the header and every page, under the ACCOUNTS epoch held here, and nothing else");

    const refused = db.db.prepare("SELECT status, last_error, payload_json FROM sync_outbox WHERE id = 'ob-1'").get() as Record<string, string>;
    assert.equal(refused.status, "SYNCED", "retired, so it no longer shows as a refusal");
    assert.match(refused.last_error, /^RETIRED by local 117: .*Was: DEAD_LETTER, REFUSED: RECORD_TOO_LARGE$/, "and it says why, and what it was");
    assert.equal(refused.payload_json, "{}", "kept, not deleted or rewritten");

    db.db.prepare(
      `INSERT INTO sync_outbox (id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json, status, available_at, created_at, updated_at)
       VALUES ('ob-2', 'LEDGER_ARCHIVE_ENTRY_PAGE', 'st-1:p1', 'INSERT', 'LEDGER_ARCHIVE_ENTRY_PAGE:st-1:p1:1', '{}', 'PENDING', ?, ?, ?)`
    ).run(NOW, NOW, NOW);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sync_outbox"), 2, "the outbox takes a page");
  });
});

test("on a computer that does not hold ACCOUNTS: the rows are paged the same way, and nothing is marked to send", () => {
  withUpgraded(false, (db, before) => {
    assert.equal(rowsAsStored(db), before);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM ledger_archive_entry_pages"), PAGES, "the same pages, with the same ids, as the writer's");
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM sync_dirty_records"), 0, "a receiver sends nothing");
  });
});

test("the import writes its rows in pages, and a statement shows only once every row of it is here", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-117-shown-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  try {
    seedPagedStatement(db);
    assert.equal(db.ledgerArchiveForParty("p-mama").statements.length, 1, "whole: shown");
    db.db.prepare("DELETE FROM ledger_archive_entries WHERE page_id = ?").run(ledgerArchivePageId("st-1", 2));
    const view = db.ledgerArchiveForParty("p-mama");
    assert.deepEqual([view.statements.length, view.entries.length], [0, 0], "a page still to come: neither the statement nor any of its rows is shown");
    assert.equal(db.partyLedgerReconciliation("CUSTOMER").rows.length, 0, "nor counted in the reconciliation");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A 117 database holding a statement of 120 rows, written by the import's own paging: 3 pages. */
function seedPagedStatement(db: SqliteDatabase): void {
  const run = (sql: string, ...params: Array<string | number>) => db.db.prepare(sql).run(...params);
  run("INSERT INTO parties (id, party_code, party_name, party_type, status, created_at, updated_at) VALUES ('p-mama', 'PTY-000009', 'SYNTHETIC CUSTOMER KARACHI', 'CUSTOMER', 'ACTIVE', ?, ?)", NOW, NOW);
  run(
    `INSERT INTO ledger_archive_statements (id, batch_id, party_id, period_from, period_to, row_count, opening_balance_paisa, closing_balance_paisa,
       total_debit_paisa, total_credit_paisa, content_hash, source_file_name, source_file_hash, imported_by, imported_at)
     VALUES ('st-1', 'batch-1', 'p-mama', '2024-01-01', '2024-01-01', 120, 0, 12000, 12000, 0, ?, 'synthetic.xls', ?, 'accounts', ?)`,
    HEX("a"), HEX("b"), NOW
  );
  db.writeArchiveRowsInPages("st-1", Array.from({ length: 120 }, (_, index) => ({
    rowNumber: index + 2, sequence: index + 1, entryDate: "2024-01-01", dateText: "01/01/2024", voucherNumber: "", transactionType: "", billNumber: "",
    description: `Row ${String(index + 1)}`, quantityText: "", quantity: null, debitPaisa: 100, creditPaisa: 0, balancePaisa: (index + 1) * 100,
    debitText: "100", creditText: "", balanceText: String(index + 1), partyCode: "1301999", customerName: "SYNTHETIC CUSTOMER KARACHI",
  })));
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM ledger_archive_entry_pages"), 3);
}
