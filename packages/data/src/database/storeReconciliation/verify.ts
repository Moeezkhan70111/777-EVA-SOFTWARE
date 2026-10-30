// ONE-TIME STORE RECONCILIATION — proving the result. Run after the write, on the written file.
//
// The scan use cases were bypassed to keep the true dates, so these checks stand in for them. Each
// re-reads the database rather than trusting the plan: every planned row is there as planned, nothing
// else in any table moved, everything the source held is either brought or deliberately left, stock
// adds up, every packet's state matches its last scan, the store-outs name the actual recipient, no
// counter can print a brought label again, and every number is used once.

import type { DatabaseSync } from "node:sqlite";
import { stockMismatches, type StockMismatch } from "../backfill.js";
import type { PlannedInsert, ReconciliationPlan } from "./plan.js";
import {
  SCAN,
  TABLE,
  all,
  keyColumn,
  nextFreeNumber,
  num,
  one,
  recipientOf,
  sourceOnly,
  stableJson,
  takeSnapshot,
  text,
  textOrNull,
  type Row,
} from "./shared.js";
import { labelTokenIndex, pairsSpelling } from "./stock.js";

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const check = (name: string, problems: readonly string[], okDetail: string): Check => ({
  name,
  ok: problems.length === 0,
  detail: problems.length === 0 ? okDetail : `${problems.length} problem(s): ${problems.slice(0, 8).join("; ")}${problems.length > 8 ? "; …" : ""}`,
});

const insertsOf = (plan: ReconciliationPlan, table: string): PlannedInsert[] => plan.inserts.filter((insert) => insert.table === table);
const keyOf = (table: string, row: Row): string => String(row[keyColumn(table)]);

/** A snapshot row's key, read back out of its JSON. */
function keyInJson(json: string, column: string): string {
  const parsed: unknown = JSON.parse(json);
  const value: unknown = typeof parsed === "object" && parsed !== null ? Object.entries(parsed).find(([key]) => key === column)?.[1] : undefined;
  return String(value);
}

function integrity(target: DatabaseSync): Check {
  const quick = String(one(target, "PRAGMA quick_check")?.quick_check ?? "");
  const foreign = all(target, "PRAGMA foreign_key_check").length;
  const problems = [...(quick === "ok" ? [] : [`quick_check: ${quick}`]), ...(foreign === 0 ? [] : [`${foreign} foreign key violation(s)`])];
  return check("Database integrity", problems, "quick_check ok, no foreign key violations");
}

/** Every planned insert is there exactly as written, and every planned update holds its new values. */
function plannedRowsWritten(target: DatabaseSync, plan: ReconciliationPlan): Check {
  const problems: string[] = [];
  for (const insert of plan.inserts) {
    const row = one(target, `SELECT * FROM ${insert.table} WHERE ${keyColumn(insert.table)} = ?`, keyOf(insert.table, insert.written));
    const differs = !row || Object.keys(insert.written).some((column) => stableJson({ v: row[column] }) !== stableJson({ v: insert.written[column] }));
    if (differs) problems.push(`${insert.table} ${keyOf(insert.table, insert.written)}`);
  }
  for (const update of plan.updates) {
    const row = one(target, `SELECT * FROM ${update.table} WHERE ${keyColumn(update.table)} = ?`, update.key);
    if (!row || Object.keys(update.set).some((column) => row[column] !== update.set[column])) problems.push(`${update.table} ${update.key} (update)`);
  }
  return check("Every planned row written as planned", problems, `${plan.inserts.length} inserted, ${plan.updates.length} updated`);
}

/** Row for row, every table is as it was, except the rows the plan inserted or updated. */
function nothingElseChanged(target: DatabaseSync, plan: ReconciliationPlan): Check {
  const after = takeSnapshot(target);
  const problems: string[] = [];
  for (const [table, beforeRows] of plan.before.snapshot) {
    const afterRows = after.get(table) ?? new Map<number, string>();
    const updated = new Set(plan.updates.filter((u) => u.table === table).map((u) => u.key));
    const inserted = new Set(insertsOf(plan, table).map((i) => keyOf(table, i.written)));
    for (const [rowid, json] of beforeRows) {
      if (afterRows.get(rowid) === json) continue;
      const key = keyInJson(json, keyColumn(table));
      if (!updated.has(key)) problems.push(`${table} row ${key} changed or disappeared`);
    }
    const added = [...afterRows].filter(([rowid]) => !beforeRows.has(rowid));
    for (const [, json] of added) {
      const key = keyInJson(json, keyColumn(table));
      if (!inserted.has(key)) problems.push(`${table} gained an unplanned row ${key}`);
    }
    if (added.length !== inserted.size) problems.push(`${table} gained ${added.length} rows, ${inserted.size} planned`);
  }
  for (const table of after.keys()) if (!plan.before.snapshot.has(table)) problems.push(`new table ${table}`);
  return check("Nothing else changed", problems, `${plan.before.snapshot.size} tables compared row by row`);
}

