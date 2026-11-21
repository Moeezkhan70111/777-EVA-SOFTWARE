import type { ArchiveBalanceRule, LedgerArchiveSide, LedgerArchiveTotals } from "@erp/domain";

// THE MAIN PROCESS'S ANSWERS ABOUT THE LEDGER ARCHIVE, CHECKED (R25). Anything that does not read as what it should
// be is a failure the screen can show, never a half-read value it trusts.

// The small readers every ledger reply here is checked with (the opening balance replies use them too).
export type Raw = Record<string, unknown>;
export const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
export const str = (value: unknown): string => (typeof value === "string" ? value : "");
export const strOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
export const int = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const sideOf = (value: unknown): LedgerArchiveSide => (value === "SUPPLIER" ? "SUPPLIER" : "CUSTOMER");
const ruleOf = (value: unknown): ArchiveBalanceRule => (value === "CREDIT_LESS_DEBIT" ? "CREDIT_LESS_DEBIT" : "DEBIT_LESS_CREDIT");

export interface ArchiveEntry {
  id: string;
  statementId: string;
  sequence: number;
  entryDate: string;
  originalDateText: string;
  voucherNumber: string;
  transactionType: string;
  billNumber: string;
  description: string;
  quantityText: string;
  quantity: number | null;
  debitPaisa: number;
  creditPaisa: number;
  balancePaisa: number;
}

export interface ArchiveStatement {
  id: string;
  batchId: string;
  ledgerSide: LedgerArchiveSide;
  /** How its printed balances run: needed to read its closing balance the right way round. */
  balanceRule: ArchiveBalanceRule;
  originalPartyCode: string;
  originalPartyName: string;
  periodFrom: string;
  periodTo: string;
  rowCount: number;
  closingBalancePaisa: number;
  sourceFileName: string;
  sourceDocumentName: string | null;
  sourceDocumentHash: string | null;
  importedBy: string;
  importedAt: string;
  /** Set once its import was withdrawn (docs/53): kept for the record, out of every ledger. */
  withdrawnAt: string | null;
  withdrawnBy: string | null;
  withdrawalReason: string | null;
}

export interface ArchiveView {
  statements: ArchiveStatement[];
  entries: ArchiveEntry[];
}

export type Reply<T> = { ok: true; value: T } | { ok: false; reason: string | null };

export const refused = (raw: unknown): { ok: false; reason: string | null } => ({ ok: false, reason: isRecord(raw) ? strOrNull(raw.reason) : null });

function readEntry(raw: unknown): ArchiveEntry | null {
  if (!isRecord(raw)) return null;
  const sequence = int(raw.sequence);
  const debitPaisa = int(raw.debitPaisa);
  const creditPaisa = int(raw.creditPaisa);
  const balancePaisa = int(raw.balancePaisa);
  const entryDate = str(raw.entryDate);
  if (!str(raw.id) || sequence === null || debitPaisa === null || creditPaisa === null || balancePaisa === null || !/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return null;
  return {
    id: str(raw.id),
    statementId: str(raw.statementId),
    sequence,
    entryDate,
    originalDateText: str(raw.originalDateText),
    voucherNumber: str(raw.voucherNumber),
    transactionType: str(raw.transactionType),
    billNumber: str(raw.billNumber),
    description: str(raw.description),
    quantityText: str(raw.quantityText),
    quantity: num(raw.quantity),
    debitPaisa,
    creditPaisa,
    balancePaisa,
  };
}

function readStatement(raw: unknown): ArchiveStatement | null {
  if (!isRecord(raw) || !str(raw.id)) return null;
  const rowCount = int(raw.rowCount);
  const closingBalancePaisa = int(raw.closingBalancePaisa);
  if (rowCount === null || closingBalancePaisa === null) return null;
  return {
    id: str(raw.id),
    batchId: str(raw.batchId),
    ledgerSide: sideOf(raw.ledgerSide),
    balanceRule: ruleOf(raw.balanceRule),
    originalPartyCode: str(raw.originalPartyCode),
    originalPartyName: str(raw.originalPartyName),
    periodFrom: str(raw.periodFrom),
    periodTo: str(raw.periodTo),
    rowCount,
    closingBalancePaisa,
    sourceFileName: str(raw.sourceFileName),
    sourceDocumentName: strOrNull(raw.sourceDocumentName),
    sourceDocumentHash: strOrNull(raw.sourceDocumentHash),
    importedBy: str(raw.importedBy),
    importedAt: str(raw.importedAt),
    withdrawnAt: strOrNull(raw.withdrawnAt),
    withdrawnBy: strOrNull(raw.withdrawnBy),
    withdrawalReason: strOrNull(raw.withdrawalReason),
  };
}

/** Every item read, or null when any one is not what it should be. */
export function readAll<T>(raw: unknown, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const items: T[] = [];
  for (const item of raw) {
    const value = read(item);
    if (value === null) return null;
    items.push(value);
  }
  return items;
}

export function readArchiveView(raw: unknown): Reply<ArchiveView> {
  if (!isRecord(raw) || raw.accepted !== true || !isRecord(raw.view)) return refused(raw);
  const statements = readAll(raw.view.statements, readStatement);
  const entries = readAll(raw.view.entries, readEntry);
  if (statements === null || entries === null) return { ok: false, reason: null };
  return { ok: true, value: { statements, entries } };
}

// ─── The import ─────────────────────────────────────────────────────────────

export type MatchHow = "EARLIER_IMPORT" | "PARTY_CODE" | "NAME" | "CHOSEN";

export interface PreviewStatement {
  /** Whose ledger it is: one import may hold customers and suppliers. */
  side: LedgerArchiveSide;
  /** This statement's own file was already imported. */
  fileAlreadyImported: { fileName: string; importedBy: string } | null;
  partyCode: string;
  customerName: string;
  match: { partyId: string; partyName: string; partyCode: string; how: MatchHow } | null;
  alreadyStored: { fileName: string } | null;
  repeatedRows: number;
  totals: LedgerArchiveTotals;
  balanceRule: ArchiveBalanceRule;
  problems: string[];
  warnings: string[];
}

export interface ImportPreview {
  alreadyImported: { fileName: string; importedBy: string } | null;
  statements: PreviewStatement[];
}

const HOWS: ReadonlySet<string> = new Set(["EARLIER_IMPORT", "PARTY_CODE", "NAME", "CHOSEN"]);
const texts = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : []);

