// What this computer is waiting on, and for how long -- so a wait is never silent (owner decision,
// 2026-10-25; docs/37, the stock-screen slice).
//
// A pulled event whose prerequisite has not arrived is parked (parking.ts) and retried until it
// applies. That is right for the data: dropping it would lose it. But a wait that lasts means
// something on this computer is incomplete -- a material whose category never came shows stock
// that is wrong -- so it has to be seen:
//
//   WAITING  under an hour   ordinary ordering lag; nothing is said
//   STUCK    over an hour    a warning
//   STALE    over a day      stays up until the cause is fixed
//
// This reads the park and says, for each entry, WHAT waits (from the event itself), what it waits
// FOR (from its reason), since when, and which material it leaves incomplete -- the stock screen marks
// that row. Words for screens are composed from copy.ts in the renderer; describeWaiting below is the
// plain English the cloud report carries for whoever reads it there.

import { MASTER_RECORDS, isMasterRecordType, SYNC_AGGREGATE } from "@erp/data";
import type { SyncEnvelope } from "./contract.js";
import { asRow, type SyncSqlHandle } from "./sqlPort.js";

export const WAIT_STUCK_AFTER_MS = 60 * 60 * 1000;
export const WAIT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type WaitTier = "WAITING" | "STUCK" | "STALE";

/** What a parked event needs, read out of its reason. */
export type WaitCause =
  | { readonly kind: "MISSING"; readonly record: string; readonly id: string }
  | { readonly kind: "IN_USE"; readonly record: string; readonly id: string }
  | { readonly kind: "NAME_TAKEN"; readonly column: string }
  /** Moved aside so another record's revision could take its name; waits for its own revision. */
  | { readonly kind: "DISPLACED"; readonly columns: readonly string[] }
  | { readonly kind: "OTHER"; readonly code: string };

export interface WaitingEntry {
  readonly dedupeKey: string;
  /** The event's own type and id: what is waiting. */
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** The waiting record's name, read from its own payload, when it has one. */
  readonly name: string | null;
  readonly cause: WaitCause;
  readonly since: string;
  readonly ageMs: number;
  readonly tier: WaitTier;
  /** The material this leaves incomplete here, when there is one. The stock screen marks its row. */
  readonly itemId: string | null;
}

export interface WaitingSummary {
  readonly entries: readonly WaitingEntry[];
  readonly waiting: number;
  readonly stuck: number;
  readonly stale: number;
  readonly oldestSince: string | null;
}

const UNKNOWN_TO_RECORD: Readonly<Record<string, string>> = {
  UNKNOWN_PARTY: SYNC_AGGREGATE.PARTY,
  UNKNOWN_INVENTORY_ITEM: SYNC_AGGREGATE.INVENTORY_ITEM,
  UNKNOWN_INVENTORY_UNIT: SYNC_AGGREGATE.INVENTORY_UNIT,
  UNKNOWN_PRODUCT_VARIANT: SYNC_AGGREGATE.PRODUCT_VARIANT,
  UNKNOWN_FACTORY: "FACTORY",
  UNKNOWN_WORKSTATION: "WORKSTATION",
  UNKNOWN_OPERATOR: "OPERATOR",
};

/** The reason a contract parked an event with, as a cause. Unrecognised reasons are kept as they are. */
export function waitCause(reason: string): WaitCause {
  const [code = "", ...rest] = reason.split(":");
  if ((code === "WAITING_FOR" || code === "STILL_IN_USE") && rest.length >= 2) {
    const [record = "", ...idParts] = rest;
    return { kind: code === "WAITING_FOR" ? "MISSING" : "IN_USE", record, id: idParts.join(":") };
  }
  if (code === "NAME_TAKEN") return { kind: "NAME_TAKEN", column: rest.join(":") };
  const record = UNKNOWN_TO_RECORD[code];
  if (record !== undefined) return { kind: "MISSING", record, id: rest.join(":") };
  return { kind: "OTHER", code: reason };
}

