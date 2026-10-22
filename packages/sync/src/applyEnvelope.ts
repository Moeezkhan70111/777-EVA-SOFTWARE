// The receiving side: applying one event, exactly once.
//
// Delivery is at-least-once — an interrupted run offers an event again — so the whole of
// exactly-once lives here, and for both supported events it needs no ledger and no bookkeeping.
// qr_master is keyed by qr_id and production_events by id, both rows are insert-only, and
// `ON CONFLICT DO NOTHING` makes a second application a no-op by construction. There is no window
// in which a repeat could be applied, because the database itself refuses the second insert.
//
// The contracts come from @erp/data, which is what writes these rows locally. Keeping a second
// copy of the field names here is exactly how a receiver and a sender drift apart.
//
// TWO KINDS OF REFUSAL, and the difference matters:
//
//   PERMANENT  offering it again could never help — an event type with no contract, a payload
//              missing a required fact, or master data this computer has never been given.
//   RETRYABLE  the event is fine but something it depends on has not arrived yet. A production
//              event whose carton identity is still in flight is the normal case, not a fault.
//
// Anything whose contract is not complete is refused permanently. That is the point: an event
// this code does not understand must stop visibly in the sender's dead-letter queue, not be
// written with guessed values.

import {
  QR_MASTER_OPENING_STATE,
  SYNC_AGGREGATE,
  readProductionProducedPayload,
  readProductVariantPayload,
  readQrMasterPayload,
} from "@erp/data";
import type { SyncEnvelope } from "./contract.js";
import { asRow, changedRows, type SyncSqlHandle } from "./sqlPort.js";

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

const refuse = (dedupeKey: string, reason: string, permanent: boolean): ApplyOutcome => ({
  dedupeKey,
  status: "REJECTED",
  reason,
  permanent,
});

/** True when a row with this id is in the table. Table names are literals, never from a caller. */
const exists = (sql: SyncSqlHandle, select: string, id: string): boolean =>
  asRow(sql.prepare(select).get(id)) !== null;

/**
 * Applies one envelope to this computer's database.
 *
 * Never throws for a bad event: a refusal is an answer the sender records. It may still throw if
 * the database itself is broken, which is a fault rather than a business outcome.
 */
export function applyEnvelope(sql: SyncSqlHandle, envelope: SyncEnvelope): ApplyOutcome {
  if (envelope.operation !== "INSERT") {
    return refuse(envelope.dedupeKey, `UNSUPPORTED_OPERATION:${envelope.operation}`, true);
  }
  if (envelope.aggregateType === SYNC_AGGREGATE.PRODUCT_VARIANT) {
    return applyProductVariant(sql, envelope);
  }
  if (envelope.aggregateType === SYNC_AGGREGATE.QR_MASTER) {
    return applyQrMaster(sql, envelope);
  }
  if (envelope.aggregateType === SYNC_AGGREGATE.PRODUCTION_PRODUCED) {
    return applyProductionProduced(sql, envelope);
  }
  // DAMAGED, STORE_ENTRY, STORE_EXIT and ADJUSTMENT still share the old catch-all
  // PRODUCTION_EVENT, and DISPATCH_EVENT and RETURN_EVENT carry neither the product variant nor
  // the snapshot columns their rows require. Each needs a contract of its own before it can be
  // applied — see @erp/data's syncEvents.ts.
  return refuse(envelope.dedupeKey, `UNSUPPORTED_AGGREGATE_TYPE:${envelope.aggregateType}`, true);
}

// ─── QR_MASTER ──────────────────────────────────────────────────────────────

/**
 * A product variant arriving from another computer.
 *
 * THIS IS WHAT TURNS UNKNOWN_PRODUCT_VARIANT FROM A DEAD END INTO A WAIT. applyQrMaster defers a
 * carton whose product this computer has not got, on the reasoning that "the product arrives when
 * the owner seeds it". Until now nothing carried the product, so that sentence described a manual
 * step. Now the variant travels ahead of the carton and the deferral resolves itself.
 *
 * INSERT-ONLY, and the narrowest thing that works. article, colour and size are fixed at
 * creation, so there is nothing to merge and no conflict rule to get wrong. Prices are not
 * carried at all. `status` is written ACTIVE here rather than taken from the wire: a variant
 * retired on the computer that sent it is still a real product here, and retirement is each
 * computer's own record.
 *
 * ON CONFLICT DO NOTHING, so a variant that already exists -- seeded by hand, or carried by an
 * earlier carton -- is a no-op rather than an overwrite. A local edit to a description is
 * therefore never clobbered by a replay.
 */
