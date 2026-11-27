import { EMPLOYEE_STATUS, SALARY_CHANGE_KIND, fromPaisa, type EmployeeStatus, type SalaryChangeKind } from "@erp/domain";
import { formatMoney, formatWholeMoney } from "../../app/format";

// The Salaries page's data (owner, 27 Nov 2026): every reply from the main process is checked before it is shown
// (R25), and money stays in integer paisa until it is written on screen (R15).

export interface Employee {
  readonly id: string;
  readonly name: string;
  readonly work: string | null;
  readonly phone: string | null;
  readonly monthlySalaryPaisa: number;
  readonly joinedOn: string | null;
  readonly status: EmployeeStatus;
}

/** One line of an employee's salary history. */
export interface SalaryChange {
  readonly id: string;
  readonly kind: SalaryChangeKind;
  /** Hundredths of a percent for PERCENT, paisa for FIXED, null for START. */
  readonly amount: number | null;
  readonly fromPaisa: number | null;
  readonly toPaisa: number;
  readonly effectiveOn: string;
  readonly note: string | null;
  readonly createdBy: string | null;
}

export interface EmployeeDetail extends Employee {
  readonly history: readonly SalaryChange[];
}

type Reply<T> = { ok: true; value: T } | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const textOrNull = (value: unknown): string | null | undefined => (value === null ? null : typeof value === "string" ? value : undefined);

/** One employee as the main process sent it, or null when it is not one. */
export function employeeOf(value: unknown): Employee | null {
  if (!isRecord(value)) return null;
  const { id, name, monthlySalaryPaisa, status } = value;
  const work = textOrNull(value.work);
  const phone = textOrNull(value.phone);
  const joinedOn = textOrNull(value.joinedOn);
  if (typeof id !== "string" || typeof name !== "string" || work === undefined || phone === undefined || joinedOn === undefined) return null;
  if (typeof monthlySalaryPaisa !== "number" || !Number.isInteger(monthlySalaryPaisa) || monthlySalaryPaisa < 0) return null;
  if (status !== EMPLOYEE_STATUS.ACTIVE && status !== EMPLOYEE_STATUS.LEFT) return null;
  return { id, name, work, phone, monthlySalaryPaisa, joinedOn, status };
}

const KINDS: ReadonlySet<string> = new Set(Object.values(SALARY_CHANGE_KIND));
const numberOrNull = (value: unknown): number | null | undefined => (value === null ? null : typeof value === "number" && Number.isInteger(value) ? value : undefined);

/** One history line as the main process sent it, or null when it is not one. */
function changeOf(value: unknown): SalaryChange | null {
  if (!isRecord(value) || typeof value.id !== "string" || !KINDS.has(String(value.kind))) return null;
  const amount = numberOrNull(value.amount);
  const fromPaisa = numberOrNull(value.fromPaisa);
  const note = textOrNull(value.note);
  const createdBy = textOrNull(value.createdBy);
  if (amount === undefined || fromPaisa === undefined || note === undefined || createdBy === undefined) return null;
  if (typeof value.toPaisa !== "number" || !Number.isInteger(value.toPaisa) || typeof value.effectiveOn !== "string") return null;
  return { id: value.id, kind: value.kind as SalaryChangeKind, amount, fromPaisa, toPaisa: value.toPaisa, effectiveOn: value.effectiveOn, note, createdBy };
}

/** An employee with their history, or null when the reply is not one. */
export function employeeDetailOf(value: unknown): EmployeeDetail | null {
  const employee = employeeOf(value);
  if (employee === null || !isRecord(value) || !Array.isArray(value.history)) return null;
  const history = value.history.map(changeOf);
  return history.every((line): line is SalaryChange => line !== null) ? { ...employee, history } : null;
}

const reasonOf = (reply: unknown, failed: string): string => (isRecord(reply) && typeof reply.reason === "string" ? reply.reason : failed);

export function parseEmployeesReply(reply: unknown, failed: string): Reply<Employee[]> {
  if (!isRecord(reply) || reply.accepted !== true || !Array.isArray(reply.employees)) return { ok: false, reason: reasonOf(reply, failed) };
  const employees = reply.employees.map(employeeOf);
  return employees.every((employee): employee is Employee => employee !== null) ? { ok: true, value: employees } : { ok: false, reason: failed };
}

export function parseEmployeeReply(reply: unknown, failed: string): Reply<Employee> {
  if (!isRecord(reply) || reply.accepted !== true) return { ok: false, reason: reasonOf(reply, failed) };
  const employee = employeeOf(reply.employee);
  return employee ? { ok: true, value: employee } : { ok: false, reason: failed };
}

export function parseEmployeeDetailReply(reply: unknown, failed: string): Reply<EmployeeDetail> {
  if (!isRecord(reply) || reply.accepted !== true) return { ok: false, reason: reasonOf(reply, failed) };
  const employee = employeeDetailOf(reply.employee);
  return employee ? { ok: true, value: employee } : { ok: false, reason: failed };
}

/** A percentage kept in hundredths, on screen: 1000 is "10", 750 is "7.5". */
export const percentText = (hundredths: number): string => String(hundredths / 100);

/** A salary on screen: whole rupees, or with its paisa when it has some. */
export const salaryText = (paisa: number): string => (paisa % 100 === 0 ? formatWholeMoney(fromPaisa(paisa)) : formatMoney(fromPaisa(paisa)));
