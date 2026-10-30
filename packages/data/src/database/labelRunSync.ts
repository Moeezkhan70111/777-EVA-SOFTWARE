// Queues the label runs and packets the backfill marked, after the materials and parties they name.
//
// A run and its packets are queued the moment they are printed (rawMaterialQr.ts), so day to day this
// builds nothing. The BACKFILL is different: it marks every run and packet printed before this
// computer synced, all at once, alongside a thousand master records. Queued straight away they went
// out ahead of their materials and parties, and a new computer parked thousands of them on its first
// sync (the gate test, 2026-10-27, froze for minutes). So they are marked, and queued here only once
// their material and party are no longer waiting to be built -- and a packet only once its run is
// queued -- exactly as stock movements wait for their material (stockEventSync.ts).

import crypto from "node:crypto";
import {
  enqueueSyncEvent,
  rawMaterialQrBatchDedupeKey,
  rawMaterialQrDedupeKey,
  SYNC_AGGREGATE,
} from "./syncEvents.js";
import type { BuildHandle } from "./masterRecords.js";

export interface LabelBuildResult {
  readonly queued: number;
  /** Marks the outbox would not take: left marked. */
  readonly unqueued: number;
  /** Marked labels no longer stored (a run erased before the pass): mark cleared. */
  readonly vanished: number;
}

type Row = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** A mark still to be built for this material or party: what a label must wait behind. */
const MASTER_PENDING = (column: string, type: string) =>
  `EXISTS (SELECT 1 FROM sync_dirty_records m WHERE m.aggregate_type = '${type}' AND m.record_id = ${column} AND m.lease_epoch IS NOT NULL)`;

const READY_RUNS = `SELECT d.record_id, d.lease_epoch, b.* FROM sync_dirty_records d
  JOIN raw_material_qr_batches b ON b.id = d.record_id
  WHERE d.aggregate_type = '${SYNC_AGGREGATE.RAW_MATERIAL_QR_BATCH}' AND d.lease_epoch IS NOT NULL
    AND NOT ${MASTER_PENDING("b.item_id", SYNC_AGGREGATE.INVENTORY_ITEM)}
    AND NOT ${MASTER_PENDING("b.party_id", SYNC_AGGREGATE.PARTY)}
  ORDER BY b.created_at, b.id LIMIT ?`;

const READY_PACKETS = `SELECT d.record_id, d.lease_epoch, q.* FROM sync_dirty_records d
  JOIN raw_material_qrs q ON q.id = d.record_id
  WHERE d.aggregate_type = '${SYNC_AGGREGATE.RAW_MATERIAL_QR}' AND d.lease_epoch IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM sync_dirty_records r WHERE r.aggregate_type = '${SYNC_AGGREGATE.RAW_MATERIAL_QR_BATCH}' AND r.record_id = q.batch_id)
    AND NOT ${MASTER_PENDING("q.item_id", SYNC_AGGREGATE.INVENTORY_ITEM)}
    AND NOT ${MASTER_PENDING("q.party_id", SYNC_AGGREGATE.PARTY)}
  ORDER BY q.batch_id, q.sequence LIMIT ?`;

/** Marks whose label is gone: nothing left to send. */
const VANISHED = `DELETE FROM sync_dirty_records
  WHERE (aggregate_type = '${SYNC_AGGREGATE.RAW_MATERIAL_QR_BATCH}' AND record_id NOT IN (SELECT id FROM raw_material_qr_batches))
     OR (aggregate_type = '${SYNC_AGGREGATE.RAW_MATERIAL_QR}' AND record_id NOT IN (SELECT id FROM raw_material_qrs))`;

/** Queues every marked run, then every marked packet, that is ready, in one transaction. */
export function buildLabelRuns(db: BuildHandle, nowIso: string, limit = 2000): LabelBuildResult {
  let queued = 0;
  let unqueued = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const vanished = Number(db.prepare(VANISHED).run().changes);
    for (const run of db.prepare(READY_RUNS).all(limit) as Row[]) {
      const id = String(run.id);
      const ok = queue(db, SYNC_AGGREGATE.RAW_MATERIAL_QR_BATCH, id, rawMaterialQrBatchDedupeKey(id), {
        batchId: id,
        partyId: String(run.party_id),
        itemId: String(run.item_id),
        startSequence: Number(run.start_sequence),
        endSequence: Number(run.end_sequence),
        quantity: Number(run.quantity),
        createdAt: String(run.created_at),
        createdBy: text(run.created_by),
        requestedBy: text(run.requested_by),
      }, Number(run.lease_epoch), nowIso);
      if (ok) queued += 1;
      else unqueued += 1;
    }
    for (const packet of db.prepare(READY_PACKETS).all(limit) as Row[]) {
      const id = String(packet.id);
      const packing = packet.packing_quantity === null || packet.packing_quantity === undefined ? null : Number(packet.packing_quantity);
      const ok = queue(db, SYNC_AGGREGATE.RAW_MATERIAL_QR, id, rawMaterialQrDedupeKey(id), {
        qrId: id,
        batchId: String(packet.batch_id),
        partyId: String(packet.party_id),
        itemId: String(packet.item_id),
        sequence: Number(packet.sequence),
        packingQuantity: packing,
        packingUnitId: packing === null ? null : text(packet.packing_unit_id),
        createdAt: String(packet.created_at),
      }, Number(packet.lease_epoch), nowIso);
      if (ok) queued += 1;
      else unqueued += 1;
    }
    db.exec("COMMIT");
    return { queued, unqueued, vanished };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Queues one label under the epoch it was marked with, and clears its mark. Already in the outbox
 * (queued when printed, or by an earlier pass) is as good as queued now: a label is sent once.
 */
function queue(db: BuildHandle, type: string, id: string, dedupeKey: string, payload: Record<string, unknown>, leaseEpoch: number, nowIso: string): boolean {
  const ok =
    enqueueSyncEvent(db, {
      outboxId: crypto.randomUUID(),
      aggregateType: type as typeof SYNC_AGGREGATE.RAW_MATERIAL_QR,
      aggregateId: id,
      dedupeKey,
      payload,
      nowIso,
      leaseEpoch,
    }) || db.prepare("SELECT 1 AS here FROM sync_outbox WHERE dedupe_key = ?").all(dedupeKey).length > 0;
  if (ok) db.prepare("DELETE FROM sync_dirty_records WHERE aggregate_type = ? AND record_id = ?").run(type, id);
  return ok;
}
