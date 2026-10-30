// WHAT ONE KIND OF EVENT NEEDS TO SAY SO THE APPLIER CAN WRITE IT.
//
// The applier (applyEnvelope.ts) is general: it validates the envelope, finds the contract for its
// aggregate type, and owns the transaction and the arrival stamp. A contract is the part that is
// genuinely different per event -- how to read its payload, what it depends on, and the row it
// writes. Nothing else.
//
// Keeping the shared rules in one engine is the point. Every contract used to repeat them, and
// the one that forgot the transaction (production, before it was fixed) could lose a pointer for
// good. A contract written against this shape cannot forget: it is never given the chance to.

import type { SyncAggregateType } from "@erp/data";
import { asRow, type SyncSqlHandle } from "./sqlPort.js";

/**
 * One aggregate type's rules for arriving on this computer.
 *
 * P is the payload as the contract's reader returns it. The reader comes from @erp/data wherever
 * the sender's contract lives there, so a sender and a receiver cannot drift apart.
 */
export interface ApplyContract<P> {
  readonly aggregateType: SyncAggregateType;
  /**
   * The table this contract writes. Checked against @erp/data's REPLICATION_EXCLUSIONS by test,
   * so no contract can ever write a table that must stay per-computer.
   */
  readonly table: string;
  /** Reads the payload off the wire, or returns null. Nothing is defaulted (R25). */
  readonly read: (payload: Record<string, unknown>) => P | null;
  /** The id the payload describes. Must equal the envelope's aggregateId. */
  readonly idOf: (payload: P) => string;
  /**
   * The first thing this row needs that this computer has not got, as a reason, or null.
   *
   * A missing prerequisite is a WAIT, never a refusal: the event is sound and what it needs is
   * still on its way, or will be created by the owner. Runs outside the transaction, so the write
   * lock is not held while reading.
   */
  readonly missing: (sql: SyncSqlHandle, payload: P) => string | null;
  /**
   * Writes the row, and any follow-up that belongs to the same arrival. Returns true when a row
   * was inserted, false when it was already here.
   *
   * Always called inside the applier's transaction, so a follow-up can never be committed without
   * its row or the other way round. Must be idempotent by primary key (ON CONFLICT DO NOTHING).
   *
   * `replicatedAt` is this computer's UTC arrival time, for the row's replicated_at column. The
   * row's created_at is ALWAYS the origin's, taken from the payload (migration 088).
   */
  readonly write: (sql: SyncSqlHandle, payload: P, replicatedAt: string) => boolean;
  /**
   * Called only when `write` inserted nothing. Says whether what is already here is a DIFFERENT
   * identity under the same key, as a reason, or null when it is genuinely the same event again.
   *
   * WHY THIS EXISTS. `ON CONFLICT DO NOTHING` cannot tell "this arrived twice" from "this id
   * already means something else here". Where an identity can be re-issued -- a raw-material
   * label run erased and its serials printed again -- the second case is real, and treating it
   * as a duplicate would keep the old packet silently and move stock by the wrong quantity on
   * every scan. A conflict is a permanent refusal: visible, and never written over.
   *
   * Omitted for contracts whose key can never be re-issued.
   */
  readonly conflict?: (sql: SyncSqlHandle, payload: P) => string | null;
}

/**
 * Thrown by a contract's write when the database itself says the record must wait: a deletion of a
 * record still in use here, or a name another record here still holds. The applier rolls the write
 * back and parks the event (a wait, never a refusal); it applies once the other record's change
 * arrives. Anything else a write throws is still a fault.
 */
export class ApplyMustWait extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ApplyMustWait";
  }
}

/** A payload that has been read and is ready to check and write. */
export interface PreparedArrival {
  readonly id: string;
  readonly missing: (sql: SyncSqlHandle) => string | null;
  readonly write: (sql: SyncSqlHandle, replicatedAt: string) => boolean;
  readonly conflict: (sql: SyncSqlHandle) => string | null;
}

/** A contract with its payload type closed over, so contracts of every type sit in one list. */
export interface RegisteredContract {
  readonly aggregateType: SyncAggregateType;
  readonly table: string;
  /** Null when the payload does not say what the contract requires. */
  readonly prepare: (payload: Record<string, unknown>) => PreparedArrival | null;
}

export function defineContract<P>(contract: ApplyContract<P>): RegisteredContract {
  return {
    aggregateType: contract.aggregateType,
    table: contract.table,
    prepare: (payload) => {
      const read = contract.read(payload);
      if (read === null) return null;
      return {
        id: contract.idOf(read),
        missing: (sql) => contract.missing(sql, read),
        write: (sql, replicatedAt) => contract.write(sql, read, replicatedAt),
        conflict: (sql) => (contract.conflict === undefined ? null : contract.conflict(sql, read)),
      };
    },
  };
}

/** True when the query finds a row. The SQL is always a literal in a contract, never a caller's. */
export const rowExists = (sql: SyncSqlHandle, select: string, id: string): boolean =>
  asRow(sql.prepare(select).get(id)) !== null;
