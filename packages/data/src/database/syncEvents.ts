// WHAT ONE COMPUTER SENDS ANOTHER, AND EXACTLY WHAT IS IN IT.
//
// This file is the one place the wire shape of a synchronised event is written down. It sits in
// the data layer because the data layer is what produces the events and what has to rebuild the
// rows from them — the transport (@erp/sync) reads these definitions rather than keeping a second
// copy that could drift.
//
// TWO EVENT TYPES ARE DEFINED HERE. Both are insert-only, both name every column their target row
// requires, and both are identified by an explicit aggregate type — never by a field being
// absent.
//
//   QR_MASTER           one carton QR's identity (production.ts insertProduced)
//   PRODUCTION_PRODUCED one production scan              (production.ts appendProducedEvent)
//
// NOT DEFINED HERE, and still travelling as the old catch-all PRODUCTION_EVENT: DAMAGED,
// STORE_ENTRY, STORE_EXIT, ADJUSTMENT, DISPATCH_EVENT and RETURN_EVENT. Each needs the same
// treatment — a type of its own and a payload that names every column — and until it gets one the
// receiving side refuses it outright.
//
// DERIVED VALUES ARE CARRIED, NOT RECOMPUTED. production_events.event_date and event_hour are
// worked out from the local clock when the scan is recorded, so recomputing them on a computer in
// another timezone would quietly produce a different hour. They travel as the origin wrote them.

import { LEASE_DOMAIN, RAW_MATERIAL_QR_STATUS, type LeaseDomain } from "@erp/domain";

/**
 * The write surface these helpers need: one prepared statement, run with bound values.
 *
 * Structural rather than node:sqlite's DatabaseSync, so the same functions work from inside a
 * transaction context here and from the transport package, which must not depend on the driver.
 */
export type SyncSqlValue = null | number | bigint | string | Uint8Array;

