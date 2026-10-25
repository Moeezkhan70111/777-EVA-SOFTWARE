// The sending side: putting an event in the outbox, claiming a batch, and settling what happened.
//
// Everything here works on `sync_outbox`, which the local schema already defines. The rules it
// keeps are the ones that make offline work safe:
//
//   * Enqueueing is part of the local write and can never fail it. A repeat is ignored, not
//     refused, so the UNIQUE dedupe key cannot turn a legitimate business save into an error.
//   * A claimed row is marked IN_FLIGHT with a lock token. If the application stops between the
//     claim and the answer, `reclaimStale` puts it back — delivery is at-least-once, and the
//     receiver is what makes it exactly-once.
//   * A failure is retried with a growing delay, and a failure the receiver calls permanent goes
//     straight to DEAD_LETTER where it can be seen, instead of being retried for ever.
//   * Nothing is ever deleted here. A sent row keeps its history.

import { LEASED_AGGREGATE_DOMAIN, SYNC_AGGREGATE, enqueueQrMaster, type QrMasterPayload } from "@erp/data";
import { QR_MASTER_OPENING_STATE, type SyncEnvelope } from "./contract.js";
import { asRow, changedRows, type SqlValue, type SyncSqlHandle } from "./sqlPort.js";

export type OutboxStatus = "PENDING" | "IN_FLIGHT" | "FAILED" | "DEAD_LETTER" | "SYNCED";

/**
 * Why an event did not go through. The difference decides whether it can ever be parked.
 *
 *   TRANSIENT  it never reached the service, or the service was in no state to answer: a
 *              network error, a timeout, a rate limit, a 5xx, an answer nobody can classify.
 *              The event is fine. Retried for ever, with a widening but capped wait.
 *   REFUSED    the service looked at it and said no, for a reason it named: a missing product,
 *              a policy that forbids it. Retried a bounded number of times, then parked where an
 *              operator can see it, because retrying will not change the answer by itself.
 *   PERMANENT  it could never be accepted by anything: an unreadable payload, an event type with
 *              no contract. Parked at once.
 *
 * Getting this wrong in the safe direction costs a few wasted requests. Getting it wrong the
 * other way parks a real carton and stops sending it, with nothing in the application to notice.
 */
export type FailureKind = "TRANSIENT" | "REFUSED" | "PERMANENT";

export interface OutboxRetryPolicy {
  /** REFUSED attempts after which a row is parked in DEAD_LETTER. Never applies to TRANSIENT. */
  readonly maxAttempts: number;
  /** The first retry delay in milliseconds. It doubles per attempt. */
  readonly baseBackoffMs: number;
  /** The longest a retry is ever delayed. Stops a long outage backing off into next week. */
  readonly maxBackoffMs: number;
  /** A row left IN_FLIGHT longer than this is treated as abandoned and claimed again. */
  readonly staleInFlightMs: number;
}

export const DEFAULT_RETRY_POLICY: OutboxRetryPolicy = {
  maxAttempts: 5,
  baseBackoffMs: 30_000,
  maxBackoffMs: 900_000,
  staleInFlightMs: 120_000,
};

/** Doubling, capped, and never negative. */
const backoffFor = (attempt: number, policy: OutboxRetryPolicy): number =>
  Math.min(policy.baseBackoffMs * 2 ** Math.max(0, attempt - 1), policy.maxBackoffMs);

const plusMs = (iso: string, ms: number): string => new Date(new Date(iso).getTime() + ms).toISOString();

// ─── Putting an event in ────────────────────────────────────────────────────

/**
 * Records one carton QR's identity for sending.
 *
 * A thin alias kept for callers written against it. The writer itself is @erp/data's
 * enqueueQrMaster, which lives beside the qr_master insert it accompanies, so sender and
 * receiver share one definition of the payload. The nowIso argument is ignored: the event is
 * stamped with the identity's own createdAt, which is the same value.
 */
export function enqueueQrMasterInsert(
  sql: SyncSqlHandle,
  input: { identity: QrMasterPayload; originDeviceId: string; outboxId: string },
  nowIso: string
): boolean {
  void nowIso;
  return enqueueQrMaster(sql, input.identity, input.outboxId);
}

// ─── Claiming a batch ───────────────────────────────────────────────────────

interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  operation: string;
  dedupe_key: string;
  payload_json: string;
  lease_epoch: number | bigint | null;
  attempts: number;
  transient_attempts: number;
  created_at: string;
}

