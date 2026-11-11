// ONE-TIME REPAIR A: PUTTING BACK THE SIX MATERIALS REMOVED ON PC2 ON 4 NOV 2026.
//
// PC2 erased them with their ledger while they held 237 units. Every other computer keeps the
// movements, append-only, so it holds stock PC2 no longer knows about and the deletions wait there
// for good. The owner chose to restore them on PC2 and account for them normally.
//
//   THE MATERIAL   written as this computer's OWN change, capture on. PC2's builder then sends it
//                  as revision 3 with its body, above the deletion that was revision 2. A computer
//                  holding that deletion in its park sees it superseded.
//   ITS MOVEMENTS  applied through the real applier, as arrivals. They are already in the cloud, so
//                  they must not be sent again: the applier suppresses capture and stamps
//                  replicated_at, which also keeps them out of any backfill.
//
// Nothing else comes back. The stock correction requests (SCR-...) the old erase deleted are not in
// the log; each adjustment's note still names its request. Stock is then accounted for through the
// normal screens: a real movement to zero, then a normal removal, or kept if the stock is real.
//
// Runs on a copy (scripts/restore-removed-materials.mjs). Refuses, changing nothing, unless the
// database is exactly the one this was written for.

import {
  LEASE_DOMAIN,
  SYNC_AGGREGATE,
  buildLeasedRecordRevisions,
  buildStockEvents,
  heldLeaseEpoch,
  leaseDomainOf,
  readLeasedRecordPayload,
  readStockEventPayload,
  snapshotRecord,
  stockEventDedupeKey,
  type LeasedRecordPayload,
  type RecordNode,
  type StockEventPayload,
} from "@erp/data";
import { applyEnvelope } from "./applyEnvelope.js";
import { LEASED_RECORD_CONTRACTS, writeOwnRecord } from "./leasedRecordContracts.js";
import { asRow, type SyncSqlHandle } from "./sqlPort.js";

const ITEM = SYNC_AGGREGATE.INVENTORY_ITEM;
/** The lease a material is written under. */
const ITEM_DOMAIN = leaseDomainOf(ITEM) ?? LEASE_DOMAIN.RAW_MATERIAL_STORE;
/** The revision the old removal sent. The builder makes the restored record the next one. */
const DELETION_REVISION = 2;
const RESTORED_REVISION = DELETION_REVISION + 1;
const AUDIT_ACTION = "RESTORE";
const AUDIT_ACTOR = "repair-a";
const QUANTITY_TOLERANCE = 1e-9;

export class RestoreRefused extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`REFUSED, nothing changed:\n  - ${reasons.join("\n  - ")}`);
    this.name = "RestoreRefused";
  }
}

export interface MaterialToRestore {
  readonly itemCode: string;
  readonly expectedBalance: number;
  readonly revision: LeasedRecordPayload & { readonly body: RecordNode };
  readonly movements: readonly StockEventPayload[];
}

export interface RestoreRecords {
  readonly deviceId: string;
  readonly materials: readonly MaterialToRestore[];
}

export interface RestoreCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** node:sqlite's handle: what the builders and capture need on top of the sync port. */
type RepairHandle = SyncSqlHandle & Parameters<typeof buildLeasedRecordRevisions>[0];

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const count = (db: SyncSqlHandle, sql: string, ...params: string[]): number =>
  Number(asRow(db.prepare(sql).get(...params))?.n ?? 0);

const allMovements = (records: RestoreRecords): StockEventPayload[] =>
  records.materials.flatMap((material) => [...material.movements]);

// ─── Reading the records file (R25: outside data until proved otherwise) ───

function readMovements(entry: Record<string, unknown> | null, itemId: string, code: string): StockEventPayload[] {
  const list: unknown[] = Array.isArray(entry?.movements) ? entry.movements : [];
  const movements: StockEventPayload[] = [];
  for (const item of list) {
    const movement = readStockEventPayload(asRow(asRow(item)?.payload) ?? {});
    if (movement === null || movement.itemId !== itemId) {
      throw new RestoreRefused([`${code}: a movement is unreadable or names another material.`]);
    }
    movements.push(movement);
  }
  if (movements.length === 0) throw new RestoreRefused([`${code}: it has no movements.`]);
  return movements;
}

