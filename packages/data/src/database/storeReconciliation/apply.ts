// ONE-TIME STORE RECONCILIATION — writing the plan. One transaction: every row goes in, or none does.
//
// An update names what the row must still hold. If anything moved between planning and writing, the
// update touches no row, and the whole transaction is rolled back rather than written over it.

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { PlannedUpdate, ReconciliationPlan } from "./plan.js";
import { insertRow, keyColumn } from "./shared.js";

function applyUpdate(db: DatabaseSync, update: PlannedUpdate): void {
  const setColumns = Object.keys(update.set);
  const expectColumns = Object.keys(update.expect);
  const sql =
    `UPDATE ${update.table} SET ${setColumns.map((column) => `${column} = ?`).join(", ")}` +
    ` WHERE ${keyColumn(update.table)} = ?${expectColumns.map((column) => ` AND ${column} IS ?`).join("")}`;
  const params: SQLInputValue[] = [
    ...setColumns.map((column) => update.set[column]),
    update.key,
    ...expectColumns.map((column) => update.expect[column]),
  ];
  const result = db.prepare(sql).run(...params);
  if (Number(result.changes) !== 1) {
    throw new Error(`${update.table} row ${update.key} no longer holds what the plan read. Nothing has been written.`);
  }
}

/** Writes the whole plan in one transaction, or nothing. */
export function applyReconciliation(target: DatabaseSync, plan: ReconciliationPlan): void {
  target.exec("BEGIN IMMEDIATE");
  try {
    for (const insert of plan.inserts) insertRow(target, insert.table, insert.written);
    for (const update of plan.updates) applyUpdate(target, update);
    target.exec("COMMIT");
  } catch (error) {
    target.exec("ROLLBACK");
    throw error;
  }
}
