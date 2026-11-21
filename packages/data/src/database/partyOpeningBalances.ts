// PARTY OPENING BALANCES (docs/53, local migration 113): each customer's and supplier's verified closing balance from
// the previous accounting software, carried into the live ERP as where its ledger starts.
//
//   READ   getPartyOpeningBalance        a party's position now, and every posting and reversal that led to it
//   WRITE  postPartyOpeningBalance       the party's first opening balance, or a new one after a reversal
//   WRITE  reversePartyOpeningBalance    takes it out of the live balance, with a reason
//   WRITE  correctPartyOpeningBalance    a reversal and a new posting, in one transaction
//   READ   partyLedgerReconciliation     every party's archive against its opening balance, side by side
//   SQL    openingBalancePaisaSql        the one fragment every live balance adds (sales.ts, cash.ts, purchases.ts)
//
// THE ACCOUNTING TREATMENT. The ERP keeps no general ledger: a party's balance is the sum of its own documents. An
// opening balance is one more figure in that sum, in a table of its own. It writes no sale, purchase, cash voucher,
// receipt, payment, stock movement or report figure, and nothing but the party balances reads it.
//
// NEVER OVERWRITTEN. A posted amount is never updated. A mistake is reversed (a new history row, with why), and a
// correction is a reversal and a new posting together. Each write names the version it was made against, so a
// correction cannot land on a position someone else changed in the meantime. A retried write with the same request
// id finds what it already did.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import crypto from "node:crypto";
import {
  LEDGER_SIDE,
  OPENING_BALANCE_ACTION,
  OPENING_BALANCE_STATUS,
  balanceProblems,
  isLedgerArchiveSide,
  naturalDirection,
  openingBalanceProblems,
  reversalReasonProblems,
  type LedgerSide,
  type OpeningBalanceAction,
  type OpeningBalanceDirection,
  type OpeningBalanceStatus,
} from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown): string => (value == null ? "" : String(value));
const textOrNull = (value: unknown): string | null => (value == null || String(value) === "" ? null : String(value));
const trimmedOrNull = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * A party's posted opening balance in its ledger's own convention, in paisa, as a SQL expression: a customer's DEBIT
 * adds (debit-positive receivable), a supplier's CREDIT adds (credit-positive payable), the other direction
 * subtracts. `party` is the SQL naming the party's id; `dateCondition` an optional condition on ob.effective_date.
 * THE ONE PLACE a live balance learns about opening balances.
 */
export const openingBalancePaisaSql = (side: LedgerSide, party: string, dateCondition = ""): string => {
  const plus = naturalDirection(side);
  const when = dateCondition ? ` AND ${dateCondition}` : "";
  return `(SELECT COALESCE(SUM(CASE WHEN ob.direction = '${plus}' THEN ob.amount_paisa ELSE -ob.amount_paisa END), 0)
    FROM party_opening_balances ob WHERE ob.party_id = ${party} AND ob.ledger_side = '${side}' AND ob.status = 'POSTED'${when})`;
};

