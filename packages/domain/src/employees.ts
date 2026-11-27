import { isBusinessDate } from "./cartonAdjustment.js";
import { typedRupeesToPaisa } from "./money.js";

// EMPLOYEES AND THEIR SALARIES (owner, 27 Nov 2026: "add a new card on dashboard named as Salaries ... add Employee ...
// set its salary"). One employee: a name, what they do, a phone, the day they joined, and the monthly salary, kept
// in integer paisa (R15). The one set of rules for the Add Employee dialog and for the database, which checks again.

export const EMPLOYEE_STATUS = {
  ACTIVE: "ACTIVE",
  /** No longer working here: kept, with the salary they had. */
  LEFT: "LEFT",
} as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUS)[keyof typeof EMPLOYEE_STATUS];

export const EMPLOYEE_NAME_MAX = 60;
export const EMPLOYEE_WORK_MAX = 60;
export const EMPLOYEE_PHONE_MAX = 20;
/** Rs 10,00,000 a month: far above any salary here, so a slipped zero is caught. */
export const EMPLOYEE_SALARY_MAX_PAISA = 1_000_000 * 100;

/** The Add Employee form as typed. */
export interface EmployeeDraft {
  readonly name: string;
  readonly work: string;
  readonly phone: string;
  /** Rupees as typed: "25000" or "25000.50". */
  readonly monthlySalary: string;
  /** YYYY-MM-DD, or empty when not known. */
  readonly joinedOn: string;
}

export type EmployeeField = keyof EmployeeDraft;

/** An employee ready to save: trimmed, upper-case name, salary in paisa. */
export interface EmployeeInput {
  readonly name: string;
  readonly work: string | null;
  readonly phone: string | null;
  readonly monthlySalaryPaisa: number;
  readonly joinedOn: string | null;
}

const PHONE = /^[0-9+\-\s()]+$/;

const salaryProblem = (typed: string): string | null => {
  if (!typed.trim()) return "Type the monthly salary in rupees, like 25000.";
  const paisa = typedRupeesToPaisa(typed.replace(/,/g, ""));
  if (paisa === null) return "Type the salary as a number of rupees, like 25000 or 25000.50.";
  if (paisa <= 0) return "The salary must be more than 0.";
  if (paisa > EMPLOYEE_SALARY_MAX_PAISA) return "That salary is over Rs 10,00,000 a month. Check for an extra zero.";
  return null;
};

/** Why each field cannot be saved, in words. Empty when the draft is ready. */
export function employeeProblems(draft: EmployeeDraft): Partial<Record<EmployeeField, string>> {
  const problems: Partial<Record<EmployeeField, string>> = {};
  const name = draft.name.trim();
  if (!name) problems.name = "Type the employee's name.";
  else if (name.length > EMPLOYEE_NAME_MAX) problems.name = `A name is at most ${EMPLOYEE_NAME_MAX} letters.`;
  if (draft.work.trim().length > EMPLOYEE_WORK_MAX) problems.work = `At most ${EMPLOYEE_WORK_MAX} letters.`;
  const phone = draft.phone.trim();
  if (phone && (!PHONE.test(phone) || phone.length > EMPLOYEE_PHONE_MAX)) problems.phone = "Type the phone number with digits only, like 0300-1234567.";
  const salary = salaryProblem(draft.monthlySalary);
  if (salary) problems.monthlySalary = salary;
  if (draft.joinedOn.trim() && !isBusinessDate(draft.joinedOn.trim())) problems.joinedOn = "Pick the day they joined from the calendar.";
  return problems;
}

/** The draft as it is saved, or null while it has a problem. */
export function employeeInput(draft: EmployeeDraft): EmployeeInput | null {
  if (Object.keys(employeeProblems(draft)).length > 0) return null;
  const optional = (value: string) => (value.trim() ? value.trim() : null);
  return {
    name: draft.name.trim().toUpperCase().replace(/\s+/g, " "),
    work: optional(draft.work)?.toUpperCase().replace(/\s+/g, " ") ?? null,
    phone: optional(draft.phone),
    monthlySalaryPaisa: typedRupeesToPaisa(draft.monthlySalary.replace(/,/g, "")) ?? 0,
    joinedOn: optional(draft.joinedOn),
  };
}

/** What the active employees cost in a month, in paisa. */
export const monthlySalaryTotal = (employees: ReadonlyArray<{ monthlySalaryPaisa: number; status: string }>): number =>
  employees.filter((employee) => employee.status === EMPLOYEE_STATUS.ACTIVE).reduce((sum, employee) => sum + employee.monthlySalaryPaisa, 0);
