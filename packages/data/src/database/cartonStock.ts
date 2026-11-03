// CARTON STOCK MOVEMENTS (docs/42, local migration 101, cloud migration 026).
//
// The carton figure moves in exactly one place: moveCartonStock, which changes
// stock_projection_by_variant and the WAREHOUSE row of stock_projection_by_location together. The
// local writers (Manual Production, its void, a gatepass and its cancel) record a carton_stock_events
// row and move the figure through it, in their own transaction. A movement received from another
// computer moves it through the same helper (@erp/sync cartonStockEventContracts.ts), so there is one
// definition of "move the carton figure".
//
// Nothing here clamps. A movement that would take either projection below zero is refused with
// CartonStockWouldGoNegative: a local writer turns it into a reason the operator can act on, and the
// applier parks the event as a named wait. A figure that looks fine and isn't is the one outcome
// this must never produce.

import crypto from "node:crypto";
import { CARTON_STOCK_EVENT_TYPE, cartonStockDelta, isCartonStockEventType, type CartonStockEventType } from "@erp/domain";
import { IN_STORE_LOCATION_TYPE } from "@erp/application";
import { enqueueSyncEvent, SYNC_AGGREGATE } from "./syncEvents.js";
import type { BuildHandle } from "./masterRecords.js";

type Bindable = string | number | null;

/** What moving the figure needs: the application's database, or the applier's handle. */
export interface CartonSql {
  prepare(sql: string): {
    run(...params: Bindable[]): unknown;
    get(...params: Bindable[]): unknown;
    all(...params: Bindable[]): unknown[];
  };
}

/** A movement would take a projection below zero. Never clamped, never swallowed. */
export class CartonStockWouldGoNegative extends Error {
  constructor(readonly variantId: string) {
    super(`CARTON_STOCK_WOULD_GO_NEGATIVE:${variantId}`);
    this.name = "CartonStockWouldGoNegative";
  }
}

const quantityIn = (sql: CartonSql, query: string, ...params: Bindable[]): number => {
  const row = sql.prepare(query).get(...params) as { quantity_on_hand?: unknown } | undefined;
  return Number(row?.quantity_on_hand ?? 0);
};

/** THE ONE PLACE the carton figure moves: both projections, together, never below zero. */
export function moveCartonStock(sql: CartonSql, move: { variantId: string; locationId: string; delta: number; nowIso: string }): void {
  if (move.delta < 0) {
    takeCartons(sql, move);
    return;
  }
  sql
    .prepare(
      `INSERT INTO stock_projection_by_variant (product_variant_id, quantity_on_hand, last_event_ts, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(product_variant_id) DO UPDATE SET
         quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand,
         last_event_ts = excluded.last_event_ts,
         updated_at = excluded.updated_at`
    )
    .run(move.variantId, move.delta, move.nowIso, move.nowIso);
  sql
    .prepare(
      `INSERT INTO stock_projection_by_location (product_variant_id, location_type, location_id, quantity_on_hand, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(product_variant_id, location_type, location_id) DO UPDATE SET
         quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand,
         updated_at = excluded.updated_at`
    )
    .run(move.variantId, IN_STORE_LOCATION_TYPE, move.locationId, move.delta, move.nowIso);
}

/**
 * Taking out: both rows must already hold the cartons. An UPDATE, not the upsert above -- SQLite
 * checks quantity_on_hand >= 0 on the row an upsert WOULD insert, before it finds the conflict.
 */
function takeCartons(sql: CartonSql, move: { variantId: string; locationId: string; delta: number; nowIso: string }): void {
  const onHand = quantityIn(sql, "SELECT quantity_on_hand FROM stock_projection_by_variant WHERE product_variant_id = ?", move.variantId);
  const inStore = quantityIn(
    sql,
    "SELECT quantity_on_hand FROM stock_projection_by_location WHERE product_variant_id = ? AND location_type = ? AND location_id = ?",
    move.variantId, IN_STORE_LOCATION_TYPE, move.locationId
  );
  if (onHand + move.delta < 0 || inStore + move.delta < 0) throw new CartonStockWouldGoNegative(move.variantId);
  sql
    .prepare("UPDATE stock_projection_by_variant SET quantity_on_hand = quantity_on_hand + ?, last_event_ts = ?, updated_at = ? WHERE product_variant_id = ?")
    .run(move.delta, move.nowIso, move.nowIso, move.variantId);
  sql
    .prepare(
      `UPDATE stock_projection_by_location SET quantity_on_hand = quantity_on_hand + ?, updated_at = ?
        WHERE product_variant_id = ? AND location_type = ? AND location_id = ?`
    )
    .run(move.delta, move.nowIso, move.variantId, IN_STORE_LOCATION_TYPE, move.locationId);
}

