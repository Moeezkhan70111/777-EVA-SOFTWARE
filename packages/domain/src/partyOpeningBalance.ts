// PARTY OPENING BALANCES (docs/53): each customer's and supplier's verified closing balance from the previous
// accounting software, carried into the live ERP as where its ledger starts.
//
// THE ACCOUNTING TREATMENT. The ERP keeps no general ledger: a party's balance is the sum of its own documents
// (sale vouchers, cash vouchers, returns; purchases, payments, claims). An opening balance is one more figure in that
// sum, kept in a table of its own. In double entry its other side is opening-balance equity, which the ERP does not
// hold, so it creates NO sale, purchase, cash voucher, receipt, payment, stock movement or report figure. It
// moves only the party's balance.
//
// DIRECTION, never a bare sign. A customer's balance is debit-positive (they owe us: debit). A supplier's balance is
// credit-positive (we owe them: credit). An opening balance stores its direction and a positive amount, and each
// ledger reads it in its own convention: a customer DEBIT adds, CREDIT (an advance) subtracts. A supplier CREDIT
// adds, DEBIT (we paid ahead) subtracts.
//
// ONE PER PARTY. A party has at most one opening position. It is never edited: a mistake is REVERSED (with a
// reason, by whom, when), and a correction is a reversal and a new posting together. Every step is kept.
//
// Pure: the data layer and the screens read these rules alike.

import { LEDGER_ARCHIVE_SIDE, archiveBalanceForSide, archiveRowMovement, type ArchiveBalanceRule, type LedgerArchiveSide } from "./ledgerArchive.js";

/** The two ledgers an opening balance can open: the party's type. */
export type LedgerSide = LedgerArchiveSide;
export const LEDGER_SIDE = LEDGER_ARCHIVE_SIDE;

export const OPENING_BALANCE_DIRECTION = { DEBIT: "DEBIT", CREDIT: "CREDIT" } as const;
export type OpeningBalanceDirection = (typeof OPENING_BALANCE_DIRECTION)[keyof typeof OPENING_BALANCE_DIRECTION];

/** What one step in an opening balance's history did. */
export const OPENING_BALANCE_ACTION = { POST: "POST", REVERSE: "REVERSE" } as const;
export type OpeningBalanceAction = (typeof OPENING_BALANCE_ACTION)[keyof typeof OPENING_BALANCE_ACTION];

/** Whether a party's opening balance counts. NONE: never posted, or reversed and not posted again. */
export const OPENING_BALANCE_STATUS = { POSTED: "POSTED", NONE: "NONE" } as const;
export type OpeningBalanceStatus = (typeof OPENING_BALANCE_STATUS)[keyof typeof OPENING_BALANCE_STATUS];

export const OPENING_BALANCE_LIMITS = {
  REFERENCE_MAX: 200,
  NOTE_MAX: 500,
  REASON_MAX: 500,
  /** Rs 10,000,000,000: far above any party's balance, and far inside a safe integer. */
  MAX_PAISA: 1_000_000_000_000,
} as const;

export const isOpeningBalanceDirection = (value: unknown): value is OpeningBalanceDirection =>
  value === OPENING_BALANCE_DIRECTION.DEBIT || value === OPENING_BALANCE_DIRECTION.CREDIT;

/** The direction that means "the party's normal balance": a customer owes us, we owe a supplier. */
export const naturalDirection = (side: LedgerSide): OpeningBalanceDirection =>
  side === LEDGER_SIDE.CUSTOMER ? OPENING_BALANCE_DIRECTION.DEBIT : OPENING_BALANCE_DIRECTION.CREDIT;

/** An opening balance in its ledger's own convention: positive is receivable (customer) or payable (supplier). */
export const openingBalanceForSide = (side: LedgerSide, direction: OpeningBalanceDirection, amountPaisa: number): number =>
  direction === naturalDirection(side) ? amountPaisa : -amountPaisa;

