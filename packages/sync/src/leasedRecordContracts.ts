// How a master-data record arrives on this computer: whole, by revision (cloud migration 013).
//
// One generic contract per record type, built from the record's spec (MASTER_RECORDS in @erp/data),
// so the sender's snapshot and the receiver's write cannot drift apart.
//
//   WHAT IT WAITS FOR  the first record it names that this computer has not got -- a material's
//                      category, a party's group -- as WAITING_FOR:<type>:<id>. A wait, never a
//                      refusal: the record is coming, or the owner will create it.
//   HOW IT WRITES      only a revision newer than the one held here. The root row is upserted column
//                      by column, never REPLACEd (a REPLACE deletes first, and a delete can cascade);
//                      only columns this computer has are written, so a newer sender's extra column
//                      does not break an older receiver. Children are replaced by parent key: rows
//                      the revision no longer has are deleted, the rest upserted. A deletion removes
//                      the children, then the root. Capture is suppressed throughout: this computer
//                      applying another's change must not mark it as its own (masterCapture.ts).
//   WHEN WRITING FINDS IT MUST WAIT
//                      a deletion of a record still in use here (a foreign key), or a name another
//                      record here still holds (a unique key -- two parties swapping names arrive one
//                      revision at a time). Both resolve when the other record's revision arrives,
//                      so both WAIT (ApplyMustWait), and a wait that lasts is made visible, never
//                      silent (docs/37, the stock-screen slice).
//
// A revision older than, or equal to, the one held here is a DUPLICATE: it has been superseded.
// That is also how a parked older revision leaves the park once a newer one has applied.

import {
  MASTER_RECORDS,
  MASTER_RECORD_TYPES,
  readLeasedRecordPayload,
  withCaptureSuppressed,
  type CaptureHandle,
  type LeasedRecordPayload,
  type MasterRecordType,
  type RecordNode,
  type RecordTableSpec,
} from "@erp/data";
import { ApplyMustWait, defineContract, type RegisteredContract } from "./applyContract.js";
import { asRow, type SyncSqlHandle } from "./sqlPort.js";

const exists = (sql: SyncSqlHandle, table: string, id: string): boolean =>
  asRow(sql.prepare(`SELECT 1 AS present FROM ${table} WHERE id = ? LIMIT 1`).get(id)) !== null;

/** Ids carried inside this revision itself: a reference to one of them is satisfied by the revision. */
function idsIn(spec: RecordTableSpec, node: RecordNode, into: Map<string, Set<string>>): void {
  const ids = into.get(spec.table) ?? new Set<string>();
  ids.add(String(node.row.id));
  into.set(spec.table, ids);
  for (const child of spec.children ?? []) {
    for (const childNode of node.children[child.table] ?? []) idsIn(child, childNode, into);
  }
}

/** The first record this revision names that is neither here nor inside the revision, as a reason. */
function firstMissing(sql: SyncSqlHandle, spec: RecordTableSpec, node: RecordNode, carried: Map<string, Set<string>>): string | null {
  for (const reference of spec.references ?? []) {
    const value = node.row[reference.column];
    if (value === null || value === undefined || value === "") continue;
    const id = String(value);
    if (carried.get(reference.table)?.has(id)) continue;
    if (!exists(sql, reference.table, id)) return `WAITING_FOR:${reference.record}:${id}`;
  }
  for (const child of spec.children ?? []) {
    for (const childNode of node.children[child.table] ?? []) {
      const missing = firstMissing(sql, child, childNode, carried);
      if (missing !== null) return missing;
    }
  }
  return null;
}

const columnsOf = (sql: SyncSqlHandle, table: string): Set<string> =>
  new Set((sql.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>).map((column) => String(column.name)));

