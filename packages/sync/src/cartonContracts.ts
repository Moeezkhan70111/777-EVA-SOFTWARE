// The carton pilot's three contracts: a product variant, a carton identity, and a production scan.
//
// All three are insert-only and keyed by their primary key, so `ON CONFLICT DO NOTHING` makes a
// second arrival a no-op by construction -- there is no window in which a repeat could be applied,
// because the database itself refuses the second insert.

import {
  QR_MASTER_OPENING_STATE,
  SYNC_AGGREGATE,
  readProductionProducedPayload,
  readProductVariantPayload,
  readQrMasterPayload,
  type ProductionProducedPayload,
} from "@erp/data";
import { defineContract, rowExists } from "./applyContract.js";
import { changedRows, type SyncSqlHandle } from "./sqlPort.js";

// ─── PRODUCT_VARIANT ────────────────────────────────────────────────────────

/**
 * A product variant arriving from another computer.
 *
 * THIS IS WHAT TURNS UNKNOWN_PRODUCT_VARIANT FROM A DEAD END INTO A WAIT. The carton contract
 * waits for a product this computer has not got, and the variant travels ahead of the carton, so
 * the wait resolves itself.
 *
 * INSERT-ONLY, and the narrowest thing that works. article, colour and size are fixed at
 * creation, so there is nothing to merge and no conflict rule to get wrong. Prices are not
 * carried at all. `status` is written ACTIVE here rather than taken from the wire: a variant
 * retired on the computer that sent it is still a real product here, and retirement is each
 * computer's own record.
 *
 * ON CONFLICT DO NOTHING, so a variant that already exists -- seeded by hand, or carried by an
 * earlier carton -- is a no-op rather than an overwrite. A local edit to a description is
 * therefore never clobbered by a replay. Any conflict, not only the id's: a variant's id is derived
 * from its article, colour and size (productIdentity.ts), so the same identity here is the same
 * variant, and a clash must not throw and fail the whole pull.
 *
 * ONLY THE IDENTITY COLUMNS ARE NAMED. Everything else takes its default, so the insert cannot
 * depend on how this computer's prices or groups are stored. Until 2026-10-28 it named
 * cost_price and selling_price, which the local table does not have (they are *_paisa), and the
 * first variant to arrive would have thrown. Nothing had ever arrived: the cloud did not log
 * variants until cloud migration 017.
 */
export const productVariantContract = defineContract({
  aggregateType: SYNC_AGGREGATE.PRODUCT_VARIANT,
  table: "product_variants",
  read: readProductVariantPayload,
  idOf: (variant) => variant.variantId,
  missing: () => null,
  write: (sql, variant, replicatedAt) =>
    changedRows(
      sql
        .prepare(
          `INSERT INTO product_variants (id, article, color, size, description, status, created_at, updated_at, replicated_at)
           VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
           ON CONFLICT DO NOTHING`
        )
        .run(
          variant.variantId,
          variant.article,
          variant.color,
          variant.size,
          variant.description,
          variant.createdAt,
          variant.createdAt,
          replicatedAt
        )
    ) > 0,
});

// ─── QR_MASTER ──────────────────────────────────────────────────────────────

