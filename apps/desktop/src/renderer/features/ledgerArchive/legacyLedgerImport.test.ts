// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "@erp/data";
import { readChosenFile, type ChosenStatement } from "./legacyImport";

// SIX REPORTS IN THE PREVIOUS SOFTWARE'S EXACT LAYOUT (docs/53), end to end: read as Excel 97-2003 files, read as ledger
// reports, imported into a real database, reconciled, given opening balances at a cutover, and withdrawn.
// The files are SYNTHETIC (docs/fixtures/legacy-ledgers/README.md): each keeps a real export's layout and edge cases,
// with no real name, code, description or amount. Amounts here are paisa.

const FIXTURES = path.resolve(__dirname, "../../../../../../docs/fixtures/legacy-ledgers");
const SCHEMA = path.resolve(__dirname, "../../../../../../packages/data/src/local-schema.sql");

interface Expected { file: string; side: "CUSTOMER" | "SUPPLIER"; code: string; name: string; rows: number; opening: number; debit: number; credit: number; closing: number; quantity: number }
const SIX: Expected[] = [
  { file: "synthetic-customer-1301901.xls", side: "CUSTOMER", code: "1301901", name: "SYNTHETIC CUSTOMER ALPHA", rows: 999, opening: 452_756_000, debit: 1_464_184_200, credit: 1_368_729_700, closing: 548_210_500, quantity: 3438 },
  { file: "synthetic-customer-1301902.xls", side: "CUSTOMER", code: "1301902", name: "SYNTHETIC CUSTOMER BRAVO", rows: 263, opening: 137_096_900, debit: 1_052_218_900, credit: 842_760_200, closing: 346_555_600, quantity: 2363 },
  { file: "synthetic-customer-1301903.xls", side: "CUSTOMER", code: "1301903", name: "SYNTHETIC CUSTOMER CHARLIE", rows: 1321, opening: 120_522_000, debit: 1_696_518_200, credit: 1_736_040_800, closing: 80_999_400, quantity: 3931.5 },
  { file: "synthetic-supplier-1201901.xls", side: "SUPPLIER", code: "1201901", name: "SYNTHETIC SUPPLIER DELTA", rows: 154, opening: -1_757_232_900, debit: 2_697_770_700, credit: 1_894_173_400, closing: -953_635_600, quantity: 14106 },
  { file: "synthetic-supplier-1201902.xls", side: "SUPPLIER", code: "1201902", name: "SYNTHETIC SUPPLIER ECHO", rows: 43, opening: -2_564_020_000, debit: 1_634_424_200, credit: 928_847_300, closing: -1_858_443_100, quantity: 19340 },
  { file: "synthetic-supplier-1201903.xls", side: "SUPPLIER", code: "1201903", name: "SYNTHETIC SUPPLIER FOXTROT", rows: 21, opening: 0, debit: 39_820_800, credit: 282_661_700, closing: -242_840_900, quantity: 2328 },
];
/** What the ERP calls the closing: a supplier's negative printed balance is what we owe. */
const erpClosing = (item: Expected): number => (item.side === "SUPPLIER" ? -item.closing : item.closing);

const fileOf = (name: string): File => new File([fs.readFileSync(path.join(FIXTURES, name))], name);

let db: SqliteDatabase;
let dir: string;
const parties = new Map<string, string>();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-legacy-"));
  db = new SqliteDatabase({ dbPath: path.join(dir, "a.db"), schemaPath: SCHEMA });
  db.setNumberBlock(1, "test");
  parties.clear();
  for (const item of SIX) parties.set(item.code, db.createParty({ partyName: item.name, partyType: item.side, status: "ACTIVE" }));
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function readAll(names: readonly string[] = SIX.map((item) => item.file)): Promise<ChosenStatement[]> {
  const files = await Promise.all(names.map((name) => readChosenFile(fileOf(name), "CUSTOMER")));
  return files.flatMap((file) => file.statements);
}