/** A balance in its ledger's own convention, as a direction and a positive amount. Zero has no direction. */
export function openingFromSideBalance(side: LedgerSide, sidePaisa: number): { direction: OpeningBalanceDirection; amountPaisa: number } | null {
  if (!Number.isSafeInteger(sidePaisa) || sidePaisa === 0) return null;
  const natural = naturalDirection(side);
  const other = natural === OPENING_BALANCE_DIRECTION.DEBIT ? OPENING_BALANCE_DIRECTION.CREDIT : OPENING_BALANCE_DIRECTION.DEBIT;
  return { direction: sidePaisa > 0 ? natural : other, amountPaisa: Math.abs(sidePaisa) };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isRealDay = (value: string): boolean => {
  if (!ISO_DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export interface OpeningBalanceDraft {
  readonly direction: unknown;
  readonly amountPaisa: unknown;
  readonly effectiveDate: unknown;
  readonly sourceReference: unknown;
  readonly note?: unknown;
}

/** What is wrong with an opening balance before it is posted, said so the person can fix it. Empty when nothing. */
export function openingBalanceProblems(draft: OpeningBalanceDraft): string[] {
  const problems: string[] = [];
  if (!isOpeningBalanceDirection(draft.direction)) problems.push("Choose whether the balance is a debit or a credit.");
  const amount = draft.amountPaisa;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) problems.push("Enter an amount above zero, in rupees and paisa.");
  else if (amount > OPENING_BALANCE_LIMITS.MAX_PAISA) problems.push("The amount is larger than any balance this ledger accepts.");
  if (typeof draft.effectiveDate !== "string" || !isRealDay(draft.effectiveDate)) problems.push("Enter the date the balance takes effect.");
  const reference = typeof draft.sourceReference === "string" ? draft.sourceReference.trim() : "";
  if (!reference) problems.push("Say where the figure comes from, for example the old ledger and the date it was closed.");
  if (reference.length > OPENING_BALANCE_LIMITS.REFERENCE_MAX) problems.push(`The source is longer than ${String(OPENING_BALANCE_LIMITS.REFERENCE_MAX)} characters.`);
  const note = typeof draft.note === "string" ? draft.note.trim() : "";
  if (note.length > OPENING_BALANCE_LIMITS.NOTE_MAX) problems.push(`The note is longer than ${String(OPENING_BALANCE_LIMITS.NOTE_MAX)} characters.`);
  return problems;
}

/** What is wrong with a reversal's reason. Empty when nothing. */
export function reversalReasonProblems(reason: unknown): string[] {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) return ["Say why the opening balance is being reversed."];
  if (text.length > OPENING_BALANCE_LIMITS.REASON_MAX) return [`The reason is longer than ${String(OPENING_BALANCE_LIMITS.REASON_MAX)} characters.`];
  return [];
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

export const RECONCILIATION_STATUS = {
  /** The opening balance is the archive's last printed balance. */
  MATCHED: "MATCHED",
  /** Both exist and differ. */
  DIFFERENT: "DIFFERENT",
  /** An archive, but no opening balance posted. */
  NO_OPENING_BALANCE: "NO_OPENING_BALANCE",
  /** An opening balance, but no archive to check it against. */
  NO_ARCHIVE: "NO_ARCHIVE",
  /** The archive's own figures do not add up, so nothing can be compared with it. */
  ARCHIVE_BROKEN: "ARCHIVE_BROKEN",
} as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUS)[keyof typeof RECONCILIATION_STATUS];

/** One archived statement, as stored, with how many of its stored rows do not follow from the row before. */
export interface ReconciliationStatementInput {
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly openingBalancePaisa: number;
  readonly closingBalancePaisa: number;
  readonly totalDebitPaisa: number;
  readonly totalCreditPaisa: number;
  readonly balanceRule: ArchiveBalanceRule;
  readonly brokenRows: number;
}

export interface ReconciliationOpeningInput {
  readonly direction: OpeningBalanceDirection;
  readonly amountPaisa: number;
  readonly effectiveDate: string;
}

export interface PartyReconciliation {
  readonly status: ReconciliationStatus;
  readonly statementCount: number;
  /** In the side's convention: positive is receivable (customer) or payable (supplier). Null without an archive. */
  readonly archiveOpeningPaisa: number | null;
  readonly archiveDebitPaisa: number;
  readonly archiveCreditPaisa: number;
  readonly archiveClosingPaisa: number | null;
  readonly archiveTo: string | null;
  /** Every stored row follows from the one before, every statement's totals add up, and statements join up. */
  readonly archiveConsistent: boolean;
  readonly openingPaisa: number | null;
  /** The opening balance less the archive's closing balance. Null unless both exist. */
  readonly differencePaisa: number | null;
  readonly notes: readonly string[];
}

/** The statement's own figures add up: opening, moved by its debits and credits, is its closing. */
const totalsAddUp = (statement: ReconciliationStatementInput): boolean =>
  statement.openingBalancePaisa + archiveRowMovement({ debitPaisa: statement.totalDebitPaisa, creditPaisa: statement.totalCreditPaisa }, statement.balanceRule) ===
  statement.closingBalancePaisa;

function archiveNotes(side: LedgerSide, statements: readonly ReconciliationStatementInput[]): string[] {
  const notes: string[] = [];
  const broken = statements.reduce((sum, statement) => sum + statement.brokenRows, 0);
  if (broken > 0) notes.push(`${String(broken)} archived ${broken === 1 ? "row does" : "rows do"} not follow from the row before.`);
  if (statements.some((statement) => !totalsAddUp(statement))) notes.push("An archived statement's opening, debits and credits do not add up to its closing.");
  for (let index = 1; index < statements.length; index += 1) {
    const before = statements[index - 1];
    const next = statements[index];
    const closing = archiveBalanceForSide(before.closingBalancePaisa, side, before.balanceRule);
    const opening = archiveBalanceForSide(next.openingBalancePaisa, side, next.balanceRule);
    if (closing !== opening) notes.push(`The statement from ${next.periodFrom} does not open at the balance the one before it closed at.`);
  }
  return notes;
}

/**
 * How a party's posted opening balance compares with its archived statements: their opening, debits, credits and
 * closing, whether their rows and totals hold together, and the difference. Nothing is adjusted to make them agree.
 */
export function reconcilePartyLedger(input: { side: LedgerSide; statements: readonly ReconciliationStatementInput[]; opening: ReconciliationOpeningInput | null }): PartyReconciliation {
  const statements = [...input.statements].sort((a, b) => (a.periodFrom === b.periodFrom ? a.periodTo.localeCompare(b.periodTo) : a.periodFrom.localeCompare(b.periodFrom)));
  const first = statements[0];
  const last = statements[statements.length - 1];
  const archiveProblems = archiveNotes(input.side, statements);
  const notes = [...archiveProblems];
  const openingPaisa = input.opening ? openingBalanceForSide(input.side, input.opening.direction, input.opening.amountPaisa) : null;
  const archiveClosingPaisa = last ? archiveBalanceForSide(last.closingBalancePaisa, input.side, last.balanceRule) : null;
  if (input.opening && last && input.opening.effectiveDate <= last.periodTo) {
    notes.push(`The archive has rows dated on or after the opening balance's date (${input.opening.effectiveDate}).`);
  }
  const consistent = archiveProblems.length === 0;
  const differencePaisa = openingPaisa !== null && archiveClosingPaisa !== null ? openingPaisa - archiveClosingPaisa : null;
  let status: ReconciliationStatus;
  if (!last) status = RECONCILIATION_STATUS.NO_ARCHIVE;
  else if (!consistent) status = RECONCILIATION_STATUS.ARCHIVE_BROKEN;
  else if (openingPaisa === null) status = RECONCILIATION_STATUS.NO_OPENING_BALANCE;
  else status = differencePaisa === 0 ? RECONCILIATION_STATUS.MATCHED : RECONCILIATION_STATUS.DIFFERENT;
  return {
    status,
    statementCount: statements.length,
    archiveOpeningPaisa: first ? archiveBalanceForSide(first.openingBalancePaisa, input.side, first.balanceRule) : null,
    archiveDebitPaisa: statements.reduce((sum, statement) => sum + statement.totalDebitPaisa, 0),
    archiveCreditPaisa: statements.reduce((sum, statement) => sum + statement.totalCreditPaisa, 0),
    archiveClosingPaisa,
    archiveTo: last ? last.periodTo : null,
    archiveConsistent: consistent,
    openingPaisa,
    differencePaisa,
    notes,
  };
}

