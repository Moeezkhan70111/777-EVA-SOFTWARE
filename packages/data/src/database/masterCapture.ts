// Which master record a write changed -- marked by the database, not remembered by each write path.
//
// Master data replicates whole, by revision (cloud migration 013, docs/37 W.1). To queue a record,
// this computer first has to know it changed. About fifty write paths touch master data, so instead
// of each remembering to say so, a trigger on every master table marks the changed RECORD in
// sync_dirty_records (migration 094), in the same transaction as the write. One builder later
// snapshots each marked record whole and queues it with its next revision.
//
// ONE MAP. MASTER_CAPTURE says, for each master table, which record a row belongs to: a material's
// values and unit steps mark the material, a category's fields and options mark the category. The
// triggers are generated from it, and masterCapture.test.ts fails on any table in the database that
// is neither in it nor classified as not master data -- so a new master table cannot go uncaptured.
//
// WHEN THE TRIGGERS EXIST.
//   * Dropped at the start of every migration run, inside its transaction: no migration fires them,
//     and none trips over a trigger naming a table it is rebuilding.
//   * Installed again after migrations, on every start. A rebuild migration that drops a table (and
//     with it the table's triggers) is repaired the next time the application starts.
//   * Suppressed, inside a transaction, for writes that are not this computer's own changes:
//     applying another computer's revision, and the backfill (withCaptureSuppressed).

import { LEASED_AGGREGATE_DOMAIN, SYNC_AGGREGATE, type SyncAggregateType } from "./syncEvents.js";

/** The narrow surface needed: run SQL, read a row, and say whether a transaction is open. */
export interface CaptureHandle {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: Array<string | number | null>): unknown;
    get(...params: Array<string | number | null>): unknown;
    all(...params: Array<string | number | null>): unknown[];
  };
  /** node:sqlite reports it. Used to refuse suppression outside a transaction. */
  readonly isTransaction?: boolean;
}

export interface MasterTableCapture {
  readonly table: string;
  readonly record: SyncAggregateType;
  /** The record's id as SQL over the row; `{row}` is NEW or OLD. Null means "no record" (skipped). */
  readonly recordId: string;
}

const ROW = "{row}";

/**
 * Every master table, and the record each of its rows belongs to. A row of a child table changes
 * its parent record: replication replaces the parent whole, children included.
 */
export const MASTER_CAPTURE: readonly MasterTableCapture[] = [
  { table: "party_groups", record: SYNC_AGGREGATE.PARTY_GROUP, recordId: `${ROW}.id` },
  { table: "parties", record: SYNC_AGGREGATE.PARTY, recordId: `${ROW}.id` },
  { table: "inventory_units", record: SYNC_AGGREGATE.INVENTORY_UNIT, recordId: `${ROW}.id` },
  // A conversion is the unit it converts FROM.
  { table: "inventory_unit_conversions", record: SYNC_AGGREGATE.INVENTORY_UNIT, recordId: `${ROW}.from_unit_id` },
  { table: "unit_ladder_presets", record: SYNC_AGGREGATE.UNIT_LADDER_PRESET, recordId: `${ROW}.id` },
  { table: "unit_ladder_preset_steps", record: SYNC_AGGREGATE.UNIT_LADDER_PRESET, recordId: `${ROW}.preset_id` },
  { table: "inventory_categories", record: SYNC_AGGREGATE.INVENTORY_CATEGORY, recordId: `${ROW}.id` },
  { table: "inventory_category_fields", record: SYNC_AGGREGATE.INVENTORY_CATEGORY, recordId: `${ROW}.category_id` },
  // An option belongs to a field, and the field to its category. If the field is already gone (it was
  // deleted first), the field's own trigger has marked the category, and this one marks nothing.
  {
    table: "inventory_category_field_options",
    record: SYNC_AGGREGATE.INVENTORY_CATEGORY,
    recordId: `(SELECT category_id FROM inventory_category_fields WHERE id = ${ROW}.field_id)`,
  },
  { table: "inventory_items", record: SYNC_AGGREGATE.INVENTORY_ITEM, recordId: `${ROW}.id` },
  { table: "inventory_item_values", record: SYNC_AGGREGATE.INVENTORY_ITEM, recordId: `${ROW}.item_id` },
  { table: "inventory_item_unit_steps", record: SYNC_AGGREGATE.INVENTORY_ITEM, recordId: `${ROW}.item_id` },
  { table: "work_sections", record: SYNC_AGGREGATE.WORK_SECTION, recordId: `${ROW}.id` },
  { table: "machines", record: SYNC_AGGREGATE.MACHINE, recordId: `${ROW}.id` },
];

