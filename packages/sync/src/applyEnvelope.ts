// The receiving side: applying one event, exactly once.
//
// Delivery is at-least-once -- an interrupted run offers an event again -- so the whole of
// exactly-once lives here. Every contract writes an insert-only row keyed by its primary key, so
// `ON CONFLICT DO NOTHING` makes a second application a no-op by construction. No ledger, no
// bookkeeping.
//
// THIS IS THE GENERAL APPLIER. What differs per event type -- reading the payload, what it depends
// on, the row it writes -- is a contract (applyContract.ts). What is the same for every type lives
// here, once:
//
//   * only INSERT is accepted, and only for a type with a registered contract
//   * the payload must say everything its contract requires, and name the envelope's aggregate id
//   * a missing prerequisite is a wait, checked before the write lock is taken
//   * the write and its follow-ups are one transaction
//   * the row is stamped with this computer's arrival time (replicated_at), while its created_at
//     stays the origin's (migration 088)
//
// TWO KINDS OF REFUSAL, and the difference matters:
//
//   PERMANENT  offering it again could never help -- an event type with no contract, a payload
//              missing a required fact, or a key that already means something else here.
//   RETRYABLE  the event is fine but something it depends on has not arrived yet.
//
// An event this code does not understand must stop visibly in the sender's dead-letter queue, not
// be written with guessed values.

import type { RegisteredContract } from "./applyContract.js";
import { productionProducedContract, productVariantContract, qrMasterContract } from "./cartonContracts.js";
import type { SyncEnvelope } from "./contract.js";
import { rawMaterialQrBatchContract, rawMaterialQrContract } from "./rawMaterialContracts.js";
import type { SyncSqlHandle } from "./sqlPort.js";

export type ApplyStatus =
  /** Written for the first time. */
  | "APPLIED"
  /** Already here. Nothing changed, and that is the correct outcome. */
  | "DUPLICATE"
  /** Refused. `permanent` says whether offering it again could ever help. */
  | "REJECTED";

export interface ApplyOutcome {
  readonly dedupeKey: string;
  readonly status: ApplyStatus;
  readonly reason?: string;
  readonly permanent?: boolean;
}

/** Every event type this computer can apply. A type that is not here is refused permanently. */
export const APPLY_CONTRACTS: readonly RegisteredContract[] = [
  productVariantContract,
  qrMasterContract,
  productionProducedContract,
  rawMaterialQrBatchContract,
  rawMaterialQrContract,
];

const contractFor = (aggregateType: string): RegisteredContract | undefined =>
  APPLY_CONTRACTS.find((contract) => contract.aggregateType === aggregateType);

const refuse = (dedupeKey: string, reason: string, permanent: boolean): ApplyOutcome => ({
  dedupeKey,
  status: "REJECTED",
  reason,
  permanent,
});

/**
 * Applies one envelope to this computer's database.
 *
 * Never throws for a bad event: a refusal is an answer the sender records. It may still throw if
 * the database itself is broken, which is a fault rather than a business outcome.
 *
 * `replicatedAt` is the arrival time written to the row. Defaults to now; a puller passes its own
 * clock so a test can fix it.
 */
export function applyEnvelope(
  sql: SyncSqlHandle,
  envelope: SyncEnvelope,
  replicatedAt: string = new Date().toISOString()
): ApplyOutcome {
  if (envelope.operation !== "INSERT") {
    return refuse(envelope.dedupeKey, `UNSUPPORTED_OPERATION:${envelope.operation}`, true);
  }
  const contract = contractFor(envelope.aggregateType);
  if (contract === undefined) {
    return refuse(envelope.dedupeKey, `UNSUPPORTED_AGGREGATE_TYPE:${envelope.aggregateType}`, true);
  }
  const arrival = contract.prepare(envelope.payload);
  if (arrival === null) return refuse(envelope.dedupeKey, "PAYLOAD_INCOMPLETE", true);
  if (arrival.id !== envelope.aggregateId) {
    return refuse(envelope.dedupeKey, "AGGREGATE_ID_MISMATCH", true);
  }

  const missing = arrival.missing(sql);
  if (missing !== null) return refuse(envelope.dedupeKey, missing, false);

  const inserted = inOneTransaction(sql, () => arrival.write(sql, replicatedAt));
  if (inserted) return { dedupeKey: envelope.dedupeKey, status: "APPLIED" };

  // Nothing inserted: usually the same event arriving twice, which at-least-once delivery
  // produces and which must be a no-op. Unless the key here already belongs to something else --
  // then it is a conflict, refused permanently and never written over.
  const conflict = arrival.conflict(sql);
  if (conflict !== null) return refuse(envelope.dedupeKey, conflict, true);
  return { dedupeKey: envelope.dedupeKey, status: "DUPLICATE" };
}

/**
 * Runs one arrival's writes as a single transaction, rolled back whole if anything fails.
 *
 * An interruption therefore leaves nothing at all, and the next pull -- whose cursor never moved
 * past an event this run did not settle -- applies the whole arrival again.
 *
 * BEGIN IMMEDIATE takes the write lock at once, and a sync pass may be running while the factory
 * is scanning, so the lock is held for the writes and nothing else: prerequisite reads happen
 * before this is called. SQLite refuses a nested BEGIN loudly, so if a caller ever wraps this in
 * a transaction of its own the mistake shows at once rather than silently.
 */
function inOneTransaction<T>(sql: SyncSqlHandle, work: () => T): T {
  sql.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    const result = work();
    sql.exec("COMMIT");
    return result;
  } catch (error) {
    sql.exec("ROLLBACK");
    throw error;
  }
}

/** Applies a batch, in the order given. Each event's outcome is independent of the others. */
export function applyEnvelopes(
  sql: SyncSqlHandle,
  envelopes: readonly SyncEnvelope[],
  replicatedAt: string = new Date().toISOString()
): ApplyOutcome[] {
  return envelopes.map((envelope) => applyEnvelope(sql, envelope, replicatedAt));
}
