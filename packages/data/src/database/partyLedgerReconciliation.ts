// LEDGER RECONCILIATION (docs/53): for every customer or supplier with an archived ledger or an opening balance, the
// archive's opening, debits, credits and closing beside the opening balance posted in the ERP, and the difference.
//
// READ ONLY. Nothing here adjusts, posts or corrects anything: a difference is shown, never closed. The archive's
// figures are checked again from its stored rows (every running balance follows from the one before it), so a
// statement damaged after import would show here too.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import {
  LEDGER_SIDE,
  OPENING_BALANCE_STATUS,
  toPaisa,
  reconcilePartyLedger,
  type ArchiveBalanceRule,
  type LedgerSide,
  type OpeningBalanceDirection,
  type PartyReconciliation,
  type ReconciliationStatementInput,
} from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import { archiveStatementShownSql } from "./ledgerArchive.js";

type Row = Record<string, unknown>;
const text = (value: unknown): string => (value == null ? "" : String(value));

export interface PartyReconciliationRow extends PartyReconciliation {
  readonly partyId: string;
  readonly partyName: string;
  readonly partyCode: string;
  /** What the old software called this party, from its latest statement. */
  readonly originalPartyCode: string;
  readonly openingEffectiveDate: string | null;
  /** The party's live balance now, opening balance included, in its ledger's convention. Null for an inactive party, which the balance lists leave out. */
  readonly liveBalancePaisa: number | null;
}

export interface PartyReconciliationReport {
  readonly side: LedgerSide;
  readonly rows: readonly PartyReconciliationRow[];
}

/** Each party's live balance now, in paisa, from the balance list itself: one formula, never a second copy. */
function liveBalances(db: SqliteDatabase, side: LedgerSide): Map<string, number> {
  const list = side === LEDGER_SIDE.CUSTOMER ? db.listCustomerBalances() : db.listSupplierBalances();
  return new Map(list.rows.map((row) => [row.partyId, toPaisa(row.balance)]));
}

export const partyLedgerReconciliationMethods = {
  /** Every party on this side with an archive or an opening balance, reconciled. Parties with neither are left out. */
  partyLedgerReconciliation(this: SqliteDatabase, side: LedgerSide): PartyReconciliationReport {
    const parties = this.db
      .prepare(
        `SELECT p.id, p.party_name, p.party_code
           FROM parties p
          WHERE p.deleted_at IS NULL AND p.party_type = ?1
            AND (EXISTS (SELECT 1 FROM ledger_archive_statements s WHERE s.party_id = p.id AND s.ledger_side = ?1 AND ${archiveStatementShownSql("s")})
                 OR EXISTS (SELECT 1 FROM party_opening_balances ob WHERE ob.party_id = p.id AND ob.ledger_side = ?1 AND ob.status = 'POSTED'))
          ORDER BY p.party_name, p.id`
      )
      .all(side) as Row[];
    const broken = this.brokenArchiveRows(side);
    const live = liveBalances(this, side);
    const statements = this.db
      .prepare(`SELECT * FROM ledger_archive_statements s WHERE s.ledger_side = ? AND ${archiveStatementShownSql("s")} ORDER BY s.party_id, s.period_from, s.imported_at`)
      .all(side) as Row[];
    const openings = this.db.prepare("SELECT * FROM party_opening_balances WHERE ledger_side = ? AND status = ?").all(side, OPENING_BALANCE_STATUS.POSTED) as Row[];
    const rows = parties.map((party) => {
      const id = text(party.id);
      const own = statements.filter((row) => text(row.party_id) === id);
      const opening = openings.find((row) => text(row.party_id) === id);
      const reconciliation = reconcilePartyLedger({
        side,
        statements: own.map((row): ReconciliationStatementInput => ({
          periodFrom: text(row.period_from),
          periodTo: text(row.period_to),
          openingBalancePaisa: Number(row.opening_balance_paisa),
          closingBalancePaisa: Number(row.closing_balance_paisa),
          totalDebitPaisa: Number(row.total_debit_paisa),
          totalCreditPaisa: Number(row.total_credit_paisa),
          balanceRule: text(row.balance_rule) as ArchiveBalanceRule,
          brokenRows: broken.get(text(row.id)) ?? 0,
        })),
        opening: opening ? { direction: text(opening.direction) as OpeningBalanceDirection, amountPaisa: Number(opening.amount_paisa), effectiveDate: text(opening.effective_date) } : null,
      });
      return {
        ...reconciliation,
        partyId: id,
        partyName: text(party.party_name),
        partyCode: text(party.party_code),
        originalPartyCode: text(own[own.length - 1]?.original_party_code),
        openingEffectiveDate: opening ? text(opening.effective_date) : null,
        liveBalancePaisa: live.get(id) ?? null,
      };
    });
    return { side, rows };
  },
};

export type PartyLedgerReconciliationMethods = typeof partyLedgerReconciliationMethods;