function upsertRow(sql: SyncSqlHandle, table: string, row: RecordNode["row"]): void {
  const known = columnsOf(sql, table);
  const columns = Object.keys(row).filter((column) => known.has(column));
  const updates = columns.filter((column) => column !== "id").map((column) => `${column} = excluded.${column}`);
  sql
    .prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
       ON CONFLICT (id) DO ${updates.length === 0 ? "NOTHING" : `UPDATE SET ${updates.join(", ")}`}`
    )
    .run(...columns.map((column) => row[column] ?? null));
}

function deleteRow(sql: SyncSqlHandle, spec: RecordTableSpec, id: string): void {
  for (const child of spec.children ?? []) {
    const childIds = sql.prepare(`SELECT id FROM ${child.table} WHERE ${child.parentColumn ?? "id"} = ?`).all(id) as Array<Record<string, unknown>>;
    for (const childRow of childIds) deleteRow(sql, child, String(childRow.id));
  }
  sql.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(id);
}

/** The node and its children, replacing whatever this computer held for them. */
function writeNode(sql: SyncSqlHandle, spec: RecordTableSpec, node: RecordNode): void {
  upsertRow(sql, spec.table, node.row);
  const id = String(node.row.id);
  for (const child of spec.children ?? []) {
    const incoming = node.children[child.table] ?? [];
    const keep = new Set(incoming.map((childNode) => String(childNode.row.id)));
    const held = sql.prepare(`SELECT id FROM ${child.table} WHERE ${child.parentColumn ?? "id"} = ?`).all(id) as Array<Record<string, unknown>>;
    for (const row of held) {
      if (!keep.has(String(row.id))) deleteRow(sql, child, String(row.id));
    }
    for (const childNode of incoming) writeNode(sql, child, childNode);
  }
}

/** A constraint the database raised while writing, as a wait -- or null for anything else. */
function waitReason(type: MasterRecordType, recordId: string, deleting: boolean, error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("FOREIGN KEY constraint failed")) {
    return deleting ? `STILL_IN_USE:${type}:${recordId}` : `WAITING_FOR_REFERENCE:${type}:${recordId}`;
  }
  const unique = /UNIQUE constraint failed: ([\w.]+(?:, [\w.]+)*)/.exec(message);
  if (unique !== null) return `NAME_TAKEN:${unique[1] ?? ""}`;
  return null;
}

const heldRevision = (sql: SyncSqlHandle, type: string, recordId: string): number =>
  Number(asRow(sql.prepare("SELECT revision FROM sync_record_revisions WHERE aggregate_type = ? AND record_id = ?").get(type, recordId))?.revision ?? 0);

function applyRevision(sql: SyncSqlHandle, type: MasterRecordType, revision: LeasedRecordPayload): boolean {
  if (heldRevision(sql, type, revision.recordId) >= revision.revision) return false;
  const spec = MASTER_RECORDS[type];
  try {
    withCaptureSuppressed(sql as CaptureHandle, () => {
      if (revision.body === null) deleteRow(sql, spec, revision.recordId);
      else writeNode(sql, spec, revision.body);
    });
  } catch (error) {
    const reason = waitReason(type, revision.recordId, revision.body === null, error);
    if (reason !== null) throw new ApplyMustWait(reason);
    throw error;
  }
  sql
    .prepare(
      `INSERT INTO sync_record_revisions (aggregate_type, record_id, revision) VALUES (?, ?, ?)
       ON CONFLICT (aggregate_type, record_id) DO UPDATE SET revision = excluded.revision`
    )
    .run(type, revision.recordId, revision.revision);
  return true;
}

function leasedRecordContract(type: MasterRecordType): RegisteredContract {
  const spec = MASTER_RECORDS[type];
  return defineContract<LeasedRecordPayload>({
    aggregateType: type,
    table: spec.table,
    read: (payload) => readLeasedRecordPayload(type, payload),
    idOf: (revision) => revision.recordId,
    missing: (sql, revision) => {
      if (revision.body === null) return null;
      const carried = new Map<string, Set<string>>();
      idsIn(spec, revision.body, carried);
      return firstMissing(sql, spec, revision.body, carried);
    },
    write: (sql, revision) => applyRevision(sql, type, revision),
  });
}

/** One contract per master record type, in prerequisite order. */
export const LEASED_RECORD_CONTRACTS: readonly RegisteredContract[] = MASTER_RECORD_TYPES.map(leasedRecordContract);
