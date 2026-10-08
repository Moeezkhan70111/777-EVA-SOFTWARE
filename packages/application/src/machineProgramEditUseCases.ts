import { MACHINE_PROGRAM_STATUS, checkMachineShift, formatShiftRange, type MachineShift } from "@erp/domain";
import type { TransactionContext } from "./ports.js";
import {
  MachineProgramRejectedError,
  auditProgramChange,
  checkRunHeader,
  formatMachineProgramCode,
  requireOpenProgram,
  runProgramWrite,
  settleProgramStatus,
  type MachineProgramActor,
  type MachineProgramDeps,
  type MachineProgramRunForWrite,
  type MachineProgramWriteResult,
} from "./machineProgramUseCases.js";

// Machine Program — everything that is not adding an upper: the machine's contractor, changing
// a sole run, taking an upper or a run off, and deleting a whole program.
//
// The one rule all the removals share: what has already been scanned out of the store for a
// line is physical fact. A line with anything taken against it is never deleted — it can be
// lowered to what was taken, and the whole program can be deleted (which keeps every line and
// only releases what was still owed), but its history is never erased.

const CONTRACTOR_PARTY_TYPE = "CONTRACTOR";

// ─── The machine's contractor ──────────────────────────────────────────────────

export interface AssignMachineContractorInput extends MachineProgramActor {
  machineId: string;
  contractorPartyId: string;
}

/**
 * Sets who works on a machine. Permanent until somebody changes it, and it affects only programs
 * made from now on — every saved program keeps the contractor it was made with.
 */
export class AssignMachineContractorUseCase {
  constructor(private readonly deps: MachineProgramDeps) {}

  async execute(input: AssignMachineContractorInput): Promise<MachineProgramWriteResult> {
    if (!String(input.actor ?? "").trim()) throw new Error("Changing a machine's contractor requires the acting user.");
    return runProgramWrite(this.deps, async (tx) => {
      const machine = await this.deps.repo.getMachineForProgram(String(input.machineId ?? "").trim(), tx);
      if (!machine) throw new MachineProgramRejectedError("MACHINE_NOT_FOUND", "This machine is no longer set up.");

      const contractor = await this.deps.repo.getContractorForProgram(String(input.contractorPartyId ?? "").trim(), tx);
      if (!contractor) throw new MachineProgramRejectedError("CONTRACTOR_NOT_FOUND", "This contractor is not in the Party Master.");
      if (contractor.partyType !== CONTRACTOR_PARTY_TYPE) {
        throw new MachineProgramRejectedError("NOT_A_CONTRACTOR", `${contractor.partyName} is not a contractor in the Party Master.`);
      }
      if (contractor.status !== "ACTIVE") {
        throw new MachineProgramRejectedError("CONTRACTOR_INACTIVE", `${contractor.partyName} is inactive. Choose an active contractor.`);
      }

      await this.deps.repo.setMachineContractor({ machineId: machine.id, contractorPartyId: contractor.id, nowIso: tx.nowIso }, tx);
      await auditProgramChange(
        this.deps,
        {
          ...input,
          eventType: "MACHINE_CONTRACTOR_ASSIGNED",
          entityId: machine.id,
          payload: { machineName: machine.name, previousContractorPartyId: machine.contractorPartyId, contractorPartyId: contractor.id, contractorName: contractor.partyName },
        },
        tx
      );
      return { accepted: true, outcome: "ASSIGNED" };
    });
  }
}

// ─── Changing a sole run ───────────────────────────────────────────────────────

export interface SaveMachineProgramRunInput extends MachineProgramActor {
  runId: string;
  soleColour: string;
  articleSizeId: string;
}

/**
 * Changes the sole colour, or the article + size, of a run already on the program.
 *
 * The sole colour can change freely — the uppers do not depend on it. The uppers DO belong to one
 * article + size, so changing that takes them off (the screen warns first), and is refused once
 * any of them has been scanned out.
 */
export class SaveMachineProgramRunUseCase {
  constructor(private readonly deps: MachineProgramDeps) {}