/**
 * LEASED WORK WITH NO LEASE EPOCH IS NOT SENDABLE. Such a row was queued before this computer knew
 * its lease, or while it ran standalone (migration 093). Sent as it is, the cloud would refuse every
 * one NOT_LEASE_HOLDER and the queue would walk them into the dead letters, which looks exactly like
 * losing them. So it is never claimed, never offered and never counted as pushable: it waits,
 * PENDING, for the backfill to decide it (docs/37 section 3.1, RM backfill).
 */
const LEASED_TYPES: readonly string[] = Object.keys(LEASED_AGGREGATE_DOMAIN);
const STAMPED_IF_LEASED = ` AND NOT (aggregate_type IN (${LEASED_TYPES.map(() => "?").join(", ")}) AND lease_epoch IS NULL)`;

export interface LeasedEvent {
  readonly outboxId: string;
  readonly envelope: SyncEnvelope;
  /** Refusals so far. Bounded. */
  readonly attempts: number;
  /** Undeliverable tries so far. Unbounded, and only widens the wait. */
  readonly transientAttempts: number;
}

/**
 * Claims up to `limit` rows that are due, marking them IN_FLIGHT under `lockToken`.
 *
 * Rows whose payload cannot be read are parked in DEAD_LETTER rather than returned: a row that
 * cannot be turned into an envelope will never succeed, and retrying it would block the queue.
 */
export function leaseBatch(
  sql: SyncSqlHandle,
  options: {
    limit: number;
    nowIso: string;
    lockToken: string;
    deviceId: string;
    /**
     * Only claim these aggregate types. Left out, everything due is claimed.
     *
     * This is how an event the transport cannot carry yet stays safe: it is never claimed, so it
     * is never offered, never refused, never retried and never parked. It simply waits as PENDING
     * for the slice that can send it. Refusing it instead would walk it up the attempt limit and
     * into the dead-letter queue, which looks exactly like losing it.
     */
    aggregateTypes?: readonly string[];
  }
): LeasedEvent[] {
  // PREREQUISITES ARE CLAIMED BEFORE WHAT NEEDS THEM, which is why the ORDER BY below sorts by
  // aggregate type ahead of created_at rather than after it. Three tiers:
  //
  //   0  PRODUCT_VARIANT  -- a carton of an unknown product is refused UNKNOWN_PRODUCT_VARIANT
  //   1  QR_MASTER        -- a scan of an unregistered carton is refused QR_NOT_REGISTERED_YET
  //      RAW_MATERIAL_QR_BATCH -- a packet of an unregistered run is refused RUN_NOT_REGISTERED_YET
  //   2  everything else
  //
  // So a variant travels in the same call as its carton, or an earlier one, and the carton in
  // the same call as its scan, or an earlier one. The chain is variant -> carton -> scan, and
  // each link is only ever ahead of the next.
  //
  // push_production_produced refuses a scan whose carton the cloud has not got yet
  // (QR_NOT_REGISTERED_YET). Within one call that cannot happen -- send() offers cartons first --
  // but the LEASE is what decides which rows share a call, and it is capped at batchSize. Ordered
  // purely by created_at, a busy day puts 100 scans in this batch and their cartons in the next,
  // so every scan is refused for a carton that is sitting one batch behind it. Each refusal is
  // bounded, so five passes park perfectly good work.
  //
  // Sorting identities first makes the carton travel in the same call as its scan, or in an
  // earlier one. It cannot reorder anything that matters: qr_master rows are insert-only and
  // independent of each other, and a scan still follows its own carton.
  const wanted = options.aggregateTypes;
  if (wanted !== undefined && wanted.length === 0) return [];
  // Values are bound, never interpolated: only the number of placeholders depends on the input.
  const typeFilter = wanted === undefined ? "" : ` AND aggregate_type IN (${wanted.map(() => "?").join(", ")})`;
  const typeValues: SqlValue[] = wanted === undefined ? [] : [...wanted];
  sql
    .prepare(
      `UPDATE sync_outbox
          SET status = 'IN_FLIGHT', lock_token = ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM sync_outbox
           WHERE status IN ('PENDING', 'FAILED')
             AND available_at <= ?${typeFilter}${STAMPED_IF_LEASED}
           ORDER BY CASE aggregate_type WHEN ? THEN 0 WHEN ? THEN 1 WHEN ? THEN 1 ELSE 2 END ASC,
                    created_at ASC, rowid ASC
           LIMIT ?
        )`
    )
    .run(
      options.lockToken,
      options.nowIso,
      options.nowIso,
      ...typeValues,
      ...LEASED_TYPES,
      SYNC_AGGREGATE.PRODUCT_VARIANT,
      SYNC_AGGREGATE.QR_MASTER,
      SYNC_AGGREGATE.RAW_MATERIAL_QR_BATCH,
      options.limit
    );

  const rows = sql
    .prepare(
      `SELECT id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json, lease_epoch, attempts, transient_attempts, created_at
         FROM sync_outbox
        WHERE status = 'IN_FLIGHT' AND lock_token = ?
        ORDER BY created_at ASC, rowid ASC`
    )
    .all(options.lockToken) as OutboxRow[];

  const leased: LeasedEvent[] = [];
  for (const row of rows) {
    const payload = parsePayload(row.payload_json);
    if (payload === null) {
      deadLetter(sql, row.id, "PAYLOAD_UNREADABLE", options.nowIso);
      continue;
    }
    leased.push({
      outboxId: row.id,
      attempts: Number(row.attempts),
      transientAttempts: Number(row.transient_attempts),
      envelope: {
        dedupeKey: row.dedupe_key,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        operation: row.operation === "UPDATE" ? "UPDATE" : "INSERT",
        payload,
        originDeviceId: options.deviceId,
        createdAt: row.created_at,
        leaseEpoch: row.lease_epoch === null ? null : Number(row.lease_epoch),
      },
    });
  }
  return leased;
}