export const qrMasterContract = defineContract({
  aggregateType: SYNC_AGGREGATE.QR_MASTER,
  table: "qr_master",
  read: readQrMasterPayload,
  idOf: (identity) => identity.qrId,
  // qr_master.product_variant_id is a foreign key, so a computer that has not been given this
  // product cannot hold the carton yet.
  //
  // A WAIT, NOT A REFUSAL. The product arrives ahead of the carton (PRODUCT_VARIANT), or the
  // owner seeds it, and then this very event can be applied. Refusing it permanently let the
  // cursor step over it, so the product arriving afterwards healed nothing and the carton was
  // missed for good -- the one failure most likely while two computers are being set up.
  missing: (sql, identity) =>
    rowExists(sql, "SELECT id FROM product_variants WHERE id = ? LIMIT 1", identity.productVariantId)
      ? null
      : `UNKNOWN_PRODUCT_VARIANT:${identity.productVariantId}`,
  write: (sql, identity, replicatedAt) =>
    changedRows(
      sql
        .prepare(
          `INSERT INTO qr_master (
             qr_id, product_variant_id, current_status, current_location_type, current_location_id,
             first_event_id, created_at, updated_at, deleted_at, deleted_by, delete_reason, replicated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
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
          identity.createdAt,
          replicatedAt
        )
    ) > 0,
});

// ─── PRODUCTION_PRODUCED ────────────────────────────────────────────────────

export const productionProducedContract = defineContract({
  aggregateType: SYNC_AGGREGATE.PRODUCTION_PRODUCED,
  table: "production_events",
  read: readProductionProducedPayload,
  idOf: (event) => event.eventId,
  missing: missingForProduction,
  write: writeProductionProduced,
});

/**
 * The first prerequisite a production scan needs and this computer has not got, or null.
 *
 * The carton identity is sent as its own event, queued first and so leased first -- but a batch
 * boundary, a reordered retry or a parked identity can all leave it not here yet. The rest are
 * master data: the product, the factory, the originating workstation, and the operator when the
 * scan named one. All of them are waits, for the reason given on qrMasterContract.
 */
function missingForProduction(sql: SyncSqlHandle, event: ProductionProducedPayload): string | null {
  if (!rowExists(sql, "SELECT qr_id FROM qr_master WHERE qr_id = ? LIMIT 1", event.qrId)) {
    return `QR_NOT_REGISTERED_YET:${event.qrId}`;
  }
  if (!rowExists(sql, "SELECT id FROM product_variants WHERE id = ? LIMIT 1", event.productVariantId)) {
    return `UNKNOWN_PRODUCT_VARIANT:${event.productVariantId}`;
  }
  if (!rowExists(sql, "SELECT id FROM factories WHERE id = ? LIMIT 1", event.factoryId)) {
    return `UNKNOWN_FACTORY:${event.factoryId}`;
  }
  if (!rowExists(sql, "SELECT id FROM workstations WHERE id = ? LIMIT 1", event.workstationId)) {
    return `UNKNOWN_WORKSTATION:${event.workstationId}`;
  }
  if (event.operatorId !== null && !rowExists(sql, "SELECT id FROM operators WHERE id = ? LIMIT 1", event.operatorId)) {
    return `UNKNOWN_OPERATOR:${event.operatorId}`;
  }
  return null;
}

/**
 * The event row and the carton's first_event_id pointer: two statements describing one arrival.
 *
 * The applier runs this inside one transaction. Left in autocommit, a process that died between
 * the two committed the event and lost the pointer -- and the pointer could never come back,
 * because the retry finds the row already there, reports DUPLICATE and skips the update.
 *
 * STOCK IS DELIBERATELY NOT TOUCHED. The local write also increments
 * stock_projection_by_variant and stock_projection_by_location, and this does not, because carton
 * dispatch, returns and store movements stay local. Counting arrivals while those stay local
 * would make the receiving computer's carton stock confidently wrong.
 */
function writeProductionProduced(sql: SyncSqlHandle, event: ProductionProducedPayload, replicatedAt: string): boolean {
  const result = sql
    .prepare(
      `INSERT INTO production_events (
         id, qr_id, product_variant_id, event_type, event_ts_local, event_date, event_hour,
         factory_id, workstation_id, operator_id, device_id,
         article_snapshot, color_snapshot, size_snapshot, serial_snapshot,
         metadata_json, created_at, sync_status, synced_at, sync_error, retry_count, source_app, replicated_at
       ) VALUES (?, ?, ?, 'PRODUCED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SYNCED', NULL, NULL, 0, ?, ?)
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
      event.sourceApp,
      replicatedAt
    );

  const inserted = changedRows(result) > 0;
  if (inserted) {
    // The same follow-up the local write does, and idempotent for the same reason: COALESCE
    // leaves an existing first event alone.
    sql
      .prepare("UPDATE qr_master SET first_event_id = COALESCE(first_event_id, ?), updated_at = ? WHERE qr_id = ?")
      .run(event.eventId, event.createdAt, event.qrId);
  }
  return inserted;
}
