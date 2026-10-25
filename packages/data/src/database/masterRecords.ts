// What a master record IS, and how this computer turns a marked one into a queued revision.
//
// A leased record (cloud migration 013) travels WHOLE: the root row and every row that belongs to
// it -- a material with its field values and unit steps, a category with its fields and their
// options. MASTER_RECORDS says, once, which tables make up each record, how a child row names its
// parent, and which other records a row needs present first. The builder snapshots by it, the
// receiving computer validates and writes by it (packages/sync/src/leasedRecordContracts.ts), and a
// record that has to wait names what it waits for from it.
//
// It must cover exactly the tables MASTER_CAPTURE marks (masterCapture.ts): masterRecords.test.ts
// checks the two agree, so a table cannot be captured and then never sent, or sent and never captured.

import crypto from "node:crypto";
import { enqueueSyncEvent, SYNC_AGGREGATE, type SyncAggregateType, type SyncWriteHandle } from "./syncEvents.js";

export type MasterRecordType =
  | typeof SYNC_AGGREGATE.PARTY_GROUP
  | typeof SYNC_AGGREGATE.PARTY
  | typeof SYNC_AGGREGATE.INVENTORY_UNIT
  | typeof SYNC_AGGREGATE.UNIT_LADDER_PRESET
  | typeof SYNC_AGGREGATE.INVENTORY_CATEGORY
  | typeof SYNC_AGGREGATE.INVENTORY_ITEM
  | typeof SYNC_AGGREGATE.WORK_SECTION
  | typeof SYNC_AGGREGATE.MACHINE;

/** A column naming another record that must be on this computer before this row can be written. */
export interface RecordReference {
  readonly column: string;
  /** The table the id is looked up in. */
  readonly table: string;
  /** The record that brings that row. */
  readonly record: MasterRecordType;
}

export interface RecordTableSpec {
  readonly table: string;
  /** The column holding the parent row's id. Absent on the root, whose key is always `id`. */
  readonly parentColumn?: string;
  readonly references?: readonly RecordReference[];
  readonly children?: readonly RecordTableSpec[];
}

const unitRef = (column: string): RecordReference => ({ column, table: "inventory_units", record: SYNC_AGGREGATE.INVENTORY_UNIT });

/**
 * Every master record type, IN PREREQUISITE ORDER: a record only refers to types before it, except
 * a category's parent category. The builder queues in this order, so a reader usually receives what
 * a record needs before the record itself.
 */
export const MASTER_RECORD_TYPES: readonly MasterRecordType[] = [
  SYNC_AGGREGATE.PARTY_GROUP,
  SYNC_AGGREGATE.INVENTORY_UNIT,
  SYNC_AGGREGATE.WORK_SECTION,
  SYNC_AGGREGATE.UNIT_LADDER_PRESET,
  SYNC_AGGREGATE.INVENTORY_CATEGORY,
  SYNC_AGGREGATE.PARTY,
  SYNC_AGGREGATE.INVENTORY_ITEM,
  SYNC_AGGREGATE.MACHINE,
];

export const MASTER_RECORDS: Readonly<Record<MasterRecordType, RecordTableSpec>> = {
  [SYNC_AGGREGATE.PARTY_GROUP]: { table: "party_groups" },
  [SYNC_AGGREGATE.PARTY]: {
    table: "parties",
    references: [{ column: "party_group_id", table: "party_groups", record: SYNC_AGGREGATE.PARTY_GROUP }],
  },
  [SYNC_AGGREGATE.INVENTORY_UNIT]: {
    table: "inventory_units",
    children: [{ table: "inventory_unit_conversions", parentColumn: "from_unit_id", references: [unitRef("to_unit_id")] }],
  },
  [SYNC_AGGREGATE.UNIT_LADDER_PRESET]: {
    table: "unit_ladder_presets",
    children: [{ table: "unit_ladder_preset_steps", parentColumn: "preset_id", references: [unitRef("from_unit_id"), unitRef("to_unit_id")] }],
  },
  [SYNC_AGGREGATE.INVENTORY_CATEGORY]: {
    table: "inventory_categories",
    references: [{ column: "parent_id", table: "inventory_categories", record: SYNC_AGGREGATE.INVENTORY_CATEGORY }],
    children: [
      {
        table: "inventory_category_fields",
        parentColumn: "category_id",
        children: [{ table: "inventory_category_field_options", parentColumn: "field_id" }],
      },
    ],
  },
  [SYNC_AGGREGATE.INVENTORY_ITEM]: {
    table: "inventory_items",
    references: [
      { column: "category_id", table: "inventory_categories", record: SYNC_AGGREGATE.INVENTORY_CATEGORY },
      unitRef("default_unit_id"),
      unitRef("packing_unit_id"),
      { column: "default_section_id", table: "work_sections", record: SYNC_AGGREGATE.WORK_SECTION },
    ],
    children: [
      {
        table: "inventory_item_values",
        parentColumn: "item_id",
        // A value names a field, and the field comes with its category's record.
        references: [{ column: "field_id", table: "inventory_category_fields", record: SYNC_AGGREGATE.INVENTORY_CATEGORY }],
      },
      { table: "inventory_item_unit_steps", parentColumn: "item_id", references: [unitRef("from_unit_id"), unitRef("to_unit_id")] },
    ],
  },
  [SYNC_AGGREGATE.WORK_SECTION]: { table: "work_sections" },
  [SYNC_AGGREGATE.MACHINE]: {
    table: "machines",
    references: [
      { column: "section_id", table: "work_sections", record: SYNC_AGGREGATE.WORK_SECTION },
      { column: "contractor_party_id", table: "parties", record: SYNC_AGGREGATE.PARTY },
      { column: "packing_contractor_party_id", table: "parties", record: SYNC_AGGREGATE.PARTY },
    ],
  },
};

