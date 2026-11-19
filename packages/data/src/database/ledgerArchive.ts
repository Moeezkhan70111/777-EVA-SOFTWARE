// HISTORICAL LEDGER ARCHIVE (docs/50, local migrations 111 and 113): customers' and suppliers' ledgers from the
// previous accounting software, kept exactly as printed and shown beside the live ledger.
//
// ONE SIDE PER IMPORT. An import is for customers or for suppliers (the ledger screen it was started from), and every
// statement in it must belong to a party of that type. A statement records its side and the rule its printed balances
// follow (debit less credit, or credit less debit for a supplier), so it is always read back the way it was printed.
//
//   READ   previewLedgerArchiveImport   what an import would do: who each customer is here, and what is already stored
//   WRITE  importLedgerArchive          every accepted statement and its rows, in one transaction, or nothing
//   READ   ledgerArchiveForParty        one customer's archived rows in a date range, in order, with their statements
//
// NOT ACCOUNTING. Nothing in this file writes a voucher, a stock movement or a party balance, and nothing that works
// out a balance reads these tables (database/cash.ts is unchanged). The live ledger and the archive meet only on the
// screen and in its exports.
//
// NOTHING THE SCREEN SENDS IS TRUSTED. Every row is read again here by the same rules the screen used
// (@erp/domain ledgerArchive.ts), and a statement with any problem refuses the whole import.
//
// NEVER TWICE. A file is imported once (its hash). A statement is stored once per customer (the hash of its rows). A
// row already archived for that customer refuses the statement that repeats it. A retried import with the same batch
// id finds what it already wrote.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import crypto from "node:crypto";
import {
  LEDGER_ARCHIVE_SIDE,
  archiveRowIdentity,
  isLedgerArchiveSide,
  readArchiveFile,
  type ArchiveBalanceRule,
  type LedgerArchiveSide,
  type LedgerArchiveRow,
  type LedgerArchiveRowInput,
  type LedgerArchiveStatementDraft,
  type LedgerArchiveTotals,
} from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const FILE_NAME_MAX = 200;
const SIDE_WORD: Readonly<Record<LedgerArchiveSide, string>> = { CUSTOMER: "customer", SUPPLIER: "supplier" };

/** The side an import or preview is for: customers unless it says suppliers. */
const sideOf = (value: unknown): LedgerArchiveSide => (isLedgerArchiveSide(value) ? value : LEDGER_ARCHIVE_SIDE.CUSTOMER);

type Row = Record<string, unknown>;
const text = (value: unknown): string => (value == null ? "" : String(value));
const textOrNull = (value: unknown): string | null => (value == null || String(value) === "" ? null : String(value));
const sha256 = (value: string): string => crypto.createHash("sha256").update(value, "utf8").digest("hex");

/** The original PDF, kept on the importing computer by its hash (main process, ledgerArchiveSources.ts). */
export interface LedgerArchiveSourceDocument {
  readonly name: string;
  readonly hash: string;
  readonly bytes: number;
}

export interface LedgerArchiveStatementInput {
  /** The ERP customer it belongs to. Optional in a preview, required to import. */
  readonly partyId?: string;
  readonly rows: readonly LedgerArchiveRowInput[];
  readonly sourceDocument?: LedgerArchiveSourceDocument | null;
}

export interface LedgerArchiveImportInput {
  /** The screen's id for this import: a retry after a lost answer finds what it wrote. */
  readonly batchId: string;
  readonly fileName: string;
  /** SHA-256 of the file as read. */
  readonly fileHash: string;
  readonly statements: readonly LedgerArchiveStatementInput[];
  /** Whose ledgers these are. Customers when absent, as every import before suppliers was. */
  readonly side?: LedgerArchiveSide;
  /** From the session, never the screen. */
  readonly actor: string;
}

/** Who a customer in the file is here, and how that was decided. */
export interface LedgerArchiveMatch {
  readonly partyId: string;
  readonly partyName: string;
  readonly partyCode: string;
  /** An earlier import named this code; this ERP party code; exactly this customer name; or the person chose it. */
  readonly how: "EARLIER_IMPORT" | "PARTY_CODE" | "NAME" | "CHOSEN";
}