function parsePayload(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return asRow(parsed);
  } catch {
    return null;
  }
}

/**
 * Returns rows abandoned mid-flight to PENDING. This is what makes an interrupted run safe: the
 * application may have stopped after the receiver applied an event but before the answer was
 * recorded, so the event is simply offered again and the receiver recognises it.
 */
export function reclaimStale(
  sql: SyncSqlHandle,
  options: { nowIso: string; staleInFlightMs: number }
): number {
  const cutoff = plusMs(options.nowIso, -options.staleInFlightMs);
  const result = sql
    .prepare(
      `UPDATE sync_outbox
          SET status = 'PENDING', lock_token = NULL, available_at = ?, updated_at = ?
        WHERE status = 'IN_FLIGHT' AND updated_at <= ?`
    )
    .run(options.nowIso, options.nowIso, cutoff);
  return changedRows(result);
}

// ─── Settling ───────────────────────────────────────────────────────────────

export function markSynced(sql: SyncSqlHandle, outboxId: string, nowIso: string): void {
  sql
    .prepare(
      `UPDATE sync_outbox
          SET status = 'SYNCED', lock_token = NULL, last_error = NULL, transient_attempts = 0, updated_at = ?
        WHERE id = ?`
    )
    .run(nowIso, outboxId);
}

/**
 * Records a failure. A permanent one is parked immediately; a temporary one waits a doubling
 * delay and is offered again until the attempt limit, after which it is parked too.
 */
