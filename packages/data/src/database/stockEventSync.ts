// Turns captured stock events into queued STOCK_EVENT envelopes (cloud migration 015).
//
// An INSERT on inventory_stock_events marks the event in sync_dirty_records, under the raw-material
// store lease held at that moment (masterCapture.ts, EVENT_CAPTURE). Each pass, this queues every
// marked event as it is stored, with balanceDelta -- the change it made to its material's balance,
// read by the one rule that understands both sign conventions (domain stockEventBalanceDelta). The
// receiver adds that delta and never re-derives a sign, so every computer moves the balance exactly
// as the store PC did.
//
// A mark without an epoch -- an event recorded before this computer synced -- is left for the
// backfill, like a master record's. A marked event that is gone (a material removed for good before
// the pass) has nothing left to send: its mark is cleared and counted.

import crypto from "node:crypto";
import { stockEventBalanceDelta } from "@erp/domain";
import { enqueueSyncEvent, readStockEventPayload, SYNC_AGGREGATE, stockEventDedupeKey, type StockEventPayload } from "./syncEvents.js";
import type { BuildHandle } from "./masterRecords.js";

export interface StockEventBuildResult {
  /** Events queued. */
  readonly queued: number;
  /** Marks the outbox would not take, or whose event could not be read: left marked. */
  readonly unqueued: number;
  /** Marked events no longer stored: nothing to send, mark cleared. */
  readonly vanished: number;
}

type EventRow = Record<string, unknown>;

/** Empty text is "none" on the wire, as the reader requires. */
const orNull = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** The stored row as the wire payload, read back through the receiver's own reader (R25). */
export function stockEventPayloadOf(row: EventRow): StockEventPayload | null {
  const quantity = Number(row.quantity);
  return readStockEventPayload({
    eventId: row.id,
    itemId: row.item_id,
    eventType: row.event_type,
    quantity,
    unitId: row.unit_id,
    note: orNull(row.note),
    createdBy: orNull(row.created_by),
    createdAt: row.created_at,
    partyId: orNull(row.party_id),
    machineProgramId: orNull(row.machine_program_id),
    balanceDelta: stockEventBalanceDelta(String(row.event_type), quantity),
  });
}

/** Queues every marked stock event that carries a lease epoch, oldest mark first, in one transaction. */
export function buildStockEvents(db: BuildHandle, nowIso: string, limit = 500): StockEventBuildResult {
  const marks = db
    .prepare(
      `SELECT record_id, lease_epoch FROM sync_dirty_records
        WHERE aggregate_type = ? AND lease_epoch IS NOT NULL
        ORDER BY marked_at, record_id
        LIMIT ?`
    )
    .all(SYNC_AGGREGATE.STOCK_EVENT, limit) as Array<{ record_id: string; lease_epoch: number }>;
  if (marks.length === 0) return { queued: 0, unqueued: 0, vanished: 0 };

  let queued = 0;
  let unqueued = 0;
  let vanished = 0;
  const clear = (eventId: string) =>
    db.prepare("DELETE FROM sync_dirty_records WHERE aggregate_type = ? AND record_id = ?").run(SYNC_AGGREGATE.STOCK_EVENT, eventId);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const mark of marks) {
      const row = db.prepare("SELECT * FROM inventory_stock_events WHERE id = ?").all(mark.record_id)[0] as EventRow | undefined;
      if (row === undefined) {
        clear(mark.record_id);
        vanished += 1;
        continue;
      }
      const payload = stockEventPayloadOf(row);
      const ok =
        payload !== null &&
        enqueueSyncEvent(db, {
          outboxId: crypto.randomUUID(),
          aggregateType: SYNC_AGGREGATE.STOCK_EVENT,
          aggregateId: payload.eventId,
          dedupeKey: stockEventDedupeKey(payload.eventId),
          payload: { ...payload },
          nowIso,
          leaseEpoch: Number(mark.lease_epoch),
        });
      // An event is sent once: already in the outbox (queued by an earlier pass or the backfill)
      // is as good as queued now, and its mark is done.
      const alreadyQueued =
        !ok && payload !== null && db.prepare("SELECT 1 AS here FROM sync_outbox WHERE dedupe_key = ?").all(stockEventDedupeKey(payload.eventId)).length > 0;
      if (!ok && !alreadyQueued) {
        unqueued += 1;
        continue;
      }
      clear(mark.record_id);
      queued += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { queued, unqueued, vanished };
}
