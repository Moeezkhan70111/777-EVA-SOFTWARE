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
//   A NAME ANOTHER RECORD HERE STILL HOLDS
//                      two parties swapping names arrive one revision at a time, each wanting the
//                      name the other has, and waiting would wait for ever on both sides. The store
//                      PC never holds two records of one type under one name, so a clash with ANOTHER
//                      record of the same type means this computer's copy of it is out of date: its
//                      clashing name is moved aside ("~moved:<its id>"), recorded in
//                      sync_displaced_records (migration 096) and shown as incomplete, and its own
//                      next revision puts the real name back. Root rows only: a clash between two
//                      children of one record still waits, visibly.
//   WHEN WRITING FINDS IT MUST WAIT
//                      a deletion of a record still in use here (a foreign key), or a name clash this
//                      computer cannot resolve. It resolves when the other record's revision arrives,
//                      so it WAITS (ApplyMustWait), and a wait that lasts is made visible, never
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

/** Names moved aside at most this many times for one revision -- one per unique key it can clash on. */
const MAX_DISPLACEMENTS = 3;

/** Another record of the same type, here, that holds the name this revision's root row wants. */
function rootNameClash(
  sql: SyncSqlHandle,
  spec: RecordTableSpec,
  revision: LeasedRecordPayload,
  error: unknown
): { readonly id: string; readonly columns: readonly string[] } | null {
  const body = revision.body;
  if (body === null) return null;
  const match = /UNIQUE constraint failed: ([\w.]+(?:, [\w.]+)*)/.exec(error instanceof Error ? error.message : "");
  if (match === null) return null;
  const qualified = (match[1] ?? "").split(", ");
  if (!qualified.every((name) => name.startsWith(`${spec.table}.`))) return null;
  const columns = qualified.map((name) => name.slice(spec.table.length + 1));
  // Only names can be moved aside: every clashing value must be text.
  if (!columns.every((column) => typeof body.row[column] === "string")) return null;
  const holder = asRow(
    sql
      .prepare(`SELECT id FROM ${spec.table} WHERE ${columns.map((column) => `${column} = ?`).join(" AND ")} AND id <> ? LIMIT 1`)
      .get(...columns.map((column) => body.row[column] ?? null), revision.recordId)
  );
  return holder === null ? null : { id: String(holder.id), columns };
}

/** Moves the out-of-date holder's clashing name aside, and records what it was. */
function displace(sql: SyncSqlHandle, type: MasterRecordType, spec: RecordTableSpec, clash: { id: string; columns: readonly string[] }): void {
  const original = asRow(sql.prepare(`SELECT ${clash.columns.join(", ")} FROM ${spec.table} WHERE id = ?`).get(clash.id)) ?? {};
  sql
    .prepare(`UPDATE ${spec.table} SET ${clash.columns.map((column) => `${column} = '~moved:' || id`).join(", ")} WHERE id = ?`)
    .run(clash.id);
  // The first original is kept: a record moved aside twice keeps the name it really had.
  sql
    .prepare(
      `INSERT INTO sync_displaced_records (aggregate_type, record_id, original_json, displaced_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (aggregate_type, record_id) DO NOTHING`
    )
    .run(type, clash.id, JSON.stringify({ ...original }), new Date().toISOString());
}

/** The revision's writes, moving an out-of-date name aside when that is what stands in the way. */
function writeRevision(sql: SyncSqlHandle, type: MasterRecordType, spec: RecordTableSpec, revision: LeasedRecordPayload): void {
  for (let displaced = 0; ; displaced += 1) {
    try {
      if (revision.body === null) deleteRow(sql, spec, revision.recordId);
      else writeNode(sql, spec, revision.body);
      return;
    } catch (error) {
      const clash = displaced < MAX_DISPLACEMENTS ? rootNameClash(sql, spec, revision, error) : null;
      if (clash !== null) {
        displace(sql, type, spec, clash);
        continue;
      }
      const reason = waitReason(type, revision.recordId, revision.body === null, error);
      if (reason !== null) throw new ApplyMustWait(reason);
      throw error;
    }
  }
}

function applyRevision(sql: SyncSqlHandle, type: MasterRecordType, revision: LeasedRecordPayload): boolean {
  if (heldRevision(sql, type, revision.recordId) >= revision.revision) return false;
  const spec = MASTER_RECORDS[type];
  // Suppressed throughout, the moving aside included: none of it is this computer's own change.
  withCaptureSuppressed(sql as CaptureHandle, () => writeRevision(sql, type, spec, revision));
  // This record's own revision has applied, so anything of it moved aside has its real values back.
  sql.prepare("DELETE FROM sync_displaced_records WHERE aggregate_type = ? AND record_id = ?").run(type, revision.recordId);
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