export function markFailed(
  sql: SyncSqlHandle,
  input: {
    outboxId: string;
    /** How many times the service has REFUSED this event so far. */
    attempts: number;
    /** How many times it could not be delivered at all so far. */
    transientAttempts: number;
    error: string;
    kind: FailureKind;
  },
  nowIso: string,
  policy: OutboxRetryPolicy = DEFAULT_RETRY_POLICY
): OutboxStatus {
  if (input.kind === "PERMANENT") {
    deadLetter(sql, input.outboxId, input.error, nowIso, input.attempts + 1);
    return "DEAD_LETTER";
  }

  if (input.kind === "TRANSIENT") {
    // NEVER parked. The event is good and the service simply could not be reached, so the only
    // thing that changes is how long to wait — widening, then capped, so a long outage settles
    // into a steady retry rather than backing off into next week or hammering the connection.
    const transientAttempts = input.transientAttempts + 1;
    sql
      .prepare(
        `UPDATE sync_outbox
            SET status = 'FAILED', lock_token = NULL, transient_attempts = ?, last_error = ?,
                available_at = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(
        transientAttempts,
        input.error,
        plusMs(nowIso, backoffFor(transientAttempts, policy)),
        nowIso,
        input.outboxId
      );
    return "FAILED";
  }

  // REFUSED: the service answered, and said no for a reason. Bounded, because retrying cannot
  // change that answer on its own — an operator has to do something.
  const attempts = input.attempts + 1;
  if (attempts >= policy.maxAttempts) {
    deadLetter(sql, input.outboxId, input.error, nowIso, attempts);
    return "DEAD_LETTER";
  }
  sql
    .prepare(
      `UPDATE sync_outbox
          SET status = 'FAILED', lock_token = NULL, attempts = ?, last_error = ?,
              available_at = ?, updated_at = ?
        WHERE id = ?`
    )
    .run(attempts, input.error, plusMs(nowIso, backoffFor(attempts, policy)), nowIso, input.outboxId);
  return "FAILED";
}

/**
 * Parks a row where it can be seen. Two statements rather than one built from a condition: every
 * value is bound, and no part of this SQL is assembled at run time.
 */
function deadLetter(sql: SyncSqlHandle, outboxId: string, error: string, nowIso: string, attempts?: number): void {
  if (attempts === undefined) {
    sql
      .prepare(
        `UPDATE sync_outbox
            SET status = 'DEAD_LETTER', lock_token = NULL, last_error = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(error, nowIso, outboxId);
    return;
  }
  sql
    .prepare(
      `UPDATE sync_outbox
          SET status = 'DEAD_LETTER', lock_token = NULL, last_error = ?, updated_at = ?, attempts = ?
        WHERE id = ?`
    )
    .run(error, nowIso, Math.trunc(attempts), outboxId);
}

// ─── Looking at the queue ───────────────────────────────────────────────────

export type OutboxCounts = Record<OutboxStatus, number>;

/** How much is waiting, in flight, failing or parked. The number an operator needs to see. */
export function outboxCounts(sql: SyncSqlHandle): OutboxCounts {
  const counts: OutboxCounts = { PENDING: 0, IN_FLIGHT: 0, FAILED: 0, DEAD_LETTER: 0, SYNCED: 0 };
  const rows = sql.prepare("SELECT status, COUNT(*) AS n FROM sync_outbox GROUP BY status").all() as Array<{
    status: string;
    n: number;
  }>;
  for (const row of rows) {
    if (row.status in counts) counts[row.status as OutboxStatus] = Number(row.n);
  }
  return counts;
}

// ─── What is actually waiting, and what could actually go ──────────────────
//
// `outboxCounts` partitions the queue by STATUS, which is the whole story only while everything
// in the queue can be sent. It cannot: four of the six aggregate types have no transport yet, so
// a PENDING count mixes cartons that will go on the next pass with dispatch and store events
// that will not go for months. An operator reading "14 pending" cannot tell which they have.
//
// This adds the second view — by SENDABILITY — and takes the predicate from the same place the
// drain does, so "what a pass would claim right now" cannot drift from what it actually claims.

export interface OutboxSummary {
  /** By status. These five partition the whole queue. */
  readonly counts: OutboxCounts;
  /** Unsent, sendable, and due: exactly what the next pass would claim. */
  readonly pushableNow: number;
  /** Unsent and sendable, but waiting out a backoff. It will go, later. */
  readonly pushableWaiting: number;
  /** Unsent, and no transport can carry it yet. Never claimed, never parked, waiting for a
   *  contract rather than for the network. */
  readonly notPushable: number;
  /** When this computer last sent something, or null if it never has. Not "when sync last ran":
   *  a pass that pushed nothing leaves no trace, and nothing here invents one. */
  readonly lastSyncedAt: string | null;
  /** When a row last failed or was parked, or null. Likewise not an attempt timestamp. */
  readonly lastFailureAt: string | null;
}

/** 0 when the query found nothing, which is the right answer for every count here. */
function scalar(sql: SyncSqlHandle, statement: string, params: SqlValue[]): number {
  const row = asRow(sql.prepare(statement).get(...params));
  if (row === null) return 0;
  const value = Object.values(row)[0];
  return value === null || value === undefined ? 0 : Number(value);
}

function timestamp(sql: SyncSqlHandle, statement: string): string | null {
  const row = asRow(sql.prepare(statement).get());
  if (row === null) return null;
  const value = Object.values(row)[0];
  return value === null || value === undefined ? null : String(value);
}

/**
 * The queue as an operator needs to read it. Pure SELECTs: nothing here claims, settles, retries
 * or changes a row, so it is safe to call from a status screen as often as it likes.
 *
 * `pushableTypes` is the transport's own list (SUPABASE_PUSHABLE_AGGREGATES). An empty list means
 * nothing can be sent at all, and every unsent row counts as notPushable.
 */
export function outboxSummary(
  sql: SyncSqlHandle,
  options: { pushableTypes: readonly string[]; nowIso: string }
): OutboxSummary {
  const counts = outboxCounts(sql);
  const types = [...options.pushableTypes];
  // Values are bound, never interpolated: only the number of placeholders depends on the input.
  const placeholders = types.map(() => "?").join(", ");

  const unsent = "status IN ('PENDING', 'FAILED')";
  const pushableNow =
    types.length === 0
      ? 0
      : scalar(
          sql,
          `SELECT COUNT(*) AS n FROM sync_outbox
            WHERE ${unsent} AND aggregate_type IN (${placeholders}) AND available_at <= ?${STAMPED_IF_LEASED}`,
          [...types, options.nowIso, ...LEASED_TYPES]
        );
  const pushableTotal =
    types.length === 0
      ? 0
      : scalar(
          sql,
          `SELECT COUNT(*) AS n FROM sync_outbox
            WHERE ${unsent} AND aggregate_type IN (${placeholders})${STAMPED_IF_LEASED}`,
          [...types, ...LEASED_TYPES]
        );
  const unsentTotal = scalar(sql, `SELECT COUNT(*) AS n FROM sync_outbox WHERE ${unsent}`, []);

  return {
    counts,
    pushableNow,
    pushableWaiting: pushableTotal - pushableNow,
    notPushable: unsentTotal - pushableTotal,
    lastSyncedAt: timestamp(
      sql,
      "SELECT MAX(updated_at) AS at FROM sync_outbox WHERE status = 'SYNCED'"
    ),
    lastFailureAt: timestamp(
      sql,
      "SELECT MAX(updated_at) AS at FROM sync_outbox WHERE status IN ('FAILED', 'DEAD_LETTER')"
    ),
  };
}

/**
 * One parked row, with enough to identify it and decide what to do about it.
 *
 * THE PAYLOAD IS NOT HERE, and that is the redaction: a production scan's payload carries the
 * operator, the station and every article/colour/size snapshot, and none of it is needed to
 * answer "what stopped, why, and how often did it try". `aggregateId` is the carton QR or the
 * event id — the identification an operator needs, and nothing more.
 */
export interface DeadLetterEntry {
  readonly outboxId: string;
  readonly dedupeKey: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Refusals the service answered with. This is the count that parked the row. */
  readonly attempts: number;
  /** Failures to reach the service at all. Never parks anything; shown because it explains delay. */
  readonly transientAttempts: number;
  readonly error: string;
  readonly createdAt: string;
  /** When it was parked. */
  readonly updatedAt: string;
}

/** The parked rows, with the reason each stopped. Nothing is retried silently for ever. */
export function deadLetters(sql: SyncSqlHandle): DeadLetterEntry[] {
  const rows = sql
    .prepare(
      `SELECT id, dedupe_key, aggregate_type, aggregate_id, attempts, transient_attempts,
              last_error, created_at, updated_at
         FROM sync_outbox
        WHERE status = 'DEAD_LETTER'
        ORDER BY updated_at ASC`
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    outboxId: String(row.id ?? ""),
    dedupeKey: String(row.dedupe_key ?? ""),
    aggregateType: String(row.aggregate_type ?? ""),
    aggregateId: String(row.aggregate_id ?? ""),
    attempts: Number(row.attempts ?? 0),
    transientAttempts: Number(row.transient_attempts ?? 0),
    error: row.last_error === null || row.last_error === undefined ? "" : String(row.last_error),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  }));
}