export interface LedgerArchiveImportedFile {
  readonly batchId: string;
  readonly fileName: string;
  readonly importedAt: string;
  readonly importedBy: string;
}

export interface LedgerArchiveStatementPreview {
  readonly partyCode: string;
  readonly customerName: string;
  readonly match: LedgerArchiveMatch | null;
  /** The same statement is already stored for the matched customer. */
  readonly alreadyStored: LedgerArchiveImportedFile | null;
  /** Rows already archived for the matched customer. */
  readonly repeatedRows: number;
  readonly totals: LedgerArchiveTotals;
  /** The rule its printed balances follow. */
  readonly balanceRule: ArchiveBalanceRule;
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

export interface LedgerArchivePreview {
  readonly alreadyImported: LedgerArchiveImportedFile | null;
  readonly statements: readonly LedgerArchiveStatementPreview[];
}

export interface LedgerArchiveStatementSummary {
  readonly id: string;
  readonly batchId: string;
  readonly partyId: string;
  readonly ledgerSide: LedgerArchiveSide;
  readonly balanceRule: ArchiveBalanceRule;
  readonly originalPartyCode: string;
  readonly originalPartyName: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly rowCount: number;
  readonly openingBalancePaisa: number;
  readonly closingBalancePaisa: number;
  readonly totalDebitPaisa: number;
  readonly totalCreditPaisa: number;
  readonly totalQuantity: number;
  readonly sourceFileName: string;
  readonly sourceDocumentName: string | null;
  readonly sourceDocumentHash: string | null;
  readonly importedBy: string;
  readonly importedAt: string;
}

/** One archived row, as stored. */
export interface LedgerArchiveEntry {
  readonly id: string;
  readonly statementId: string;
  readonly sequence: number;
  readonly entryDate: string;
  readonly originalDateText: string;
  readonly voucherNumber: string;
  readonly transactionType: string;
  readonly billNumber: string;
  readonly description: string;
  readonly quantityText: string;
  readonly quantity: number | null;
  readonly debitPaisa: number;
  readonly creditPaisa: number;
  readonly balancePaisa: number;
}

export interface LedgerArchiveView {
  readonly statements: readonly LedgerArchiveStatementSummary[];
  readonly entries: readonly LedgerArchiveEntry[];
}

export interface LedgerArchiveImportResult {
  readonly batchId: string;
  /** True when this batch was already written, by an earlier try. */
  readonly duplicate: boolean;
  readonly statements: readonly LedgerArchiveStatementSummary[];
}

/** A refusal the screen shows as it is: nothing was written. */
export class LedgerArchiveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerArchiveRefused";
  }
}

/** A statement's rows read again here: exactly one party's, with no problem, or the problems. */
function readStatement(input: LedgerArchiveStatementInput, side: LedgerArchiveSide): { draft: LedgerArchiveStatementDraft; problems: [] } | { draft: null; problems: string[] } {
  const file = readArchiveFile(input.rows, side);
  const problems = [...file.rowProblems, ...(file.statements[0]?.problems ?? [])].map((problem) => problem.message);
  if (file.statements.length !== 1) problems.push("A statement must hold one party's rows, and at least one row.");
  return problems.length === 0 ? { draft: file.statements[0], problems: [] } : { draft: null, problems };
}

const rowHash = (row: LedgerArchiveRow): string => sha256(archiveRowIdentity(row));
const contentHash = (rows: readonly LedgerArchiveRow[]): string => sha256(rows.map((row) => `${String(row.sequence)}\u001e${archiveRowIdentity(row)}`).join("\u001d"));
const normalName = (name: string): string => name.trim().replace(/\s+/g, " ").toUpperCase();