  async execute(input: SaveMachineProgramRunInput): Promise<MachineProgramWriteResult> {
    if (!String(input.actor ?? "").trim()) throw new Error("Changing a machine program requires the acting user.");
    return runProgramWrite(this.deps, async (tx) => {
      const run = await requireRun(this.deps, input.runId, tx);
      const header = await checkRunHeader(this.deps.repo, input, tx);

      const articleChanged = header.articleSizeId !== run.articleSizeId;
      if (articleChanged && run.hasScans) {
        throw new MachineProgramRejectedError(
          "IN_USE",
          `Uppers for ${run.article} ${run.size} have already been scanned for this sole, so its article and size cannot change. Add a new sole instead.`
        );
      }
      const removedLines = articleChanged ? run.lineCount : 0;
      if (articleChanged) await this.deps.repo.deleteMachineProgramRunLines(run.id, tx);
      await this.deps.repo.updateMachineProgramRun({ id: run.id, ...header, updatedAt: tx.nowIso }, tx);

      await settleProgramStatus(this.deps.repo, run.programId, run.programStatus, input.actor, tx);
      await auditProgramChange(this.deps, { ...input, eventType: "MACHINE_PROGRAM_RUN_CHANGED", entityId: run.programId, payload: { runId: run.id, from: { articleSizeId: run.articleSizeId }, to: header, removedLines } }, tx);
      return { accepted: true, outcome: "SAVED", programId: run.programId, runId: run.id, removedLines };
    });
  }
}

// ─── Taking things off ───────────────────────────────────────────────────────────

export interface RemoveMachineProgramLineInput extends MachineProgramActor {
  lineId: string;
}

/** Takes one upper colour off a run. The run goes too when it was the run's last upper. */
export class RemoveMachineProgramLineUseCase {
  constructor(private readonly deps: MachineProgramDeps) {}

  async execute(input: RemoveMachineProgramLineInput): Promise<MachineProgramWriteResult> {
    if (!String(input.actor ?? "").trim()) throw new Error("Changing a machine program requires the acting user.");
    return runProgramWrite(this.deps, async (tx) => {
      const line = await this.deps.repo.getMachineProgramLineForWrite(String(input.lineId ?? "").trim(), tx);
      if (!line) throw new MachineProgramRejectedError("LINE_NOT_FOUND", "This upper is no longer on the program.");
      requireOpenProgram(line.programStatus);
      if (line.hasScans) {
        throw new MachineProgramRejectedError(
          "IN_USE",
          line.consumed > 0
            ? `${line.consumed} of this upper have already been scanned out, so it stays on the program. Lower it to ${line.consumed} instead.`
            : "This upper has been scanned for this program before, so it stays on it as a record."
        );
      }

      await this.deps.repo.deleteMachineProgramLine(line.id, tx);
      const runEmptied = (await this.deps.repo.countMachineProgramRunLines(line.runId, tx)) === 0;
      if (runEmptied) await this.deps.repo.deleteMachineProgramRun(line.runId, tx);

      await settleProgramStatus(this.deps.repo, line.programId, line.programStatus, input.actor, tx);
      await auditProgramChange(this.deps, { ...input, eventType: "MACHINE_PROGRAM_LINE_REMOVED", entityId: line.programId, payload: { runId: line.runId, lineId: line.id, itemId: line.itemId, quantity: line.quantity, runRemoved: runEmptied } }, tx);
      return { accepted: true, outcome: "REMOVED", programId: line.programId, runId: runEmptied ? undefined : line.runId };
    });
  }
}

export interface RemoveMachineProgramRunInput extends MachineProgramActor {
  runId: string;
}

/** Takes a whole sole run, and every upper on it, off an injector. */
export class RemoveMachineProgramRunUseCase {
  constructor(private readonly deps: MachineProgramDeps) {}

  async execute(input: RemoveMachineProgramRunInput): Promise<MachineProgramWriteResult> {
    if (!String(input.actor ?? "").trim()) throw new Error("Changing a machine program requires the acting user.");
    return runProgramWrite(this.deps, async (tx) => {
      const run = await requireRun(this.deps, input.runId, tx);
      if (run.hasScans) {
        throw new MachineProgramRejectedError(
          "IN_USE",
          "Uppers for this sole have already been scanned out, so it cannot be taken off. Delete the whole program to release what is left."
        );
      }
      await this.deps.repo.deleteMachineProgramRun(run.id, tx);
      await settleProgramStatus(this.deps.repo, run.programId, run.programStatus, input.actor, tx);
      await auditProgramChange(this.deps, { ...input, eventType: "MACHINE_PROGRAM_RUN_REMOVED", entityId: run.programId, payload: { runId: run.id, injectorNo: run.injectorNo, article: run.article, size: run.size, lines: run.lineCount } }, tx);
      return { accepted: true, outcome: "REMOVED", programId: run.programId };
    });
  }
}

const requireRun = async (deps: MachineProgramDeps, runId: string, tx: TransactionContext): Promise<MachineProgramRunForWrite> => {
  const run = await deps.repo.getMachineProgramRunForWrite(String(runId ?? "").trim(), tx);
  if (!run) throw new MachineProgramRejectedError("RUN_NOT_FOUND", "This sole is no longer on the program.");
  requireOpenProgram(run.programStatus);
  return run;
};

