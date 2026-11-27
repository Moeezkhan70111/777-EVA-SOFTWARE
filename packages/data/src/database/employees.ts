// EMPLOYEES AND THEIR SALARIES (owner, 27 Nov 2026). Local 124, cloud 044.
//
//   createEmployee   checked again by the domain's rules (employeeInput), then written once. A second working
//                    employee with the same name is refused in words, never added twice.
//   listEmployees    everyone, working first, then by name.
//   getEmployee      one employee with their salary history (local 126), oldest change first.
//   incrementEmployeeSalary   the salary up by a percentage or a fixed amount (owner, 27 Nov 2026), worked out by the
//                    domain (incrementOf) on the salary as it is NOW, refused if that is not the salary the person saw
//                    (a double click, or a change from elsewhere), and kept as a new line of the history.
//
// The IPC writing it is leased to ACCOUNTS (leaseChannels.ts), so employees are written only on PC1 and read
// everywhere. These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import { randomUUID } from "node:crypto";
import {
  EMPLOYEE_STATUS,
  SALARY_CHANGE_KIND,
  employeeInput,
  employeeProblems,
  incrementOf,
  incrementProblems,
  type EmployeeDraft,
  type EmployeeStatus,
  type IncrementDraft,
  type SalaryChangeKind,
} from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";

export interface EmployeeRecord {
  readonly id: string;
  readonly name: string;
  readonly work: string | null;
  readonly phone: string | null;
  readonly monthlySalaryPaisa: number;
  readonly joinedOn: string | null;
  readonly status: EmployeeStatus;
  readonly createdAt: string;
}

/** One line of an employee's salary history. */
export interface SalaryChangeRecord {
  readonly id: string;
  readonly kind: SalaryChangeKind;
  /** Hundredths of a percent for PERCENT, paisa for FIXED, null for START. */
  readonly amount: number | null;
  readonly fromPaisa: number | null;
  readonly toPaisa: number;
  readonly effectiveOn: string;
  readonly note: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface EmployeeWithHistory extends EmployeeRecord {
  readonly history: readonly SalaryChangeRecord[];
}

/** A refusal said to the person, in words. */
export class EmployeeRefused extends Error {}

const recordOf = (row: Record<string, unknown>): EmployeeRecord => ({
  id: String(row.id),
  name: String(row.name),
  work: row.work == null ? null : String(row.work),
  phone: row.phone == null ? null : String(row.phone),
  monthlySalaryPaisa: Number(row.monthly_salary_paisa),
  joinedOn: row.joined_on == null ? null : String(row.joined_on),
  status: row.status === EMPLOYEE_STATUS.LEFT ? EMPLOYEE_STATUS.LEFT : EMPLOYEE_STATUS.ACTIVE,
  createdAt: String(row.created_at),
});

const SELECT = "SELECT id, name, work, phone, monthly_salary_paisa, joined_on, status, created_at FROM employees";

const KINDS: ReadonlySet<string> = new Set(Object.values(SALARY_CHANGE_KIND));
const nullableNumber = (value: unknown): number | null => (value == null ? null : Number(value));

const changeOf = (row: Record<string, unknown>): SalaryChangeRecord => ({
  id: String(row.id),
  kind: (KINDS.has(String(row.kind)) ? String(row.kind) : SALARY_CHANGE_KIND.START) as SalaryChangeKind,
  amount: nullableNumber(row.amount),
  fromPaisa: nullableNumber(row.from_paisa),
  toPaisa: Number(row.to_paisa),
  effectiveOn: String(row.effective_on),
  note: row.note == null ? null : String(row.note),
  createdBy: row.created_by == null ? null : String(row.created_by),
  createdAt: String(row.created_at),
});

/** One write, all of it or none. */
function inTransaction<T>(database: SqliteDatabase, work: () => T): T {
  database.db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    const result = work();
    database.db.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
    throw error;
  }
}