/** One step of a party's opening balance history, as stored. */
export interface PartyOpeningBalanceEntry {
  readonly id: string;
  readonly version: number;
  readonly action: OpeningBalanceAction;
  readonly direction: OpeningBalanceDirection;
  readonly amountPaisa: number;
  readonly effectiveDate: string;
  readonly sourceReference: string;
  readonly archiveStatementId: string | null;
  readonly note: string | null;
  readonly reason: string | null;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/** A posted opening balance. */
export interface PartyOpeningPosition {
  readonly direction: OpeningBalanceDirection;
  readonly amountPaisa: number;
  readonly effectiveDate: string;
  readonly sourceReference: string;
  readonly archiveStatementId: string | null;
}

export interface PartyOpeningBalanceView {
  readonly partyId: string;
  readonly partyName: string;
  readonly side: LedgerSide;
  readonly status: OpeningBalanceStatus;
  readonly current: PartyOpeningPosition | null;
  /** The version a reversal or correction must name. 0 when there has never been one. */
  readonly version: number;
  readonly history: readonly PartyOpeningBalanceEntry[];
  /** The earliest live document dated for this party: an opening balance dated after it may count it twice. */
  readonly firstLiveDate: string | null;
}

export interface PostOpeningBalanceInput {
  readonly requestId: string;
  readonly partyId: string;
  readonly direction: unknown;
  readonly amountPaisa: unknown;
  readonly effectiveDate: unknown;
  readonly sourceReference: unknown;
  readonly archiveStatementId?: unknown;
  readonly note?: unknown;
  /** From the session, never the screen. */
  readonly actor: string;
}

export interface ReverseOpeningBalanceInput {
  readonly requestId: string;
  readonly partyId: string;
  readonly expectedVersion: number;
  readonly reason: unknown;
  readonly actor: string;
}

export type CorrectOpeningBalanceInput = PostOpeningBalanceInput & { readonly expectedVersion: number; readonly reason: unknown };

/** A posted opening balance as one ledger row, dated when it takes effect. */
export interface OpeningBalanceLedgerRow {
  readonly id: string;
  readonly date: string;
  readonly direction: OpeningBalanceDirection;
  readonly amountPaisa: number;
  readonly reference: string;
}

/** The ledgers' voucher type for it, and the number they show. */
export const OPENING_BALANCE_ENTRY_TYPE = "OPENING_BALANCE";
export const OPENING_BALANCE_ENTRY_NUMBER = "OB";

/** A refusal the screen shows as it is: nothing was written. */
export class OpeningBalanceRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpeningBalanceRefused";
  }
}

function entryOf(row: Row): PartyOpeningBalanceEntry {
  return {
    id: text(row.id),
    version: Number(row.version),
    action: text(row.action) as OpeningBalanceAction,
    direction: text(row.direction) as OpeningBalanceDirection,
    amountPaisa: Number(row.amount_paisa),
    effectiveDate: text(row.effective_date),
    sourceReference: text(row.source_reference),
    archiveStatementId: textOrNull(row.archive_statement_id),
    note: textOrNull(row.note),
    reason: textOrNull(row.reason),
    recordedBy: text(row.recorded_by),
    recordedAt: text(row.recorded_at),
  };
}

function positionOf(root: Row | undefined): PartyOpeningPosition | null {
  if (!root || text(root.status) !== OPENING_BALANCE_STATUS.POSTED) return null;
  return {
    direction: text(root.direction) as OpeningBalanceDirection,
    amountPaisa: Number(root.amount_paisa),
    effectiveDate: text(root.effective_date),
    sourceReference: text(root.source_reference),
    archiveStatementId: textOrNull(root.archive_statement_id),
  };
}

/** The checked figures of a posting: what the domain rules accept, or a refusal naming every problem. */
function checkedPosting(input: PostOpeningBalanceInput): PartyOpeningPosition & { note: string | null } {
  const problems = openingBalanceProblems(input);
  if (problems.length > 0) throw new OpeningBalanceRefused(`Nothing was saved: ${problems.join(" ")}`);
  return {
    direction: input.direction as OpeningBalanceDirection,
    amountPaisa: input.amountPaisa as number,
    effectiveDate: input.effectiveDate as string,
    sourceReference: (input.sourceReference as string).trim(),
    archiveStatementId: trimmedOrNull(input.archiveStatementId),
    note: trimmedOrNull(input.note),
  };
}

function checkedRequest(requestId: string, actor: string): void {
  if (!UUID.test(text(requestId))) throw new OpeningBalanceRefused("This change could not be identified. Nothing was saved. Try again.");
  if (!text(actor).trim()) throw new OpeningBalanceRefused("This change must name who made it. Sign in again.");
}

