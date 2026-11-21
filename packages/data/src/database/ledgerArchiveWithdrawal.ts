// WITHDRAWING AN IMPORTED OLD-LEDGER BATCH (docs/53, local migration 114).
//
//   READ   getLedgerArchiveBatch       every statement one import wrote, withdrawn or not
//   WRITE  withdrawLedgerArchiveBatch  marks the whole batch withdrawn: who, when, why, under which request
//
// NOTHING IS ERASED. Every row stays exactly as it was imported. A withdrawn statement is only left out: of the ledger
// screens, the reconciliation, the duplicate checks and the opening-balance proposals, so a corrected file can be
// imported again. The archive is not accounting, so no balance, cash, stock or voucher moves.
//
// IT DOES NOT BREAK THE RECONCILIATION. While an opening balance that was checked against one of the batch's statements
// is posted, the withdrawal is refused, naming the parties: reverse or correct that opening balance first.
//
// The withdrawal travels as a new revision of each LEDGER_ARCHIVE_STATEMENT record (masterCapture marks the update).
// The caller has checked the person is an administrator and that this computer holds the ACCOUNTS lease.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import crypto from "node:crypto";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import { LedgerArchiveRefused, type LedgerArchiveStatementSummary } from "./ledgerArchive.js";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_MAX = 500;
const text = (value: unknown): string => (value == null ? "" : String(value));

export interface WithdrawArchiveBatchInput {
  readonly requestId: string;
  readonly batchId: string;
  readonly reason: unknown;
  /** From the session, never the screen. */
  readonly actor: string;
}

export interface WithdrawArchiveBatchResult {
  readonly batchId: string;
  /** True when this request had already withdrawn it: answered, not repeated. */
  readonly duplicate: boolean;
  readonly statements: readonly LedgerArchiveStatementSummary[];
}

function checked(input: WithdrawArchiveBatchInput): string {
  if (!UUID.test(text(input.requestId))) throw new LedgerArchiveRefused("This withdrawal could not be identified. Nothing was changed. Try again.");
  if (!UUID.test(text(input.batchId))) throw new LedgerArchiveRefused("Choose the import to withdraw. Nothing was changed.");
  if (!text(input.actor).trim()) throw new LedgerArchiveRefused("A withdrawal must name who made it. Sign in again.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new LedgerArchiveRefused("Say why this import is being withdrawn. Nothing was changed.");
  if (reason.length > REASON_MAX) throw new LedgerArchiveRefused(`The reason is longer than ${String(REASON_MAX)} characters. Nothing was changed.`);
  return reason;
}

export const ledgerArchiveWithdrawalMethods = {
  /** Every statement one import wrote, withdrawn or not, for the withdrawal dialog and the record. */
  getLedgerArchiveBatch(this: SqliteDatabase, batchId: string): LedgerArchiveStatementSummary[] {
    return this.archiveBatch(text(batchId));
  },

  /** Withdraws every statement of one import batch, in one transaction. Retried with the same request id: answered. */
  withdrawLedgerArchiveBatch(this: SqliteDatabase, input: WithdrawArchiveBatchInput): WithdrawArchiveBatchResult {
    const reason = checked(input);
    return this.inArchiveTransaction(() => {
      const rows = this.db.prepare("SELECT id, party_id, withdrawn_at, withdrawn_by, withdrawal_request_id FROM ledger_archive_statements WHERE batch_id = ?").all(input.batchId) as Row[];
      if (rows.length === 0) throw new LedgerArchiveRefused("That import is not on this computer. Nothing was changed.");
      if (rows.every((row) => text(row.withdrawal_request_id) === input.requestId)) {
        return { batchId: input.batchId, duplicate: true, statements: this.archiveBatch(input.batchId) };
      }
      const already = rows.find((row) => row.withdrawn_at != null);
      if (already) throw new LedgerArchiveRefused(`This import was already withdrawn by ${text(already.withdrawn_by)} on ${text(already.withdrawn_at).slice(0, 10)}. Nothing was changed.`);
      this.refuseWhileOpeningBalancesNameIt(input.batchId);
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE ledger_archive_statements SET withdrawn_at = ?, withdrawn_by = ?, withdrawal_reason = ?, withdrawal_request_id = ? WHERE batch_id = ? AND withdrawn_at IS NULL")
        .run(now, input.actor, reason, input.requestId, input.batchId);
      const statements = this.archiveBatch(input.batchId);
      const payload = JSON.stringify({ actor: input.actor, reason, batchId: input.batchId, statements: statements.map((s) => ({ id: s.id, partyId: s.partyId, rows: s.rowCount, side: s.ledgerSide })) });
      this.db
        .prepare(
          `INSERT INTO audit_log (id, event_type, event_version, entity_type, entity_id, occurred_at, payload_json, hash_sha256, created_at)
           VALUES (?, 'LEDGER_ARCHIVE_WITHDRAWN', 1, 'LEDGER_ARCHIVE_BATCH', ?, ?, ?, ?, ?)`
        )
        .run(crypto.randomUUID(), input.batchId, now, payload, crypto.createHash("sha256").update(payload).digest("hex"), now);
      return { batchId: input.batchId, duplicate: false, statements };
    });
  },

  /** @internal Refuses while a posted opening balance was checked against one of the batch's statements. */
  refuseWhileOpeningBalancesNameIt(this: SqliteDatabase, batchId: string): void {
    const named = this.db
      .prepare(
        `SELECT p.party_name FROM party_opening_balances ob
           JOIN ledger_archive_statements s ON s.id = ob.archive_statement_id
           JOIN parties p ON p.id = ob.party_id
          WHERE s.batch_id = ? AND ob.status = 'POSTED' ORDER BY p.party_name`
      )
      .all(batchId) as Row[];
    if (named.length > 0) {
      const names = named.map((row) => text(row.party_name));
      throw new LedgerArchiveRefused(`Opening balances checked against this import are still posted for ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${String(names.length - 5)} more` : ""}. Reverse or correct them first. Nothing was changed.`);
    }
  },
};

export type LedgerArchiveWithdrawalMethods = typeof ledgerArchiveWithdrawalMethods;