// ─── Bringing one parked row back ───────────────────────────────────────────
//
// A row reaches DEAD_LETTER because the service refused it the agreed number of times — a
// product the cloud does not have yet, a device that was not enrolled. Those are conditions
// someone fixes, and until this existed nothing in the application could offer the event again:
// `dedupe_key` is UNIQUE and every enqueue is ON CONFLICT DO NOTHING, so the carton could not
// even be re-queued. The row was in the database, and had silently stopped being sent.
//
// It is deliberately ONE row per call, named explicitly, by an administrator. There is no
// "requeue everything": the reason each row stopped is its own, and a sweep would spend five
// fresh attempts on every one of them against a cause nobody has looked at.

export type RequeueOutcome =
  | { readonly requeued: true; readonly entry: DeadLetterEntry }
  | { readonly requeued: false; readonly reason: "NOT_FOUND" }
  | { readonly requeued: false; readonly reason: "NOT_DEAD_LETTERED"; readonly status: string };

/**
 * Puts one parked row back in the queue, if it really is parked.
 *
 * WHAT IS RESET: the status, the claim, the wait, and both attempt counters — the four things
 * that decide whether the drain will pick it up and how long it has before being parked again.
 *
 * WHAT IS NOT: `dedupe_key` and `payload_json` (the event must go as the event it always was, so
 * the receiver still recognises a repeat), `created_at` (queue order is by creation, and a
 * recovered event belongs where it always did, not at the back), and `last_error` (the reason it
 * stopped is the audit trail, and the next failure overwrites it anyway — `reclaimStale` leaves
 * it alone for the same reason).
 *
 * No transaction: the UPDATE re-checks the status it read, so two callers racing cannot both
 * requeue, and there is nothing else to keep consistent with it.
 */
