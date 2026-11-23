import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ledgerArchiveRowsOf, parseDelimitedText } from "@erp/domain";
import { SqliteDatabase, buildLeasedRecordRevisions } from "@erp/data";
import { applyEnvelope } from "./applyEnvelope.js";
import type { SyncEnvelope } from "./contract.js";

// OPENING BALANCES AND ARCHIVES ACROSS COMPUTERS (docs/53), end to end: the accounts computer imports an archive and
// posts, corrects and reverses an opening balance the ordinary way; its capture marks them; the real builder queues
// them; another computer applies them with the real applier. Both must show the same balances at every step, a
// revision delivered twice must change nothing, and the reader must never mark what it received as its own.

const SCHEMA = path.resolve(import.meta.dirname, "../../data/src/local-schema.sql");
const BEHRAAM_CSV = path.resolve(import.meta.dirname, "../../../docs/fixtures/ledger-archive/behraam-shoes-1301139.csv");
const NOW = "2026-11-19T10:00:00.000Z";

interface Pc {
  readonly db: SqliteDatabase;
  readonly close: () => void;
}

function openPc(name: string): Pc {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `erp-opening-${name}-`));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: SCHEMA });
  return { db, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** The accounts computer: it holds ACCOUNTS, and PARTIES so the parties it names travel too. */
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

/** Builds what the computer has marked and returns the queued revisions as envelopes, in queue order. */
function sent(from: Pc): SyncEnvelope[] {
  buildLeasedRecordRevisions(from.db.db, NOW);
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

const deliver = (reader: Pc, envelopes: readonly SyncEnvelope[]) => {
  for (const envelope of envelopes) applyEnvelope(reader.db.db, envelope, NOW);
};

/** What both computers must agree on. */
const balances = (pc: Pc, customer: string) => ({
  current: pc.db.getCurrentPartyBalance(customer),
  listed: pc.db.listCustomerBalances({ asOfDate: "2026-12-31" }).rows.find((row) => row.partyId === customer)?.balance ?? null,
  ledgerClosing: pc.db.getCustomerLedgerWithCash(customer).closingBalance,
  reconciliation: pc.db.partyLedgerReconciliation("CUSTOMER").rows.map((row) => [row.partyId, row.status, row.differencePaisa]),
  archivedRows: pc.db.ledgerArchiveForParty(customer).entries.length,
});

test("an archive and an opening balance arrive whole, and both computers show the same balance after every change", () => {
  const accounts = openAccounts();
  const reader = openPc("reader");
  try {
    const customer = accounts.db.createParty({ partyName: "Behraam Shoes Karachi", partyType: "CUSTOMER", status: "ACTIVE" });
    const csv = fs.readFileSync(BEHRAAM_CSV, "utf8");
    const sheet = parseDelimitedText(csv);
    const [statement] = accounts.db.importLedgerArchive({
      batchId: crypto.randomUUID(), fileName: "behraam-shoes-1301139.csv", fileHash: crypto.createHash("sha256").update(csv).digest("hex"),
      statements: [{ partyId: customer, rows: ledgerArchiveRowsOf(sheet.headers, sheet.rows) }], actor: "accounts",
    }).statements;
    const posted = accounts.db.postPartyOpeningBalance({
      requestId: crypto.randomUUID(), partyId: customer, direction: "DEBIT", amountPaisa: 35_000_000, effectiveDate: "2026-11-14",
      sourceReference: "Old ledger 1301139", archiveStatementId: statement.id, actor: "admin",
    });
    const first = sent(accounts);
    assert.deepEqual(first.map((envelope) => envelope.aggregateType), ["PARTY", "LEDGER_ARCHIVE_STATEMENT", "LEDGER_ARCHIVE_ENTRY_PAGE", "PARTY_OPENING_BALANCE"], "the party, its archive header and its one page of rows, then the balance that names them");
    deliver(reader, first);
    assert.deepEqual(balances(reader, customer), balances(accounts, customer));
    assert.equal(reader.db.getCurrentPartyBalance(customer), 350_000);

    accounts.db.correctPartyOpeningBalance({
      requestId: crypto.randomUUID(), partyId: customer, expectedVersion: posted.version, direction: "DEBIT", amountPaisa: 35_388_000,
      effectiveDate: "2026-11-14", sourceReference: "Old ledger 1301139", archiveStatementId: statement.id, reason: "Typed 350,000", actor: "admin",
    });
    const correction = sent(accounts);
    assert.deepEqual(correction.map((envelope) => envelope.aggregateType), ["PARTY_OPENING_BALANCE"], "a correction is one revision of one record");
    deliver(reader, correction);
    assert.deepEqual(balances(reader, customer), balances(accounts, customer));
    assert.equal(reader.db.getCurrentPartyBalance(customer), 353_880, "the corrected figure, counted once");
    assert.equal(reader.db.getPartyOpeningBalance(customer)?.history.length, 3, "the history travelled with it");

    deliver(reader, [...first, ...correction]);
    assert.equal(reader.db.getCurrentPartyBalance(customer), 353_880, "delivered again: nothing changes");
    assert.equal(Number((reader.db.db.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = 'PARTY_OPENING_BALANCE'").get() as { n: number }).n), 0, "the reader does not mark it as its own");

    const now = accounts.db.getPartyOpeningBalance(customer);
    accounts.db.reversePartyOpeningBalance({ requestId: crypto.randomUUID(), partyId: customer, expectedVersion: now?.version ?? 0, reason: "Settled outside", actor: "admin" });
    deliver(reader, sent(accounts));
    assert.deepEqual(balances(reader, customer), balances(accounts, customer));
    assert.equal(reader.db.getCurrentPartyBalance(customer), 0);
    assert.equal(reader.db.ledgerArchiveForParty(customer).entries.length, 45, "the archive is untouched by any of it");
  } finally {
    accounts.close();
    reader.close();
  }
});