export const isMasterRecordType = (value: string): value is MasterRecordType =>
  (MASTER_RECORD_TYPES as readonly string[]).includes(value);

/** Every table of a record spec, root first. */
export function specTables(spec: RecordTableSpec): RecordTableSpec[] {
  return [spec, ...(spec.children ?? []).flatMap((child) => specTables(child))];
}

// ─── The record on the wire ─────────────────────────────────────────────────

/** One row, and the rows that belong to it, by child table. */
export interface RecordNode {
  readonly row: Readonly<Record<string, string | number | null>>;
  readonly children: Readonly<Record<string, readonly RecordNode[]>>;
}

/** What a leased-record revision carries (cloud migration 013's body, inside the log payload). */
export interface LeasedRecordPayload {
  readonly recordId: string;
  readonly revision: number;
  readonly deleted: boolean;
  /** The whole record. Null exactly when it was deleted. */
  readonly body: RecordNode | null;
}

/** A revision of one record is its own event: a reader applies them in order. */
export const leasedRecordDedupeKey = (type: string, recordId: string, revision: number): string =>
  `${type}:${recordId}:${String(revision)}`;

type SqlRow = Record<string, unknown>;

/** What a snapshot needs: to read rows. */
export interface RecordReadHandle {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

const plainRow = (row: SqlRow): Record<string, string | number | null> => {
  const copy: Record<string, string | number | null> = {};
  for (const [column, value] of Object.entries(row)) {
    copy[column] = typeof value === "string" || typeof value === "number" ? value : value === null || value === undefined ? null : String(value);
  }
  return copy;
};

/** The record as this computer holds it now, or null when its root row is gone. */
export function snapshotRecord(db: RecordReadHandle, type: MasterRecordType, recordId: string): RecordNode | null {
  const spec = MASTER_RECORDS[type];
  const root = db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).all(recordId)[0] as SqlRow | undefined;
  if (root === undefined) return null;
  return snapshotNode(db, spec, root);
}

function snapshotNode(db: RecordReadHandle, spec: RecordTableSpec, row: SqlRow): RecordNode {
  const children: Record<string, RecordNode[]> = {};
  for (const child of spec.children ?? []) {
    const rows = db.prepare(`SELECT * FROM ${child.table} WHERE ${child.parentColumn ?? "id"} = ? ORDER BY id`).all(String(row.id)) as SqlRow[];
    children[child.table] = rows.map((childRow) => snapshotNode(db, child, childRow));
  }
  return { row: plainRow(row), children };
}

// ─── Reading a revision off the wire (R25) ──────────────────────────────────

const isCell = (value: unknown): value is string | number | null =>
  value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

function readNode(value: unknown, spec: RecordTableSpec, parentId: string | null): RecordNode | null {
  if (typeof value !== "object" || value === null) return null;
  const node = value as Record<string, unknown>;
  if (typeof node.row !== "object" || node.row === null || typeof node.children !== "object" || node.children === null) return null;
  const row = node.row as Record<string, unknown>;
  if (!Object.values(row).every(isCell)) return null;
  if (typeof row.id !== "string" || row.id.trim() === "") return null;
  if (spec.parentColumn !== undefined && row[spec.parentColumn] !== parentId) return null;
  const given = node.children as Record<string, unknown>;
  const allowed = new Set((spec.children ?? []).map((child) => child.table));
  if (!Object.keys(given).every((table) => allowed.has(table))) return null;
  const children: Record<string, RecordNode[]> = {};
  for (const child of spec.children ?? []) {
    const list = given[child.table] ?? [];
    if (!Array.isArray(list)) return null;
    const read: RecordNode[] = [];
    for (const item of list) {
      const childNode = readNode(item, child, row.id);
      if (childNode === null) return null;
      read.push(childNode);
    }
    children[child.table] = read;
  }
  return { row: row as Record<string, string | number | null>, children };
}