function summaryOf(row: Row): LedgerArchiveStatementSummary {
  return {
    id: text(row.id),
    batchId: text(row.batch_id),
    partyId: text(row.party_id),
    ledgerSide: sideOf(row.ledger_side),
    balanceRule: text(row.balance_rule) === "CREDIT_LESS_DEBIT" ? "CREDIT_LESS_DEBIT" : "DEBIT_LESS_CREDIT",
    originalPartyCode: text(row.original_party_code),
    originalPartyName: text(row.original_party_name),
    periodFrom: text(row.period_from),
    periodTo: text(row.period_to),
    rowCount: Number(row.row_count),
    openingBalancePaisa: Number(row.opening_balance_paisa),
    closingBalancePaisa: Number(row.closing_balance_paisa),
    totalDebitPaisa: Number(row.total_debit_paisa),
    totalCreditPaisa: Number(row.total_credit_paisa),
    totalQuantity: Number(row.total_quantity),
    sourceFileName: text(row.source_file_name),
    sourceDocumentName: textOrNull(row.source_document_name),
    sourceDocumentHash: textOrNull(row.source_document_hash),
    importedBy: text(row.imported_by),
    importedAt: text(row.imported_at),
  };
}

function entryOf(row: Row): LedgerArchiveEntry {
  return {
    id: text(row.id),
    statementId: text(row.statement_id),
    sequence: Number(row.sequence),
    entryDate: text(row.entry_date),
    originalDateText: text(row.original_date_text),
    voucherNumber: text(row.voucher_number),
    transactionType: text(row.transaction_type),
    billNumber: text(row.bill_number),
    description: text(row.description),
    quantityText: text(row.quantity_text),
    quantity: row.quantity == null ? null : Number(row.quantity),
    debitPaisa: Number(row.debit_paisa),
    creditPaisa: Number(row.credit_paisa),
    balancePaisa: Number(row.balance_paisa),
  };
}

const importedFileOf = (row: Row | undefined): LedgerArchiveImportedFile | null =>
  row === undefined ? null : { batchId: text(row.batch_id), fileName: text(row.source_file_name), importedAt: text(row.imported_at), importedBy: text(row.imported_by) };

function checkedHeader(input: LedgerArchiveImportInput): void {
  if (!UUID.test(text(input.batchId))) throw new LedgerArchiveRefused("This import could not be identified. Nothing was saved. Try again.");
  if (!text(input.fileName).trim() || text(input.fileName).length > FILE_NAME_MAX) throw new LedgerArchiveRefused("The file's name is missing or too long. Nothing was saved.");
  if (!SHA256.test(text(input.fileHash))) throw new LedgerArchiveRefused("The file could not be identified. Choose it again. Nothing was saved.");
  if (!text(input.actor).trim()) throw new LedgerArchiveRefused("This import must name who made it. Sign in again.");
  if (!Array.isArray(input.statements) || input.statements.length === 0) throw new LedgerArchiveRefused("There is nothing to import.");
}

function checkedSource(source: LedgerArchiveSourceDocument | null | undefined): LedgerArchiveSourceDocument | null {
  if (source === null || source === undefined) return null;
  const name = text(source.name).trim();
  if (!name || name.length > FILE_NAME_MAX || !SHA256.test(text(source.hash)) || !Number.isSafeInteger(source.bytes) || source.bytes <= 0) {
    throw new LedgerArchiveRefused("The original PDF could not be identified. Attach it again. Nothing was saved.");
  }
  return { name, hash: text(source.hash), bytes: source.bytes };
}

