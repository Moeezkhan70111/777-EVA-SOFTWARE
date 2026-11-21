// BULK OPENING BALANCES AT A CUTOVER DATE (docs/53).
//
//   READ   previewBulkOpeningBalances  for every customer or supplier with an archive: what its opening balance would be
//                                      on the cutover date, or why it is left out
//   WRITE  postBulkOpeningBalances     posts the chosen proposals, all in one transaction, exactly as previewed
//
// THE FIGURE. The opening balance on the cutover date (the first day the ERP holds the party's live entries) is the
// balance the old software PRINTED on the last archived line dated before it, read the side's way: what the customer
// owes, or what we owe the supplier. Nothing is added up again. Archived lines dated on or after the cutover are not
// counted: the ERP's own entries should hold those, and the preview says how many there are.
//
// NOTHING IS GUESSED. The cutover date is the administrator's, given every time: there is no default. A party is left out,
// with the reason, when it already has an opening balance, when its archive does not add up, when no archived line comes
// before the cutover, or when that balance is zero.
//
// EXACTLY AS PREVIEWED, ONCE. The post names, for every party, the direction, amount and statement it saw. Each is worked
// out again inside the transaction, and one that differs refuses the whole post. Each party's posting carries a request
// id derived from the post's, so a retry finds what it wrote and posts nothing twice. The posting itself is the one way
// an opening balance is ever posted (partyOpeningBalances.ts, postOpeningWithin): audited, never overwritten.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import crypto from "node:crypto";
import {
  archiveBalanceAtCutover,
  isIsoDay,
  isLedgerArchiveSide,
  isOpeningBalanceDirection,
  openingFromSideBalance,
  type ArchiveBalancePoint,
  type ArchiveBalanceRule,
  type LedgerSide,
  type OpeningBalanceDirection,
} from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import { OpeningBalanceRefused } from "./partyOpeningBalances.js";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PARTIES = 5000;
const text = (value: unknown): string => (value == null ? "" : String(value));
const rupees = (paisa: number): string => (paisa / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });

export interface BulkOpeningProposal {
  readonly partyId: string;
  readonly partyName: string;
  readonly partyCode: string;
  readonly originalPartyCode: string;
  readonly status: "READY" | "SKIP";
  readonly skipReason: string | null;
  readonly direction: OpeningBalanceDirection | null;
  readonly amountPaisa: number | null;
  /** In the side's convention: receivable (customer) or payable (supplier) positive. */
  readonly sidePaisa: number | null;
  readonly archiveStatementId: string | null;
  /** The archived line the balance was read from. */
  readonly balanceAsOf: string | null;
  readonly linesOnOrAfterCutover: number;
  readonly firstLiveDate: string | null;
  readonly warnings: readonly string[];
}

export interface BulkOpeningPreview {
  readonly side: LedgerSide;
  readonly cutoverDate: string;
  readonly proposals: readonly BulkOpeningProposal[];
}

export interface BulkOpeningPostInput {
  readonly requestId: string;
  readonly side: unknown;
  readonly cutoverDate: unknown;
  /** What the administrator saw and chose, party by party. */
  readonly expected: ReadonlyArray<{ readonly partyId: unknown; readonly direction: unknown; readonly amountPaisa: unknown; readonly archiveStatementId: unknown }>;
  /** From the session, never the screen. */
  readonly actor: string;
}

export interface BulkOpeningPostResult {
  /** True when this post had already been written: answered, not repeated. */
  readonly duplicate: boolean;
  readonly posted: number;
  readonly partyIds: readonly string[];
}