function readMaterial(value: unknown): MaterialToRestore {
  const entry = asRow(value);
  const itemCode = String(entry?.itemCode ?? "?");
  const revision = readLeasedRecordPayload(ITEM, asRow(entry?.revision) ?? {});
  if (revision === null || revision.body === null || revision.deleted) {
    throw new RestoreRefused([`${itemCode}: its revision is not a whole record.`]);
  }
  const movements = readMovements(entry, revision.recordId, itemCode);
  const expectedBalance = Number(entry?.expectedBalance);
  const net = sum(movements.map((movement) => movement.balanceDelta));
  if (!(Math.abs(net - expectedBalance) <= QUANTITY_TOLERANCE)) {
    throw new RestoreRefused([`${itemCode}: its movements add up to ${String(net)}, not ${String(entry?.expectedBalance)}.`]);
  }
  return { itemCode, expectedBalance, revision: { ...revision, body: revision.body }, movements };
}

/** The records file, validated. Throws RestoreRefused rather than guess. */
export function readRestoreRecords(raw: unknown): RestoreRecords {
  const file = asRow(raw);
  const deviceId = typeof file?.deviceId === "string" ? file.deviceId.trim() : "";
  const list: unknown[] = Array.isArray(file?.materials) ? file.materials : [];
  if (deviceId === "") throw new RestoreRefused(["The records name no device."]);
  if (list.length === 0) throw new RestoreRefused(["The records list no materials."]);
  return { deviceId, materials: list.map(readMaterial) };
}

// ─── Refusing ───

function databaseRefusals(db: SyncSqlHandle, records: RestoreRecords, expectedDeviceId: string): string[] {
  const reasons: string[] = [];
  const device = asRow(db.prepare("SELECT setting_value AS v FROM app_settings WHERE setting_key = 'device.id'").get())?.v;
  if (expectedDeviceId !== records.deviceId) {
    reasons.push(`The records are for device ${records.deviceId}, not ${expectedDeviceId}.`);
  }
  if (device !== records.deviceId) {
    reasons.push(`This database's device.id is ${String(device ?? "missing")}, not ${records.deviceId}: it is not PC2.`);
  }
  const columns = db.prepare("PRAGMA table_info(inventory_items)").all().map((column) => asRow(column)?.name);
  if (!columns.includes("removed_at")) {
    reasons.push("inventory_items has no removed_at column: install the release with migration 102 and start it once first.");
  }
  // A material travels under the lease its type is written under (the store's, cloud 031), not a fixed one.
  if (heldLeaseEpoch(db, ITEM_DOMAIN) === null) {
    reasons.push("This computer does not hold the lease materials are written under, so a restored material could not be sent.");
  }
  if (heldLeaseEpoch(db, LEASE_DOMAIN.RAW_MATERIAL_STORE) === null) {
    reasons.push("This computer does not hold the raw-material store lease, so a movement to zero could not be sent.");
  }
  const triggers = "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_capture_inventory_items_ins'";
  if (count(db, triggers) === 0) reasons.push("The capture triggers are not installed, so a restored material would never be sent.");
  return reasons;
}

function identityRefusals(db: SyncSqlHandle, material: MaterialToRestore): string[] {
  const code = material.itemCode;
  const row = material.revision.body.row;
  const id = String(row.id);
  const reasons: string[] = [];
  const held = asRow(
    db.prepare("SELECT revision FROM sync_record_revisions WHERE aggregate_type = ? AND record_id = ?").get(ITEM, id)
  )?.revision;
  if (Number(held) !== DELETION_REVISION) {
    reasons.push(`${code}: its revision here is ${String(held ?? "none")}, not ${String(DELETION_REVISION)}.`);
  }
  if (count(db, "SELECT COUNT(*) AS n FROM inventory_items WHERE item_code = ? AND id <> ?", String(row.item_code), id) > 0) {
    reasons.push(`${code}: another material now has this code.`);
  }
  const twin = asRow(
    db
      .prepare("SELECT item_code FROM inventory_items WHERE category_id = ? AND signature_hash = ? AND id <> ?")
      .get(String(row.category_id), String(row.signature_hash), id)
  );
  if (twin !== null) {
    reasons.push(`${code}: ${String(twin.item_code)} was created since with the same attributes. Decide which one stands first.`);
  }
  return reasons;
}

