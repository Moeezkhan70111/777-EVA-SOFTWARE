import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";
import { EmployeeRefused } from "./database/employees.js";

// Employees and their salaries (owner, 27 Nov 2026): written once, checked again here, never twice for one person.

function withDb(run: (db: SqliteDatabase) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-employees-"));
  const db = new SqliteDatabase({ dbPath: path.join(dir, "erp.db"), schemaPath: path.resolve(process.cwd(), "src/local-schema.sql") });
  try {
    run(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const draft = { name: "ali raza", work: "cutting", phone: "0300-1234567", monthlySalary: "25000", joinedOn: "2026-11-01" };

test("an employee is saved as the rules say and listed, the salary in paisa", () => {
  withDb((db) => {
    const saved = db.createEmployee(draft, "owner");
    assert.equal(saved.name, "ALI RAZA");
    assert.equal(saved.monthlySalaryPaisa, 2_500_000);
    db.createEmployee({ ...draft, name: "Babar", monthlySalary: "30000.50", work: "", phone: "", joinedOn: "" });
    assert.deepEqual(db.listEmployees().map((employee) => [employee.name, employee.monthlySalaryPaisa, employee.work, employee.status]), [
      ["ALI RAZA", 2_500_000, "CUTTING", "ACTIVE"],
      ["BABAR", 3_000_050, null, "ACTIVE"],
    ]);
    const marked = db.db.prepare("SELECT COUNT(*) AS n, COUNT(lease_epoch) AS leased FROM sync_dirty_records WHERE aggregate_type = 'EMPLOYEE'").get() as { n: number; leased: number };
    assert.deepEqual([Number(marked.n), Number(marked.leased)], [2, 0], "both marked, with no lease epoch here: sent only from where ACCOUNTS is held");
  });
});

test("the same working name is refused in words, and a bad draft is refused with its own reason", () => {
  withDb((db) => {
    db.createEmployee(draft);
    assert.throws(() => db.createEmployee({ ...draft, name: " ALI  RAZA " }), (error: unknown) => error instanceof EmployeeRefused && /already an employee/.test(error.message));
    assert.throws(() => db.createEmployee({ ...draft, name: "Kamran", monthlySalary: "abc" }), /number of rupees/);
    assert.equal(db.listEmployees().length, 1);
  });
});

// Owner, 27 Nov 2026: "increment the salary by percentage or a fixed value". Every change is a line of the history.
test("an increment raises the salary on the figure as it is now, and the history keeps every step", () => {
  withDb((db) => {
    const ali = db.createEmployee(draft, "owner");
    const first = db.incrementEmployeeSalary({ employeeId: ali.id, expectedSalaryPaisa: 2_500_000, draft: { kind: "PERCENT", value: "10", effectiveOn: "2026-12-01", note: " yearly " } }, "owner");
    assert.equal(first.monthlySalaryPaisa, 2_750_000);
    const second = db.incrementEmployeeSalary({ employeeId: ali.id, expectedSalaryPaisa: 2_750_000, draft: { kind: "FIXED", value: "1500", effectiveOn: "2027-01-01", note: "" } }, "owner");
    assert.equal(second.monthlySalaryPaisa, 2_900_000);
    assert.deepEqual(second.history.map((line) => [line.kind, line.amount, line.fromPaisa, line.toPaisa, line.effectiveOn, line.note]), [
      ["START", null, null, 2_500_000, "2026-11-01", null],
      ["PERCENT", 1000, 2_500_000, 2_750_000, "2026-12-01", "yearly"],
      ["FIXED", 150_000, 2_750_000, 2_900_000, "2027-01-01", null],
    ]);
    assert.equal(db.listEmployees()[0]?.monthlySalaryPaisa, 2_900_000);
  });
});

test("an increment on a salary that changed meanwhile, or a bad one, is refused and changes nothing", () => {
  withDb((db) => {
    const ali = db.createEmployee(draft);
    const raise = { kind: "PERCENT" as const, value: "10", effectiveOn: "2026-12-01", note: "" };
    db.incrementEmployeeSalary({ employeeId: ali.id, expectedSalaryPaisa: 2_500_000, draft: raise });
    assert.throws(() => db.incrementEmployeeSalary({ employeeId: ali.id, expectedSalaryPaisa: 2_500_000, draft: raise }), /changed while this was open/);
    assert.throws(() => db.incrementEmployeeSalary({ employeeId: ali.id, expectedSalaryPaisa: 2_750_000, draft: { ...raise, value: "500" } }), /at most 100%/);
    assert.throws(() => db.incrementEmployeeSalary({ employeeId: "nobody", expectedSalaryPaisa: 1, draft: raise }), /not on this computer/);
    assert.equal(db.getEmployee(ali.id)?.history.length, 2);
    assert.equal(db.getEmployee(ali.id)?.monthlySalaryPaisa, 2_750_000);
  });
});