const importAll = (statements: readonly ChosenStatement[], batchId: string = crypto.randomUUID()) =>
  db.importLedgerArchive({
    batchId, fileName: `${String(statements.length)} files`, fileHash: crypto.createHash("sha256").update(statements.map((s) => s.fileHash).join()).digest("hex"), actor: "accounts",
    statements: statements.map((s) => ({ partyId: parties.get(s.report?.partyCode ?? ""), rows: s.rows, side: s.side, sourceFile: { name: s.fileName, hash: s.fileHash }, report: s.report })),
  });

describe("six reports in the previous software's layout", () => {
  it("holds no real business data: every report in the fixtures folder names a SYNTHETIC party", async () => {
    const names = fs.readdirSync(FIXTURES).filter((name) => /.(xls|xlsx|csv)$/i.test(name));
    expect(names.sort()).toEqual(SIX.map((item) => item.file).sort());
    for (const name of names) {
      const file = await readChosenFile(fileOf(name), "CUSTOMER");
      expect(file.statements.map((s) => s.report?.partyName ?? "").every((party) => party.startsWith("SYNTHETIC ")), name).toBe(true);
    }
  });

  it("each is read as one party's complete report: title, code, period, every line, and its Total line", async () => {
    for (const item of SIX) {
      const file = await readChosenFile(fileOf(item.file), "CUSTOMER");
      expect(file.problems, item.file).toEqual([]);
      expect(file.statements).toHaveLength(1);
      const [s] = file.statements;
      expect([s?.side, s?.report?.partyCode, s?.report?.partyName, s?.rows.length, s?.readProblems], item.file).toEqual([item.side, item.code, item.name, item.rows, []]);
      expect(s?.report?.periodTo).toBe("2026-11-20");
      expect(s?.rows[0]?.description).toBe("Opening Balance");
    }
  });

  it("all six preview with no problem, matched by name, each on its own ledger", async () => {
    const statements = await readAll();
    const preview = db.previewLedgerArchiveImport({ fileHash: "0".repeat(64), statements: statements.map((s) => ({ rows: s.rows, side: s.side, sourceFile: { name: s.fileName, hash: s.fileHash }, report: s.report })) });
    for (const [i, p] of preview.statements.entries()) {
      expect(p.problems, statements[i]?.fileName).toEqual([]);
      expect([p.side, p.match?.how, p.balanceRule]).toEqual([statements[i]?.side, "NAME", "DEBIT_LESS_CREDIT"]);
    }
  });

  it("imported together, every statement's opening, debits, credits, closing and quantity are exactly the report's", async () => {
    const result = importAll(await readAll());
    expect(result.statements).toHaveLength(6);
    for (const item of SIX) {
      const s = result.statements.find((statement) => statement.originalPartyCode === item.code);
      expect([s?.ledgerSide, s?.balanceRule, s?.rowCount], item.code).toEqual([item.side, "DEBIT_LESS_CREDIT", item.rows]);
      expect([s?.openingBalancePaisa, s?.totalDebitPaisa, s?.totalCreditPaisa, s?.closingBalancePaisa, s?.totalQuantity], item.code)
        .toEqual([item.opening, item.debit, item.credit, item.closing, item.quantity]);
      expect(s?.sourceFileName).toBe(item.file);
    }
  });

  it("the reconciliation reads suppliers' negative balances as what we owe, and every archive adds up", async () => {
    importAll(await readAll());
    for (const side of ["CUSTOMER", "SUPPLIER"] as const) {
      for (const row of db.partyLedgerReconciliation(side).rows) {
        const item = SIX.find((expected) => expected.code === row.originalPartyCode);
        expect([row.archiveConsistent, row.archiveClosingPaisa, row.status], row.partyName).toEqual([true, item ? erpClosing(item) : 0, "NO_OPENING_BALANCE"]);
      }
    }
  });

  it("history stays history: no voucher, bill, cash, stock or balance moves", async () => {
    const live = [...parties.values()].map((id) => db.getCurrentPartyBalance(id));
    const counts = () => ["sale_vouchers", "cash_vouchers", "purchase_vouchers", "party_claims", "carton_stock_events", "gatepasses", "manual_production_entries"].map((t) => Number((db.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n));
    const before = counts();
    importAll(await readAll());
    expect(counts()).toEqual(before);
    expect([...parties.values()].map((id) => db.getCurrentPartyBalance(id))).toEqual(live);
    expect(db.listSupplierBalances({ asOfDate: "2026-12-31" }).rows.every((row) => row.balance === 0)).toBe(true);
  });

  it("repeated legitimate lines are kept, each with its own balance (ALPHA has 5, CHARLIE 7)", async () => {
    importAll(await readAll(["synthetic-customer-1301901.xls", "synthetic-customer-1301903.xls"]));
    const repeats = (code: string) => {
      const rows = db.db.prepare(
        `SELECT e.entry_date, e.voucher_number, e.transaction_type, e.bill_number, e.description, e.quantity_text, e.debit_paisa, e.credit_paisa
           FROM ledger_archive_entries e JOIN ledger_archive_statements s ON s.id = e.statement_id WHERE s.original_party_code = ?`
      ).all(code) as Array<Record<string, unknown>>;
      const seen = new Map<string, number>();
      for (const row of rows) { const key = JSON.stringify(row); seen.set(key, (seen.get(key) ?? 0) + 1); }
      return [...seen.values()].reduce((sum, n) => sum + n - 1, 0);
    };
    expect([repeats("1301901"), repeats("1301903")]).toEqual([5, 7]);
  });

  it("supplier CV lines keep their direction: payments, claims and goods returned are debits, bills are credits", async () => {
    importAll(await readAll(["synthetic-supplier-1201901.xls"]));
    const cv = db.db.prepare(
      `SELECT SUM(e.debit_paisa > 0) AS debits, SUM(e.credit_paisa > 0) AS credits FROM ledger_archive_entries e
         JOIN ledger_archive_statements s ON s.id = e.statement_id WHERE s.original_party_code = '1201901' AND e.transaction_type = 'CV'`
    ).get() as { debits: number; credits: number };
    expect([Number(cv.debits), Number(cv.credits)]).toEqual([52, 12]);
  });

  it("the same file is never imported twice, alone or among others", async () => {
    const statements = await readAll();
    importAll(statements);
    expect(() => importAll(statements.slice(0, 1))).toThrow(/already imported/);
    const again = db.previewLedgerArchiveImport({ fileHash: "0".repeat(64), statements: statements.slice(0, 1).map((s) => ({ rows: s.rows, side: s.side, sourceFile: { name: s.fileName, hash: s.fileHash }, report: s.report })) });
    expect(again.statements[0]?.fileAlreadyImported?.fileName).toBe("synthetic-customer-1301901.xls");
  });

  it("a supplier report cannot be imported onto the customer ledger, nor matched to a customer", async () => {
    const [supplier] = await readAll(["synthetic-supplier-1201903.xls"]);
    expect(() =>
      db.importLedgerArchive({ batchId: crypto.randomUUID(), fileName: "x", fileHash: supplier!.fileHash, actor: "a", statements: [{ partyId: parties.get("1301901"), rows: supplier!.rows, side: "CUSTOMER", report: supplier!.report }] })
    ).toThrow(/supplier ledger, imported as a customer one/);
  });

  it("a report whose lines do not add up to its Total line is refused, naming the difference", async () => {
    const [s] = await readAll(["synthetic-supplier-1201903.xls"]);
    const tampered = { ...s!.report!, printedTotals: { ...s!.report!.printedTotals, credit: "2826618" } };
    expect(() => importAll([{ ...s!, report: tampered }])).toThrow(/report's Total line says 2,826,618/);
  });

  it("bulk opening balances at a cutover: each party's balance on the last line before it, the supplier's as a payable", async () => {
    importAll(await readAll());
    const customers = db.previewBulkOpeningBalances("CUSTOMER", "2026-11-21");
    expect(customers.proposals.map((p) => [p.originalPartyCode, p.status, p.direction, p.amountPaisa, p.linesOnOrAfterCutover]).sort()).toEqual([
      ["1301901", "READY", "DEBIT", 548_210_500, 0],
      ["1301902", "READY", "DEBIT", 346_555_600, 0],
      ["1301903", "READY", "DEBIT", 80_999_400, 0],
    ]);
    const suppliers = db.previewBulkOpeningBalances("SUPPLIER", "2026-11-21");
    expect(suppliers.proposals.map((p) => [p.originalPartyCode, p.direction, p.amountPaisa]).sort()).toEqual([
      ["1201901", "CREDIT", 953_635_600],
      ["1201902", "CREDIT", 1_858_443_100],
      ["1201903", "CREDIT", 242_840_900],
    ]);
    const earlier = db.previewBulkOpeningBalances("SUPPLIER", "2026-11-01").proposals.find((p) => p.originalPartyCode === "1201903");
    expect(earlier?.linesOnOrAfterCutover).toBeGreaterThan(0);
    expect(earlier?.warnings.join(" ")).toMatch(/not counted/);
  });

  it("posting them is all-or-none, exactly as previewed, and a retry posts nothing twice", async () => {
    importAll(await readAll());
    const preview = db.previewBulkOpeningBalances("SUPPLIER", "2026-11-21");
    const expected = preview.proposals.map((p) => ({ partyId: p.partyId, direction: p.direction, amountPaisa: p.amountPaisa, archiveStatementId: p.archiveStatementId }));
    const requestId = crypto.randomUUID();
    expect(db.postBulkOpeningBalances({ requestId, side: "SUPPLIER", cutoverDate: "2026-11-21", expected, actor: "owner" }).posted).toBe(3);
    expect(db.postBulkOpeningBalances({ requestId, side: "SUPPLIER", cutoverDate: "2026-11-21", expected, actor: "owner" }).duplicate).toBe(true);
    const balances = new Map(db.listSupplierBalances({ asOfDate: "2026-12-31" }).rows.map((row) => [row.partyId, row.balance]));
    expect(balances.get(parties.get("1201901") ?? "")).toBe(9_536_356);
    expect(db.partyLedgerReconciliation("SUPPLIER").rows.every((row) => row.status === "MATCHED")).toBe(true);
    const stale = [{ ...expected[0]!, amountPaisa: 1 }];
    expect(() => db.postBulkOpeningBalances({ requestId: crypto.randomUUID(), side: "SUPPLIER", cutoverDate: "2026-11-21", expected: stale, actor: "owner" })).toThrow(/not what was previewed/);
  });

  it("an import can be withdrawn with a reason, only while no posted opening balance rests on it, and imported again after", async () => {
    const statements = await readAll(["synthetic-customer-1301902.xls"]);
    const imported = importAll(statements);
    const proposal = db.previewBulkOpeningBalances("CUSTOMER", "2026-11-21").proposals[0]!;
    const post = db.postBulkOpeningBalances({ requestId: crypto.randomUUID(), side: "CUSTOMER", cutoverDate: "2026-11-21", expected: [{ partyId: proposal.partyId, direction: proposal.direction, amountPaisa: proposal.amountPaisa, archiveStatementId: proposal.archiveStatementId }], actor: "owner" });
    expect(post.posted).toBe(1);
    const withdraw = (requestId: string) => db.withdrawLedgerArchiveBatch({ requestId, batchId: imported.batchId, reason: "Wrong period exported", actor: "owner" });
    expect(() => withdraw(crypto.randomUUID())).toThrow(/still posted for SYNTHETIC CUSTOMER BRAVO/);
    const view = db.getPartyOpeningBalance(proposal.partyId)!;
    db.reversePartyOpeningBalance({ requestId: crypto.randomUUID(), partyId: proposal.partyId, expectedVersion: view.version, reason: "Re-importing", actor: "owner" });
    const requestId = crypto.randomUUID();
    expect(withdraw(requestId).statements[0]?.withdrawalReason).toBe("Wrong period exported");
    expect(withdraw(requestId).duplicate).toBe(true);
    expect(db.ledgerArchiveForParty(proposal.partyId).entries).toHaveLength(0);
    expect(Number((db.db.prepare("SELECT COUNT(*) AS n FROM ledger_archive_entries").get() as { n: number }).n)).toBe(263);
    expect(db.partyLedgerReconciliation("CUSTOMER").rows).toEqual([]);
    expect(importAll(statements).statements).toHaveLength(1);
    expect(Number((db.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'LEDGER_ARCHIVE_WITHDRAWN'").get() as { n: number }).n)).toBe(1);
  });
});
