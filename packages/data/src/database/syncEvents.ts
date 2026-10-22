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
} as const;

export type SyncAggregateType = (typeof SYNC_AGGREGATE)[keyof typeof SYNC_AGGREGATE];

/** One identity per QR, for all time. */
export const qrMasterDedupeKey = (qrId: string): string => `${SYNC_AGGREGATE.QR_MASTER}:${qrId}`;
/** One identity per variant, for all time. */
export const productVariantDedupeKey = (variantId: string): string =>
  `${SYNC_AGGREGATE.PRODUCT_VARIANT}:${variantId}`;
/** One per production event id. */
export const productionProducedDedupeKey = (eventId: string): string =>
  `${SYNC_AGGREGATE.PRODUCTION_PRODUCED}:${eventId}`;

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
 * Returns true when a row was queued. False means either a duplicate or a failure, and the caller
 * is expected to log rather than abort.
 */
export function enqueueSyncEvent(db: SyncWriteHandle, input: EnqueueInput): boolean {
  try {
    const result = db
      .prepare(
        `INSERT INTO sync_outbox (
           id, aggregate_type, aggregate_id, operation, dedupe_key,
           payload_json, status, lock_token, available_at, attempts, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, 'INSERT', ?, ?, 'PENDING', NULL, ?, 0, NULL, ?, ?)
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
        input.nowIso
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
