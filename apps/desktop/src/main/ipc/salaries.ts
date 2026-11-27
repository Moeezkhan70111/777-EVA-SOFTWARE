// THE SALARIES PAGE (owner, 27 Nov 2026): employees and their monthly salaries.
//
//   listEmployees    anyone given Salaries (PERMISSION.SALARIES), on any computer.
//   createEmployee   the same permission, and only where the accounts are written (the ACCOUNTS lease, PC1,
//                    leaseChannels.ts). The rules are the domain's (employees.ts), checked again by the database.
//
// Who added it is read here, never from the screen.

import type { IpcMainInvokeEvent } from "electron";
import { PERMISSION, asRecord, asString } from "@erp/domain";
import { EmployeeRefused } from "@erp/data";
import { ipcMain } from "../leaseGuard";
import { IPC } from "../../shared/ipcChannels";
import { DATA_KIND, type DataKind } from "../../shared/dataChange";
import { rejection, type SessionUser } from "../authorize";
import { refusalReason } from "../writeRefusal";
import type { IpcContext } from "./context";

/** What an operator is told. One place, for translation later (R21). */
export const SALARY_MESSAGES = {
  BUSY: "The employee was not saved because another write is in progress. Nothing was changed. Please try again.",
  NOT_SAVED: "The employee could not be saved. Nothing was changed.",
  NOT_LOADED: "The employees could not be loaded. Try again.",
  NOT_ALLOWED: "Your account does not have access to Salaries.",
} as const;

/** Exactly what these handlers need. */
export interface SalaryContext {
  db: IpcContext["db"];
  logger: Pick<IpcContext["logger"], "log">;
  authorizer: Pick<IpcContext["authorizer"], "requirePermission">;
  deviceId: string;
  /** Tells open screens what changed (main/dataChanged.ts). Nothing when absent. */
  announce?: (kinds: readonly DataKind[]) => void;
}

type Allowed = { ok: true; user: SessionUser } | { ok: false; reason: string };

export function registerSalaryHandlers(ctx: SalaryContext): void {
  const { db, logger, authorizer, deviceId } = ctx;
  const announce = ctx.announce ?? (() => undefined);

  const allowed = (event: IpcMainInvokeEvent, opts: unknown): Allowed => {
    try {
      return { ok: true, user: authorizer.requirePermission(event, PERMISSION.SALARIES, asRecord(opts).token) };
    } catch (error) {
      return { ok: false, reason: rejection(error, SALARY_MESSAGES.NOT_ALLOWED).reason };
    }
  };

  ipcMain.handle(IPC.listEmployees, (event, opts?: unknown) => {
    const who = allowed(event, opts);
    if (!who.ok) return { accepted: false, reason: who.reason };
    try {
      return { accepted: true, employees: db.listEmployees() };
    } catch {
      return { accepted: false, reason: SALARY_MESSAGES.NOT_LOADED };
    }
  });

  ipcMain.handle(IPC.createEmployee, (event, input?: unknown, opts?: unknown) => {
    const who = allowed(event, opts);
    if (!who.ok) return { accepted: false, reason: who.reason };
    const fields = asRecord(input);
    const draft = {
      name: asString(fields.name), work: asString(fields.work), phone: asString(fields.phone),
      monthlySalary: asString(fields.monthlySalary), joinedOn: asString(fields.joinedOn),
    };
    try {
      const employee = db.createEmployee(draft, who.user.username);
      logger.log({ module: "salaries", severity: "INFO", operation: "create-employee", deviceId, userId: who.user.id, message: `${employee.name}, ${employee.monthlySalaryPaisa} paisa a month` });
      announce([DATA_KIND.SALARIES]);
      return { accepted: true, employee };
    } catch (error) {
      const reason = error instanceof EmployeeRefused ? error.message : refusalReason(error, SALARY_MESSAGES.BUSY, SALARY_MESSAGES.NOT_SAVED);
      logger.log({ module: "salaries", severity: "WARNING", operation: "create-employee-refused", deviceId, userId: who.user.id, message: reason });
      return { accepted: false, reason };
    }
  });
}