// ─── Deleting a program ──────────────────────────────────────────────────────────

export interface DeleteMachineProgramInput extends MachineProgramActor {
  programId: string;
  reason?: string | null;
}

/**
 * Deleting a machine program cancels it. The document and every line are kept: what was
 * promised, and what was taken against it, is history. Only what was still outstanding is
 * released. Uppers Raw Material Output already issued are on the machine, and no paper decision
 * brings them back into stock. The date is free for a new program afterwards.
 */
export class DeleteMachineProgramUseCase {
  constructor(private readonly deps: MachineProgramDeps) {}

  async execute(input: DeleteMachineProgramInput): Promise<MachineProgramWriteResult> {
    if (!String(input.actor ?? "").trim()) throw new Error("Deleting a machine program requires the acting user.");
    return runProgramWrite(this.deps, async (tx) => {
      const program = await this.deps.repo.getMachineProgramForClose(String(input.programId ?? "").trim(), tx);
      if (!program) throw new MachineProgramRejectedError("PROGRAM_NOT_FOUND", "This program no longer exists.");
      if (program.status === MACHINE_PROGRAM_STATUS.CANCELLED) {
        throw new MachineProgramRejectedError("PROGRAM_CLOSED", "This program has already been deleted.");
      }

      const reason = String(input.reason ?? "").trim() || null;
      const closed = await this.deps.repo.closeMachineProgram(
        { programId: program.id, status: MACHINE_PROGRAM_STATUS.CANCELLED, actor: input.actor, reason, nowIso: tx.nowIso },
        tx
      );
      if (!closed) throw new MachineProgramRejectedError("PROGRAM_CLOSED", "This program changed while you were looking at it. Open it again.");

      await auditProgramChange(this.deps, { ...input, eventType: "MACHINE_PROGRAM_DELETED", entityId: program.id, payload: { code: formatMachineProgramCode(program.programNumber), machineName: program.machineName, contractorName: program.contractorName, programDate: program.programDate, totalQuantity: program.totalQuantity, consumedQuantity: program.consumedQuantity, releasedQuantity: program.outstandingQuantity, reason } }, tx);
      return {
        accepted: true,
        outcome: "CANCELLED",
        programId: program.id,
        // A COMPLETED program held nothing back, so deleting it releases nothing.
        releasedQuantity: program.status === MACHINE_PROGRAM_STATUS.PROGRAMMED ? program.outstandingQuantity : 0,
        consumedQuantity: program.consumedQuantity,
      };
    });
  }
}

// ─── The shift a program runs ──────────────────────────────────────────────────

export interface SetMachineProgramShiftInput extends MachineProgramActor {
  programId: string;
  shift: MachineShift;
}

/**
 * Changes which shift a saved program is for.
 *
 * The shift describes the program, not any of its lines, so nothing is reserved, released or
 * moved by this: the same uppers are promised, for a different stretch of the clock. A deleted
 * program is refused, like every other write.
 */
export class SetMachineProgramShiftUseCase {
  constructor(private readonly deps: MachineProgramDeps) {}

  async execute(input: SetMachineProgramShiftInput): Promise<MachineProgramWriteResult> {
    if (!String(input.actor ?? "").trim()) throw new Error("Changing a program's shift requires the acting user.");
    if (!input.shift || !checkMachineShift(input.shift)) {
      return { accepted: false, outcome: "INVALID_SHIFT", reason: "Choose the shift this program runs." };
    }

    return runProgramWrite(this.deps, async (tx) => {
      const program = await this.deps.repo.getMachineProgramForClose(String(input.programId ?? "").trim(), tx);
      if (!program) throw new MachineProgramRejectedError("PROGRAM_NOT_FOUND", "This program no longer exists.");
      requireOpenProgram(program.status);

      await this.deps.repo.setMachineProgramShift(
        { programId: program.id, shiftStartMinute: input.shift.startMinute, shiftEndMinute: input.shift.endMinute, nowIso: tx.nowIso },
        tx
      );
      await auditProgramChange(
        this.deps,
        {
          ...input,
          eventType: "MACHINE_PROGRAM_SHIFT_CHANGED",
          entityId: program.id,
          payload: {
            code: formatMachineProgramCode(program.programNumber),
            machineName: program.machineName,
            programDate: program.programDate,
            shift: formatShiftRange(input.shift),
          },
        },
        tx
      );
      return { accepted: true, outcome: "SAVED", programId: program.id };
    });
  }
}