function readTotals(raw: unknown): LedgerArchiveTotals | null {
  if (!isRecord(raw)) return null;
  const fields = ["rowCount", "openingBalancePaisa", "closingBalancePaisa", "totalDebitPaisa", "totalCreditPaisa"] as const;
  const values = fields.map((field) => int(raw[field]));
  const totalQuantity = num(raw.totalQuantity);
  if (values.some((value) => value === null) || totalQuantity === null) return null;
  const [rowCount, openingBalancePaisa, closingBalancePaisa, totalDebitPaisa, totalCreditPaisa] = values as number[];
  return { rowCount, openingBalancePaisa, closingBalancePaisa, totalDebitPaisa, totalCreditPaisa, totalQuantity, periodFrom: str(raw.periodFrom), periodTo: str(raw.periodTo) };
}

function readMatch(raw: unknown): PreviewStatement["match"] {
  if (!isRecord(raw) || !str(raw.partyId) || !HOWS.has(str(raw.how))) return null;
  return { partyId: str(raw.partyId), partyName: str(raw.partyName), partyCode: str(raw.partyCode), how: str(raw.how) as MatchHow };
}

function readPreviewStatement(raw: unknown): PreviewStatement | null {
  if (!isRecord(raw)) return null;
  const totals = readTotals(raw.totals);
  const repeatedRows = int(raw.repeatedRows);
  if (totals === null || repeatedRows === null) return null;
  const file = raw.fileAlreadyImported;
  return {
    side: sideOf(raw.side),
    fileAlreadyImported: isRecord(file) ? { fileName: str(file.fileName), importedBy: str(file.importedBy) } : null,
    partyCode: str(raw.partyCode),
    customerName: str(raw.customerName),
    match: readMatch(raw.match),
    alreadyStored: isRecord(raw.alreadyStored) ? { fileName: str(raw.alreadyStored.fileName) } : null,
    repeatedRows,
    totals,
    balanceRule: ruleOf(raw.balanceRule),
    problems: texts(raw.problems),
    warnings: texts(raw.warnings),
  };
}

export function readImportPreview(raw: unknown): Reply<ImportPreview> {
  if (!isRecord(raw) || raw.accepted !== true || !isRecord(raw.preview)) return refused(raw);
  const statements = readAll(raw.preview.statements, readPreviewStatement);
  if (statements === null) return { ok: false, reason: null };
  const file = raw.preview.alreadyImported;
  const alreadyImported = isRecord(file) ? { fileName: str(file.fileName), importedBy: str(file.importedBy) } : null;
  return { ok: true, value: { alreadyImported, statements } };
}

export interface ImportOutcome {
  duplicate: boolean;
  statements: number;
  rows: number;
}

export function readImportOutcome(raw: unknown): Reply<ImportOutcome> {
  if (!isRecord(raw) || raw.accepted !== true || !isRecord(raw.result)) return refused(raw);
  const statements = readAll(raw.result.statements, readStatement);
  if (statements === null) return { ok: false, reason: null };
  return { ok: true, value: { duplicate: raw.result.duplicate === true, statements: statements.length, rows: statements.reduce((sum, statement) => sum + statement.rowCount, 0) } };
}

export interface SourceDocument {
  name: string;
  hash: string;
  bytes: number;
}

export function readSourceDocument(raw: unknown): Reply<SourceDocument> {
  if (!isRecord(raw) || raw.accepted !== true || !isRecord(raw.source)) return refused(raw);
  const bytes = int(raw.source.bytes);
  const hash = str(raw.source.hash);
  if (bytes === null || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: null };
  return { ok: true, value: { name: str(raw.source.name), hash, bytes } };
}

/** Every statement one import wrote, for the withdrawal dialog. */
export function readArchiveBatch(raw: unknown): Reply<ArchiveStatement[]> {
  if (!isRecord(raw) || raw.accepted !== true) return refused(raw);
  const statements = readAll(raw.statements, readStatement);
  return statements === null ? { ok: false, reason: null } : { ok: true, value: statements };
}

export interface WithdrawOutcome {
  duplicate: boolean;
  statements: number;
}

export function readWithdrawOutcome(raw: unknown): Reply<WithdrawOutcome> {
  if (!isRecord(raw) || raw.accepted !== true || !isRecord(raw.result)) return refused(raw);
  const statements = readAll(raw.result.statements, readStatement);
  if (statements === null || statements.some((statement) => statement.withdrawnAt === null)) return { ok: false, reason: null };
  return { ok: true, value: { duplicate: raw.result.duplicate === true, statements: statements.length } };
}

/** An answer that is only accepted or refused. */
export function readPlainReply(raw: unknown): Reply<true> {
  return isRecord(raw) && raw.accepted === true ? { ok: true, value: true } : refused(raw);
}