const insertChange = (database: SqliteDatabase, line: Omit<SalaryChangeRecord, "id" | "createdAt"> & { employeeId: string }, now: string): void => {
  database.db
    .prepare(
      `INSERT INTO employee_salary_changes (id, employee_id, kind, amount, from_paisa, to_paisa, effective_on, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(randomUUID(), line.employeeId, line.kind, line.amount, line.fromPaisa, line.toPaisa, line.effectiveOn, line.note, line.createdBy, now);
};

export const employeeMethods = {
  createEmployee(this: SqliteDatabase, draft: EmployeeDraft, actor?: string | null): EmployeeRecord {
    const input = employeeInput(draft);
    if (input === null) throw new EmployeeRefused(Object.values(employeeProblems(draft))[0] ?? "Check the employee's details.");
    const taken = this.db.prepare("SELECT 1 AS here FROM employees WHERE UPPER(TRIM(name)) = ? AND status = ?").get(input.name, EMPLOYEE_STATUS.ACTIVE);
    if (taken) throw new EmployeeRefused(`${input.name} is already an employee. Add something to tell them apart, like ${input.name} (CUTTING).`);
    const id = randomUUID();
    const now = new Date().toISOString();
    inTransaction(this, () => {
      this.db
        .prepare(
          `INSERT INTO employees (id, name, work, phone, monthly_salary_paisa, joined_on, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.name, input.work, input.phone, input.monthlySalaryPaisa, input.joinedOn, EMPLOYEE_STATUS.ACTIVE, actor ?? null, now, now);
      // The history starts with the salary they were added with.
      insertChange(this, {
        employeeId: id, kind: SALARY_CHANGE_KIND.START, amount: null, fromPaisa: null, toPaisa: input.monthlySalaryPaisa,
        effectiveOn: input.joinedOn ?? now.slice(0, 10), note: null, createdBy: actor ?? null,
      }, now);
    });
    return recordOf(this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as Record<string, unknown>);
  },

  getEmployee(this: SqliteDatabase, employeeId: string): EmployeeWithHistory | null {
    const row = this.db.prepare(`${SELECT} WHERE id = ?`).get(employeeId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const history = (this.db
      .prepare("SELECT * FROM employee_salary_changes WHERE employee_id = ? ORDER BY effective_on, created_at")
      .all(employeeId) as Array<Record<string, unknown>>).map(changeOf);
    return { ...recordOf(row), history };
  },

  incrementEmployeeSalary(
    this: SqliteDatabase,
    input: { employeeId: string; draft: IncrementDraft; expectedSalaryPaisa: number },
    actor?: string | null
  ): EmployeeWithHistory {
    return inTransaction(this, () => {
      const row = this.db.prepare(`${SELECT} WHERE id = ?`).get(input.employeeId) as Record<string, unknown> | undefined;
      if (!row) throw new EmployeeRefused("That employee is not on this computer.");
      const employee = recordOf(row);
      if (employee.status !== EMPLOYEE_STATUS.ACTIVE) throw new EmployeeRefused(`${employee.name} no longer works here, so the salary cannot be raised.`);
      if (employee.monthlySalaryPaisa !== input.expectedSalaryPaisa) {
        throw new EmployeeRefused(`${employee.name}'s salary changed while this was open. Nothing was changed. Look at the new figure and try again.`);
      }
      const increment = incrementOf(employee.monthlySalaryPaisa, input.draft);
      if (increment === null) throw new EmployeeRefused(Object.values(incrementProblems(employee.monthlySalaryPaisa, input.draft))[0] ?? "Check the increment.");
      const now = new Date().toISOString();
      this.db.prepare("UPDATE employees SET monthly_salary_paisa = ?, updated_at = ? WHERE id = ?").run(increment.newSalaryPaisa, now, employee.id);
      insertChange(this, {
        employeeId: employee.id, kind: input.draft.kind, amount: increment.amount, fromPaisa: employee.monthlySalaryPaisa,
        toPaisa: increment.newSalaryPaisa, effectiveOn: input.draft.effectiveOn.trim(), note: input.draft.note.trim() || null, createdBy: actor ?? null,
      }, now);
      return this.getEmployee(employee.id) as EmployeeWithHistory;
    });
  },

  listEmployees(this: SqliteDatabase): EmployeeRecord[] {
    return (this.db.prepare(`${SELECT} ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, name, created_at`).all() as Array<Record<string, unknown>>).map(recordOf);
  },
};

export type EmployeeMethods = typeof employeeMethods;
