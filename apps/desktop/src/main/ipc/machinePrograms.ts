// Machine Program: the machines on the floor with their two contractors, and each machine's
// program for the day — the carton QRs generated for it in the QR Generator and B-Carton Labels.
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
import { CARTON_GRADE, PERMISSION, asRecord, asString, isMachineContractorRole } from "@erp/domain";
import { rejection } from "../authorize";

/** What every write returns when it never reached the use case. */
interface WriteRefusal {
  accepted: false;
  outcome: string;
  reason?: string;
}

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
        return { ...rejection(error, "You cannot change machines."), accepted: false, outcome: "NOT_AUTHORIZED" };
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

  // Dana for a program's sole colour — Store Out's Dana issue reads it for programs still open.
  read(IPC.listMachineProgramDana, { rows: [] }, (colour) => ({ rows: db.listMachineProgramDana(asString(colour)) }));

  // ─── The Machine Program: one program per machine per day ───────────────────
  //
  // A program is opened by the machine's first QR run of the day (data/database/cartonProgram.ts),
  // so nothing here creates one. The planning workflow that used to live here — injectors, soles,
  // runs, uppers and their writes — was retired in Phase 1 and its channels are not registered.

  read(IPC.listMachineDayPrograms, { rows: [] }, (programDate) => ({ rows: db.listMachineDayPrograms(asString(programDate)) }));
  read(IPC.listCartonProgramBatches, { rows: [] }, (input) => {
    const line = asRecord(input);
    return {
      rows: db.listCartonProgramBatches({
        programId: asString(line.programId),
        articleSizeId: asString(line.articleSizeId),
        color: asString(line.color),
        grade: line.grade === CARTON_GRADE.B ? CARTON_GRADE.B : null,
      }),
    };
  });

  // + Add Machine: the machine and both of its contractors, in one audited transaction.
  write(IPC.addMachine, (input, actor) =>
    programs.addMachine.execute({
      name: asString(input.name),
      contractorPartyId: asString(input.contractorPartyId),
      packingContractorPartyId: asString(input.packingContractorPartyId),
      ...actor,
    })
  );

  // Changing one of a machine's two contractors. It stays until changed again; a program already
  // opened keeps the pair it was opened with. The role is validated here rather than trusted.
  write(IPC.assignMachineContractor, (input, actor) =>
    programs.assignContractor.execute({
      machineId: asString(input.machineId),
      role: isMachineContractorRole(input.role) ? input.role : null,
      contractorPartyId: asString(input.contractorPartyId),
      ...actor,
    })
  );
}
