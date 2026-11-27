import test from "node:test";
import assert from "node:assert/strict";
import { EMPLOYEE_STATUS, employeeInput, employeeProblems, monthlySalaryTotal, type EmployeeDraft } from "./employees.js";

// Employees and their salaries (owner, 27 Nov 2026): the one set of rules for the dialog and the database.

const draft = (over: Partial<EmployeeDraft> = {}): EmployeeDraft => ({ name: " ali  raza ", work: "cutting", phone: "0300-1234567", monthlySalary: "25,000", joinedOn: "2026-11-01", ...over });

test("a complete draft is saved trimmed, upper-case, the salary in paisa", () => {
  assert.deepEqual(employeeProblems(draft()), {});
  assert.deepEqual(employeeInput(draft()), { name: "ALI RAZA", work: "CUTTING", phone: "0300-1234567", monthlySalaryPaisa: 2_500_000, joinedOn: "2026-11-01" });
  assert.deepEqual(employeeInput(draft({ work: " ", phone: "", joinedOn: "" })), { name: "ALI RAZA", work: null, phone: null, monthlySalaryPaisa: 2_500_000, joinedOn: null });
  assert.equal(employeeInput(draft({ monthlySalary: "25000.5" }))?.monthlySalaryPaisa, 2_500_050);
});

test("each problem is said in words, on its own field", () => {
  const problems = employeeProblems(draft({ name: "", phone: "call me", monthlySalary: "25k", joinedOn: "1/11/26" }));
  assert.deepEqual(Object.keys(problems).sort(), ["joinedOn", "monthlySalary", "name", "phone"]);
  assert.match(problems.monthlySalary ?? "", /number of rupees/);
  assert.match(employeeProblems(draft({ monthlySalary: "" })).monthlySalary ?? "", /Type the monthly salary/);
  assert.match(employeeProblems(draft({ monthlySalary: "0" })).monthlySalary ?? "", /more than 0/);
  assert.match(employeeProblems(draft({ monthlySalary: "25000000" })).monthlySalary ?? "", /extra zero/);
  assert.equal(employeeInput(draft({ name: "" })), null);
});

test("the month's total counts active employees only", () => {
  assert.equal(monthlySalaryTotal([
    { monthlySalaryPaisa: 2_500_000, status: EMPLOYEE_STATUS.ACTIVE },
    { monthlySalaryPaisa: 3_000_000, status: EMPLOYEE_STATUS.ACTIVE },
    { monthlySalaryPaisa: 9_900_000, status: EMPLOYEE_STATUS.LEFT },
  ]), 5_500_000);
});