function leftoverRefusals(db: SyncSqlHandle, material: MaterialToRestore): string[] {
  const id = material.revision.recordId;
  const code = material.itemCode;
  const has = (sql: string, ...params: string[]): boolean => count(db, sql, ...params) > 0;
  const reasons: string[] = [];
  if (has("SELECT COUNT(*) AS n FROM inventory_items WHERE id = ?", id)) {
    reasons.push(`${code}: it is already here. Already restored, or this copy predates the removal.`);
  }
  if (has("SELECT COUNT(*) AS n FROM inventory_stock_events WHERE item_id = ?", id)) reasons.push(`${code}: movements for it are already here.`);
  if (has("SELECT COUNT(*) AS n FROM inventory_stock_balances WHERE item_id = ?", id)) reasons.push(`${code}: a balance for it is already here.`);
  if (has("SELECT COUNT(*) AS n FROM raw_material_qrs WHERE item_id = ?", id)) reasons.push(`${code}: labels still name it, and its label sequence was erased.`);
  if (has("SELECT COUNT(*) AS n FROM sync_dirty_records WHERE aggregate_type = ? AND record_id = ?", ITEM, id)) {
    reasons.push(`${code}: a change to it is still marked to send.`);
  }
  if (has("SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type = ? AND aggregate_id = ? AND status <> 'SYNCED'", ITEM, id)) {
    reasons.push(`${code}: its deletion has not finished sending. Let the queue settle first.`);
  }
  return reasons;
}

function prerequisiteRefusals(db: SyncSqlHandle, material: MaterialToRestore): string[] {
  const contract = LEASED_RECORD_CONTRACTS.find((candidate) => candidate.aggregateType === ITEM);
  const missing = contract?.prepare({ ...material.revision })?.missing(db) ?? null;
  return missing === null ? [] : [`${material.itemCode}: this computer lacks what it needs (${missing}).`];
}

/** Every reason this database cannot be repaired; empty when it can. Reads only. */
export function restoreRefusals(db: SyncSqlHandle, records: RestoreRecords, expectedDeviceId: string): string[] {
  const reasons = databaseRefusals(db, records, expectedDeviceId);
  for (const material of records.materials) {
    reasons.push(...identityRefusals(db, material), ...leftoverRefusals(db, material), ...prerequisiteRefusals(db, material));
  }
  return reasons;
}

// ─── Restoring ───

function writeAudit(db: SyncSqlHandle, material: MaterialToRestore, nowIso: string): void {
  const id = material.revision.recordId;
  const detail = JSON.stringify({ itemCode: material.itemCode, restoredBalance: material.expectedBalance });
  db.prepare(
    `INSERT INTO inventory_item_audit (id, item_id, entity_type, entity_id, action, old_value_json, new_value_json, changed_by, created_at)
     VALUES (?, ?, 'ITEM', ?, ?, NULL, ?, ?, ?)`
  ).run(crypto.randomUUID(), id, id, AUDIT_ACTION, detail, AUDIT_ACTOR, nowIso);
}