const samePosition = (a: PartyOpeningPosition, b: PartyOpeningPosition): boolean =>
  a.direction === b.direction && a.amountPaisa === b.amountPaisa && a.effectiveDate === b.effectiveDate && a.sourceReference === b.sourceReference && a.archiveStatementId === b.archiveStatementId;

export const partyOpeningBalanceMethods = {
  /** A party's opening position now, with its history. Null when the party is not a live customer or supplier. */
  getPartyOpeningBalance(this: SqliteDatabase, partyId: string): PartyOpeningBalanceView | null {
    const party = this.getParty(text(partyId));
    if (!party || !isLedgerArchiveSide(party.partyType)) return null;
    const root = this.db.prepare("SELECT * FROM party_opening_balances WHERE party_id = ?").get(party.id) as Row | undefined;
    const history = root
      ? (this.db.prepare("SELECT * FROM party_opening_balance_entries WHERE opening_balance_id = ? ORDER BY version").all(text(root.id)) as Row[]).map(entryOf)
      : [];
    const current = positionOf(root);
    return {
      partyId: party.id,
      partyName: party.partyName,
      side: party.partyType,
      status: current ? OPENING_BALANCE_STATUS.POSTED : OPENING_BALANCE_STATUS.NONE,
      current,
      version: root ? Number(root.current_version) : 0,
      history,
      firstLiveDate: this.firstLiveLedgerDate(party.id, party.partyType),
    };
  },

  /** Posts a party's opening balance. Refused while one is posted: that one is corrected or reversed instead. */
  postPartyOpeningBalance(this: SqliteDatabase, input: PostOpeningBalanceInput): PartyOpeningBalanceView {
    checkedRequest(input.requestId, input.actor);
    const posting = checkedPosting(input);
    return this.inOpeningBalanceTransaction(input.partyId, input.requestId, (side, root) => {
      this.postOpeningWithin({ partyId: input.partyId, side, root, posting, requestId: input.requestId, actor: input.actor });
    });
  },

  /**
   * @internal Posts one party's opening balance. Call ONLY inside BEGIN IMMEDIATE, with the party's current record row.
   * The one way an opening balance is posted: by the dialog for one party, and by the bulk posting for many.
   */
  postOpeningWithin(
    this: SqliteDatabase,
    args: { partyId: string; side: LedgerSide; root: Row | undefined; posting: PartyOpeningPosition & { note: string | null }; requestId: string; actor: string }
  ): void {
    const { partyId, side, root, posting, requestId, actor } = args;
    if (positionOf(root)) throw new OpeningBalanceRefused("This party already has an opening balance. Correct or reverse it instead. Nothing was saved.");
    this.checkArchiveLink(partyId, side, posting.archiveStatementId);
    const id = root ? text(root.id) : this.createOpeningBalanceRoot(partyId, side, actor);
    const version = (root ? Number(root.current_version) : 0) + 1;
    this.writeOpeningBalanceEntry(id, version, OPENING_BALANCE_ACTION.POST, posting, { note: posting.note, reason: null, requestId, actor });
    this.setOpeningPosition(id, version, posting);
    this.auditOpeningBalance("PARTY_OPENING_BALANCE_POSTED", partyId, actor, { version, ...posting });
  },

  /** Takes a posted opening balance out of the live balance. The history keeps what it was, who, when and why. */
  reversePartyOpeningBalance(this: SqliteDatabase, input: ReverseOpeningBalanceInput): PartyOpeningBalanceView {
    checkedRequest(input.requestId, input.actor);
    const problems = reversalReasonProblems(input.reason);
    if (problems.length > 0) throw new OpeningBalanceRefused(`Nothing was saved: ${problems.join(" ")}`);
    const reason = text(input.reason).trim();
    return this.inOpeningBalanceTransaction(input.partyId, input.requestId, (_side, root) => {
      const current = this.postedAtVersion(root, input.expectedVersion);
      const id = text(root?.id);
      const version = input.expectedVersion + 1;
      this.writeOpeningBalanceEntry(id, version, OPENING_BALANCE_ACTION.REVERSE, current, { note: null, reason, requestId: input.requestId, actor: input.actor });
      this.setOpeningPosition(id, version, null);
      this.auditOpeningBalance("PARTY_OPENING_BALANCE_REVERSED", input.partyId, input.actor, { version, reason, reversed: current });
    });
  },

  /** Replaces a posted opening balance: its reversal and the new posting, both kept, in one transaction. */
  correctPartyOpeningBalance(this: SqliteDatabase, input: CorrectOpeningBalanceInput): PartyOpeningBalanceView {
    checkedRequest(input.requestId, input.actor);
    const posting = checkedPosting(input);
    const problems = reversalReasonProblems(input.reason);
    if (problems.length > 0) throw new OpeningBalanceRefused(`Nothing was saved: ${problems.join(" ")}`);
    const reason = text(input.reason).trim();
    return this.inOpeningBalanceTransaction(input.partyId, input.requestId, (side, root) => {
      const current = this.postedAtVersion(root, input.expectedVersion);
      if (samePosition(current, posting)) throw new OpeningBalanceRefused("The correction is the same as the opening balance already posted. Nothing was saved.");
      this.checkArchiveLink(input.partyId, side, posting.archiveStatementId);
      const id = text(root?.id);
      const step = { requestId: input.requestId, actor: input.actor };
      this.writeOpeningBalanceEntry(id, input.expectedVersion + 1, OPENING_BALANCE_ACTION.REVERSE, current, { ...step, note: null, reason });
      this.writeOpeningBalanceEntry(id, input.expectedVersion + 2, OPENING_BALANCE_ACTION.POST, posting, { ...step, note: posting.note, reason });
      this.setOpeningPosition(id, input.expectedVersion + 2, posting);
      this.auditOpeningBalance("PARTY_OPENING_BALANCE_CORRECTED", input.partyId, input.actor, { version: input.expectedVersion + 2, reason, from: current, to: posting });
    });
  },

  /**
   * What a ledger for this date range needs of the party's opening balance: the part that takes effect before the
   * range (carried into the ledger's opening figure) and the posting dated inside it (shown as a row). In the
   * side's convention, in paisa.
   */
  openingBalanceForLedger(this: SqliteDatabase, partyId: string, side: LedgerSide, fromDate: string, toDate: string): { beforePaisa: number; row: OpeningBalanceLedgerRow | null } {
    const before = this.db.prepare(`SELECT ${openingBalancePaisaSql(side, "?", "ob.effective_date < ?")} AS paisa`).get(partyId, fromDate) as Row;
    const posted = this.db
      .prepare("SELECT id, direction, amount_paisa, effective_date, source_reference FROM party_opening_balances WHERE party_id = ? AND ledger_side = ? AND status = 'POSTED' AND effective_date >= ? AND effective_date <= ?")
      .get(partyId, side, fromDate, toDate) as Row | undefined;
    const row = posted
      ? { id: text(posted.id), date: text(posted.effective_date), direction: text(posted.direction) as OpeningBalanceDirection, amountPaisa: Number(posted.amount_paisa), reference: text(posted.source_reference) }
      : null;
    return { beforePaisa: Number(before.paisa ?? 0), row };
  },

  /** @internal Runs a write for a live customer or supplier, once per request id, in one BEGIN IMMEDIATE transaction. */
  inOpeningBalanceTransaction(this: SqliteDatabase, partyId: string, requestId: string, work: (side: LedgerSide, root: Row | undefined) => void): PartyOpeningBalanceView {
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const party = this.getParty(text(partyId));
      if (!party || !isLedgerArchiveSide(party.partyType)) throw new OpeningBalanceRefused("An opening balance is for a customer or a supplier. Choose one. Nothing was saved.");
      const root = this.db.prepare("SELECT * FROM party_opening_balances WHERE party_id = ?").get(party.id) as Row | undefined;
      const done = this.db.prepare("SELECT opening_balance_id FROM party_opening_balance_entries WHERE request_id = ? LIMIT 1").get(text(requestId)) as Row | undefined;
      if (done && text(done.opening_balance_id) !== text(root?.id)) throw new OpeningBalanceRefused("This change belongs to another party. Nothing was saved.");
      // A retry after a lost answer: already done, so it is answered, not repeated.
      if (!done) work(party.partyType, root);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
    const view = this.getPartyOpeningBalance(partyId);
    if (!view) throw new OpeningBalanceRefused("The opening balance could not be read back.");
    return view;
  },

  /** @internal The posted position a reversal or correction acts on, only at the version the person saw. */
  postedAtVersion(this: SqliteDatabase, root: Row | undefined, expectedVersion: number): PartyOpeningPosition {
    const current = positionOf(root);
    if (!current || !root) throw new OpeningBalanceRefused("This party has no opening balance posted. Nothing was saved.");
    if (!Number.isSafeInteger(expectedVersion) || Number(root.current_version) !== expectedVersion) {
      throw new OpeningBalanceRefused("The opening balance was changed since you opened it. Look at it again. Nothing was saved.");
    }
    return current;
  },

  /** @internal An archived statement named as the source must be this party's, on this side. */
  checkArchiveLink(this: SqliteDatabase, partyId: string, side: LedgerSide, statementId: string | null): void {
    if (statementId === null) return;
    const row = this.db.prepare("SELECT party_id, ledger_side, withdrawn_at FROM ledger_archive_statements WHERE id = ?").get(statementId) as Row | undefined;
    if (!row || text(row.party_id) !== partyId || text(row.ledger_side) !== side || row.withdrawn_at != null) {
      throw new OpeningBalanceRefused("The archived statement named is not this party's. Nothing was saved.");
    }
  },

  /** @internal A party's opening balance record, with no position yet. Call ONLY inside BEGIN IMMEDIATE. */
  createOpeningBalanceRoot(this: SqliteDatabase, partyId: string, side: LedgerSide, actor: string): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const device = this.db.prepare("SELECT setting_value AS v FROM app_settings WHERE setting_key = 'device.id'").get() as Row | undefined;
    this.db
      .prepare(
        `INSERT INTO party_opening_balances (id, party_id, ledger_side, status, current_version, created_by, created_at, updated_at, origin_device_id)
         VALUES (?, ?, ?, 'NONE', 1, ?, ?, ?, ?)`
      )
      .run(id, partyId, side, actor, now, now, textOrNull(device?.v));
    return id;
  },

  /** @internal One history step. Call ONLY inside BEGIN IMMEDIATE. */
  writeOpeningBalanceEntry(
    this: SqliteDatabase,
    openingBalanceId: string,
    version: number,
    action: OpeningBalanceAction,
    figures: PartyOpeningPosition,
    step: { note: string | null; reason: string | null; requestId: string; actor: string }
  ): void {
    this.db
      .prepare(
        `INSERT INTO party_opening_balance_entries (id, opening_balance_id, version, action, direction, amount_paisa, effective_date, source_reference,
           archive_statement_id, note, reason, request_id, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(), openingBalanceId, version, action, figures.direction, figures.amountPaisa, figures.effectiveDate, figures.sourceReference,
        figures.archiveStatementId, step.note, step.reason, step.requestId, step.actor, new Date().toISOString()
      );
  },

  /** @internal The record's position now: posted figures, or none. Call ONLY inside BEGIN IMMEDIATE. */
  setOpeningPosition(this: SqliteDatabase, openingBalanceId: string, version: number, position: PartyOpeningPosition | null): void {
    this.db
      .prepare(
        `UPDATE party_opening_balances SET status = ?, direction = ?, amount_paisa = ?, effective_date = ?, source_reference = ?, archive_statement_id = ?,
           current_version = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        position ? OPENING_BALANCE_STATUS.POSTED : OPENING_BALANCE_STATUS.NONE,
        position?.direction ?? null, position?.amountPaisa ?? null, position?.effectiveDate ?? null,
        position?.sourceReference ?? null, position?.archiveStatementId ?? null, version, new Date().toISOString(), openingBalanceId
      );
  },

  /** @internal This computer's own audit trail of the change, beside the history that travels. */
  auditOpeningBalance(this: SqliteDatabase, eventType: string, partyId: string, actor: string, details: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const payload = JSON.stringify({ actor, ...details });
    this.db
      .prepare(
        `INSERT INTO audit_log (id, event_type, event_version, entity_type, entity_id, occurred_at, payload_json, hash_sha256, created_at)
         VALUES (?, ?, 1, 'PARTY', ?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), eventType, partyId, now, payload, crypto.createHash("sha256").update(payload).digest("hex"), now);
  },

  /** @internal The earliest live document dated for a party, on its own ledger. */
  firstLiveLedgerDate(this: SqliteDatabase, partyId: string, side: LedgerSide): string | null {
    const cash = `SELECT cv.voucher_date AS d FROM live_cash_vouchers cv WHERE cv.deleted_at IS NULL AND cv.status = 'ACTIVE'
        AND (cv.party_id = ?1 OR EXISTS (SELECT 1 FROM cash_voucher_lines l WHERE l.voucher_id = cv.id AND l.party_id = ?1))`;
    const sql = side === LEDGER_SIDE.CUSTOMER
      ? `SELECT MIN(d) AS first FROM (
           SELECT voucher_date AS d FROM live_sale_vouchers WHERE party_id = ?1 AND deleted_at IS NULL AND total_amount_paisa <> 0
           UNION ALL ${cash}
           UNION ALL SELECT return_date AS d FROM live_sale_returns WHERE party_id = ?1 AND deleted_at IS NULL AND status = 'ACTIVE')`
      : `SELECT MIN(d) AS first FROM (
           SELECT voucher_date AS d FROM purchase_vouchers WHERE party_id = ?1 AND deleted_at IS NULL AND status != 'CANCELLED'
           UNION ALL ${cash}
           UNION ALL SELECT claim_date AS d FROM party_claims WHERE party_id = ?1 AND status = 'POSTED')`;
    const row = this.db.prepare(sql).get(partyId) as Row | undefined;
    return textOrNull(row?.first);
  },

  /** @internal Archived statements' stored rows that do not follow from the row before, by statement. */
  brokenArchiveRows(this: SqliteDatabase, side: LedgerSide): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT e.statement_id, e.sequence, e.debit_paisa, e.credit_paisa, e.balance_paisa, s.balance_rule
           FROM ledger_archive_entries e JOIN ledger_archive_statements s ON s.id = e.statement_id
          WHERE s.ledger_side = ? AND s.withdrawn_at IS NULL ORDER BY e.statement_id, e.sequence`
      )
      .all(side) as Row[];
    const byStatement = new Map<string, Row[]>();
    for (const row of rows) byStatement.set(text(row.statement_id), [...(byStatement.get(text(row.statement_id)) ?? []), row]);
    const broken = new Map<string, number>();
    for (const [id, entries] of byStatement) {
      const walked = entries.map((row) => ({ rowNumber: Number(row.sequence), debitPaisa: Number(row.debit_paisa), creditPaisa: Number(row.credit_paisa), balancePaisa: Number(row.balance_paisa) }));
      const rule = text(entries[0]?.balance_rule) === "CREDIT_LESS_DEBIT" ? "CREDIT_LESS_DEBIT" : "DEBIT_LESS_CREDIT";
      broken.set(id, balanceProblems(walked, rule).length);
    }
    return broken;
  },
};

export type PartyOpeningBalanceMethods = typeof partyOpeningBalanceMethods;
