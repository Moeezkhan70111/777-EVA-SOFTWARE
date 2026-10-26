// THE ONE-TIME BACKFILL: the store PC sends what it held before it synced (docs/37, the stock-screen
// slice, item 3).
//
// Everything written since this computer started syncing travels on its own: capture marks master
// records and stock movements, and label runs queue as they are printed. What was written BEFORE --
// years of materials, parties and stock history -- was never marked, or was queued without a lease
// epoch and can never be sent as it is. A new PC is filled from the cloud alone, so all of it has to
// go up once.
//
// THE BACKFILL ONLY MARKS. It writes no business table. It marks every master record and every
// stock movement recorded here under the lease held now, stamps the label runs and packets queued
// without an epoch, and queues those never queued at all. The ordinary passes then send it all, by
// the same builders and pushes as any new change -- prerequisites first, a material ahead of its
// stock.
//
// IT REFUSES, RATHER THAN SEND STOCK THAT DOES NOT ADD UP. A receiving computer's balance is the sum
// of the movements it receives. If, for any material here, the movements do not add up to the
// balance (or are in another unit than the balance), sending them would give every other computer a
// wrong number for that material with full confidence. So the plan lists those materials and the
// backfill sends nothing until the owner has decided what each one should be.
//
// Safe to run twice: a movement, run or packet already sent is a duplicate everywhere, and a master
// record simply travels as its next revision.

import { stockEventBalanceDelta } from "@erp/domain";
import { MASTER_RECORD_TYPES, MASTER_RECORDS, type BuildHandle, type MasterRecordType } from "./masterRecords.js";
import {
  enqueueRawMaterialQr,
  enqueueRawMaterialQrBatch,
  heldLeaseEpoch,
  LEASE_DOMAIN,
  SYNC_AGGREGATE,
} from "./syncEvents.js";
import crypto from "node:crypto";

/** Where the last completed backfill is recorded (app_settings: per computer, never replicated). */
export const BACKFILL_SETTING_KEY = "sync.backfill.last";

/** Balances and movement sums closer than this are equal: quantities are REAL. */
const TOLERANCE = 1e-6;

export interface StockMismatch {
  readonly itemId: string;
  readonly displayName: string;
  /** What inventory_stock_balances says. */
  readonly balance: number;
  /** What the movements add up to, read by the store's own sign rule. */
  readonly fromMovements: number;
  /** A movement is recorded in another unit than the balance. */
  readonly unitDiffers: boolean;
}

export interface BackfillPlan {
  /** The epochs the marks would carry, or null when this computer does not hold that lease. */
  readonly masterEpoch: number | null;
  readonly storeEpoch: number | null;
  readonly masterRecords: Readonly<Record<MasterRecordType, number>>;
  readonly stockMovements: number;
  readonly labelRunsToQueue: number;
  readonly packetsToQueue: number;
  /** Runs and packets already queued without an epoch, which the backfill stamps. */
  readonly unstampedQueued: number;
  readonly mismatches: readonly StockMismatch[];
}

export type BackfillOutcome =
  | { readonly done: true; readonly plan: BackfillPlan }
  | { readonly done: false; readonly reason: "NO_LEASE" | "STOCK_DOES_NOT_ADD_UP"; readonly plan: BackfillPlan };

type Row = Record<string, unknown>;
const count = (db: BuildHandle, sql: string, ...params: unknown[]): number => Number((db.prepare(sql).all(...params)[0] as Row | undefined)?.n ?? 0);

/** Own runs and packets not in the outbox at all. Received ones (replicated_at set) are not ours to send. */
const UNQUEUED_RUNS = `SELECT * FROM raw_material_qr_batches b WHERE b.replicated_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.dedupe_key = 'RAW_MATERIAL_QR_BATCH:' || b.id)`;
const UNQUEUED_PACKETS = `SELECT * FROM raw_material_qrs q WHERE q.replicated_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.dedupe_key = 'RAW_MATERIAL_QR:' || q.id)`;
const UNSTAMPED_QUEUED = `FROM sync_outbox WHERE aggregate_type IN ('RAW_MATERIAL_QR_BATCH', 'RAW_MATERIAL_QR')
  AND lease_epoch IS NULL AND status IN ('PENDING', 'FAILED')`;

/** When the last backfill finished on this computer, or null when it never has. */
export function lastBackfillAt(db: BuildHandle): string | null {
  const row = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?").all(BACKFILL_SETTING_KEY)[0] as Row | undefined;
  try {
    const parsed: unknown = JSON.parse(String(row?.setting_value ?? "null"));
    const at = typeof parsed === "object" && parsed !== null ? (parsed as { at?: unknown }).at : null;
    return typeof at === "string" ? at : null;
  } catch {
    return null;
  }
}

