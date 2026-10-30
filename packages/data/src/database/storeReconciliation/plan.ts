// ONE-TIME STORE RECONCILIATION — the plan: every row to insert, every row to update, every row left
// behind and why. Built from the two files and the owner's decisions, before anything is written.
// Any reason to refuse is collected and thrown together, so one run shows everything that is wrong.

import type { DatabaseSync } from "node:sqlite";
import { stockMismatches, type StockMismatch } from "../backfill.js";
import { classifyMovements, classifyScans, closedAt, planSessions, planStaleCloses, type MovementPlan, type ScanPlan, type SessionPlan } from "./classify.js";
import {
  MOVEMENT,
  ReconciliationRefused,
  TABLE,
  columnNames,
  latestMigration,
  one,
  setting,
  sourceOnly,
  tableNames,
  takeSnapshot,
  text,
  type ExpectedCounts,
  type ReconciliationDecisions,
  type Row,
  type Snapshot,
} from "./shared.js";
import { planBalances, planCounters, planMaterials, planRuns, type BalanceChange, type CounterChange, type MaterialPlan } from "./stock.js";
import { DEVICE_ID_SETTING_KEY } from "../numberRange.js";

export interface RunInfo {
  /** Also the audit_log row's id, so a second run of the same plan cannot write twice. */
  readonly reconciliationId: string;
  readonly nowIso: string;
  /** Who ran it, for the audit record. */
  readonly actor: string;
}

export interface PlannedInsert {
  readonly table: string;
  /** The source's row this copies, or null for a row the reconciliation makes itself. */
  readonly source: Row | null;
  readonly written: Row;
}

export interface PlannedUpdate {
  readonly table: string;
  readonly key: string;
  /** What the row must still hold, or the update is refused: nothing moved since the plan. */
  readonly expect: Row;
  readonly set: Row;
}

export interface LeftBehind {
  readonly table: string;
  readonly row: Row;
  readonly why: string;
}

export interface ReconciliationSummary {
  readonly materials: ReadonlyArray<{ oldCode: string; newCode: string; name: string }>;
  readonly sessions: ReadonlyArray<{ kind: "STORE_IN" | "STORE_OUT"; oldNumber: number; newNumber: number; scans: number }>;
  readonly counters: ReadonlyArray<{ kind: CounterChange["kind"]; party: string; material: string; from: number | null; to: number }>;
  readonly balances: ReadonlyArray<{ material: string; from: number | null; to: number }>;
  readonly staleCloses: ReadonlyArray<{ table: string; number: number; closedAt: string }>;
  readonly counts: ExpectedCounts;
}

export interface ReconciliationPlan {
  readonly run: RunInfo;
  readonly decisions: ReconciliationDecisions;
  readonly inserts: readonly PlannedInsert[];
  readonly updates: readonly PlannedUpdate[];
  readonly left: readonly LeftBehind[];
  readonly summary: ReconciliationSummary;
  /** The target as it was, for verification. */
  readonly before: { readonly snapshot: Snapshot; readonly mismatches: readonly StockMismatch[] };
}

/** Tables whose source-only rows the plan sorts. A source-only row anywhere else stops the run. */
const SORTED_TABLES: ReadonlySet<string> = new Set([
  TABLE.ITEMS, TABLE.ITEM_VALUES, TABLE.ITEM_AUDIT, TABLE.RUNS, TABLE.PACKETS, TABLE.PACKET_EVENTS,
  TABLE.STOCK_EVENTS, TABLE.RECEIVING, TABLE.ISSUE, TABLE.COUNTERS, TABLE.BALANCES,
]);