/** One party's request id within a bulk post: derived, so a retry of the post finds every one it wrote. */
export const bulkPartyRequestId = (requestId: string, partyId: string): string => {
  const hex = crypto.createHash("sha256").update(`${requestId}:${partyId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

function checkedPost(input: BulkOpeningPostInput): { side: LedgerSide; cutover: string; expected: Array<{ partyId: string; direction: OpeningBalanceDirection; amountPaisa: number; archiveStatementId: string }> } {
  if (!UUID.test(text(input.requestId))) throw new OpeningBalanceRefused("This posting could not be identified. Nothing was saved. Try again.");
  if (!text(input.actor).trim()) throw new OpeningBalanceRefused("This posting must name who made it. Sign in again.");
  if (!isLedgerArchiveSide(input.side)) throw new OpeningBalanceRefused("Say whether these are customers or suppliers. Nothing was saved.");
  if (!isIsoDay(input.cutoverDate)) throw new OpeningBalanceRefused("Choose the cutover date. Nothing was saved.");
  if (!Array.isArray(input.expected) || input.expected.length === 0) throw new OpeningBalanceRefused("Choose at least one party. Nothing was saved.");
  if (input.expected.length > MAX_PARTIES) throw new OpeningBalanceRefused(`At most ${String(MAX_PARTIES)} parties may be posted at once. Nothing was saved.`);
  const expected = input.expected.map((item) => {
    const amount = item.amountPaisa;
    if (typeof item.partyId !== "string" || !isOpeningBalanceDirection(item.direction) || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 || typeof item.archiveStatementId !== "string") {
      throw new OpeningBalanceRefused("A chosen party's figures could not be read. Preview again. Nothing was saved.");
    }
    return { partyId: item.partyId, direction: item.direction, amountPaisa: amount, archiveStatementId: item.archiveStatementId };
  });
  if (new Set(expected.map((item) => item.partyId)).size !== expected.length) throw new OpeningBalanceRefused("A party is chosen twice. Nothing was saved.");
  return { side: input.side, cutover: input.cutoverDate, expected };
}

export const bulkOpeningBalanceMethods = {
  /** Every party on this side with an archive in force: its opening balance at the cutover, or why it is left out. */
  previewBulkOpeningBalances(this: SqliteDatabase, side: LedgerSide, cutoverDate: string): BulkOpeningPreview {
    if (!isLedgerArchiveSide(side)) throw new OpeningBalanceRefused("Say whether these are customers or suppliers.");
    if (!isIsoDay(cutoverDate)) throw new OpeningBalanceRefused("Choose the cutover date: the first day the ERP holds these parties' live entries.");
    const reconciliation = new Map(this.partyLedgerReconciliation(side).rows.map((row) => [row.partyId, row]));
    const proposals = [...reconciliation.values()]
      .filter((row) => row.statementCount > 0)
      .map((row) => this.bulkProposal(side, cutoverDate, row.partyId, { consistent: row.archiveConsistent, name: row.partyName, code: row.partyCode, oldCode: row.originalPartyCode }));
    return { side, cutoverDate, proposals };
  },

  /** Posts the chosen proposals exactly as previewed, all or none. */
  postBulkOpeningBalances(this: SqliteDatabase, input: BulkOpeningPostInput): BulkOpeningPostResult {
    const { side, cutover, expected } = checkedPost(input);
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const result = this.postBulkWithin(input.requestId, side, cutover, expected, input.actor);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  /** @internal The bulk post's body. Call ONLY inside BEGIN IMMEDIATE. */
  postBulkWithin(
    this: SqliteDatabase,
    requestId: string,
    side: LedgerSide,
    cutover: string,
    expected: ReadonlyArray<{ partyId: string; direction: OpeningBalanceDirection; amountPaisa: number; archiveStatementId: string }>,
    actor: string
  ): BulkOpeningPostResult {
    const ids = expected.map((item) => bulkPartyRequestId(requestId, item.partyId));
    const written = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM party_opening_balance_entries WHERE request_id IN (${ids.map(() => "?").join(", ")})`).get(...ids) as Row).n);
    if (written === ids.length) return { duplicate: true, posted: 0, partyIds: expected.map((item) => item.partyId) };
    if (written > 0) throw new OpeningBalanceRefused("Part of this posting is already recorded under the same request. Preview again. Nothing was saved.");
    const proposals = new Map(this.previewBulkOpeningBalances(side, cutover).proposals.map((p) => [p.partyId, p]));
    for (const item of expected) {
      const now = proposals.get(item.partyId);
      if (!now || now.status !== "READY" || now.direction !== item.direction || now.amountPaisa !== item.amountPaisa || now.archiveStatementId !== item.archiveStatementId) {
        throw new OpeningBalanceRefused(`${now?.partyName ?? "A party"}'s opening balance is not what was previewed any more${now?.skipReason ? ` (${now.skipReason})` : ""}. Preview again. Nothing was saved.`);
      }
    }
    for (const item of expected) {
      const proposal = proposals.get(item.partyId);
      const root = this.db.prepare("SELECT * FROM party_opening_balances WHERE party_id = ?").get(item.partyId) as Row | undefined;
      this.postOpeningWithin({
        partyId: item.partyId, side, root, actor, requestId: bulkPartyRequestId(requestId, item.partyId),
        posting: {
          direction: item.direction, amountPaisa: item.amountPaisa, effectiveDate: cutover, archiveStatementId: item.archiveStatementId,
          sourceReference: `Old software ledger ${proposal?.originalPartyCode ?? ""}, balance on ${proposal?.balanceAsOf ?? ""}`.trim(),
          note: `Bulk opening balance at cutover ${cutover}`,
        },
      });
    }
    const now = new Date().toISOString();
    const payload = JSON.stringify({ actor, side, requestId, cutover, parties: expected });
    this.db
      .prepare(
        `INSERT INTO audit_log (id, event_type, event_version, entity_type, entity_id, occurred_at, payload_json, hash_sha256, created_at)
         VALUES (?, 'PARTY_OPENING_BALANCES_BULK_POSTED', 1, 'OPENING_BALANCE_BULK', ?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), requestId, now, payload, crypto.createHash("sha256").update(payload).digest("hex"), now);
    return { duplicate: false, posted: expected.length, partyIds: expected.map((item) => item.partyId) };
  },

  /** @internal One party's proposal. */
  bulkProposal(this: SqliteDatabase, side: LedgerSide, cutover: string, partyId: string, about: { consistent: boolean; name: string; code: string; oldCode: string }): BulkOpeningProposal {
    const base = { partyId, partyName: about.name, partyCode: about.code, originalPartyCode: about.oldCode, firstLiveDate: this.firstLiveLedgerDate(partyId, side) };
    const skip = (skipReason: string, extra: Partial<BulkOpeningProposal> = {}): BulkOpeningProposal => ({
      ...base, status: "SKIP", skipReason, direction: null, amountPaisa: null, sidePaisa: null, archiveStatementId: null, balanceAsOf: null, linesOnOrAfterCutover: 0, warnings: [], ...extra,
    });
    const posted = this.db.prepare("SELECT amount_paisa, effective_date FROM party_opening_balances WHERE party_id = ? AND status = 'POSTED'").get(partyId) as Row | undefined;
    if (posted) return skip(`Already has an opening balance (Rs ${rupees(Number(posted.amount_paisa))} from ${text(posted.effective_date)}). Correct it on the party's ledger if it is wrong.`);
    if (!about.consistent) return skip("Its archive does not add up. See the reconciliation.");
    const at = archiveBalanceAtCutover(side, this.archivePoints(partyId, side), cutover);
    if (!at) return skip(`No archived line is dated before ${cutover}.`);
    const position = openingFromSideBalance(side, at.sidePaisa);
    if (!position) return skip(`The archived balance on ${at.asOf} is zero: there is nothing to post.`, { sidePaisa: 0, balanceAsOf: at.asOf, linesOnOrAfterCutover: at.linesOnOrAfterCutover });
    const warnings: string[] = [];
    if (at.linesOnOrAfterCutover > 0) warnings.push(`${String(at.linesOnOrAfterCutover)} archived line(s) are dated on or after ${cutover}. They are not counted: the ERP's own entries should hold them.`);
    if (base.firstLiveDate && base.firstLiveDate < cutover) warnings.push(`Live ERP entries start on ${base.firstLiveDate}, before the cutover. The old balance may already include them.`);
    return { ...base, status: "READY", skipReason: null, ...position, sidePaisa: at.sidePaisa, archiveStatementId: at.statementId, balanceAsOf: at.asOf, linesOnOrAfterCutover: at.linesOnOrAfterCutover, warnings };
  },

  /** @internal A party's archived balances in force, in archive order. */
  archivePoints(this: SqliteDatabase, partyId: string, side: LedgerSide): ArchiveBalancePoint[] {
    return (this.db
      .prepare(
        `SELECT s.id AS statement_id, s.balance_rule, e.entry_date, e.balance_paisa
           FROM ledger_archive_entries e JOIN ledger_archive_statements s ON s.id = e.statement_id
          WHERE s.party_id = ? AND s.ledger_side = ? AND s.withdrawn_at IS NULL
          ORDER BY e.entry_date, s.period_from, s.imported_at, s.id, e.sequence`
      )
      .all(partyId, side) as Row[]).map((row) => {
      const balanceRule: ArchiveBalanceRule = text(row.balance_rule) === "CREDIT_LESS_DEBIT" ? "CREDIT_LESS_DEBIT" : "DEBIT_LESS_CREDIT";
      return { statementId: text(row.statement_id), entryDate: text(row.entry_date), balancePaisa: Number(row.balance_paisa), balanceRule };
    });
  },
};

export type BulkOpeningBalanceMethods = typeof bulkOpeningBalanceMethods;