/** Every material whose recorded movements do not add up to its balance, or are in another unit. */
export function stockMismatches(db: BuildHandle): StockMismatch[] {
  const events = db.prepare("SELECT item_id, event_type, quantity, unit_id FROM inventory_stock_events").all() as Row[];
  const balances = db.prepare("SELECT item_id, quantity_on_hand, unit_id FROM inventory_stock_balances").all() as Row[];
  const byItem = new Map<string, { sum: number; units: Set<string> }>();
  for (const event of events) {
    const itemId = String(event.item_id);
    const entry = byItem.get(itemId) ?? { sum: 0, units: new Set<string>() };
    entry.sum += stockEventBalanceDelta(String(event.event_type), Number(event.quantity));
    entry.units.add(String(event.unit_id));
    byItem.set(itemId, entry);
  }
  const balanceOf = new Map(balances.map((row) => [String(row.item_id), { quantity: Number(row.quantity_on_hand), unit: String(row.unit_id) }]));
  const items = new Set([...byItem.keys(), ...balanceOf.keys()]);
  const mismatches: StockMismatch[] = [];
  for (const itemId of items) {
    const moved = byItem.get(itemId) ?? { sum: 0, units: new Set<string>() };
    const balance = balanceOf.get(itemId);
    const unitDiffers = balance !== undefined && [...moved.units].some((unit) => unit !== balance.unit);
    if (!unitDiffers && Math.abs((balance?.quantity ?? 0) - moved.sum) < TOLERANCE) continue;
    const name = db.prepare("SELECT display_name FROM inventory_items WHERE id = ?").all(itemId)[0] as Row | undefined;
    mismatches.push({
      itemId,
      displayName: String(name?.display_name ?? itemId),
      balance: balance?.quantity ?? 0,
      fromMovements: moved.sum,
      unitDiffers,
    });
  }
  return mismatches.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** What a backfill would send from here, and whether it can. Reads only. */
export function planBackfill(db: BuildHandle): BackfillPlan {
  const masterRecords = Object.fromEntries(
    MASTER_RECORD_TYPES.map((type) => [type, count(db, `SELECT COUNT(*) AS n FROM ${MASTER_RECORDS[type].table}`)])
  ) as Record<MasterRecordType, number>;
  return {
    masterEpoch: heldLeaseEpoch(db, LEASE_DOMAIN.MASTER_DATA),
    storeEpoch: heldLeaseEpoch(db, LEASE_DOMAIN.RAW_MATERIAL_STORE),
    masterRecords,
    stockMovements: count(db, "SELECT COUNT(*) AS n FROM inventory_stock_events WHERE replicated_at IS NULL"),
    labelRunsToQueue: count(db, `SELECT COUNT(*) AS n FROM (${UNQUEUED_RUNS})`),
    packetsToQueue: count(db, `SELECT COUNT(*) AS n FROM (${UNQUEUED_PACKETS})`),
    unstampedQueued: count(db, `SELECT COUNT(*) AS n ${UNSTAMPED_QUEUED}`),
    mismatches: stockMismatches(db),
  };
}

/**
 * Marks everything this computer held before it synced, in one transaction. Refuses, marking
 * nothing, when a lease is unknown here or any material's stock does not add up.
 *
 * The caller is the lease-guarded write path: only the holder of both leases, caught up.
 */
export function runBackfill(db: BuildHandle, nowIso: string): BackfillOutcome {
  const plan = planBackfill(db);
  if (plan.masterEpoch === null || plan.storeEpoch === null) return { done: false, reason: "NO_LEASE", plan };
  if (plan.mismatches.length > 0) return { done: false, reason: "STOCK_DOES_NOT_ADD_UP", plan };

  db.exec("BEGIN IMMEDIATE");
  try {
    markEverything(db, plan.masterEpoch, plan.storeEpoch, nowIso);
    queueLabels(db);
    db.prepare(`UPDATE sync_outbox SET lease_epoch = ? WHERE aggregate_type IN ('RAW_MATERIAL_QR_BATCH', 'RAW_MATERIAL_QR')
      AND lease_epoch IS NULL AND status IN ('PENDING', 'FAILED')`).run(plan.storeEpoch);
    db.prepare(
      `INSERT INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at)
       VALUES (?, ?, 'json', 0, 'backfill', ?)
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`
    ).run(BACKFILL_SETTING_KEY, JSON.stringify({ at: nowIso, plan }), nowIso);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { done: true, plan };
}

const MARK = `INSERT INTO sync_dirty_records (aggregate_type, record_id, lease_epoch, marked_at)
  SELECT ?, id, ?, ? FROM {table} {where}
  ON CONFLICT (aggregate_type, record_id) DO UPDATE SET lease_epoch = excluded.lease_epoch, marked_at = excluded.marked_at`;

function markEverything(db: BuildHandle, masterEpoch: number, storeEpoch: number, nowIso: string): void {
  for (const type of MASTER_RECORD_TYPES) {
    // "WHERE true": SQLite reads ON CONFLICT after a bare FROM as a join constraint.
    db.prepare(MARK.replace("{table}", MASTER_RECORDS[type].table).replace("{where}", "WHERE true")).run(type, masterEpoch, nowIso);
  }
  // Only movements recorded here: one received from another computer is already in the cloud.
  db.prepare(MARK.replace("{table}", "inventory_stock_events").replace("{where}", "WHERE replicated_at IS NULL"))
    .run(SYNC_AGGREGATE.STOCK_EVENT, storeEpoch, nowIso);
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** Queues own runs, then their packets, that were never queued. Stamped from the lease cache. */
function queueLabels(db: BuildHandle): void {
  for (const run of db.prepare(UNQUEUED_RUNS).all() as Row[]) {
    enqueueRawMaterialQrBatch(db, {
      batchId: String(run.id),
      partyId: String(run.party_id),
      itemId: String(run.item_id),
      startSequence: Number(run.start_sequence),
      endSequence: Number(run.end_sequence),
      quantity: Number(run.quantity),
      createdAt: String(run.created_at),
      createdBy: text(run.created_by),
      requestedBy: text(run.requested_by),
    }, crypto.randomUUID());
  }
  for (const packet of db.prepare(UNQUEUED_PACKETS).all() as Row[]) {
    const packing = packet.packing_quantity === null || packet.packing_quantity === undefined ? null : Number(packet.packing_quantity);
    enqueueRawMaterialQr(db, {
      qrId: String(packet.id),
      batchId: String(packet.batch_id),
      partyId: String(packet.party_id),
      itemId: String(packet.item_id),
      sequence: Number(packet.sequence),
      packingQuantity: packing,
      packingUnitId: packing === null ? null : text(packet.packing_unit_id),
      createdAt: String(packet.created_at),
    }, crypto.randomUUID());
  }
}
