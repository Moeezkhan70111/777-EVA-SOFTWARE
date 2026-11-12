// A carton stock movement arriving from the computer that holds the carton lease (cloud migration
// 026, docs/42): Manual Production, its void, a gatepass, or its cancel.
//
// The event is stored as its origin stored it, and the figure moves by its balanceDelta in the same
// transaction, through the one helper every local writer uses (@erp/data moveCartonStock). An event
// already here moves nothing: the figure changes only when the row is new, so at-least-once delivery
// cannot count a movement twice.
//
// THE ONLY PREREQUISITE IS THE PRODUCT VARIANT, which replicates. The gatepass and the Manual
// Production entry it names never do: they are references, kept as sent and never waited for.
//
// A MOVEMENT THAT WOULD TAKE THE FIGURE BELOW ZERO IS PARKED, NEVER CLAMPED. Under one writer it
// cannot happen, so if it does the figure here is not the origin's and must not be quietly made to
// look right: the event waits as CARTON_STOCK_WOULD_GO_NEGATIVE:<variant>, where the sync health
// report shows it, and nothing of it is written.
//
// Applied with capture suppressed: a movement received is not this computer's own to send.

import {
  CartonStockWouldGoNegative,
  moveCartonStock,
  readCartonStockEventPayload,
  SYNC_AGGREGATE,
  withCaptureSuppressed,
  type CaptureHandle,
  type CartonStockEventPayload,
} from "@erp/data";
import { ApplyMustWait, defineContract, rowExists } from "./applyContract.js";
import { asRow, changedRows, type SyncSqlHandle } from "./sqlPort.js";

export const cartonStockEventContract = defineContract({
  aggregateType: SYNC_AGGREGATE.CARTON_STOCK_EVENT,
  table: "carton_stock_events",
  read: readCartonStockEventPayload,
  idOf: (event) => event.eventId,
  missing: (sql, event) =>
    rowExists(sql, "SELECT id FROM product_variants WHERE id = ? LIMIT 1", event.productVariantId)
      ? null
      : `UNKNOWN_PRODUCT_VARIANT:${event.productVariantId}`,
  write: (sql, event, replicatedAt, sender) =>
    withCaptureSuppressed(sql as CaptureHandle, () => writeCartonStockEvent(sql, event, replicatedAt, sender)),
  conflict: eventConflict,
});

function writeCartonStockEvent(sql: SyncSqlHandle, event: CartonStockEventPayload, replicatedAt: string, sender: string | null): boolean {
  const inserted =
    changedRows(
      sql
        .prepare(
          `INSERT INTO carton_stock_events (
             id, product_variant_id, event_type, quantity, balance_delta, location_type, location_id, created_by, created_at,
             origin_device_id, replicated_at, manual_production_entry_id, gatepass_id, gatepass_line_id, reason
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`
        )
        .run(
          event.eventId, event.productVariantId, event.eventType, event.quantity, event.balanceDelta, event.locationType, event.locationId,
          event.createdBy, event.createdAt, sender, replicatedAt, event.manualProductionEntryId, event.gatepassId, event.gatepassLineId, event.reason
        )
    ) > 0;
  if (!inserted) return false;
  try {
    // The same rule as the computer that made it: a gatepass may take the figure below zero, nothing else may.
    moveCartonStock(sql, {
      variantId: event.productVariantId,
      locationId: event.locationId,
      delta: event.balanceDelta,
      nowIso: replicatedAt,
      eventType: event.eventType,
    });
  } catch (error) {
    // Rolled back with the row by the applier, and parked with its reason.
    if (error instanceof CartonStockWouldGoNegative) throw new ApplyMustWait(error.message);
    throw error;
  }
  return true;
}

/** An event already here under this id must be the same movement: same variant, type, cartons, store row and time. */
function eventConflict(sql: SyncSqlHandle, event: CartonStockEventPayload): string | null {
  const here = asRow(
    sql.prepare("SELECT product_variant_id, event_type, quantity, location_id, created_at FROM carton_stock_events WHERE id = ?").get(event.eventId)
  );
  const same =
    here !== null &&
    here.product_variant_id === event.productVariantId &&
    here.event_type === event.eventType &&
    Number(here.quantity) === event.quantity &&
    here.location_id === event.locationId &&
    here.created_at === event.createdAt;
  return same ? null : `CARTON_STOCK_EVENT_IDENTITY_CONFLICT:${event.eventId}`;
}