/** Same schema, the right computers, and both exactly at the migration the plan was written for. */
function checkFiles(source: DatabaseSync, target: DatabaseSync, decisions: ReconciliationDecisions, refusals: string[]): void {
  for (const [name, db] of [["source", source], ["target", target]] as const) {
    const version = latestMigration(db);
    if (version !== decisions.schemaVersion) refusals.push(`The ${name} is at migration ${version ?? "none"}, the plan was written for ${decisions.schemaVersion}.`);
  }
  if (setting(source, DEVICE_ID_SETTING_KEY) !== decisions.sourceDeviceId) refusals.push("The source file is not the source computer's database.");
  if (setting(target, DEVICE_ID_SETTING_KEY) !== decisions.targetDeviceId) refusals.push("The target file is not the target computer's database.");
  for (const table of [...SORTED_TABLES, TABLE.AUDIT_LOG]) {
    if (columnNames(source, table).join(",") !== columnNames(target, table).join(",")) refusals.push(`${table} has different columns in the two files.`);
  }
}

/** Every table with source-only rows is one the plan sorts, or one the decisions say to ignore. */
function checkNothingUnsorted(source: DatabaseSync, target: DatabaseSync, decisions: ReconciliationDecisions, refusals: string[]): void {
  const targetTables = new Set(tableNames(target));
  for (const table of tableNames(source)) {
    if (SORTED_TABLES.has(table) || decisions.ignoredTables.includes(table) || !columnNames(source, table).includes("id")) continue;
    if (!targetTables.has(table)) refusals.push(`${table} is not in the target.`);
    else {
      const count = sourceOnly(source, target, table).length;
      if (count > 0) refusals.push(`${count} row(s) in ${table} only the source holds, and the plan does not cover that table.`);
    }
  }
}

function checkCounts(expected: ExpectedCounts, found: ExpectedCounts, refusals: string[]): void {
  for (const key of Object.keys(expected) as Array<keyof ExpectedCounts>) {
    if (expected[key] !== found[key]) refusals.push(`The plan expects ${expected[key]} ${key}, the files hold ${found[key]}.`);
  }
}

/** Reads both files and plans the whole reconciliation. Writes nothing; throws ReconciliationRefused. */
export function planReconciliation(source: DatabaseSync, target: DatabaseSync, decisions: ReconciliationDecisions, run: RunInfo): ReconciliationPlan {
  const refusals: string[] = [];
  checkFiles(source, target, decisions, refusals);
  if (refusals.length > 0) throw new ReconciliationRefused(refusals);
  checkNothingUnsorted(source, target, decisions, refusals);
  const materials = planMaterials(source, target, refusals);
  const { runs, packets } = planRuns(source, target, new Set(materials.materials.map((m) => text(m.source, "id"))), refusals);
  const sessions = planSessions(source, target, decisions, refusals);
  const scans = classifyScans(source, target, decisions, sessions, new Set(packets.map((p) => text(p, "id"))), refusals);
  const movements = classifyMovements(source, target, scans, refusals);
  const counters = planCounters(source, target, { runs, packets, materials: materials.materials, nowIso: run.nowIso }, refusals);
  const staleCloses = planStaleCloses(source, target, decisions, refusals);
  const balances = planBalances(source, target, movements.brought, refusals);
  checkSourceBalances(source, target, balances, refusals);
  for (const session of sessions.issue) {
    if (closedAt(scans.storeOuts, text(session.source, "id")) === null) refusals.push(`Store-out session ${String(session.source.session_number)} has no scans to bring across.`);
  }
  const parts: Parts = { materials, runs, packets, sessions, scans, movements, counters, staleCloses, balances };
  const counts = countParts(parts);
  checkCounts(decisions.expected, counts, refusals);
  if (refusals.length > 0) throw new ReconciliationRefused(refusals);
  const summary = summarize(target, parts, counts);
  return {
    run, decisions, summary,
    inserts: [...plannedInserts(source, parts, run), auditRow(decisions, run, summary)],
    updates: plannedUpdates(parts, run),
    left: [
      ...scans.duplicates.map((row) => ({ table: TABLE.PACKET_EVENTS, row, why: "store-out of a packet the target already shows issued" })),
      ...movements.left.map((row) => ({ table: TABLE.STOCK_EVENTS, row, why: "stock movement of a duplicate store-out" })),
      ...sessions.empty.map((row) => ({ table: TABLE.ISSUE, row, why: "store-out session with no scans" })),
    ],
    before: { snapshot: takeSnapshot(target), mismatches: stockMismatches(target) },
  };
}