function restoreMaterials(db: SyncSqlHandle, records: RestoreRecords, nowIso: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const material of records.materials) {
      writeOwnRecord(db, ITEM, material.revision.body);
      writeAudit(db, material, nowIso);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function replayMovement(db: SyncSqlHandle, movement: StockEventPayload, deviceId: string, nowIso: string): void {
  const outcome = applyEnvelope(
    db,
    {
      dedupeKey: stockEventDedupeKey(movement.eventId),
      aggregateType: SYNC_AGGREGATE.STOCK_EVENT,
      aggregateId: movement.eventId,
      operation: "INSERT",
      payload: { ...movement },
      originDeviceId: deviceId,
      createdAt: movement.createdAt,
    },
    nowIso
  );
  if (outcome.status !== "APPLIED") throw new Error(`Movement ${movement.eventId}: ${outcome.status} ${outcome.reason ?? ""}`);
}

/**
 * Puts the materials and their movements back. The caller works on a copy and discards it on any
 * failure: each movement is its own transaction in the applier, so this is not one transaction whole.
 */
export function applyRestore(db: SyncSqlHandle, records: RestoreRecords, expectedDeviceId: string, nowIso: string): void {
  const reasons = restoreRefusals(db, records, expectedDeviceId);
  if (reasons.length > 0) throw new RestoreRefused(reasons);
  restoreMaterials(db, records, nowIso);
  const oldestFirst = allMovements(records).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const movement of oldestFirst) replayMovement(db, movement, records.deviceId, nowIso);
}

// ─── Checking ───

/** The held record says everything the sent one said. A column added since is not a difference. */
function nodeMatches(held: RecordNode, sent: RecordNode): boolean {
  if (!Object.keys(sent.row).every((column) => held.row[column] === sent.row[column])) return false;
  return Object.entries(sent.children).every(([table, sentChildren]) => {
    const heldChildren = held.children[table] ?? [];
    if (heldChildren.length !== sentChildren.length) return false;
    return sentChildren.every((child) => {
      const match = heldChildren.find((candidate) => candidate.row.id === child.row.id);
      return match !== undefined && nodeMatches(match, child);
    });
  });
}

function expectedGrowth(records: RestoreRecords): Map<string, number> {
  const growth = new Map<string, number>();
  const add = (table: string, rows: number) => growth.set(table, (growth.get(table) ?? 0) + rows);
  for (const material of records.materials) {
    for (const table of ["inventory_items", "inventory_item_audit", "inventory_stock_balances", "sync_dirty_records"]) add(table, 1);
    add("inventory_stock_events", material.movements.length);
    for (const [table, children] of Object.entries(material.revision.body.children)) add(table, children.length);
  }
  return growth;
}

/** Every user table and its row count, for the before/after comparison. */
export function tableCounts(db: SyncSqlHandle): Map<string, number> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const counts = new Map<string, number>();
  for (const table of tables) {
    const name = String(asRow(table)?.name);
    counts.set(name, count(db, `SELECT COUNT(*) AS n FROM "${name}"`));
  }
  return counts;
}

function checkRowCounts(db: SyncSqlHandle, before: Map<string, number>, records: RestoreRecords): RestoreCheck {
  const growth = expectedGrowth(records);
  const wrong = [...tableCounts(db).entries()]
    .filter(([table, rows]) => rows !== (before.get(table) ?? 0) + (growth.get(table) ?? 0))
    .map(([table, rows]) => `${table} ${String(before.get(table) ?? 0)} -> ${String(rows)}`);
  return { name: "Row counts", ok: wrong.length === 0, detail: wrong.join(", ") || "only the expected tables grew, by the expected rows" };
}

function checkMaterials(db: SyncSqlHandle, records: RestoreRecords): RestoreCheck {
  const wrong = records.materials.filter((material) => {
    const held = snapshotRecord(db, ITEM, material.revision.recordId);
    return held === null || !nodeMatches(held, material.revision.body);
  });
  const fine = `${String(records.materials.length)} back, each as its revision 1 said`;
  return { name: "Materials", ok: wrong.length === 0, detail: wrong.map((material) => material.itemCode).join(", ") || fine };
}

function checkBalances(db: SyncSqlHandle, records: RestoreRecords): RestoreCheck {
  const wrong: string[] = [];
  for (const material of records.materials) {
    const row = asRow(db.prepare("SELECT quantity_on_hand AS q FROM inventory_stock_balances WHERE item_id = ?").get(material.revision.recordId));
    const balance = Number(row?.q);
    if (!(Math.abs(balance - material.expectedBalance) <= QUANTITY_TOLERANCE)) {
      wrong.push(`${material.itemCode} holds ${String(balance)}, expected ${String(material.expectedBalance)}`);
    }
  }
  const total = sum(records.materials.map((material) => material.expectedBalance));
  const fine = `${String(total)} units across ${String(records.materials.length)} materials`;
  return { name: "Balances", ok: wrong.length === 0, detail: wrong.join("; ") || fine };
}

