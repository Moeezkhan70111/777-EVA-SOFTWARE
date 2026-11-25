import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEDGER_ARCHIVE_LIMITS, LEDGER_ARCHIVE_PAGE_ROWS, ledgerArchiveRowsOf } from "@erp/domain";
import { SqliteDatabase, buildLeasedRecordRevisions } from "@erp/data";
import { applyEnvelope } from "./applyEnvelope.js";
import type { SyncEnvelope } from "./contract.js";

// A LONG LEDGER REACHES THE OTHER COMPUTERS (docs/50, local 117, cloud 041). On 22 Nov 2026 PC1 imported a customer's
// old ledger and PC3 never showed it: the statement went as ONE record with every row, and the cloud refuses a record
// over 256 KB (013, RECORD_TOO_LARGE). Now the statement goes as its header and its rows in pages of 50.
//
// End to end with the real import, capture, builder and applier, and the cloud's own measure of a record:
//   * every revision of a 5,000-row statement whose every row is at its longest is under the cloud's limit;
//   * the reader shows nothing of a statement until its last page is here, and then exactly what the writer shows;
//   * a page that arrives before its statement waits, and applies once the statement is here;
//   * delivered twice, nothing changes; the reader marks nothing as its own; no balance moves anywhere.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const NOW = "2026-11-23T10:00:00.000Z";
/** 013's limit: octet_length(body::text) of the jsonb body. */
const CLOUD_RECORD_LIMIT = 262_144;

interface Pc {
  readonly db: SqliteDatabase;
  readonly close: () => void;
}

function openPc(name: string): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-archive-pages-${name}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  return { db, close: () => { db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } };
}

/** The accounts computer: it holds ACCOUNTS, and PARTIES so the party travels too. */
function openAccounts(): Pc {
  const pc = openPc("accounts");
  pc.db.db.prepare(
    `INSERT INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
     VALUES ('ACCOUNTS', 'dev-accounts', 'Accounts PC', 1, 0, ?, 'https://test.supabase.co', ?),
            ('PARTIES', 'dev-accounts', 'Accounts PC', 1, 0, ?, 'https://test.supabase.co', ?)`
  ).run(NOW, NOW, NOW, NOW);
  pc.db.setNumberBlock(1, "test");
  return pc;
}

/** Builds everything marked, as the sync pass does (a page of marks at a time), and returns it in queue order. */
function sent(from: Pc): SyncEnvelope[] {
  while (buildLeasedRecordRevisions(from.db.db, NOW).queued > 0) { /* until nothing more is marked */ }
  const rows = from.db.db.prepare("SELECT aggregate_type, aggregate_id, dedupe_key, payload_json FROM sync_outbox WHERE status = 'PENDING' ORDER BY rowid").all() as Array<Record<string, unknown>>;
  from.db.db.prepare("UPDATE sync_outbox SET status = 'SYNCED' WHERE status = 'PENDING'").run();
  return rows.map((row) => ({
    dedupeKey: String(row.dedupe_key),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    operation: "INSERT" as const,
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    originDeviceId: "dev-accounts",
    createdAt: NOW,
  }));
}

const deliver = (reader: Pc, envelopes: readonly SyncEnvelope[]) => envelopes.map((envelope) => applyEnvelope(reader.db.db, envelope, NOW).status);

/** How Postgres prints a jsonb value as text: a space after every ':' and ','. What 013 measures. */
function jsonbText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonbText).join(", ")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${jsonbText(item)}`).join(", ")}}`;
  return JSON.stringify(value);
}
const cloudBytes = (envelope: SyncEnvelope): number => Buffer.byteLength(jsonbText(envelope.payload.body), "utf8");

const HEADINGS = ["party_code", "customer_name", "transaction_date", "voucher_number", "transaction_type", "bill_number", "description", "quantity", "debit", "credit", "running_balance", "sequence"];

/** A statement of `count` rows, each at its longest when `longest`: what the import is allowed to accept. */
function statementRows(count: number, longest: boolean) {
  const short = (seed: string) => (longest ? seed.padEnd(LEDGER_ARCHIVE_LIMITS.SHORT_TEXT_MAX, "9").slice(0, LEDGER_ARCHIVE_LIMITS.SHORT_TEXT_MAX) : seed);
  const rows = Array.from({ length: count }, (_, index) => ({
    party_code: "1301999",
    customer_name: "SYNTHETIC CUSTOMER KARACHI",
    transaction_date: "13/11/2026",
    voucher_number: short(String(10_000 + index)),
    transaction_type: "SL",
    bill_number: short(String(20_000 + index)),
    description: longest ? "ک".repeat(LEDGER_ARCHIVE_LIMITS.DESCRIPTION_MAX) : `Sale ${String(index + 1)}`,
    quantity: "1",
    debit: "1,000",
    credit: "-",
    running_balance: ((index + 1) * 1_000).toLocaleString("en-US"),
    sequence: String(index + 1),
  }));
  return ledgerArchiveRowsOf(HEADINGS, rows);
}

function importStatement(accounts: Pc, customer: string, count: number, longest: boolean) {
  return accounts.db.importLedgerArchive({
    batchId: crypto.randomUUID(), fileName: `synthetic-${String(count)}.csv`, fileHash: crypto.randomBytes(32).toString("hex"),
    statements: [{ partyId: customer, rows: statementRows(count, longest) }], actor: "accounts",
  }).statements[0]!;
}

const shown = (pc: Pc, customer: string) => {
  const view = pc.db.ledgerArchiveForParty(customer);
  return { statements: view.statements.map((statement) => [statement.id, statement.rowCount]), rows: view.entries.map((entry) => [entry.sequence, entry.description, entry.balancePaisa]) };
};