export interface SyncWriteStatement {
  run(...params: SyncSqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface SyncWriteHandle {
  prepare(sql: string): SyncWriteStatement;
}

export const SYNC_AGGREGATE = {
  /** A carton QR's identity: which product it is, and when it was registered. */
  QR_MASTER: "QR_MASTER",
  /** One production scan, with everything production_events needs to hold it. */
  PRODUCTION_PRODUCED: "PRODUCTION_PRODUCED",
  /**
   * One product variant's identity, so a carton of it is not refused as unknown.
   *
   * Insert-only and conflict-free: article, colour and size are fixed at creation and nothing
   * edits them. Prices are deliberately NOT carried -- no contract needs them, and the cloud
   * has no use for the company's pricing.
   */
  PRODUCT_VARIANT: "PRODUCT_VARIANT",
  /** One run of raw-material packet labels: which supplier, which material, which serials. */
  RAW_MATERIAL_QR_BATCH: "RAW_MATERIAL_QR_BATCH",
  /**
   * One raw-material packet's identity: its run, its serial, and what one packet holds. The
   * packet's movement status is NOT carried -- it is derived on each computer from the packet's
   * events (docs/37 Class A, "the one trap in this class").
   */
  RAW_MATERIAL_QR: "RAW_MATERIAL_QR",
} as const;

export type SyncAggregateType = (typeof SYNC_AGGREGATE)[keyof typeof SYNC_AGGREGATE];

// The lease domains live in @erp/domain (leases.ts): one definition, re-exported here.
export { LEASE_DOMAIN, type LeaseDomain };

/**
 * The lease each leased event type is written under. A type that is not here is not leased --
 * carton flows -- and is queued without an epoch.
 *
 * enqueueSyncEvent stamps a leased event with this computer's cached epoch for its domain, in the
 * same insert, so no caller can forget it. The cloud accepts the event only while that epoch is
 * still this computer's lease (cloud migrations 011 and 012).
 */
export const LEASED_AGGREGATE_DOMAIN: Readonly<Partial<Record<SyncAggregateType, LeaseDomain>>> = {
  [SYNC_AGGREGATE.RAW_MATERIAL_QR_BATCH]: LEASE_DOMAIN.RAW_MATERIAL_STORE,
  [SYNC_AGGREGATE.RAW_MATERIAL_QR]: LEASE_DOMAIN.RAW_MATERIAL_STORE,
};

/** The lease an event type is written under, or null when it is not leased. */
export const leaseDomainOf = (aggregateType: string): LeaseDomain | null =>
  (LEASED_AGGREGATE_DOMAIN as Readonly<Record<string, LeaseDomain | undefined>>)[aggregateType] ?? null;

/** One identity per QR, for all time. */
export const qrMasterDedupeKey = (qrId: string): string => `${SYNC_AGGREGATE.QR_MASTER}:${qrId}`;
/** One identity per variant, for all time. */
export const productVariantDedupeKey = (variantId: string): string =>
  `${SYNC_AGGREGATE.PRODUCT_VARIANT}:${variantId}`;
/** One per production event id. */
export const productionProducedDedupeKey = (eventId: string): string =>
  `${SYNC_AGGREGATE.PRODUCTION_PRODUCED}:${eventId}`;
/** One per label run. */
export const rawMaterialQrBatchDedupeKey = (batchId: string): string =>
  `${SYNC_AGGREGATE.RAW_MATERIAL_QR_BATCH}:${batchId}`;
/** One identity per packet, for all time. */
export const rawMaterialQrDedupeKey = (qrId: string): string => `${SYNC_AGGREGATE.RAW_MATERIAL_QR}:${qrId}`;

// ─── QR_MASTER ──────────────────────────────────────────────────────────────

/**
 * A qr_master row is created in one place and always with the same opening state: PRODUCED, at
 * the FACTORY, no location id, no first event. Only these three facts vary, and none of them
 * changes afterwards, so there is never anything to merge.
 */
export interface QrMasterPayload {
  readonly qrId: string;
  readonly productVariantId: string;
  readonly createdAt: string;
}

/** The opening state the receiver writes. Not carried: it cannot vary, so it cannot be wrong. */
export const QR_MASTER_OPENING_STATE = {
  currentStatus: "PRODUCED",
  currentLocationType: "FACTORY",
  currentLocationId: null,
  firstEventId: null,
} as const;

// ─── PRODUCT_VARIANT ───────────────────────────────────────────────────────

/**
 * A variant's identity, and nothing else.
 *
 * No price. `status` is not carried either: a variant arrives ACTIVE, and retirement is each
 * computer's own record (a variant retired here is still a real product elsewhere). That makes
 * the payload immutable in practice, which is what lets it be insert-only.
 */
export interface ProductVariantPayload {
  readonly variantId: string;
  readonly article: string;
  readonly color: string;
  readonly size: string;
  readonly description: string | null;
  readonly createdAt: string;
}

/** Reads a PRODUCT_VARIANT payload off the wire, or returns null. Nothing is defaulted (R25). */
export function readProductVariantPayload(payload: Record<string, unknown>): ProductVariantPayload | null {
  const text = (key: string): string | null => {
    const value = payload[key];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };
  const variantId = text("variantId");
  const article = text("article");
  const color = text("color");
  const size = text("size");
  const createdAt = text("createdAt");
  if (variantId === null || article === null || color === null || size === null || createdAt === null) {
    return null;
  }
  const description = payload.description;
  return {
    variantId,
    article,
    color,
    size,
    description: typeof description === "string" && description !== "" ? description : null,
    createdAt,
  };
}

// ─── PRODUCTION_PRODUCED ────────────────────────────────────────────────────

/**
 * Every column production_events needs for a PRODUCED row, as appendProducedEvent writes it.
 *
 * `metadataJson` travels as the exact text that was stored rather than as its parts, so what the
 * receiver holds is what the origin recorded, character for character.
 */
export interface ProductionProducedPayload {
  readonly eventId: string;
  readonly qrId: string;
  readonly productVariantId: string;
  readonly occurredAt: string;
  /** Carried, not recomputed: both come from the recording computer's local clock. */
  readonly eventDate: string;
  readonly eventHour: number;
  readonly factoryId: string;
  readonly workstationId: string;
  readonly operatorId: string | null;
  readonly deviceId: string;
  readonly article: string;
  readonly color: string;
  readonly size: string;
  readonly serial: string;
  readonly metadataJson: string;
  readonly createdAt: string;
  readonly sourceApp: string;
}

// ─── Reading what arrived (R25) ─────────────────────────────────────────────
//
// Nothing off the wire is trusted. A payload missing any required fact is refused by the caller,
// never completed with a default: a production event that has lost its article or its hour is a
// broken record, not a record to patch up.

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

export function readQrMasterPayload(payload: Record<string, unknown>): QrMasterPayload | null {
  const qrId = text(payload.qrId);
  const productVariantId = text(payload.productVariantId);
  const createdAt = text(payload.createdAt);
  if (qrId === null || productVariantId === null || createdAt === null) return null;
  return { qrId, productVariantId, createdAt };
}

export function readProductionProducedPayload(
  payload: Record<string, unknown>
): ProductionProducedPayload | null {
  const required = {
    eventId: text(payload.eventId),
    qrId: text(payload.qrId),
    productVariantId: text(payload.productVariantId),
    occurredAt: text(payload.occurredAt),
    eventDate: text(payload.eventDate),
    factoryId: text(payload.factoryId),
    workstationId: text(payload.workstationId),
    deviceId: text(payload.deviceId),
    article: text(payload.article),
    color: text(payload.color),
    size: text(payload.size),
    serial: text(payload.serial),
    createdAt: text(payload.createdAt),
    sourceApp: text(payload.sourceApp),
  };
  if (Object.values(required).some((value) => value === null)) return null;

  const eventHour = payload.eventHour;
  if (typeof eventHour !== "number" || !Number.isInteger(eventHour) || eventHour < 0 || eventHour > 23) {
    return null;
  }
  // metadata_json is nullable in the table but always written, so an empty string is accepted
  // while a non-string is not.
  if (typeof payload.metadataJson !== "string") return null;
  // operator_id is a real foreign key and genuinely optional. Absent and null both mean "none".
  const operatorId = payload.operatorId === undefined || payload.operatorId === null
    ? null
    : text(payload.operatorId);
  if (payload.operatorId !== undefined && payload.operatorId !== null && operatorId === null) return null;

  return {
    eventId: required.eventId as string,
    qrId: required.qrId as string,
    productVariantId: required.productVariantId as string,
    occurredAt: required.occurredAt as string,
    eventDate: required.eventDate as string,
    eventHour,
    factoryId: required.factoryId as string,
    workstationId: required.workstationId as string,
    operatorId,
    deviceId: required.deviceId as string,
    article: required.article as string,
    color: required.color as string,
    size: required.size as string,
    serial: required.serial as string,
    metadataJson: payload.metadataJson,
    createdAt: required.createdAt as string,
    sourceApp: required.sourceApp as string,
  };
}

// ─── RAW_MATERIAL_QR_BATCH and RAW_MATERIAL_QR ──────────────────────────────

/**
 * A run of packet labels, as generateRawMaterialQrBatch writes it. Insert-only: nothing edits a
 * run after it is printed.
 */
export interface RawMaterialQrBatchPayload {
  readonly batchId: string;
  readonly partyId: string;
  readonly itemId: string;
  readonly startSequence: number;
  readonly endSequence: number;
  readonly quantity: number;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly requestedBy: string | null;
}

/**
 * One packet's identity. `packingQuantity` is what one packet holds, in `packingUnitId`. It is
 * written once when the label is generated and never edited (correcting a material's pack changes
 * inventory_items, not the packets already printed), so it belongs to the identity. Both are
 * null only on packets printed before packing existed.
 */
export interface RawMaterialQrPayload {
  readonly qrId: string;
  readonly batchId: string;
  readonly partyId: string;
  readonly itemId: string;
  readonly sequence: number;
  readonly packingQuantity: number | null;
  readonly packingUnitId: string | null;
  readonly createdAt: string;
}

/**
 * The state a packet is printed in, which the receiver writes. Not carried: where a packet is now
 * is derived from its events on each computer, so a value shipped here could only be stale.
 */
export const RAW_MATERIAL_QR_OPENING_STATE = {
  status: RAW_MATERIAL_QR_STATUS.GENERATED,
  currentStatus: RAW_MATERIAL_QR_STATUS.GENERATED,
  currentSectionId: null,
  currentHopIndex: 0,
} as const;

const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

/** Absent and null both mean "none". Anything else must be non-empty text, or the payload is bad. */
const optionalText = (value: unknown): { ok: true; value: string | null } | { ok: false } => {
  if (value === undefined || value === null) return { ok: true, value: null };
  const read = text(value);
  return read === null ? { ok: false } : { ok: true, value: read };
};

export function readRawMaterialQrBatchPayload(payload: Record<string, unknown>): RawMaterialQrBatchPayload | null {
  const batchId = text(payload.batchId);
  const partyId = text(payload.partyId);
  const itemId = text(payload.itemId);
  const createdAt = text(payload.createdAt);
  const startSequence = positiveInteger(payload.startSequence);
  const endSequence = positiveInteger(payload.endSequence);
  const quantity = positiveInteger(payload.quantity);
  const createdBy = optionalText(payload.createdBy);
  const requestedBy = optionalText(payload.requestedBy);
  if (batchId === null || partyId === null || itemId === null || createdAt === null) return null;
  if (startSequence === null || endSequence === null || quantity === null) return null;
  if (!createdBy.ok || !requestedBy.ok) return null;
  // A run that does not add up is a broken record, not one to repair.
  if (endSequence - startSequence + 1 !== quantity) return null;
  return {
    batchId, partyId, itemId, startSequence, endSequence, quantity, createdAt,
    createdBy: createdBy.value,
    requestedBy: requestedBy.value,
  };
}

export function readRawMaterialQrPayload(payload: Record<string, unknown>): RawMaterialQrPayload | null {
  const qrId = text(payload.qrId);
  const batchId = text(payload.batchId);
  const partyId = text(payload.partyId);
  const itemId = text(payload.itemId);
  const createdAt = text(payload.createdAt);
  const sequence = positiveInteger(payload.sequence);
  const packingUnitId = optionalText(payload.packingUnitId);
  if (qrId === null || batchId === null || partyId === null || itemId === null || createdAt === null) return null;
  if (sequence === null || !packingUnitId.ok) return null;

  // Packing travels as a pair: both present, or both absent on an old packet.
  const rawQuantity = payload.packingQuantity;
  const hasQuantity = rawQuantity !== undefined && rawQuantity !== null;
  if (hasQuantity !== (packingUnitId.value !== null)) return null;
  if (hasQuantity && !(typeof rawQuantity === "number" && Number.isFinite(rawQuantity) && rawQuantity > 0)) return null;

  return {
    qrId, batchId, partyId, itemId, sequence, createdAt,
    packingQuantity: hasQuantity ? (rawQuantity as number) : null,
    packingUnitId: packingUnitId.value,
  };
}

// ─── Putting an event in the outbox ─────────────────────────────────────────

export interface EnqueueInput {
  readonly outboxId: string;
  readonly aggregateType: SyncAggregateType;
  readonly aggregateId: string;
  readonly dedupeKey: string;
  readonly payload: Record<string, unknown>;
  readonly nowIso: string;
}

/**
 * Queues one event for sending, from inside the transaction that is recording the business fact.
 *
 * Two rules, both about never harming the local write:
 *
 *   * A repeat is ignored rather than refused. dedupe_key is UNIQUE, and letting that constraint
 *     throw would fail a legitimate save for a reason that has nothing to do with the business.
 *   * NOTHING here throws. If queueing fails — a constraint nobody foresaw, a schema that has not
 *     been migrated yet — the business transaction still commits. Losing the chance to tell
 *     another computer about a carton is bad. Losing the carton is worse.
 *
 * A LEASED event is stamped with this computer's cached lease epoch for its domain, read in the
 * same insert (migration 093). The write gate has already refused the write unless this computer
 * holds that lease, so the cached epoch is its own. With no cached lease the epoch is null, and
 * the drain leaves the row for the backfill rather than sending it.
 *
 * Returns true when a row was queued. False means either a duplicate or a failure, and the caller
 * is expected to log rather than abort.
 */
export function enqueueSyncEvent(db: SyncWriteHandle, input: EnqueueInput): boolean {
  const domain = leaseDomainOf(input.aggregateType);
  try {
    const result = db
      .prepare(
        `INSERT INTO sync_outbox (
           id, aggregate_type, aggregate_id, operation, dedupe_key,
           payload_json, status, lock_token, available_at, attempts, last_error, created_at, updated_at
           ${domain === null ? "" : ", lease_epoch"}
         ) VALUES (?, ?, ?, 'INSERT', ?, ?, 'PENDING', NULL, ?, 0, NULL, ?, ?
           ${domain === null ? "" : ", (SELECT epoch FROM sync_domain_leases WHERE domain = ?)"})
         ON CONFLICT(dedupe_key) DO NOTHING`
      )
      .run(
        input.outboxId,
        input.aggregateType,
        input.aggregateId,
        input.dedupeKey,
        JSON.stringify(input.payload),
        input.nowIso,
        input.nowIso,
        input.nowIso,
        ...(domain === null ? [] : [domain])
      );
    return Number(result.changes) > 0;
  } catch {
    return false;
  }
}

/** Queues one carton QR's identity. Call inside the transaction inserting the qr_master row. */
export function enqueueQrMaster(db: SyncWriteHandle, payload: QrMasterPayload, outboxId: string): boolean {
  return enqueueSyncEvent(db, {
    outboxId,
    aggregateType: SYNC_AGGREGATE.QR_MASTER,
    aggregateId: payload.qrId,
    dedupeKey: qrMasterDedupeKey(payload.qrId),
    payload: { ...payload },
    nowIso: payload.createdAt,
  });
}

/**
 * Queues one product variant's identity. Call inside the transaction that queues a carton of it.
 *
 * Idempotent by dedupe key, so queueing it on every carton costs one row per variant for all
 * time rather than one per carton.
 */
export function enqueueProductVariant(db: SyncWriteHandle, payload: ProductVariantPayload, outboxId: string): boolean {
  return enqueueSyncEvent(db, {
    outboxId,
    aggregateType: SYNC_AGGREGATE.PRODUCT_VARIANT,
    aggregateId: payload.variantId,
    dedupeKey: productVariantDedupeKey(payload.variantId),
    payload: { ...payload },
    nowIso: payload.createdAt,
  });
}

/**
 * Queues one label run. Call inside the transaction inserting the raw_material_qr_batches row,
 * BEFORE queueing its packets: the outbox is sent in the order it was written, and a packet
 * whose run has not arrived only waits.
 */
export function enqueueRawMaterialQrBatch(
  db: SyncWriteHandle,
  payload: RawMaterialQrBatchPayload,
  outboxId: string
): boolean {
  return enqueueSyncEvent(db, {
    outboxId,
    aggregateType: SYNC_AGGREGATE.RAW_MATERIAL_QR_BATCH,
    aggregateId: payload.batchId,
    dedupeKey: rawMaterialQrBatchDedupeKey(payload.batchId),
    payload: { ...payload },
    nowIso: payload.createdAt,
  });
}

/**
 * Queues one packet's identity. Call inside the transaction inserting the raw_material_qrs row.
 *
 * Keyed by packet id. A packet id can be printed again after its run is erased, so an erase must
 * withdraw these rows before a reprint queues new ones -- see withdrawQueuedRawMaterialQrBatch.
 */
export function enqueueRawMaterialQr(db: SyncWriteHandle, payload: RawMaterialQrPayload, outboxId: string): boolean {
  return enqueueSyncEvent(db, {
    outboxId,
    aggregateType: SYNC_AGGREGATE.RAW_MATERIAL_QR,
    aggregateId: payload.qrId,
    dedupeKey: rawMaterialQrDedupeKey(payload.qrId),
    payload: { ...payload },
    nowIso: payload.createdAt,
  });
}

// ─── Taking queued events back ──────────────────────────────────────────────

/** The read-and-write surface needed to inspect queue rows before deleting them. */
export interface SyncQueueHandle {
  prepare(sql: string): {
    run(...params: SyncSqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    all(...params: SyncSqlValue[]): unknown[];
  };
}

export type WithdrawOutcome =
  /** Every queued row was still unsent, and all of them are gone. Zero means none was queued. */
  | { readonly kind: "WITHDRAWN"; readonly withdrawn: number }
  /** At least one row may already have reached the cloud. Nothing was deleted. */
  | { readonly kind: "MAY_HAVE_LEFT"; readonly rows: number };

/** Kept well under SQLite's bound-parameter limit. */
const KEYS_PER_STATEMENT = 400;

const inChunks = <T>(items: readonly T[]): T[][] => {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += KEYS_PER_STATEMENT) {
    chunks.push(items.slice(start, start + KEYS_PER_STATEMENT));
  }
  return chunks;
};

/**
 * Removes queued events for something being erased -- but only if none of them can have left this
 * computer. All or nothing.
 *
 * "CANNOT HAVE LEFT" MEANS NEVER ATTEMPTED: PENDING with no attempt of either kind. A FAILED or
 * retried row may have been delivered with only the answer lost, an IN_FLIGHT row is being sent
 * right now, and a SYNCED row is in the cloud. For any of those the erase is no longer local: other
 * computers may hold the rows, and taking the queue back would leave them holding something this
 * computer says never existed. The caller must refuse instead.
 *
 * Call inside the caller's BEGIN IMMEDIATE transaction, so the check and the delete cannot be
 * split by a sync pass leasing the same rows.
 */
export function withdrawUnsentSyncEvents(db: SyncQueueHandle, dedupeKeys: readonly string[]): WithdrawOutcome {
  const chunks = inChunks(dedupeKeys);
  let mayHaveLeft = 0;
  for (const keys of chunks) {
    const rows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sync_outbox
         WHERE dedupe_key IN (${keys.map(() => "?").join(", ")})
           AND NOT (status = 'PENDING' AND attempts = 0 AND transient_attempts = 0)`
      )
      .all(...keys) as Array<{ n: number | bigint }>;
    mayHaveLeft += Number(rows[0]?.n ?? 0);
  }
  if (mayHaveLeft > 0) return { kind: "MAY_HAVE_LEFT", rows: mayHaveLeft };

  let withdrawn = 0;
  for (const keys of chunks) {
    const result = db
      .prepare(`DELETE FROM sync_outbox WHERE dedupe_key IN (${keys.map(() => "?").join(", ")})`)
      .run(...keys);
    withdrawn += Number(result.changes);
  }
  return { kind: "WITHDRAWN", withdrawn };
}

/** The queued events of one label run: the run itself and each of its packets. */
export const rawMaterialQrBatchDedupeKeys = (batchId: string, qrIds: readonly string[]): string[] => [
  rawMaterialQrBatchDedupeKey(batchId),
  ...qrIds.map(rawMaterialQrDedupeKey),
];

/** Queues one production scan. Call inside the transaction appending the production_events row. */
export function enqueueProductionProduced(
  db: SyncWriteHandle,
  payload: ProductionProducedPayload,
  outboxId: string
): boolean {
  return enqueueSyncEvent(db, {
    outboxId,
    aggregateType: SYNC_AGGREGATE.PRODUCTION_PRODUCED,
    aggregateId: payload.eventId,
    dedupeKey: productionProducedDedupeKey(payload.eventId),
    payload: { ...payload },
    nowIso: payload.createdAt,
  });
}