interface Parts {
  readonly materials: MaterialPlan;
  readonly runs: readonly Row[];
  readonly packets: readonly Row[];
  readonly sessions: SessionPlan;
  readonly scans: ScanPlan;
  readonly movements: MovementPlan;
  readonly counters: readonly CounterChange[];
  readonly staleCloses: ReadonlyArray<{ table: string; id: string; number: number; closedAt: string }>;
  readonly balances: readonly BalanceChange[];
}

/** A balance the source holds for a material the target lacks must be one the movements rebuild. */
function checkSourceBalances(source: DatabaseSync, target: DatabaseSync, balances: readonly BalanceChange[], refusals: string[]): void {
  const rebuilt = new Set(balances.map((change) => change.itemId));
  for (const row of sourceOnly(source, target, TABLE.BALANCES)) {
    if (!rebuilt.has(text(row, "item_id"))) refusals.push(`The source's balance for material ${text(row, "item_id")} has no brought movements to rebuild it from.`);
  }
}

function countParts(parts: Parts): ExpectedCounts {
  return {
    materials: parts.materials.materials.length,
    materialValues: parts.materials.values.length,
    materialAudits: parts.materials.audits.length,
    runs: parts.runs.length,
    packets: parts.packets.length,
    storeIns: parts.scans.storeIns.length,
    storeOuts: parts.scans.storeOuts.length,
    duplicateStoreOuts: parts.scans.duplicates.length,
    receives: parts.movements.brought.filter((row) => row.event_type === MOVEMENT.IN).length,
    transfersOut: parts.movements.brought.filter((row) => row.event_type === MOVEMENT.OUT).length,
    staleSessions: parts.staleCloses.length,
  };
}

const copy = (table: string, rows: readonly Row[]): PlannedInsert[] => rows.map((row) => ({ table, source: row, written: row }));

/** Inserts in the order the foreign keys need: materials, runs, packets, counters, sessions, scans, movements, balances. */
function plannedInserts(source: DatabaseSync, parts: Parts, run: RunInfo): PlannedInsert[] {
  const original = (id: string): Row | null => one(source, "SELECT * FROM raw_material_qr_events WHERE id = ?", id) ?? null;
  return [
    ...parts.materials.materials.map((m) => ({ table: TABLE.ITEMS, source: m.source, written: { ...m.source, item_code: m.newCode } })),
    ...copy(TABLE.ITEM_VALUES, parts.materials.values),
    ...copy(TABLE.ITEM_AUDIT, parts.materials.audits),
    ...copy(TABLE.RUNS, parts.runs),
    ...copy(TABLE.PACKETS, parts.packets),
    ...parts.counters.filter((c) => c.from === null).map((c) => ({
      table: TABLE.COUNTERS,
      source: c.source,
      written: c.source ?? { id: c.counterId, party_id: c.partyId, item_id: c.itemId, last_sequence: c.to, updated_at: c.updatedAt },
    })),
    ...parts.sessions.receiving.map((s) => ({ table: TABLE.RECEIVING, source: s.source, written: { ...s.source, session_number: s.newNumber } })),
    ...parts.sessions.issue.map((s) => ({
      table: TABLE.ISSUE,
      source: s.source,
      written: { ...s.source, session_number: s.newNumber, status: "CLOSED", closed_at: closedAt(parts.scans.storeOuts, text(s.source, "id")), updated_at: run.nowIso },
    })),
    ...copy(TABLE.PACKET_EVENTS, parts.scans.storeIns),
    ...parts.scans.storeOuts.map((row) => ({ table: TABLE.PACKET_EVENTS, source: original(text(row, "id")), written: row })),
    ...copy(TABLE.STOCK_EVENTS, parts.movements.brought),
    ...parts.balances.filter((b) => b.from === null).map((b) => ({
      table: TABLE.BALANCES,
      source: b.source,
      written: { item_id: b.itemId, quantity_on_hand: b.to, unit_id: b.unitId, updated_at: run.nowIso },
    })),
  ];
}