function applyProductVariant(sql: SyncSqlHandle, envelope: SyncEnvelope): ApplyOutcome {
  const variant = readProductVariantPayload(envelope.payload);
  if (variant === null) return refuse(envelope.dedupeKey, "PAYLOAD_INCOMPLETE", true);
  if (variant.variantId !== envelope.aggregateId) {
    return refuse(envelope.dedupeKey, "AGGREGATE_ID_MISMATCH", true);
  }

  const result = sql
    .prepare(
      `INSERT INTO product_variants (
         id, article, color, size, description, cost_price, selling_price,
         status, created_at, updated_at, deleted_at, deleted_by, delete_reason
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'ACTIVE', ?, ?, NULL, NULL, NULL)
       ON CONFLICT(id) DO NOTHING`
    )
    .run(
      variant.variantId,
      variant.article,
      variant.color,
      variant.size,
      variant.description,
      variant.createdAt,
      variant.createdAt
    );

  return { dedupeKey: envelope.dedupeKey, status: changedRows(result) > 0 ? "APPLIED" : "DUPLICATE" };
}

function applyQrMaster(sql: SyncSqlHandle, envelope: SyncEnvelope): ApplyOutcome {
  const identity = readQrMasterPayload(envelope.payload);
  if (identity === null) return refuse(envelope.dedupeKey, "PAYLOAD_INCOMPLETE", true);
  if (identity.qrId !== envelope.aggregateId) {
    return refuse(envelope.dedupeKey, "AGGREGATE_ID_MISMATCH", true);
  }

  // qr_master.product_variant_id is a foreign key, and master data is NOT synchronised, so a
  // computer that has not been given this product cannot hold the carton yet.
  //
  // DEFERRED, NOT PERMANENT. The product arrives when the owner seeds it, and then this very
  // event can be applied. Calling it permanent let the cursor step over it, so seeding the
  // product afterwards healed nothing and the carton was missed for good -- the one failure
  // mode most likely to happen while two computers are being set up.
  if (!exists(sql, "SELECT id FROM product_variants WHERE id = ? LIMIT 1", identity.productVariantId)) {
    return refuse(envelope.dedupeKey, `UNKNOWN_PRODUCT_VARIANT:${identity.productVariantId}`, false);
  }

  const result = sql
    .prepare(
      `INSERT INTO qr_master (
         qr_id, product_variant_id, current_status, current_location_type, current_location_id,
         first_event_id, created_at, updated_at, deleted_at, deleted_by, delete_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
       ON CONFLICT(qr_id) DO NOTHING`
    )
    .run(
      identity.qrId,
      identity.productVariantId,
      QR_MASTER_OPENING_STATE.currentStatus,
      QR_MASTER_OPENING_STATE.currentLocationType,
      QR_MASTER_OPENING_STATE.currentLocationId,
      QR_MASTER_OPENING_STATE.firstEventId,
      identity.createdAt,
      identity.createdAt
    );

  // Nothing changed means the row was already here: the same event arriving twice, which is
  // exactly what at-least-once delivery produces and exactly what must be a no-op.
  return { dedupeKey: envelope.dedupeKey, status: changedRows(result) > 0 ? "APPLIED" : "DUPLICATE" };
}

// ─── PRODUCTION_PRODUCED ────────────────────────────────────────────────────

