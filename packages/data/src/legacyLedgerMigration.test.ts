import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLegacyLedgerReport, type LegacyCell } from "@erp/domain";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { readLeasedRecordPayload, snapshotRecord } from "./database/masterRecords.js";

// MIGRATING THE PREVIOUS SOFTWARE'S LEDGERS (docs/53), in a real database: bulk opening balances at a cutover, and
// withdrawing an import. The six real exports run end to end in apps/desktop legacyLedgerImport.test.ts.

const report = (code: string, name: string, lines: Array<[string, number, number, number]>, title = "Customer Ledger Report"): LegacyCell[][] => {
  const total = lines.reduce((t, [, debit, credit]) => [t[0] + debit, t[1] + credit], [0, 0]);
  return [
    [null, "777 EVA Shoes"], [null, null, null, null, null, title], [null, null, null, `Name : ${code} - ${name}`],
    ["From", ":", "01/10/2026"], ["To", ":", "20/11/2026"],
    ["Date", null, "No.", "Type", "Bill.No", "Description", null, null, null, "Qty", "Debit", null, "Credit", null, "Balance"],
    ["2026-09-30", null, 0, null, null, "Opening Balance", null, null, null, 0, null, 0, null, null, 1000],
    ...lines.map(([date, debit, credit, balance], i): LegacyCell[] => [date, null, 100 + i, debit ? "SL" : "CV", null, `line ${String(i)}`, null, null, null, 0, debit, null, credit, null, null, balance]),
    [null, null, null, null, null, "Total :", null, null, 0, total[0], null, total[1], null, null, lines.at(-1)?.[3] ?? 1000],
  ];
};

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-legacy-migration-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "a.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  db.setNumberBlock(1, "test");
  const party = (name: string, type: "CUSTOMER" | "SUPPLIER") => db.createParty({ partyName: name, partyType: type, status: "ACTIVE" });
  return { db, party, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
type Fixture = ReturnType<typeof createFixture>;

const importReport = (f: Fixture, partyId: string, grid: LegacyCell[][]) => {
  const [s] = parseLegacyLedgerReport(grid).statements;
  assert.ok(s && s.side && s.periodFrom && s.periodTo && s.printedTotals);
  const hash = crypto.createHash("sha256").update(JSON.stringify(grid)).digest("hex");
  return f.db.importLedgerArchive({
    batchId: crypto.randomUUID(), fileName: `${s.partyCode}.xls`, fileHash: hash, actor: "accounts",
    statements: [{ partyId, rows: s.rows, side: s.side, sourceFile: { name: `${s.partyCode}.xls`, hash }, report: { title: s.title, side: s.side, partyCode: s.partyCode, partyName: s.partyName, periodFrom: s.periodFrom, periodTo: s.periodTo, printedTotals: s.printedTotals } }],
  });
};

test("BULK: every party with an archive is proposed or left out, with the reason", () => {
  const f = createFixture();
  try {
    const ready = f.party("READY", "CUSTOMER");
    const zero = f.party("ZERO", "CUSTOMER");
    const late = f.party("LATE", "CUSTOMER");
    const posted = f.party("POSTED", "CUSTOMER");
    importReport(f, ready, report("1301001", "READY", [["2026-10-05", 500, 0, 1500], ["2026-11-25", 0, 100, 1400]]));
    importReport(f, zero, report("1301002", "ZERO", [["2026-10-05", 0, 1000, 0]]));
    importReport(f, late, report("1301003", "LATE", [["2026-10-05", 500, 0, 1500]]));
    importReport(f, posted, report("1301004", "POSTED", [["2026-10-05", 500, 0, 1500]]));
    f.db.postPartyOpeningBalance({ requestId: crypto.randomUUID(), partyId: posted, direction: "DEBIT", amountPaisa: 150_000, effectiveDate: "2026-11-21", sourceReference: "by hand", actor: "owner" });
    const byName = (cutover: string) => new Map(f.db.previewBulkOpeningBalances("CUSTOMER", cutover).proposals.map((p) => [p.partyName, p]));
    const at = byName("2026-11-21");
    assert.deepEqual([at.get("READY")?.status, at.get("READY")?.amountPaisa, at.get("READY")?.linesOnOrAfterCutover], ["READY", 150_000, 1]);
    assert.match(at.get("READY")?.warnings.join(" ") ?? "", /1 archived line\(s\) are dated on or after 2026-11-21/);
    assert.match(at.get("ZERO")?.skipReason ?? "", /zero: there is nothing to post/);
    assert.match(at.get("POSTED")?.skipReason ?? "", /Already has an opening balance/);
    assert.match(byName("2026-09-30").get("LATE")?.skipReason ?? "", /No archived line is dated before 2026-09-30/);
  } finally {
    f.cleanup();
  }
});

test("BULK: there is no default cutover, and a malformed post is refused before anything is written", () => {
  const f = createFixture();
  try {
    assert.throws(() => f.db.previewBulkOpeningBalances("CUSTOMER", ""), /Choose the cutover date/);
    const base = { requestId: crypto.randomUUID(), side: "CUSTOMER", cutoverDate: "2026-11-21", actor: "owner" };
    assert.throws(() => f.db.postBulkOpeningBalances({ ...base, expected: [] }), /Choose at least one party/);
    assert.throws(() => f.db.postBulkOpeningBalances({ ...base, cutoverDate: "2026-02-30", expected: [{ partyId: "x", direction: "DEBIT", amountPaisa: 1, archiveStatementId: "s" }] }), /Choose the cutover date/);
    assert.throws(() => f.db.postBulkOpeningBalances({ ...base, expected: [{ partyId: "x", direction: "UP", amountPaisa: 1, archiveStatementId: "s" }] }), /could not be read/);
    assert.equal(Number((f.db.db.prepare("SELECT COUNT(*) AS n FROM party_opening_balances").get() as { n: number }).n), 0);
  } finally {
    f.cleanup();
  }
});

test("BULK: one stale party refuses the whole post, so nothing is half-posted", () => {
  const f = createFixture();
  try {
    const a = f.party("A", "CUSTOMER");
    const b = f.party("B", "CUSTOMER");
    importReport(f, a, report("1301001", "A", [["2026-10-05", 500, 0, 1500]]));
    importReport(f, b, report("1301002", "B", [["2026-10-05", 700, 0, 1700]]));
    const proposals = f.db.previewBulkOpeningBalances("CUSTOMER", "2026-11-21").proposals;
    const expected = proposals.map((p) => ({ partyId: p.partyId, direction: p.direction, amountPaisa: p.amountPaisa, archiveStatementId: p.archiveStatementId }));
    expected[1] = { ...expected[1]!, amountPaisa: 1 };
    assert.throws(() => f.db.postBulkOpeningBalances({ requestId: crypto.randomUUID(), side: "CUSTOMER", cutoverDate: "2026-11-21", expected, actor: "owner" }), /not what was previewed/);
    assert.equal(Number((f.db.db.prepare("SELECT COUNT(*) AS n FROM party_opening_balance_entries").get() as { n: number }).n), 0);
  } finally {
    f.cleanup();
  }
});

test("WITHDRAWAL: needs a reason, keeps every row, travels as a revision of the same record, and is audited", () => {
  const f = createFixture();
  try {
    const a = f.party("A", "CUSTOMER");
    const imported = importReport(f, a, report("1301001", "A", [["2026-10-05", 500, 0, 1500]]));
    const statementId = imported.statements[0]!.id;
    assert.throws(() => f.db.withdrawLedgerArchiveBatch({ requestId: crypto.randomUUID(), batchId: imported.batchId, reason: " ", actor: "owner" }), /Say why/);
    f.db.db.prepare("DELETE FROM sync_dirty_records").run();
    f.db.withdrawLedgerArchiveBatch({ requestId: crypto.randomUUID(), batchId: imported.batchId, reason: "Exported the wrong period", actor: "owner" });
    const marks = f.db.db.prepare("SELECT record_id FROM sync_dirty_records WHERE aggregate_type = 'LEDGER_ARCHIVE_STATEMENT'").all() as Array<{ record_id: string }>;
    assert.deepEqual(marks.map((m) => m.record_id), [statementId]);
    const body = snapshotRecord(f.db.db, "LEDGER_ARCHIVE_STATEMENT", statementId);
    assert.equal(body?.row.withdrawal_reason, "Exported the wrong period");
    assert.equal(body?.children.ledger_archive_entries?.length, 2, "every row still travels with it");
    assert.ok(readLeasedRecordPayload("LEDGER_ARCHIVE_STATEMENT", { recordId: statementId, revision: 2, deleted: false, body }));
    assert.throws(() => f.db.withdrawLedgerArchiveBatch({ requestId: crypto.randomUUID(), batchId: imported.batchId, reason: "again", actor: "owner" }), /already withdrawn by owner/);
    assert.equal(f.db.getLedgerArchiveBatch(imported.batchId)[0]?.withdrawnBy, "owner");
  } finally {
    f.cleanup();
  }
});

test("WITHDRAWAL: an opening balance cannot be checked against a withdrawn statement", () => {
  const f = createFixture();
  try {
    const a = f.party("A", "CUSTOMER");
    const imported = importReport(f, a, report("1301001", "A", [["2026-10-05", 500, 0, 1500]]));
    f.db.withdrawLedgerArchiveBatch({ requestId: crypto.randomUUID(), batchId: imported.batchId, reason: "wrong file", actor: "owner" });
    assert.throws(
      () => f.db.postPartyOpeningBalance({ requestId: crypto.randomUUID(), partyId: a, direction: "DEBIT", amountPaisa: 150_000, effectiveDate: "2026-11-21", sourceReference: "x", archiveStatementId: imported.statements[0]!.id, actor: "owner" }),
      /not this party's/
    );
    assert.deepEqual(f.db.previewBulkOpeningBalances("CUSTOMER", "2026-11-21").proposals, []);
  } finally {
    f.cleanup();
  }
});

test("A FILE NAMING SEVERAL PARTIES: importing some leaves the rest importable, and the file is whole only once all are in", () => {
  const f = createFixture();
  try {
    const a = f.party("A", "CUSTOMER");
    const b = f.party("B", "CUSTOMER");
    const [sa] = parseLegacyLedgerReport(report("1301001", "A", [["2026-10-05", 500, 0, 1500]])).statements;
    const [sb] = parseLegacyLedgerReport(report("1301002", "B", [["2026-10-05", 700, 0, 1700]])).statements;
    const hash = "c".repeat(64);
    const statement = (s: typeof sa, partyId?: string) => ({ partyId, rows: s!.rows, side: "CUSTOMER" as const, sourceFile: { name: "two-parties.xls", hash } });
    const preview = () => f.db.previewLedgerArchiveImport({ fileHash: hash, statements: [statement(sa), statement(sb)] });
    const importOnly = (s: typeof sa, partyId: string) =>
      f.db.importLedgerArchive({ batchId: crypto.randomUUID(), fileName: "two-parties.xls", fileHash: hash, actor: "accounts", statements: [statement(s, partyId)] });

    importOnly(sa, a);
    const partly = preview();
    assert.equal(partly.alreadyImported, null, "a partly imported file is not 'already imported'");
    assert.deepEqual(partly.statements.map((s) => s.fileAlreadyImported?.fileName ?? null), ["two-parties.xls", null]);
    assert.throws(() => importOnly(sa, a), /A in this file was already imported \(two-parties.xls, by accounts\)/);

    importOnly(sb, b);
    assert.equal(preview().alreadyImported?.fileName, "two-parties.xls", "whole once every party in it is in");
    assert.throws(() => importOnly(sb, b), /B in this file was already imported/);
  } finally {
    f.cleanup();
  }
});