test("the longest statement the import accepts goes in pages, every one under the cloud's 256 KB", () => {
  const accounts = openAccounts();
  try {
    const customer = accounts.db.createParty({ partyName: "SYNTHETIC CUSTOMER KARACHI", partyType: "CUSTOMER", status: "ACTIVE" });
    const statement = importStatement(accounts, customer, LEDGER_ARCHIVE_LIMITS.MAX_STATEMENT_ROWS, true);
    const queued = sent(accounts);
    const pages = queued.filter((envelope) => envelope.aggregateType === "LEDGER_ARCHIVE_ENTRY_PAGE");
    assert.equal(pages.length, LEDGER_ARCHIVE_LIMITS.MAX_STATEMENT_ROWS / LEDGER_ARCHIVE_PAGE_ROWS, "5,000 rows are 100 pages");
    assert.deepEqual(queued.filter((envelope) => envelope.aggregateType === "LEDGER_ARCHIVE_STATEMENT").map((envelope) => envelope.aggregateId), [statement.id]);
    const largest = Math.max(...queued.map(cloudBytes));
    assert.ok(largest < CLOUD_RECORD_LIMIT, `the largest record is ${String(largest)} bytes, under ${String(CLOUD_RECORD_LIMIT)}`);
    const whole = Buffer.byteLength(jsonbText(pages.flatMap((page) => (page.payload.body as { children: { ledger_archive_entries: unknown[] } }).children.ledger_archive_entries)), "utf8");
    assert.ok(whole > CLOUD_RECORD_LIMIT * 10, "sent whole, as before 117, it would have been refused many times over");
  } finally {
    accounts.close();
  }
});

test("the reader shows a long statement only once its last page is here, then exactly what the writer shows", () => {
  const accounts = openAccounts();
  const reader = openPc("reader");
  try {
    const customer = accounts.db.createParty({ partyName: "SYNTHETIC CUSTOMER KARACHI", partyType: "CUSTOMER", status: "ACTIVE" });
    importStatement(accounts, customer, 1_234, false);
    const queued = sent(accounts);
    assert.deepEqual([...new Set(queued.map((envelope) => envelope.aggregateType))], ["PARTY", "LEDGER_ARCHIVE_STATEMENT", "LEDGER_ARCHIVE_ENTRY_PAGE"], "the party, the header, then its pages");
    const header = queued.filter((envelope) => envelope.aggregateType !== "LEDGER_ARCHIVE_ENTRY_PAGE");
    const pages = queued.filter((envelope) => envelope.aggregateType === "LEDGER_ARCHIVE_ENTRY_PAGE");
    assert.equal(pages.length, 25);
    const balanceBefore = reader.db.getCurrentPartyBalance(customer);

    // Pages first, as a slow pull might bring them: they wait for their statement, never written half.
    const early = deliver(reader, pages.slice(0, 3));
    assert.ok(early.every((status) => status !== "APPLIED"), `a page before its statement waits (${early.join(",")})`);
    deliver(reader, header);
    assert.deepEqual(shown(reader, customer), { statements: [], rows: [] }, "the header alone shows nothing");

    deliver(reader, pages.slice(0, -1));
    assert.deepEqual(shown(reader, customer), { statements: [], rows: [] }, "24 of 25 pages: still nothing, never half a ledger");
    assert.equal(reader.db.getCurrentPartyBalance(customer), balanceBefore, "half a ledger moves no balance");

    deliver(reader, pages.slice(-1));
    assert.deepEqual(shown(reader, customer), shown(accounts, customer), "the last page: the whole statement, exactly as on the accounts computer");
    assert.equal(shown(reader, customer).rows.length, 1_234);

    deliver(reader, queued);
    assert.deepEqual(shown(reader, customer), shown(accounts, customer), "delivered again: nothing changes");
    assert.equal(Number((reader.db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records").get() as { n: number }).n), 0, "the reader marks nothing as its own");
    // Owner, 25 Nov 2026: an imported old ledger is real. Its closing balance is the customer's balance until ERP
    // entries add to it, on every computer alike.
    assert.notEqual(accounts.db.getCurrentPartyBalance(customer), 0, "the old ledger's closing balance counts");
    assert.equal(reader.db.getCurrentPartyBalance(customer), accounts.db.getCurrentPartyBalance(customer), "both computers show the same balance");
  } finally {
    accounts.close();
    reader.close();
  }
});

test("a withdrawal travels as the header alone, and the reader stops showing the statement", () => {
  const accounts = openAccounts();
  const reader = openPc("reader");
  try {
    const customer = accounts.db.createParty({ partyName: "SYNTHETIC CUSTOMER KARACHI", partyType: "CUSTOMER", status: "ACTIVE" });
    const statement = importStatement(accounts, customer, 120, false);
    deliver(reader, sent(accounts));
    assert.equal(shown(reader, customer).rows.length, 120);
    accounts.db.withdrawLedgerArchiveBatch({ requestId: crypto.randomUUID(), batchId: statement.batchId, reason: "Wrong period", actor: "owner" });
    const withdrawal = sent(accounts);
    assert.deepEqual(withdrawal.map((envelope) => envelope.aggregateType), ["LEDGER_ARCHIVE_STATEMENT"], "one small revision, no pages");
    deliver(reader, withdrawal);
    assert.deepEqual(shown(reader, customer), { statements: [], rows: [] });
    assert.equal(Number((reader.db.db.prepare("SELECT COUNT(*) AS n FROM ledger_archive_entries").get() as { n: number }).n), 120, "its rows are kept");
  } finally {
    accounts.close();
    reader.close();
  }
});