/** The only differences from the source's rows are the ones the plan exists to make. */
const ALLOWED_CHANGES: Readonly<Record<string, readonly string[]>> = {
  [TABLE.ITEMS]: ["item_code"],
  [TABLE.RECEIVING]: ["session_number"],
  [TABLE.ISSUE]: ["session_number", "status", "closed_at", "updated_at"],
  [TABLE.PACKET_EVENTS]: ["metadata_json"],
  [TABLE.BALANCES]: ["updated_at"],
};

function withoutRecipient(metadata: string | null): string {
  const parsed: unknown = metadata === null ? null : JSON.parse(metadata);
  if (typeof parsed !== "object" || parsed === null) return JSON.stringify(parsed);
  return JSON.stringify(Object.entries(parsed).filter(([key]) => key !== "issuedToPartyId"));
}

function onlyPlannedDifferences(plan: ReconciliationPlan): Check {
  const problems: string[] = [];
  for (const insert of plan.inserts) {
    if (insert.source === null) continue;
    const allowed = ALLOWED_CHANGES[insert.table] ?? [];
    const source = insert.source;
    const changed = Object.keys(source).filter((column) => stableJson({ v: source[column] }) !== stableJson({ v: insert.written[column] }));
    for (const column of changed) {
      if (!allowed.includes(column)) problems.push(`${insert.table} ${keyOf(insert.table, source)}: ${column} differs from the source`);
    }
    if (insert.table === TABLE.PACKET_EVENTS && withoutRecipient(textOrNull(source, "metadata_json")) !== withoutRecipient(textOrNull(insert.written, "metadata_json"))) {
      problems.push(`scan ${keyOf(insert.table, source)}: metadata changed beyond the recipient`);
    }
  }
  return check("Only planned differences from the source", problems, "codes, session numbers, a closed session, recipients and balance times only");
}

/** Everything the source held that the target lacked is now on the target, or deliberately left behind. */
function sourceAccountedFor(source: DatabaseSync, target: DatabaseSync, plan: ReconciliationPlan): Check {
  const problems: string[] = [];
  const tables = [TABLE.ITEMS, TABLE.ITEM_VALUES, TABLE.ITEM_AUDIT, TABLE.RUNS, TABLE.PACKETS, TABLE.PACKET_EVENTS, TABLE.STOCK_EVENTS, TABLE.RECEIVING, TABLE.ISSUE, TABLE.COUNTERS, TABLE.BALANCES];
  for (const table of tables) {
    const missing = sourceOnly(source, target, table).map((row) => keyOf(table, row)).sort().join(",");
    const left = plan.left.filter((l) => l.table === table).map((l) => keyOf(table, l.row)).sort().join(",");
    if (missing !== left) problems.push(`${table}: what is still missing is not exactly what was left behind`);
  }
  return check("Everything from the source brought or deliberately left", problems, `${plan.left.length} row(s) left behind, each with a reason`);
}

const mismatchKey = (m: StockMismatch): string => `${m.itemId}|${m.balance}|${m.fromMovements}|${m.unitDiffers}`;

/** No touched material's stock fails to add up, and no other material's has changed whether it does. */
function stockAddsUp(target: DatabaseSync, plan: ReconciliationPlan): Check {
  const touched = new Set([...insertsOf(plan, TABLE.BALANCES).map((i) => keyOf(TABLE.BALANCES, i.written)), ...plan.updates.filter((u) => u.table === TABLE.BALANCES).map((u) => u.key)]);
  const after = stockMismatches(target);
  const problems = after.filter((m) => touched.has(m.itemId)).map((m) => `${m.displayName} does not add up`);
  const before = plan.before.mismatches.map(mismatchKey).sort().join(";");
  const untouched = after.filter((m) => !touched.has(m.itemId)).map(mismatchKey).sort().join(";");
  if (before !== untouched) problems.push("the set of other materials whose stock does not add up has changed");
  return check("Stock adds up", problems, `${touched.size} materials touched, all add up (${after.length} pre-existing mismatch(es) elsewhere, unchanged)`);
}

