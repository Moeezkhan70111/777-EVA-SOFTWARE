// EMPLOYEES AND THEIR SALARIES (owner, 27 Nov 2026). Local 124, cloud 044.
//
//   createEmployee   checked again by the domain's rules (employeeInput), then written once. A second working
//                    employee with the same name is refused in words, never added twice.
//   listEmployees    everyone, working first, then by name.
//
// The IPC writing it is leased to ACCOUNTS (leaseChannels.ts), so employees are written only on PC1 and read
// everywhere. These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import { randomUUID } from "node:crypto";
import { EMPLOYEE_STATUS, employeeInput, employeeProblems, type EmployeeDraft, type EmployeeStatus } from "@erp/domain";
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

export const employeeMethods = {
  createEmployee(this: SqliteDatabase, draft: EmployeeDraft, actor?: string | null): EmployeeRecord {
    const input = employeeInput(draft);
    if (input === null) throw new EmployeeRefused(Object.values(employeeProblems(draft))[0] ?? "Check the employee's details.");
    const taken = this.db.prepare("SELECT 1 AS here FROM employees WHERE UPPER(TRIM(name)) = ? AND status = ?").get(input.name, EMPLOYEE_STATUS.ACTIVE);
    if (taken) throw new EmployeeRefused(`${input.name} is already an employee. Add something to tell them apart, like ${input.name} (CUTTING).`);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO employees (id, name, work, phone, monthly_salary_paisa, joined_on, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.name, input.work, input.phone, input.monthlySalaryPaisa, input.joinedOn, EMPLOYEE_STATUS.ACTIVE, actor ?? null, now, now);
    return recordOf(this.db.prepare(`${SELECT} WHERE id = ?`).get(id) as Record<string, unknown>);
  },

  listEmployees(this: SqliteDatabase): EmployeeRecord[] {
    return (this.db.prepare(`${SELECT} ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, name, created_at`).all() as Array<Record<string, unknown>>).map(recordOf);
  },
};

export type EmployeeMethods = typeof employeeMethods;