/** Every capture trigger's name starts with this, so they can all be found and dropped. */
export const CAPTURE_TRIGGER_PREFIX = "trg_capture_";

const OPERATIONS = [
  { suffix: "ins", event: "INSERT", rows: ["NEW"] },
  { suffix: "upd", event: "UPDATE", rows: ["NEW", "OLD"] },
  { suffix: "del", event: "DELETE", rows: ["OLD"] },
] as const;

export const captureTriggerName = (table: string, suffix: "ins" | "upd" | "del"): string =>
  `${CAPTURE_TRIGGER_PREFIX}${table}_${suffix}`;

/** One mark: the record, the master-data lease epoch held now, and when. Coalesced per record. */
function markStatement(capture: MasterTableCapture, row: "NEW" | "OLD"): string {
  const id = capture.recordId.split(ROW).join(row);
  const domain = LEASED_AGGREGATE_DOMAIN[capture.record] ?? "MASTER_DATA";
  return `INSERT INTO sync_dirty_records (aggregate_type, record_id, lease_epoch, marked_at)
    SELECT '${capture.record}', ${id}, (SELECT epoch FROM sync_domain_leases WHERE domain = '${domain}'),
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE ${id} IS NOT NULL
    ON CONFLICT (aggregate_type, record_id) DO UPDATE SET lease_epoch = excluded.lease_epoch, marked_at = excluded.marked_at;`;
}

/** The three triggers for one master table, as SQL. An update marks both the old and the new record. */
export function captureTriggerSql(capture: MasterTableCapture): string[] {
  return OPERATIONS.map(
    (operation) => `CREATE TRIGGER ${captureTriggerName(capture.table, operation.suffix)}
  AFTER ${operation.event} ON ${capture.table}
  WHEN COALESCE((SELECT suppressed FROM sync_capture WHERE id = 1), 0) = 0
BEGIN
  ${operation.rows.map((row) => markStatement(capture, row)).join("\n  ")}
END`
  );
}

const tableExists = (db: CaptureHandle, table: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) !== undefined;

/** Drops every capture trigger. Opens no transaction of its own: the migration runner calls it inside its own. */
export function dropCaptureTriggers(db: CaptureHandle): void {
  const triggers = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ?")
    .all(`${CAPTURE_TRIGGER_PREFIX}%`) as Array<{ name: string }>;
  for (const { name } of triggers) db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
}

/**
 * Replaces every capture trigger with the current definitions, in one transaction. Returns false,
 * with none installed, when the tables they write do not exist yet (before migrations 093 and 094).
 */
export function installCaptureTriggers(db: CaptureHandle): boolean {
  const ready = ["sync_capture", "sync_dirty_records", "sync_domain_leases"].every((table) => tableExists(db, table));
  db.exec("BEGIN IMMEDIATE");
  try {
    dropCaptureTriggers(db);
    if (ready) {
      for (const capture of MASTER_CAPTURE) {
        if (!tableExists(db, capture.table)) continue;
        for (const sql of captureTriggerSql(capture)) db.exec(sql);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return ready;
}

/**
 * Runs `work` with marking off: for writes that are not this computer's own changes (applying
 * another computer's revision, the backfill). Must be called INSIDE the transaction of those writes,
 * so a crash rolls the switch back with them and it can never be left off.
 */
export function withCaptureSuppressed<T>(db: CaptureHandle, work: () => T): T {
  if (db.isTransaction === false) {
    throw new Error("withCaptureSuppressed must run inside a transaction, so the switch cannot outlive it.");
  }
  db.prepare("UPDATE sync_capture SET suppressed = 1 WHERE id = 1").run();
  try {
    return work();
  } finally {
    db.prepare("UPDATE sync_capture SET suppressed = 0 WHERE id = 1").run();
  }
}