export const ledgerArchiveMethods = {
  /** What an import of this file would do, without writing anything. */
  previewLedgerArchiveImport(this: SqliteDatabase, input: { fileHash: string; statements: readonly LedgerArchiveStatementInput[]; side?: LedgerArchiveSide }): LedgerArchivePreview {
    const side = sideOf(input.side);
    const alreadyImported = SHA256.test(text(input.fileHash))
      ? importedFileOf(this.db.prepare("SELECT batch_id, source_file_name, imported_at, imported_by FROM ledger_archive_statements WHERE source_file_hash = ? LIMIT 1").get(input.fileHash) as Row | undefined)
      : null;
    const statements = input.statements.map((statement) => this.previewArchiveStatement(statement, side));
    return { alreadyImported, statements };
  },

  /** Every statement and its rows, in one transaction: all of them, or none. */
  importLedgerArchive(this: SqliteDatabase, input: LedgerArchiveImportInput): LedgerArchiveImportResult {
    checkedHeader(input);
    const side = sideOf(input.side);
    const prepared = input.statements.map((statement) => {
      const read = readStatement(statement, side);
      if (read.draft === null) throw new LedgerArchiveRefused(`A statement has problems, so nothing was saved: ${read.problems.slice(0, 3).join(" ")}`);
      return { statement, draft: read.draft, source: checkedSource(statement.sourceDocument) };
    });
    return this.inArchiveTransaction(() => {
      const earlier = this.archiveBatch(input.batchId);
      if (earlier.length > 0) return { batchId: input.batchId, duplicate: true, statements: earlier };
      const file = importedFileOf(this.db.prepare("SELECT batch_id, source_file_name, imported_at, imported_by FROM ledger_archive_statements WHERE source_file_hash = ? LIMIT 1").get(input.fileHash) as Row | undefined);
      if (file) throw new LedgerArchiveRefused(`This file was already imported (${file.fileName}, by ${file.importedBy}). Nothing was saved.`);
      const parties = new Set<string>();
      const nowIso = new Date().toISOString();
      for (const { statement, draft, source } of prepared) {
        const partyId = this.archiveParty(text(statement.partyId), side);
        if (parties.has(partyId)) throw new LedgerArchiveRefused(`Two parties in this file are matched to the same ERP ${SIDE_WORD[side]}. Nothing was saved.`);
        parties.add(partyId);
        this.writeArchiveStatement({ input, partyId, draft, source, nowIso });
      }
      const written = this.archiveBatch(input.batchId);
      this.auditArchiveImport(input, side, written, nowIso);
      return { batchId: input.batchId, duplicate: false, statements: written };
    });
  },

  /** One customer's archived rows dated within the range, in order: by date, then statement, then original order. */
  ledgerArchiveForParty(this: SqliteDatabase, partyId: string, query: { fromDate?: string; toDate?: string } = {}): LedgerArchiveView {
    const fromDate = query.fromDate ?? "0000-01-01";
    const toDate = query.toDate ?? "9999-12-31";
    const statements = (this.db
      .prepare("SELECT * FROM ledger_archive_statements WHERE party_id = ? ORDER BY period_from, imported_at, id")
      .all(text(partyId)) as Row[]).map(summaryOf);
    const entries = (this.db
      .prepare(
        `SELECT e.* FROM ledger_archive_entries e JOIN ledger_archive_statements s ON s.id = e.statement_id
          WHERE s.party_id = ? AND e.entry_date >= ? AND e.entry_date <= ?
          ORDER BY e.entry_date, s.period_from, s.imported_at, s.id, e.sequence`
      )
      .all(text(partyId), fromDate, toDate) as Row[]).map(entryOf);
    return { statements, entries };
  },

  /** @internal One statement of a preview: its customer here, and what is already stored. */
  previewArchiveStatement(this: SqliteDatabase, statement: LedgerArchiveStatementInput, side: LedgerArchiveSide = LEDGER_ARCHIVE_SIDE.CUSTOMER): LedgerArchiveStatementPreview {
    const file = readArchiveFile(statement.rows, side);
    const draft = file.statements[0];
    const problems = [...file.rowProblems, ...(draft?.problems ?? [])].map((problem) => problem.message);
    if (file.statements.length !== 1) problems.push("A statement must hold one party's rows, and at least one row.");
    const partyCode = draft?.partyCode ?? text(statement.rows[0]?.partyCode).trim();
    const customerName = draft?.customerName ?? text(statement.rows[0]?.customerName).trim();
    const match = statement.partyId ? this.archiveMatchById(statement.partyId, side) : this.archiveMatch(partyCode, customerName, side);
    const stored = match && draft && problems.length === 0 ? this.storedArchive(match.partyId, draft.rows) : { alreadyStored: null, repeatedRows: 0 };
    return {
      partyCode,
      customerName,
      match,
      ...stored,
      totals: draft?.totals ?? { rowCount: 0, periodFrom: "", periodTo: "", openingBalancePaisa: 0, closingBalancePaisa: 0, totalDebitPaisa: 0, totalCreditPaisa: 0, totalQuantity: 0 },
      balanceRule: draft?.balanceRule ?? "DEBIT_LESS_CREDIT",
      problems,
      warnings: (draft?.warnings ?? []).map((warning) => warning.message),
    };
  },

  /** @internal The party an import names, on its side: an earlier import of this code, this ERP code, or exactly this name. */
  archiveMatch(this: SqliteDatabase, partyCode: string, customerName: string, side: LedgerArchiveSide = LEDGER_ARCHIVE_SIDE.CUSTOMER): LedgerArchiveMatch | null {
    if (partyCode) {
      const earlier = this.db
        .prepare(
          `SELECT p.id, p.party_name, p.party_code FROM ledger_archive_statements s JOIN parties p ON p.id = s.party_id
            WHERE s.original_party_code = ? AND s.ledger_side = ? AND p.deleted_at IS NULL AND p.party_type = ? ORDER BY s.imported_at DESC LIMIT 1`
        )
        .get(partyCode, side, side) as Row | undefined;
      if (earlier) return { partyId: text(earlier.id), partyName: text(earlier.party_name), partyCode: text(earlier.party_code), how: "EARLIER_IMPORT" };
      const coded = this.db.prepare("SELECT id, party_name, party_code FROM parties WHERE party_code = ? AND deleted_at IS NULL AND party_type = ?").get(partyCode, side) as Row | undefined;
      if (coded) return { partyId: text(coded.id), partyName: text(coded.party_name), partyCode: text(coded.party_code), how: "PARTY_CODE" };
    }
    if (!customerName) return null;
    const customers = this.db.prepare("SELECT id, party_name, party_code FROM parties WHERE deleted_at IS NULL AND party_type = ?").all(side) as Row[];
    const named = customers.filter((row) => normalName(text(row.party_name)) === normalName(customerName));
    // Two customers with the same name: neither is guessed.
    if (named.length !== 1) return null;
    return { partyId: text(named[0].id), partyName: text(named[0].party_name), partyCode: text(named[0].party_code), how: "NAME" };
  },

  /** @internal The party the person chose, as a match, when it is on this side. */
  archiveMatchById(this: SqliteDatabase, partyId: string, side: LedgerArchiveSide = LEDGER_ARCHIVE_SIDE.CUSTOMER): LedgerArchiveMatch | null {
    const row = this.db.prepare("SELECT id, party_name, party_code FROM parties WHERE id = ? AND deleted_at IS NULL AND party_type = ?").get(text(partyId), side) as Row | undefined;
    return row ? { partyId: text(row.id), partyName: text(row.party_name), partyCode: text(row.party_code), how: "CHOSEN" } : null;
  },

  /** @internal Whether this statement, or any of its rows, is already archived for the customer. */
  storedArchive(this: SqliteDatabase, partyId: string, rows: readonly LedgerArchiveRow[]): { alreadyStored: LedgerArchiveImportedFile | null; repeatedRows: number } {
    const alreadyStored = importedFileOf(
      this.db.prepare("SELECT batch_id, source_file_name, imported_at, imported_by FROM ledger_archive_statements WHERE party_id = ? AND content_hash = ?").get(partyId, contentHash(rows)) as Row | undefined
    );
    const held = new Set(
      (this.db.prepare("SELECT e.row_hash FROM ledger_archive_entries e JOIN ledger_archive_statements s ON s.id = e.statement_id WHERE s.party_id = ?").all(partyId) as Row[]).map((row) => text(row.row_hash))
    );
    return { alreadyStored, repeatedRows: rows.filter((row) => held.has(rowHash(row))).length };
  },

  /** @internal A live ERP party of this side, or a refusal. */
  archiveParty(this: SqliteDatabase, partyId: string, side: LedgerArchiveSide): string {
    const word = SIDE_WORD[side];
    const party = this.getParty(partyId);
    if (!party) throw new LedgerArchiveRefused(`A statement is not matched to an ERP ${word}. Choose the ${word} for every statement. Nothing was saved.`);
    if (party.partyType !== side) throw new LedgerArchiveRefused(`${party.partyName} is not a ${word}. Nothing was saved.`);
    return party.id;
  },

  /** @internal This computer's own audit trail of an import, beside the statements that travel. */
  auditArchiveImport(this: SqliteDatabase, input: LedgerArchiveImportInput, side: LedgerArchiveSide, written: readonly LedgerArchiveStatementSummary[], nowIso: string): void {
    const payload = JSON.stringify({
      actor: input.actor, side, batchId: input.batchId, fileName: input.fileName.trim(), fileHash: input.fileHash,
      statements: written.map((statement) => ({ id: statement.id, partyId: statement.partyId, rows: statement.rowCount, closingBalancePaisa: statement.closingBalancePaisa })),
    });
    this.db
      .prepare(
        `INSERT INTO audit_log (id, event_type, event_version, entity_type, entity_id, occurred_at, payload_json, hash_sha256, created_at)
         VALUES (?, 'LEDGER_ARCHIVE_IMPORTED', 1, 'LEDGER_ARCHIVE_BATCH', ?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), input.batchId, nowIso, payload, sha256(payload), nowIso);
  },

  /** @internal Writes one statement and its rows. Call ONLY inside BEGIN IMMEDIATE. */
  writeArchiveStatement(
    this: SqliteDatabase,
    args: { input: LedgerArchiveImportInput; partyId: string; draft: LedgerArchiveStatementDraft; source: LedgerArchiveSourceDocument | null; nowIso: string }
  ): void {
    const { input, partyId, draft, source, nowIso } = args;
    const stored = this.storedArchive(partyId, draft.rows);
    if (stored.alreadyStored) throw new LedgerArchiveRefused(`${draft.customerName || draft.partyCode}'s statement is already archived (${stored.alreadyStored.fileName}). Nothing was saved.`);
    if (stored.repeatedRows > 0) throw new LedgerArchiveRefused(`${String(stored.repeatedRows)} of ${draft.customerName || draft.partyCode}'s rows are already archived for this party. Nothing was saved.`);
    const statementId = crypto.randomUUID();
    const totals = draft.totals;
    const device = this.db.prepare("SELECT setting_value AS v FROM app_settings WHERE setting_key = 'device.id'").get() as Row | undefined;
    this.db
      .prepare(
        `INSERT INTO ledger_archive_statements (id, batch_id, party_id, original_party_code, original_party_name, period_from, period_to, row_count,
           opening_balance_paisa, closing_balance_paisa, total_debit_paisa, total_credit_paisa, total_quantity, content_hash,
           source_file_name, source_file_hash, source_document_name, source_document_hash, source_document_bytes, imported_by, imported_at, origin_device_id,
           ledger_side, balance_rule)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        statementId, input.batchId, partyId, draft.partyCode, draft.customerName, totals.periodFrom, totals.periodTo, totals.rowCount,
        totals.openingBalancePaisa, totals.closingBalancePaisa, totals.totalDebitPaisa, totals.totalCreditPaisa, totals.totalQuantity, contentHash(draft.rows),
        input.fileName.trim(), input.fileHash, source?.name ?? null, source?.hash ?? null, source?.bytes ?? null, input.actor, nowIso, textOrNull(device?.v),
        draft.side, draft.balanceRule
      );
    const insert = this.db.prepare(
      `INSERT INTO ledger_archive_entries (id, statement_id, sequence, entry_date, original_date_text, voucher_number, transaction_type, bill_number,
         description, quantity_text, quantity, debit_paisa, credit_paisa, balance_paisa, debit_text, credit_text, balance_text, row_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of draft.rows) {
      insert.run(
        crypto.randomUUID(), statementId, row.sequence, row.entryDate, row.dateText, row.voucherNumber, row.transactionType, row.billNumber,
        row.description, row.quantityText, row.quantity, row.debitPaisa, row.creditPaisa, row.balancePaisa, row.debitText, row.creditText, row.balanceText, rowHash(row)
      );
    }
  },

  /** @internal The statements one import batch wrote. */
  archiveBatch(this: SqliteDatabase, batchId: string): LedgerArchiveStatementSummary[] {
    return (this.db.prepare("SELECT * FROM ledger_archive_statements WHERE batch_id = ? ORDER BY original_party_name, id").all(text(batchId)) as Row[]).map(summaryOf);
  },

  /** @internal Runs `work` in one BEGIN IMMEDIATE transaction: all of it, or none. */
  inArchiveTransaction<T>(this: SqliteDatabase, work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },
};

export type LedgerArchiveMethods = typeof ledgerArchiveMethods;
