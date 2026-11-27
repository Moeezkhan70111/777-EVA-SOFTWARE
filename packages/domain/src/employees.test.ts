import test from "node:test";
import assert from "node:assert/strict";
import { EMPLOYEE_STATUS, SALARY_CHANGE_KIND, employeeInput, employeeProblems, incrementOf, incrementProblems, monthlySalaryTotal, type EmployeeDraft, type IncrementDraft } from "./employees.js";

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

// Owner, 27 Nov 2026: "increment the salary by percentage or a fixed value".

const raise = (over: Partial<IncrementDraft> = {}): IncrementDraft => ({ kind: SALARY_CHANGE_KIND.PERCENT, value: "10", effectiveOn: "2026-12-01", note: "", ...over });

test("a percentage is worked out on the salary now, rounded to the nearest rupee", () => {
  assert.deepEqual(incrementOf(2_500_000, raise()), { increasePaisa: 250_000, newSalaryPaisa: 2_750_000, amount: 1000 });
  assert.deepEqual(incrementOf(2_533_300, raise()), { increasePaisa: 253_300, newSalaryPaisa: 2_786_600, amount: 1000 }, "10% of Rs 25,333 is Rs 2,533");
  assert.deepEqual(incrementOf(2_500_000, raise({ value: "7.5" })), { increasePaisa: 187_500, newSalaryPaisa: 2_687_500, amount: 750 });
});

test("a fixed amount is added as typed", () => {
  assert.deepEqual(incrementOf(2_500_000, raise({ kind: SALARY_CHANGE_KIND.FIXED, value: "2,500" })), { increasePaisa: 250_000, newSalaryPaisa: 2_750_000, amount: 250_000 });
});

test("a slip is refused in words, on its own field", () => {
  assert.match(incrementProblems(2_500_000, raise({ value: "" })).value ?? "", /as a percentage/);
  assert.match(incrementProblems(2_500_000, raise({ value: "ten" })).value ?? "", /like 10 or 7.5/);
  assert.match(incrementProblems(2_500_000, raise({ value: "0" })).value ?? "", /more than 0/);
  assert.match(incrementProblems(2_500_000, raise({ value: "150" })).value ?? "", /at most 100%/);
  assert.match(incrementProblems(1_000, raise({ value: "1" })).value ?? "", /less than one rupee/);
  assert.match(incrementProblems(2_500_000, raise({ kind: SALARY_CHANGE_KIND.FIXED, value: "99999999" })).value ?? "", /over Rs 10,00,000/);
  assert.match(incrementProblems(2_500_000, raise({ effectiveOn: "" })).effectiveOn ?? "", /Pick the day/);
  assert.equal(incrementOf(2_500_000, raise({ value: "abc" })), null);
});
