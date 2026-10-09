// Machine Program: the machines and their contractors, the masters a program is cut from, the
// stock it is cut against, and the program itself.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.
//
// Nothing here decides a business rule. Reads go straight to the data layer, and every write goes
// through a use case, which re-checks it inside the write lock. Hiding a button in the renderer is
// not authorisation, so the permission is checked again here.

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { PERMISSION, asOptionalString, asRecord, asString, isMachineContractorRole, type MachineShift } from "@erp/domain";
import { rejection } from "../authorize";

/** What every program write returns when it never reached the use case. */
interface WriteRefusal {
  accepted: false;
  outcome: string;
  reason?: string;
}

/**
 * A number exactly as the renderer sent it. Deliberately NOT coerced — "30abc" or an empty box must
 * reach the use case as something it refuses, never silently become 30 or 0.
 */
const rawNumber = (value: unknown): number => (typeof value === "number" ? value : Number.NaN);

export function registerMachineProgramHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, deviceId, useCases } = ctx;
  const programs = useCases.machineProgram;

  const log = (severity: "INFO" | "WARNING" | "ERROR", operation: string, message: string, userId?: string) =>
    logger.log({ module: "machine-program", severity, operation, deviceId, userId, message });

  /** A read behind the machine-program permission. A failure comes back as a refusal, never a throw. */
  const read = <T>(channel: string, fallback: T, work: (...args: unknown[]) => T) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        authorizer.requirePermission(event, PERMISSION.MACHINE_PROGRAM);
        return { accepted: true, ...work(...args) };
      } catch (error) {
        log("WARNING", channel, error instanceof Error ? error.message : String(error));
        return { ...rejection(error, "This could not be loaded. Try again."), ...fallback };
      }
    });
  };

  /** A write: permission first, then the use case with the acting user, then one log line. */
  const write = <R extends { accepted: boolean; outcome: string; reason?: string }>(
    channel: string,
    work: (input: Record<string, unknown>, actor: { actor: string; actorUserId: string; deviceId: string }) => Promise<R>
  ) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, rawInput?: unknown): Promise<R | WriteRefusal> => {
      let user;
      try {
        user = authorizer.requirePermission(event, PERMISSION.MACHINE_PROGRAM);
      } catch (error) {
        log("WARNING", `${channel}-denied`, error instanceof Error ? error.message : String(error));
        return { ...rejection(error, "You cannot change machine programs."), accepted: false, outcome: "NOT_AUTHORIZED" };
      }
      try {
        const result = await work(asRecord(rawInput), { actor: user.username, actorUserId: user.id, deviceId });
        log(result.accepted ? "INFO" : "WARNING", channel, JSON.stringify({ outcome: result.outcome, reason: result.reason ?? null }), user.id);
        return result;
      } catch (error) {
        log("ERROR", `${channel}-error`, error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error), user.id);
        return { accepted: false, outcome: "ERROR", reason: "This could not be saved. Nothing was changed — try again." };
      }
    });
  };

  // ─── Machines (master data, set up with raw material setup) ─────────────────

  ipcMain.handle(IPC.listMachines, (_event, includeInactive?: boolean) => {
    try {
      return db.listMachines(includeInactive === true);
    } catch (error) {
      log("ERROR", "list-machines", error instanceof Error ? error.message : String(error));
      return [];
    }
  });

  ipcMain.handle(IPC.createMachine, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      return { accepted: true, machine: db.createMachine({ name: asString(input?.name), sectionId: asString(input?.sectionId) }) };
    } catch (error) {
      return rejection(error, "The machine could not be saved.");
    }
  });

  ipcMain.handle(IPC.setMachineStatus, (event, machineId?: string, status?: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.STOCK);
      db.setMachineStatus(asString(machineId), status === "INACTIVE" ? "INACTIVE" : "ACTIVE");
      return { accepted: true };
    } catch (error) {
      return rejection(error, "The machine could not be updated.");
    }
  });

  // ─── Reads ──────────────────────────────────────────────────────────────────

  read(IPC.listMachineProgramBoard, { rows: [] }, (date) => ({ rows: db.listMachineProgramBoard(asString(date)) }));
  read(IPC.getMachineProgramForDate, { program: null }, (machineId, date) => ({
    program: db.getMachineProgramForDate(asString(machineId), asString(date)),
  }));
  read(IPC.listSoleColourOptions, { rows: [] }, () => ({ rows: db.listSoleColourOptions() }));
  read(IPC.listMachineProgramDana, { rows: [] }, (colour) => ({ rows: db.listMachineProgramDana(asString(colour)) }));
  read(IPC.listMachineProgramArticles, { rows: [] }, () => ({ rows: db.listMachineProgramArticles() }));
  read(IPC.listMachineProgramUppers, { rows: [] }, (machineId, articleSizeId) => ({
    rows: db.listMachineProgramUppers(asString(machineId), asString(articleSizeId)),
  }));

  // ─── Writes ─────────────────────────────────────────────────────────────────

  // The role is validated here rather than trusted: anything that is not a known role is sent
  // as null, and the use case treats that as the MACHINE contractor it always meant.
  write(IPC.assignMachineContractor, (input, actor) =>
    programs.assignContractor.execute({
      machineId: asString(input.machineId),
      role: isMachineContractorRole(input.role) ? input.role : null,
      contractorPartyId: asString(input.contractorPartyId),
      ...actor,
    })
  );

  write(IPC.saveMachineProgramLine, (input, actor) => {
    const run = input.run == null ? null : asRecord(input.run);
    return programs.saveLine.execute({
      machineId: asString(input.machineId),
      programDate: asString(input.programDate),
      shift: readShift(input.shift),
      injectorNo: rawNumber(input.injectorNo),
      runId: asOptionalString(input.runId) ?? null,
      run: run ? { soleColour: asString(run.soleColour), articleSizeId: asString(run.articleSizeId) } : null,
      lineId: asOptionalString(input.lineId) ?? null,
      itemId: asString(input.itemId),
      quantity: rawNumber(input.quantity),
      ...actor,
    });
  });

  write(IPC.saveMachineProgramRun, (input, actor) =>
    programs.saveRun.execute({
      runId: asString(input.runId),
      soleColour: asString(input.soleColour),
      articleSizeId: asString(input.articleSizeId),
      ...actor,
    })
  );

  write(IPC.removeMachineProgramLine, (input, actor) => programs.removeLine.execute({ lineId: asString(input.lineId), ...actor }));
  write(IPC.removeMachineProgramRun, (input, actor) => programs.removeRun.execute({ runId: asString(input.runId), ...actor }));
  write(IPC.deleteMachineProgram, (input, actor) =>
    programs.deleteProgram.execute({ programId: asString(input.programId), reason: asOptionalString(input.reason) ?? null, ...actor })
  );

  write(IPC.setMachineProgramShift, (input, actor) =>
    programs.setShift.execute({
      programId: asString(input.programId),
      shift: readShift(input.shift) ?? { startMinute: Number.NaN, endMinute: Number.NaN },
      ...actor,
    })
  );
}

/**
 * A shift exactly as the renderer sent it, or null when it sent none.
 *
 * The minutes are deliberately NOT coerced: a shift the screen got wrong must reach the use
 * case as something checkMachineShift refuses, never silently become 0.
 */
const readShift = (value: unknown): MachineShift | null => {
  if (value == null) return null;
  const shift = asRecord(value);
  return { startMinute: rawNumber(shift.startMinute), endMinute: rawNumber(shift.endMinute) };
};
