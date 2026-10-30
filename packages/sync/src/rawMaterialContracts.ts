// Raw-material packet identity: a run of labels, and each packet in it.
//
// Class A in docs/37: insert-only, multi-writer (docs/37 section W -- packets are minted from each
// computer's own serial block). What a packet IS travels. Where a packet IS -- current_status,
// current_section_id, current_hop_index -- does not: it is derived on each computer from the
// packet's events, because shipping it as a value would let the last writer win and misstate what
// is in the store.
//
// IDENTITY REUSE IS REAL HERE, unlike for cartons. An untouched run can be erased and its serials
// printed again (deleteRawMaterialQrBatch), so the same packet id can come to mean a different
// packet, possibly of a different size. Both contracts therefore check, when nothing was inserted,
// that what is here really is the same identity -- and refuse permanently when it is not.
//
// Every prerequisite is a WAIT (owner decision, 2026-10-23): a run needs its supplier and its
// material, a packet needs its run and its packing unit. Master data replicates under the write
// lease (docs/37 section W), and until it has arrived the packet waits rather than being refused.

import {
  RAW_MATERIAL_QR_OPENING_STATE,
  SYNC_AGGREGATE,
  readRawMaterialQrBatchPayload,
  readRawMaterialQrPayload,
  type RawMaterialQrBatchPayload,
  type RawMaterialQrPayload,
} from "@erp/data";
import { defineContract, rowExists } from "./applyContract.js";
import { asRow, changedRows, type SyncSqlHandle } from "./sqlPort.js";

// ─── RAW_MATERIAL_QR_BATCH ──────────────────────────────────────────────────

export const rawMaterialQrBatchContract = defineContract({
  aggregateType: SYNC_AGGREGATE.RAW_MATERIAL_QR_BATCH,
  table: "raw_material_qr_batches",
  read: readRawMaterialQrBatchPayload,
  idOf: (batch) => batch.batchId,
  missing: (sql, batch) => {
    if (!rowExists(sql, "SELECT id FROM parties WHERE id = ? LIMIT 1", batch.partyId)) {
      return `UNKNOWN_PARTY:${batch.partyId}`;
    }
    if (!rowExists(sql, "SELECT id FROM inventory_items WHERE id = ? LIMIT 1", batch.itemId)) {
      return `UNKNOWN_INVENTORY_ITEM:${batch.itemId}`;
    }
    return null;
  },
  write: (sql, batch, replicatedAt) =>
    changedRows(
      sql
        .prepare(
          `INSERT INTO raw_material_qr_batches (
             id, party_id, item_id, start_sequence, end_sequence, quantity,
             created_at, created_by, requested_by, replicated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`
        )
        .run(
          batch.batchId,
          batch.partyId,
          batch.itemId,
          batch.startSequence,
          batch.endSequence,
          batch.quantity,
          batch.createdAt,
          batch.createdBy,
          batch.requestedBy,
          replicatedAt
        )
    ) > 0,
  conflict: batchConflict,
});

/** A run already here under this id must be the same run: same supplier, material and serials. */
function batchConflict(sql: SyncSqlHandle, batch: RawMaterialQrBatchPayload): string | null {
  const here = asRow(
    sql
      .prepare("SELECT party_id, item_id, start_sequence, end_sequence FROM raw_material_qr_batches WHERE id = ?")
      .get(batch.batchId)
  );
  const same =
    here !== null &&
    here.party_id === batch.partyId &&
    here.item_id === batch.itemId &&
    Number(here.start_sequence) === batch.startSequence &&
    Number(here.end_sequence) === batch.endSequence;
  return same ? null : `RAW_MATERIAL_QR_BATCH_IDENTITY_CONFLICT:${batch.batchId}`;
}

// ─── RAW_MATERIAL_QR ────────────────────────────────────────────────────────

export const rawMaterialQrContract = defineContract({
  aggregateType: SYNC_AGGREGATE.RAW_MATERIAL_QR,
  table: "raw_material_qrs",
  read: readRawMaterialQrPayload,
  idOf: (packet) => packet.qrId,
  missing: (sql, packet) => {
    // The run arrives as its own event, queued ahead of its packets -- but a batch boundary or a
    // parked run can still leave it behind.
    if (!rowExists(sql, "SELECT id FROM raw_material_qr_batches WHERE id = ? LIMIT 1", packet.batchId)) {
      return `RAW_MATERIAL_QR_BATCH_NOT_HERE_YET:${packet.batchId}`;
    }
    if (
      packet.packingUnitId !== null &&
      !rowExists(sql, "SELECT id FROM inventory_units WHERE id = ? LIMIT 1", packet.packingUnitId)
    ) {
      return `UNKNOWN_INVENTORY_UNIT:${packet.packingUnitId}`;
    }
    return null;
  },
  write: writeRawMaterialQr,
  conflict: packetConflict,
});

/**
 * ON CONFLICT DO NOTHING with NO target, on purpose. raw_material_qrs is unique on its id AND on
 * (party_id, item_id, sequence). A targeted clause would let the second constraint throw out of
 * the applier and fail the whole pull; untargeted, it inserts nothing and packetConflict says why.
 */
function writeRawMaterialQr(sql: SyncSqlHandle, packet: RawMaterialQrPayload, replicatedAt: string): boolean {
  const opening = RAW_MATERIAL_QR_OPENING_STATE;
  const result = sql
    .prepare(
      `INSERT INTO raw_material_qrs (
         id, batch_id, party_id, item_id, sequence, status, current_status, current_section_id,
         current_hop_index, packing_quantity, packing_unit_id, created_at, updated_at, replicated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    )
    .run(
      packet.qrId,
      packet.batchId,
      packet.partyId,
      packet.itemId,
      packet.sequence,
      opening.status,
      opening.currentStatus,
      opening.currentSectionId,
      opening.currentHopIndex,
      packet.packingQuantity,
      packet.packingUnitId,
      packet.createdAt,
      packet.createdAt,
      replicatedAt
    );
  return changedRows(result) > 0;
}

/**
 * The packet here under this id must be this packet: same run, same serial, same contents.
 *
 * A different run means the serial was erased and printed again at the origin after this computer
 * had already received the first printing -- exactly the case that must not pass as a duplicate.
 * No row under this id at all means another packet already holds this supplier, material and
 * serial.
 */
function packetConflict(sql: SyncSqlHandle, packet: RawMaterialQrPayload): string | null {
  const here = asRow(
    sql
      .prepare(
        `SELECT batch_id, party_id, item_id, sequence, packing_quantity, packing_unit_id
         FROM raw_material_qrs WHERE id = ?`
      )
      .get(packet.qrId)
  );
  if (here === null) return `RAW_MATERIAL_QR_SERIAL_TAKEN:${packet.qrId}`;
  const herePacking = here.packing_quantity === null ? null : Number(here.packing_quantity);
  const same =
    here.batch_id === packet.batchId &&
    here.party_id === packet.partyId &&
    here.item_id === packet.itemId &&
    Number(here.sequence) === packet.sequence &&
    herePacking === packet.packingQuantity &&
    (here.packing_unit_id ?? null) === packet.packingUnitId;
  return same ? null : `RAW_MATERIAL_QR_IDENTITY_CONFLICT:${packet.qrId}`;
}