export const waitTier = (ageMs: number): WaitTier =>
  ageMs >= WAIT_STALE_AFTER_MS ? "STALE" : ageMs >= WAIT_STUCK_AFTER_MS ? "STUCK" : "WAITING";

/** The column that names a record, per master record type. */
const NAME_COLUMN: Readonly<Record<string, string>> = {
  [SYNC_AGGREGATE.PARTY_GROUP]: "group_name",
  [SYNC_AGGREGATE.PARTY]: "party_name",
  [SYNC_AGGREGATE.INVENTORY_UNIT]: "name",
  [SYNC_AGGREGATE.UNIT_LADDER_PRESET]: "name",
  [SYNC_AGGREGATE.INVENTORY_CATEGORY]: "name",
  [SYNC_AGGREGATE.INVENTORY_ITEM]: "display_name",
  [SYNC_AGGREGATE.WORK_SECTION]: "name",
  [SYNC_AGGREGATE.MACHINE]: "name",
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** The waiting record's name, and the material it leaves incomplete, from the event itself. */
function describePayload(envelope: SyncEnvelope): { name: string | null; itemId: string | null } {
  const payload = envelope.payload;
  if (isMasterRecordType(envelope.aggregateType) && MASTER_RECORDS[envelope.aggregateType] !== undefined) {
    const body = asRow(payload.body);
    const row = body === null ? null : asRow(body.row);
    const column = NAME_COLUMN[envelope.aggregateType] ?? "name";
    return {
      name: row === null ? null : text(row[column]),
      itemId: envelope.aggregateType === SYNC_AGGREGATE.INVENTORY_ITEM ? text(payload.recordId) : null,
    };
  }
  // Raw-material label runs, packets and stock movements name their material by itemId.
  return { name: null, itemId: text(payload.itemId) };
}

/** Everything this computer is waiting on, oldest first, with each entry's tier at `nowMs`. */
export function waitingSummary(sql: SyncSqlHandle, nowMs: number): WaitingSummary {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = sql.prepare("SELECT dedupe_key, envelope_json, reason, parked_at FROM sync_inbox_parked ORDER BY parked_at, seq").all() as Array<Record<string, unknown>>;
  } catch {
    // Before migration 091 there is no park, and nothing can be waiting.
    return { entries: [], waiting: 0, stuck: 0, stale: 0, oldestSince: null };
  }
  const entries: WaitingEntry[] = [];
  for (const row of rows) {
    let envelope: SyncEnvelope;
    try {
      envelope = JSON.parse(String(row.envelope_json)) as SyncEnvelope;
    } catch {
      continue;
    }
    const since = String(row.parked_at);
    const ageMs = Math.max(0, nowMs - Date.parse(since));
    const { name, itemId } = describePayload(envelope);
    entries.push({
      dedupeKey: String(row.dedupe_key),
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      name,
      cause: waitCause(String(row.reason)),
      since,
      ageMs,
      tier: waitTier(ageMs),
      itemId,
    });
  }
  entries.push(...displacedEntries(sql, nowMs));
  entries.sort((a, b) => a.since.localeCompare(b.since));
  const count = (tier: WaitTier) => entries.filter((entry) => entry.tier === tier).length;
  return { entries, waiting: count("WAITING"), stuck: count("STUCK"), stale: count("STALE"), oldestSince: entries[0]?.since ?? null };
}

/**
 * Records this computer moved aside so another record's revision could take their name
 * (sync_displaced_records, migration 096). Incomplete until their own revision arrives, so they are
 * shown like a wait, under the name they really had.
 */