function movementDiffers(db: SyncSqlHandle, movement: StockEventPayload): boolean {
  const held = asRow(
    db.prepare("SELECT quantity, created_at, created_by, note, replicated_at FROM inventory_stock_events WHERE id = ?").get(movement.eventId)
  );
  if (held === null || held.replicated_at === null) return true;
  return (
    held.created_at !== movement.createdAt ||
    Number(held.quantity) !== movement.quantity ||
    held.created_by !== movement.createdBy ||
    held.note !== movement.note
  );
}

function checkMovements(db: SyncSqlHandle, records: RestoreRecords): RestoreCheck {
  const movements = allMovements(records);
  const wrong = movements.filter((movement) => movementDiffers(db, movement));
  const fine = `${String(movements.length)} back, original times and notes, marked as already in the cloud`;
  return { name: "Movements", ok: wrong.length === 0, detail: wrong.map((movement) => movement.eventId).join(", ") || fine };
}

function checkMarks(db: SyncSqlHandle, records: RestoreRecords): RestoreCheck {
  const epoch = heldLeaseEpoch(db, ITEM_DOMAIN);
  const markOf = "SELECT lease_epoch FROM sync_dirty_records WHERE aggregate_type = ? AND record_id = ?";
  const unmarked = records.materials.filter((material) => {
    const mark = asRow(db.prepare(markOf).get(ITEM, material.revision.recordId));
    return mark === null || mark.lease_epoch === null || Number(mark.lease_epoch) !== epoch;
  });
  const resent = allMovements(records).filter((movement) => asRow(db.prepare(markOf).get(SYNC_AGGREGATE.STOCK_EVENT, movement.eventId)) !== null);
  const ok = unmarked.length === 0 && resent.length === 0;
  const detail = ok
    ? `every material marked to send under epoch ${String(epoch)}, no movement marked`
    : `${String(unmarked.length)} material(s) unmarked, ${String(resent.length)} movement(s) marked`;
  return { name: "Marks", ok, detail };
}

/** The repaired database against the counts taken before it. Reads only. */
export function verifyRestore(db: SyncSqlHandle, before: Map<string, number>, records: RestoreRecords): RestoreCheck[] {
  return [
    checkRowCounts(db, before, records),
    checkMaterials(db, records),
    checkBalances(db, records),
    checkMovements(db, records),
    checkMarks(db, records),
  ];
}

function revisionIsWhole(db: SyncSqlHandle, material: MaterialToRestore): boolean {
  const key = `${ITEM}:${material.revision.recordId}:${String(RESTORED_REVISION)}`;
  const row = asRow(db.prepare("SELECT payload_json FROM sync_outbox WHERE dedupe_key = ?").get(key));
  if (row === null) return false;
  const payload = asRow(JSON.parse(String(row.payload_json)));
  return payload?.deleted === false && payload.body !== null;
}

/**
 * What the app's own builders send from the repaired database. WRITES: it runs them, so it is for a
 * throwaway copy of the output, never the output itself.
 */
export function rehearseSending(db: RepairHandle, records: RestoreRecords, nowIso: string): RestoreCheck {
  buildLeasedRecordRevisions(db, nowIso);
  buildStockEvents(db, nowIso);
  const wrong = records.materials.filter((material) => !revisionIsWhole(db, material));
  const unsent = "SELECT COUNT(*) AS n FROM sync_outbox WHERE dedupe_key = ? AND status <> 'SYNCED'";
  const resent = allMovements(records).filter((movement) => count(db, unsent, stockEventDedupeKey(movement.eventId)) > 0);
  const ok = wrong.length === 0 && resent.length === 0;
  const detail = ok
    ? `the builders queue revision ${String(RESTORED_REVISION)} with its body for each, and no movement`
    : `${String(wrong.length)} material(s) wrong, ${String(resent.length)} movement(s) would be sent again`;
  return { name: "Sending", ok, detail };
}
