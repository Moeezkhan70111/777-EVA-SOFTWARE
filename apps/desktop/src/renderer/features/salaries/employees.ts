import { EMPLOYEE_STATUS, fromPaisa, type EmployeeStatus } from "@erp/domain";
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

/** A salary on screen: whole rupees, or with its paisa when it has some. */
export const salaryText = (paisa: number): string => (paisa % 100 === 0 ? formatWholeMoney(fromPaisa(paisa)) : formatMoney(fromPaisa(paisa)));