export interface CartonStockMovement {
  readonly variantId: string;
  readonly eventType: CartonStockEventType;
  readonly cartons: number;
  readonly locationId: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly manualProductionEntryId?: string | null;
  readonly gatepassId?: string | null;
  readonly gatepassLineId?: string | null;
}

/**
 * Records a movement made on THIS computer and moves the figure by it. Call only inside the writer's
 * own transaction: the event and the figure change together or not at all.
 */
export function recordCartonStockMovement(sql: CartonSql, movement: CartonStockMovement): string {
  const id = crypto.randomUUID();
  const delta = cartonStockDelta(movement.eventType, movement.cartons);
  sql
    .prepare(
      `INSERT INTO carton_stock_events (
         id, product_variant_id, event_type, quantity, balance_delta, location_type, location_id,
         created_by, created_at, manual_production_entry_id, gatepass_id, gatepass_line_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, movement.variantId, movement.eventType, movement.cartons, delta, IN_STORE_LOCATION_TYPE, movement.locationId,
      movement.createdBy, movement.createdAt, movement.manualProductionEntryId ?? null, movement.gatepassId ?? null, movement.gatepassLineId ?? null
    );
  moveCartonStock(sql, { variantId: movement.variantId, locationId: movement.locationId, delta, nowIso: movement.createdAt });
  return id;
}

/**
 * Where a gatepass takes `cartons` of a variant from: the store rows holding it, fullest first.
 * With one store that is one row. Refuses when the store does not hold them all.
 */
export function storeRowsToTakeFrom(sql: CartonSql, variantId: string, cartons: number): Array<{ locationId: string; cartons: number }> {
  const rows = sql
    .prepare(
      `SELECT location_id, quantity_on_hand FROM stock_projection_by_location
        WHERE product_variant_id = ? AND location_type = ? AND quantity_on_hand > 0
        ORDER BY quantity_on_hand DESC, location_id`
    )
    .all(variantId, IN_STORE_LOCATION_TYPE) as Array<{ location_id: string; quantity_on_hand: number }>;
  const taken: Array<{ locationId: string; cartons: number }> = [];
  let left = cartons;
  for (const row of rows) {
    if (left === 0) break;
    const take = Math.min(left, Number(row.quantity_on_hand));
    taken.push({ locationId: String(row.location_id), cartons: take });
    left -= take;
  }
  if (left > 0) throw new CartonStockWouldGoNegative(variantId);
  return taken;
}

// ─── On the wire ────────────────────────────────────────────────────────────

export interface CartonStockEventPayload {
  readonly eventId: string;
  readonly productVariantId: string;
  readonly eventType: CartonStockEventType;
  readonly quantity: number;
  readonly balanceDelta: number;
  readonly locationType: typeof IN_STORE_LOCATION_TYPE;
  readonly locationId: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly manualProductionEntryId: string | null;
  readonly gatepassId: string | null;
  readonly gatepassLineId: string | null;
}

export const cartonStockEventDedupeKey = (eventId: string): string => `${SYNC_AGGREGATE.CARTON_STOCK_EVENT}:${eventId}`;

const requiredText = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** Absent is null. Present must be real text: a number or an empty string is a broken payload. */
const optionalText = (value: unknown): { ok: boolean; value: string | null } => {
  if (value === null || value === undefined) return { ok: true, value: null };
  return typeof value === "string" && value.trim() !== "" ? { ok: true, value } : { ok: false, value: null };
};

/**
 * The movement as sent, or null when any part of it is missing or inconsistent (R25). The delta must
 * be exactly what the type says for the quantity: anything else is a broken event, never applied.
 */
export function readCartonStockEventPayload(payload: Record<string, unknown>): CartonStockEventPayload | null {
  const eventId = requiredText(payload.eventId);
  const productVariantId = requiredText(payload.productVariantId);
  const locationId = requiredText(payload.locationId);
  const createdAt = requiredText(payload.createdAt);
  const { eventType, quantity, balanceDelta } = payload;
  const references = [payload.createdBy, payload.manualProductionEntryId, payload.gatepassId, payload.gatepassLineId].map(optionalText);
  if (eventId === null || productVariantId === null || locationId === null || createdAt === null) return null;
  if (!isCartonStockEventType(eventType) || payload.locationType !== IN_STORE_LOCATION_TYPE) return null;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) return null;
  if (balanceDelta !== cartonStockDelta(eventType, quantity)) return null;
  if (references.some((reference) => !reference.ok)) return null;
  const [createdBy, manualProductionEntryId, gatepassId, gatepassLineId] = references.map((reference) => reference.value);
  return {
    eventId, productVariantId, eventType, quantity, balanceDelta, locationType: IN_STORE_LOCATION_TYPE, locationId, createdAt,
    createdBy: createdBy ?? null,
    manualProductionEntryId: manualProductionEntryId ?? null,
    gatepassId: gatepassId ?? null,
    gatepassLineId: gatepassLineId ?? null,
  };
}

/** A stored row as the wire payload, read back through the receiver's own reader. */
export function cartonStockEventPayloadOf(row: Record<string, unknown>): CartonStockEventPayload | null {
  return readCartonStockEventPayload({
    eventId: row.id,
    productVariantId: row.product_variant_id,
    eventType: row.event_type,
    quantity: Number(row.quantity),
    balanceDelta: Number(row.balance_delta),
    locationType: row.location_type,
    locationId: row.location_id,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    manualProductionEntryId: row.manual_production_entry_id ?? null,
    gatepassId: row.gatepass_id ?? null,
    gatepassLineId: row.gatepass_line_id ?? null,
  });
}

// ─── Queueing for sending ───────────────────────────────────────────────────

export interface CartonStockBuildResult {
  readonly queued: number;
  readonly unqueued: number;
}

/**
 * Queues every captured movement that carries a carton lease epoch, oldest first, in one transaction.
 * A mark without an epoch (made before this computer held the lease) is left: it was never this
 * computer's to send. An event is never deleted, so a mark always finds its row.
 */
export function buildCartonStockEvents(db: BuildHandle, nowIso: string, limit = 500): CartonStockBuildResult {
  const type = SYNC_AGGREGATE.CARTON_STOCK_EVENT;
  const marks = db
    .prepare(
      `SELECT record_id, lease_epoch FROM sync_dirty_records
        WHERE aggregate_type = ? AND lease_epoch IS NOT NULL ORDER BY marked_at, record_id LIMIT ?`
    )
    .all(type, limit) as Array<{ record_id: string; lease_epoch: number }>;
  if (marks.length === 0) return { queued: 0, unqueued: 0 };

  let queued = 0;
  let unqueued = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const mark of marks) {
      if (queueOne(db, mark, nowIso)) {
        db.prepare("DELETE FROM sync_dirty_records WHERE aggregate_type = ? AND record_id = ?").run(type, mark.record_id);
        queued += 1;
      } else {
        unqueued += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { queued, unqueued };
}

/** True when the movement is in the outbox: queued now, or by an earlier pass. */
function queueOne(db: BuildHandle, mark: { record_id: string; lease_epoch: number }, nowIso: string): boolean {
  const row = db.prepare("SELECT * FROM carton_stock_events WHERE id = ?").all(mark.record_id)[0] as Record<string, unknown> | undefined;
  const payload = row === undefined ? null : cartonStockEventPayloadOf(row);
  if (payload === null) return false;
  const dedupeKey = cartonStockEventDedupeKey(payload.eventId);
  const ok = enqueueSyncEvent(db, {
    outboxId: crypto.randomUUID(),
    aggregateType: SYNC_AGGREGATE.CARTON_STOCK_EVENT,
    aggregateId: payload.eventId,
    dedupeKey,
    payload: { ...payload },
    nowIso,
    leaseEpoch: Number(mark.lease_epoch),
  });
  return ok || db.prepare("SELECT 1 AS here FROM sync_outbox WHERE dedupe_key = ?").all(dedupeKey).length > 0;
}

export { CARTON_STOCK_EVENT_TYPE };