/** Each brought packet's state is what its last brought scan left it in. */
function packetStates(target: DatabaseSync, plan: ReconciliationPlan): Check {
  const scans = insertsOf(plan, TABLE.PACKET_EVENTS).map((i) => i.written);
  const problems: string[] = [];
  for (const insert of insertsOf(plan, TABLE.PACKETS)) {
    const id = keyOf(TABLE.PACKETS, insert.written);
    const last = scans.filter((scan) => scan.qr_id === id).sort((a, b) => text(a, "event_ts_local").localeCompare(text(b, "event_ts_local"))).at(-1);
    const now = one(target, "SELECT current_status FROM raw_material_qrs WHERE id = ?", id)?.current_status;
    if (last && now !== last.new_status) problems.push(`${id} is ${String(now)}, its last scan left it ${String(last.new_status)}`);
  }
  return check("Packet states match their last scan", problems, `${insertsOf(plan, TABLE.PACKETS).length} packets`);
}

function recipients(target: DatabaseSync, plan: ReconciliationPlan): Check {
  const outs = insertsOf(plan, TABLE.PACKET_EVENTS).filter((i) => i.written.event_type === SCAN.OUT);
  const problems = outs
    .map((i) => one(target, "SELECT metadata_json FROM raw_material_qr_events WHERE id = ?", keyOf(TABLE.PACKET_EVENTS, i.written)))
    .filter((row) => recipientOf(row ? textOrNull(row, "metadata_json") : null) !== plan.decisions.recipient.actual)
    .map(() => "a brought store-out names another party");
  return check("Store-outs name the actual recipient", problems, `${outs.length} store-outs, all to ${plan.decisions.recipient.actual}`);
}

/** No counter, for any supplier and material, could print a brought packet's ID again; none went down. */
function labelsCannotRepeat(target: DatabaseSync, plan: ReconciliationPlan): Check {
  const index = labelTokenIndex(target);
  const problems: string[] = [];
  let pairs = 0;
  for (const insert of insertsOf(plan, TABLE.PACKETS)) {
    for (const pair of pairsSpelling(index, keyOf(TABLE.PACKETS, insert.written))) {
      pairs += 1;
      const counter = one(target, "SELECT last_sequence FROM raw_material_qr_sequences WHERE party_id = ? AND item_id = ?", pair.partyId, pair.itemId);
      if (!counter || num(counter, "last_sequence") < pair.serial) problems.push(`${keyOf(TABLE.PACKETS, insert.written)} could be printed again`);
    }
  }
  for (const update of plan.updates.filter((u) => u.table === TABLE.COUNTERS)) {
    if (Number(update.set.last_sequence) < Number(update.expect.last_sequence)) problems.push(`counter ${update.key} went down`);
  }
  return check("No label can be printed twice", problems, `${pairs} supplier/material pairs that spell a brought label are all past it`);
}

/** Each new number is used once, and the target's next number is past all of them. */
function numbersUnique(target: DatabaseSync, plan: ReconciliationPlan): Check {
  const sites = [
    { table: TABLE.ITEMS, column: "item_code", site: "inventoryItemCode" as const },
    { table: TABLE.RECEIVING, column: "session_number", site: "rmReceivingSession" as const },
    { table: TABLE.ISSUE, column: "session_number", site: "rmIssueSession" as const },
  ];
  const problems: string[] = [];
  const next: string[] = [];
  for (const { table, column, site } of sites) {
    for (const insert of insertsOf(plan, table)) {
      const value = insert.written[column];
      const uses = num(one(target, `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, value) ?? { n: 0 }, "n");
      if (uses !== 1) problems.push(`${table} ${String(value)} is used ${uses} times`);
    }
    next.push(`${site} next ${nextFreeNumber(target, site)}`);
  }
  return check("Every new number used once", problems, next.join(", "));
}

/** Every check, in order. The result is safe to swap in only if every one passes. */
export function verifyReconciliation(source: DatabaseSync, target: DatabaseSync, plan: ReconciliationPlan): Check[] {
  return [
    integrity(target),
    plannedRowsWritten(target, plan),
    nothingElseChanged(target, plan),
    onlyPlannedDifferences(plan),
    sourceAccountedFor(source, target, plan),
    stockAddsUp(target, plan),
    packetStates(target, plan),
    recipients(target, plan),
    labelsCannotRepeat(target, plan),
    numbersUnique(target, plan),
  ];
}