function displacedEntries(sql: SyncSqlHandle, nowMs: number): WaitingEntry[] {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = sql.prepare("SELECT aggregate_type, record_id, original_json, displaced_at FROM sync_displaced_records").all() as Array<Record<string, unknown>>;
  } catch {
    return []; // before migration 096
  }
  return rows.map((row) => {
    let original: Record<string, unknown> = {};
    try {
      original = asRow(JSON.parse(String(row.original_json))) ?? {};
    } catch {
      original = {};
    }
    const type = String(row.aggregate_type);
    const recordId = String(row.record_id);
    const since = String(row.displaced_at);
    const ageMs = Math.max(0, nowMs - Date.parse(since));
    return {
      dedupeKey: `DISPLACED:${type}:${recordId}`,
      aggregateType: type,
      aggregateId: recordId,
      name: text(Object.values(original).find((value) => typeof value === "string")),
      cause: { kind: "DISPLACED", columns: Object.keys(original) },
      since,
      ageMs,
      tier: waitTier(ageMs),
      itemId: type === SYNC_AGGREGATE.INVENTORY_ITEM ? recordId : null,
    };
  });
}

const RECORD_WORDS: Readonly<Record<string, string>> = {
  [SYNC_AGGREGATE.PARTY_GROUP]: "party group",
  [SYNC_AGGREGATE.PARTY]: "party",
  [SYNC_AGGREGATE.INVENTORY_UNIT]: "unit",
  [SYNC_AGGREGATE.UNIT_LADDER_PRESET]: "unit ladder",
  [SYNC_AGGREGATE.INVENTORY_CATEGORY]: "category",
  [SYNC_AGGREGATE.INVENTORY_ITEM]: "material",
  [SYNC_AGGREGATE.WORK_SECTION]: "work section",
  [SYNC_AGGREGATE.MACHINE]: "machine",
  [SYNC_AGGREGATE.RAW_MATERIAL_QR_BATCH]: "label run",
  [SYNC_AGGREGATE.RAW_MATERIAL_QR]: "packet",
  [SYNC_AGGREGATE.PRODUCT_VARIANT]: "product",
  [SYNC_AGGREGATE.QR_MASTER]: "carton",
  [SYNC_AGGREGATE.PRODUCTION_PRODUCED]: "production scan",
  [SYNC_AGGREGATE.STOCK_EVENT]: "stock movement",
};

export const recordWords = (type: string): string => RECORD_WORDS[type] ?? type.toLowerCase().replace(/_/g, " ");

/**
 * One entry in plain English, for the cloud report (report_sync_health), where whoever reads it has
 * no screen to compose it: "Material NAWAAR -- 5 SOOTAR -- BLACK" waits for "a category the store PC
 * has not sent (c-17)". The screens compose their own words from copy.ts.
 */
export function describeWaiting(entry: WaitingEntry): { subject: string; waitingFor: string; needs?: string } {
  const what = recordWords(entry.aggregateType);
  const subject = `${what.charAt(0).toUpperCase()}${what.slice(1)} ${entry.name ?? entry.aggregateId}`;
  const cause = entry.cause;
  const waitingFor =
    cause.kind === "MISSING"
      ? `a ${recordWords(cause.record)} not on this computer yet (${cause.id})`
      : cause.kind === "IN_USE"
        ? "removal: still in use on this computer"
        : cause.kind === "NAME_TAKEN"
          ? `its name, still held by another record here (${cause.column})`
          : cause.kind === "DISPLACED"
            ? "its own update: its name was moved aside for another record's"
            : cause.code;
  const needs = recordNeeded(entry);
  return needs === null ? { subject, waitingFor } : { subject, waitingFor, needs };
}

/**
 * The master record whose revision would end this wait, as "TYPE:id", or null. The computer holding
 * the lease can send that record again (markRecordToSendAgain). A missing record is the one waited
 * for, a displaced record is itself. Other waits are not ended by resending anything.
 */
export function recordNeeded(entry: WaitingEntry): string | null {
  const cause = entry.cause;
  if (cause.kind === "MISSING" && isMasterRecordType(cause.record)) return `${cause.record}:${cause.id}`;
  if (cause.kind === "DISPLACED" && isMasterRecordType(entry.aggregateType)) return `${entry.aggregateType}:${entry.aggregateId}`;
  return null;
}