export function requeueDeadLetter(sql: SyncSqlHandle, outboxId: string, nowIso: string): RequeueOutcome {
  const row = asRow(
    sql
      .prepare(
        `SELECT id, dedupe_key, aggregate_type, aggregate_id, status, attempts, transient_attempts,
                last_error, created_at, updated_at
           FROM sync_outbox WHERE id = ? LIMIT 1`
      )
      .get(outboxId)
  );
  if (row === null) return { requeued: false, reason: "NOT_FOUND" };

  const status = String(row.status ?? "");
  if (status !== "DEAD_LETTER") return { requeued: false, reason: "NOT_DEAD_LETTERED", status };

  // What it was before the reset — what an audit entry has to be able to say.
  const entry: DeadLetterEntry = {
    outboxId: String(row.id ?? ""),
    dedupeKey: String(row.dedupe_key ?? ""),
    aggregateType: String(row.aggregate_type ?? ""),
    aggregateId: String(row.aggregate_id ?? ""),
    attempts: Number(row.attempts ?? 0),
    transientAttempts: Number(row.transient_attempts ?? 0),
    error: row.last_error === null || row.last_error === undefined ? "" : String(row.last_error),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };

  const result = sql
    .prepare(
      `UPDATE sync_outbox
          SET status = 'PENDING', lock_token = NULL, available_at = ?,
              attempts = 0, transient_attempts = 0, updated_at = ?
        WHERE id = ? AND status = 'DEAD_LETTER'`
    )
    .run(nowIso, nowIso, outboxId);

  // Someone else got there first between the read and the write.
  if (changedRows(result) === 0) return { requeued: false, reason: "NOT_DEAD_LETTERED", status: "PENDING" };
  return { requeued: true, entry };
}

// THE SCAN PATH IS WIRED.
//
// production.ts insertProduced queues the carton identity and enqueueProduced queues the
// PRODUCED event, both from inside the transaction that records them — so the rows and the news
// of them commit together, and a queue that refuses can never cost the factory a carton.
//
// The opening state is carried nowhere on purpose: insertProduced always writes the same four
// values, so the receiver sets them itself.
export { QR_MASTER_OPENING_STATE };

/**
 * The newest row a pass could send right now, as a number that grows with every enqueue (its
 * rowid), or 0 when there is none. Pure SELECT.
 *
 * For push on save: the host compares it with the last value it saw and nudges the scheduler when
 * it grows. Watching the queue rather than calling out from each write means every path that queues
 * -- scans, label runs, production -- is covered, including ones not written yet, and the data
 * layer never has to know a scheduler exists.
 *
 * Only PENDING rows of types the transport can carry count: a row of a type with no cloud contract
 * yet would start a pass that sends nothing.
 */
export function newestSendableRow(sql: SyncSqlHandle, pushableTypes: readonly string[]): number {
  if (pushableTypes.length === 0) return 0;
  const placeholders = pushableTypes.map(() => "?").join(", ");
  return scalar(
    sql,
    `SELECT COALESCE(MAX(rowid), 0) AS n FROM sync_outbox
      WHERE status = 'PENDING' AND aggregate_type IN (${placeholders})${STAMPED_IF_LEASED}`,
    [...pushableTypes, ...LEASED_TYPES]
  );
}
