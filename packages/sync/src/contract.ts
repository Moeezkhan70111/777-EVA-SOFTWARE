// THE WIRE: what an event looks like in transit, and which ones may travel.
//
// The event contracts themselves — field names, payload shapes, dedupe keys — live in
// @erp/data's syncEvents.ts, beside the code that writes those rows. They are re-exported here so
// there is one definition, not a sender's copy and a receiver's copy drifting apart.
//
// SUPPORTED TODAY
//
//   QR_MASTER            one carton QR's identity
//   PRODUCTION_PRODUCED  one production scan, with every column its row requires
//
// Both are insert-only, both name an explicit aggregate type, and neither carries a value that
// could need merging.
//
// NOT SUPPORTED, and refused rather than guessed at:
//
//   PRODUCTION_EVENT — still the catch-all for DAMAGED (qrCodes.ts), STORE_ENTRY and STORE_EXIT
//     (store.ts) and ADJUSTMENT (dispatch.ts): three payload shapes under one name. Each needs
//     its own type and a payload naming every column, exactly as PRODUCED now has.
//
//   DISPATCH_EVENT, RETURN_EVENT — their payloads omit productVariantId and the four NOT NULL
//     snapshot columns, so the row cannot be rebuilt from what is sent. They also move
//     qr_master's status and location, which is mutable state that has to be derived from the
//     events on each computer, never shipped as a value.
//
//   PROJECTION — nothing has ever enqueued one. Stock quantities are counters maintained with
//     `quantity_on_hand = quantity_on_hand + 1`. Carrying them as values would make the last
//     writer win and silently destroy the other computer's count.

import { SYNC_AGGREGATE, type SyncAggregateType } from "@erp/data";

export {
  SYNC_AGGREGATE,
  QR_MASTER_OPENING_STATE,
  qrMasterDedupeKey,
  productionProducedDedupeKey,
  readQrMasterPayload,
  readProductVariantPayload,
  readProductionProducedPayload,
  productVariantDedupeKey,
} from "@erp/data";
export type { SyncAggregateType, QrMasterPayload, ProductVariantPayload, ProductionProducedPayload } from "@erp/data";

export const SUPPORTED_AGGREGATE_TYPES = [
  SYNC_AGGREGATE.PRODUCT_VARIANT,
  SYNC_AGGREGATE.QR_MASTER,
  SYNC_AGGREGATE.PRODUCTION_PRODUCED,
] as const;

export type SupportedAggregateType = SyncAggregateType;

export const isSupportedAggregateType = (value: unknown): value is SupportedAggregateType =>
  typeof value === "string" && (SUPPORTED_AGGREGATE_TYPES as readonly string[]).includes(value);

/** One business event on the wire. */
export interface SyncEnvelope {
  /** Globally unique for the business event. The receiver's protection against a repeat. */
  readonly dedupeKey: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly operation: "INSERT" | "UPDATE";
  readonly payload: Record<string, unknown>;
  /** Which installation produced it. Recorded for tracing, never used to decide a winner. */
  readonly originDeviceId: string;
  /** UTC ISO 8601, as everything in this system is stored (R16). */
  readonly createdAt: string;
}

// ─── Validation at the boundary (R25) ───────────────────────────────────────
//
// Nothing that arrives over the wire is trusted. An envelope that is not shaped like an envelope
// never reaches an applier, and a payload that does not say exactly what its contract requires is
// refused as a permanent failure rather than patched up with defaults.

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

export const isSyncEnvelope = (value: unknown): value is SyncEnvelope => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    isNonEmptyString(record.dedupeKey) &&
    isNonEmptyString(record.aggregateType) &&
    isNonEmptyString(record.aggregateId) &&
    (record.operation === "INSERT" || record.operation === "UPDATE") &&
    typeof record.payload === "object" &&
    record.payload !== null &&
    isNonEmptyString(record.originDeviceId) &&
    isNonEmptyString(record.createdAt)
  );
};