function plannedUpdates(parts: Parts, run: RunInfo): PlannedUpdate[] {
  return [
    ...parts.counters.filter((c) => c.from !== null).map((c) => ({
      table: TABLE.COUNTERS, key: c.counterId, expect: { last_sequence: c.from }, set: { last_sequence: c.to, updated_at: c.updatedAt },
    })),
    ...parts.staleCloses.map((s) => ({
      table: s.table, key: s.id, expect: { status: "OPEN", closed_at: null }, set: { status: "CLOSED", closed_at: s.closedAt, updated_at: run.nowIso },
    })),
    ...parts.balances.filter((b) => b.from !== null).map((b) => ({
      table: TABLE.BALANCES, key: b.itemId, expect: { quantity_on_hand: b.from, unit_id: b.unitId }, set: { quantity_on_hand: b.to, updated_at: run.nowIso },
    })),
  ];
}

/** Readable names for the report: codes as they will stand after the reconciliation. */
function summarize(target: DatabaseSync, parts: Parts, counts: ExpectedCounts): ReconciliationSummary {
  const newCodes = new Map(parts.materials.materials.map((m) => [text(m.source, "id"), m.newCode]));
  const material = (id: string): string => newCodes.get(id) ?? String(one(target, "SELECT item_code FROM inventory_items WHERE id = ?", id)?.item_code ?? id);
  const party = (id: string): string => String(one(target, "SELECT party_code FROM parties WHERE id = ?", id)?.party_code ?? id);
  const scansIn = (rows: readonly Row[], id: string): number => rows.filter((row) => row.session_id === id).length;
  return {
    materials: parts.materials.materials.map((m) => ({ oldCode: text(m.source, "item_code"), newCode: m.newCode, name: text(m.source, "display_name") })),
    sessions: [
      ...parts.sessions.receiving.map((s) => ({ kind: "STORE_IN" as const, oldNumber: Number(s.source.session_number), newNumber: s.newNumber, scans: scansIn(parts.scans.storeIns, text(s.source, "id")) })),
      ...parts.sessions.issue.map((s) => ({ kind: "STORE_OUT" as const, oldNumber: Number(s.source.session_number), newNumber: s.newNumber, scans: scansIn(parts.scans.storeOuts, text(s.source, "id")) })),
    ],
    counters: parts.counters.map((c) => ({ kind: c.kind, party: party(c.partyId), material: material(c.itemId), from: c.from, to: c.to })),
    balances: parts.balances.map((b) => ({ material: material(b.itemId), from: b.from, to: b.to })),
    staleCloses: parts.staleCloses.map((s) => ({ table: s.table, number: s.number, closedAt: s.closedAt })),
    counts,
  };
}

/** The one audit record of the reconciliation: what was decided, and what was done. */
function auditRow(decisions: ReconciliationDecisions, run: RunInfo, summary: ReconciliationSummary): PlannedInsert {
  const payload = { reference: "docs/39-pc2-pc3-reconciliation-plan.md", actor: run.actor, decisions, summary };
  return {
    table: TABLE.AUDIT_LOG,
    source: null,
    written: {
      id: run.reconciliationId, event_type: "STORE_RECONCILIATION", event_version: 1, entity_type: "RAW_MATERIAL_STORE",
      entity_id: run.reconciliationId, actor_user_id: null, actor_device_id: null, actor_role_code: null,
      occurred_at: run.nowIso, payload_json: JSON.stringify(payload), hash_sha256: null, created_at: run.nowIso,
    },
  };
}