/**
 * A revision as it arrives, validated whole against the record's spec, or null. A body naming a
 * table the spec does not have, a child that names another parent, or a value that is not a plain
 * cell is refused rather than partly written.
 */
export function readLeasedRecordPayload(type: string, payload: Record<string, unknown>): LeasedRecordPayload | null {
  if (!isMasterRecordType(type)) return null;
  const { recordId, revision, deleted } = payload;
  if (typeof recordId !== "string" || recordId.trim() === "") return null;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return null;
  if (typeof deleted !== "boolean") return null;
  if (deleted) return payload.body === null || payload.body === undefined ? { recordId, revision, deleted, body: null } : null;
  const body = readNode(payload.body, MASTER_RECORDS[type], null);
  if (body === null || body.row.id !== recordId) return null;
  return { recordId, revision, deleted, body };
}

// ─── Building revisions from marks ──────────────────────────────────────────

export interface BuildHandle extends SyncWriteHandle {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: Array<string | number | null>): { changes: number | bigint; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
  };
}

export interface BuildResult {
  /** Revisions queued. */
  readonly queued: number;
  /** Marks that could not be queued and were left marked (the outbox refused the row). */
  readonly unqueued: number;
}

const ORDER = MASTER_RECORD_TYPES.map((type, index) => `WHEN '${type}' THEN ${String(index)}`).join(" ");

/**
 * Turns marked records into queued revisions, prerequisites first, in one transaction.
 *
 * Only marks that carry a lease epoch are built: a change made while this computer held the
 * master-data lease. Each revision is stamped with THAT epoch, not the one held now, so a change
 * made under a lease since lost is refused visibly when pushed (NOT_LEASE_HOLDER, a dead letter).
 * A mark with no epoch -- made while this computer was not set up for sync -- stays marked for the
 * backfill.
 *
 * A record whose root row is gone is queued as a deletion. A mark the outbox will not take is left
 * marked and counted, never cleared: clearing it would lose the change.
 */
export function buildLeasedRecordRevisions(db: BuildHandle, nowIso: string, limit = 200): BuildResult {
  const marks = db
    .prepare(
      `SELECT aggregate_type, record_id, lease_epoch FROM sync_dirty_records
        WHERE lease_epoch IS NOT NULL
        ORDER BY CASE aggregate_type ${ORDER} ELSE 99 END, marked_at, record_id
        LIMIT ?`
    )
    .all(limit) as Array<{ aggregate_type: string; record_id: string; lease_epoch: number }>;
  if (marks.length === 0) return { queued: 0, unqueued: 0 };

  let queued = 0;
  let unqueued = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const mark of marks) {
      if (!isMasterRecordType(mark.aggregate_type)) {
        unqueued += 1;
        continue;
      }
      const type = mark.aggregate_type;
      const current = db.prepare("SELECT revision FROM sync_record_revisions WHERE aggregate_type = ? AND record_id = ?").all(type, mark.record_id)[0] as
        | { revision: number }
        | undefined;
      const revision = Number(current?.revision ?? 0) + 1;
      const body = snapshotRecord(db, type, mark.record_id);
      const payload: LeasedRecordPayload = { recordId: mark.record_id, revision, deleted: body === null, body };
      const ok = enqueueSyncEvent(db, {
        outboxId: crypto.randomUUID(),
        aggregateType: type as SyncAggregateType,
        aggregateId: mark.record_id,
        dedupeKey: leasedRecordDedupeKey(type, mark.record_id, revision),
        payload: { ...payload },
        nowIso,
        leaseEpoch: Number(mark.lease_epoch),
      });
      if (!ok) {
        unqueued += 1;
        continue;
      }
      db.prepare(
        `INSERT INTO sync_record_revisions (aggregate_type, record_id, revision) VALUES (?, ?, ?)
         ON CONFLICT (aggregate_type, record_id) DO UPDATE SET revision = excluded.revision`
      ).run(type, mark.record_id, revision);
      db.prepare("DELETE FROM sync_dirty_records WHERE aggregate_type = ? AND record_id = ?").run(type, mark.record_id);
      queued += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { queued, unqueued };
}