function applyProductionProduced(sql: SyncSqlHandle, envelope: SyncEnvelope): ApplyOutcome {
  const event = readProductionProducedPayload(envelope.payload);
  if (event === null) return refuse(envelope.dedupeKey, "PAYLOAD_INCOMPLETE", true);
  if (event.eventId !== envelope.aggregateId) {
    return refuse(envelope.dedupeKey, "AGGREGATE_ID_MISMATCH", true);
  }

  // The carton identity is sent as its own event, queued first and so leased first — but a batch
  // boundary, a reordered retry or a dead-lettered identity can all leave it not here yet. That
  // is RETRYABLE: the event is sound, its prerequisite is simply still on its way.
  if (!exists(sql, "SELECT qr_id FROM qr_master WHERE qr_id = ? LIMIT 1", event.qrId)) {
    return refuse(envelope.dedupeKey, `QR_NOT_REGISTERED_YET:${event.qrId}`, false);
  }

  // The rest are foreign keys into master data, which this milestone does NOT synchronise: the
  // product, the factory, the originating workstation, and the operator when the scan named one.
  //
  // Deferred for the same reason as the carton above. Retrying does not create them, but the
  // owner does, and when they do the waiting event applies itself. Stepping over it instead
  // would mean the scan is never seen on this computer however much master data arrives later.
  const missing = missingMasterData(sql, event);
  if (missing !== null) return refuse(envelope.dedupeKey, missing, false);

  // THE ROW AND ITS FOLLOW-UP ARE ONE TRANSACTION.
  //
  // The insert and the first_event_id update are two statements describing one arrival. Left in
  // autocommit, a process that died between them committed the event and lost the pointer — and
  // the pointer could never come back, because the retry finds the row already there, reports
  // DUPLICATE and skips the update. A permanently incomplete apply, from one badly timed stop.
  //
  // Rolled back together instead, an interruption leaves nothing at all, and the next pull (the
  // cursor never advanced past an event this run did not settle) applies the whole thing again.
  //
  // The prerequisite reads above stay OUTSIDE the transaction on purpose: BEGIN IMMEDIATE takes
  // the write lock, and a sync pass may be running while the factory is scanning. The lock is
  // held for the two writes and nothing else.
  //
  // This function owns the transaction. Nothing calls it from inside another one today, and
  // SQLite would refuse a nested BEGIN loudly rather than silently if that ever changed.
  sql.exec("BEGIN IMMEDIATE TRANSACTION");
  let applied: boolean;
  try {
    const result = sql
      .prepare(
        `INSERT INTO production_events (
           id, qr_id, product_variant_id, event_type, event_ts_local, event_date, event_hour,
           factory_id, workstation_id, operator_id, device_id,
           article_snapshot, color_snapshot, size_snapshot, serial_snapshot,
           metadata_json, created_at, sync_status, synced_at, sync_error, retry_count, source_app
         ) VALUES (?, ?, ?, 'PRODUCED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SYNCED', NULL, NULL, 0, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(
        event.eventId,
        event.qrId,
        event.productVariantId,
        event.occurredAt,
        event.eventDate,
        event.eventHour,
        event.factoryId,
        event.workstationId,
        event.operatorId,
        event.deviceId,
        event.article,
        event.color,
        event.size,
        event.serial,
        event.metadataJson,
        event.createdAt,
        event.sourceApp
      );

    applied = changedRows(result) > 0;
    if (applied) {
      // The same follow-up the local write does, and idempotent for the same reason: COALESCE
      // leaves an existing first event alone.
      sql
        .prepare("UPDATE qr_master SET first_event_id = COALESCE(first_event_id, ?), updated_at = ? WHERE qr_id = ?")
        .run(event.eventId, event.createdAt, event.qrId);
    }
    sql.exec("COMMIT");
  } catch (error) {
    // Leave no half-written arrival behind. The event is offered again, exactly as a lost answer
    // or an interrupted run already is.
    sql.exec("ROLLBACK");
    throw error;
  }

  // STOCK IS DELIBERATELY NOT TOUCHED. The local write also increments
  // stock_projection_by_variant and stock_projection_by_location, and this does not — not
  // because quantities are unimportant, but because only production is synchronised so far.
  // Counting arrivals while dispatch, returns and store movements stay local would make the
  // receiving computer's stock confidently wrong. The event log converges, the projection stays
  // local, and no quantity is ever carried as a value.
  return { dedupeKey: envelope.dedupeKey, status: applied ? "APPLIED" : "DUPLICATE" };
}

/** The first master-data row this event needs and this computer does not have, or null. */
function missingMasterData(
  sql: SyncSqlHandle,
  event: { productVariantId: string; factoryId: string; workstationId: string; operatorId: string | null }
): string | null {
  if (!exists(sql, "SELECT id FROM product_variants WHERE id = ? LIMIT 1", event.productVariantId)) {
    return `UNKNOWN_PRODUCT_VARIANT:${event.productVariantId}`;
  }
  if (!exists(sql, "SELECT id FROM factories WHERE id = ? LIMIT 1", event.factoryId)) {
    return `UNKNOWN_FACTORY:${event.factoryId}`;
  }
  if (!exists(sql, "SELECT id FROM workstations WHERE id = ? LIMIT 1", event.workstationId)) {
    return `UNKNOWN_WORKSTATION:${event.workstationId}`;
  }
  if (event.operatorId !== null && !exists(sql, "SELECT id FROM operators WHERE id = ? LIMIT 1", event.operatorId)) {
    return `UNKNOWN_OPERATOR:${event.operatorId}`;
  }
  return null;
}

/** Applies a batch, in the order given. Each event's outcome is independent of the others. */
export function applyEnvelopes(sql: SyncSqlHandle, envelopes: readonly SyncEnvelope[]): ApplyOutcome[] {
  return envelopes.map((envelope) => applyEnvelope(sql, envelope));
}
