import {
  CONTRACTOR_PARTY_TYPE,
  MACHINE_PROGRAM_STATUS,
  attributeKey,
  checkMachineShift,
  checkSoleSlot,
  formatShiftRange,
  isMachineContractorRole,
  type MachineContractorRole,
  type MachineShift,
} from "@erp/domain";
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

// ─── The machine's contractor ──────────────────────────────────────────────────

/** The contractor a machine may be given: in the Party Master, a CONTRACTOR, and active. */
const requireActiveContractor = async (
  deps: MachineProgramDeps,
  partyId: string,
  tx: TransactionContext
): Promise<{ id: string; partyName: string }> => {
  const contractor = await deps.repo.getContractorForProgram(String(partyId ?? "").trim(), tx);
  if (!contractor) throw new MachineProgramRejectedError("CONTRACTOR_NOT_FOUND", "This contractor is not in the Party Master.");
  if (contractor.partyType !== CONTRACTOR_PARTY_TYPE) {
    throw new MachineProgramRejectedError("NOT_A_CONTRACTOR", `${contractor.partyName} is not a contractor in the Party Master.`);
  }
  if (contractor.status !== "ACTIVE") {
    throw new MachineProgramRejectedError("CONTRACTOR_INACTIVE", `${contractor.partyName} is inactive. Choose an active contractor.`);
  }
  return contractor;
};

export interface AssignMachineContractorInput extends MachineProgramActor {
  machineId: string;
  /** Which of the machine's two contractors this is — the one who runs it, or the one who packs. */
  role?: MachineContractorRole | null;
  contractorPartyId: string;
}

/**
 * Sets one of the two contractors a machine is worked by. Permanent until somebody changes it,
 * and it affects only programs made from now on — every saved program keeps the pair it was
 * made with.
 *
 * The role defaults to MACHINE so a caller written before packing existed still means what it
 * always meant.
 */
export class AssignMachineContractorUseCase {
  constructor(private readonly deps: MachineProgramDeps) {}

  async execute(input: AssignMachineContractorInput): Promise<MachineProgramWriteResult> {
    if (!String(input.actor ?? "").trim()) throw new Error("Changing a machine's contractor requires the acting user.");
    return runProgramWrite(this.deps, async (tx) => {
      const machine = await this.deps.repo.getMachineForProgram(String(input.machineId ?? "").trim(), tx);
      if (!machine) throw new MachineProgramRejectedError("MACHINE_NOT_FOUND", "This machine is no longer set up.");

      const role: MachineContractorRole = isMachineContractorRole(input.role) ? input.role : "MACHINE";
      const contractor = await requireActiveContractor(this.deps, input.contractorPartyId, tx);

      await this.deps.repo.setMachineContractor({ machineId: machine.id, role, contractorPartyId: contractor.id, nowIso: tx.nowIso }, tx);
      await auditProgramChange(
        this.deps,
        {
          ...input,
          eventType: "MACHINE_CONTRACTOR_ASSIGNED",
          entityId: machine.id,
          payload: {
            machineName: machine.name,
            role,
            previousContractorPartyId: role === "PACKING" ? machine.packingContractorPartyId : machine.contractorPartyId,
            contractorPartyId: contractor.id,
            contractorName: contractor.partyName,
          },
        },
        tx
      );
      return { accepted: true, outcome: "ASSIGNED" };
    });
  }
}

// ─── Adding a machine ──────────────────────────────────────────────────────────

export interface AddMachineInput extends MachineProgramActor {
  name: string;
  contractorPartyId: string;
  packingContractorPartyId: string;
}

/**
 * Adds a machine together with the two contractors it is worked by — the Machine Program's
 * "+ Add Machine". One transaction: the machine never exists without both of them.
 *
 * A name already in use is refused rather than returned: adding "MACHINE 1" twice must not
 * quietly re-assign the contractors of the machine that already has that name.
 */
export class AddMachineUseCase {
  constructor(private readonly deps: MachineProgramDeps) {}

  async execute(input: AddMachineInput): Promise<MachineProgramWriteResult> {
    if (!String(input.actor ?? "").trim()) throw new Error("Adding a machine requires the acting user.");
    const name = String(input.name ?? "").trim().toUpperCase();
    if (!name) return { accepted: false, outcome: "NAME_REQUIRED", reason: "Type the machine's name." };

    return runProgramWrite(this.deps, async (tx) => {
      const existing = await this.deps.repo.findMachineByName(name, tx);
      if (existing) {
        throw new MachineProgramRejectedError(
          "MACHINE_EXISTS",
          existing.status === "ACTIVE"
            ? `${name} is already set up. Change its contractors instead.`
            : `${name} already exists but is retired. Restore it under Raw Material → Setup → Machines.`
        );
      }
      const contractor = await requireActiveContractor(this.deps, input.contractorPartyId, tx);
      const packing = await requireActiveContractor(this.deps, input.packingContractorPartyId, tx);

      const machine = await this.deps.repo.insertMachineForProgram(name, tx);
      await this.deps.repo.setMachineContractor({ machineId: machine.id, role: "MACHINE", contractorPartyId: contractor.id, nowIso: tx.nowIso }, tx);
      await this.deps.repo.setMachineContractor({ machineId: machine.id, role: "PACKING", contractorPartyId: packing.id, nowIso: tx.nowIso }, tx);
      await auditProgramChange(
        this.deps,
        {
          ...input,
          eventType: "MACHINE_ADDED",
          entityId: machine.id,
          payload: { machineName: machine.name, contractorName: contractor.partyName, packingContractorName: packing.partyName },
        },
        tx
      );
      return { accepted: true, outcome: "ADDED", machineId: machine.id };
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
      // A FIX run's carton labels point at it, so the database would refuse the delete anyway —
      // said here in words, because a printed carton identity is a record, not a detail.
      const fixRun = await this.deps.repo.getMachineProgramFixRunForWrite(run.id, tx);
      if (fixRun && fixRun.labelledCartons > 0) {
        throw new MachineProgramRejectedError(
          "CARTONS_LABELLED",
          `${fixRun.labelledCartons} carton labels are already printed for ${run.article} ${run.size}, so it cannot be taken off the program. Void them in QR Management first.`
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
// ─── When each sole runs, inside that shift ────────────────────────────────────

export interface SetMachineProgramSoleSlotInput extends MachineProgramActor {
  programId: string;
  injectorNo: number;
  soleColour: string;
  /** The hours this colour runs, or null to clear the slot and run the whole shift. */
  slot: MachineShift | null;
}

/**
 * Times one sole colour on one injector: "BLACK 06:00 AM - 10:00 AM".
 *
 * The shift says how long the MACHINE runs. This says how long a SOLE is on it, which is the
 * answer a minder standing at the machine actually needs. The slot has to sit inside the shift,
 * because a sole cannot run while the machine is off, and the floor would be given a plan
 * nobody can work to. Overlapping slots are allowed on purpose — an injector changes sole
 * mid-shift and the times read in order.
 *
 * It is written to every run of that colour on that injector, so the one sole card the floor
 * reads has one answer rather than one per article. Nothing is reserved, released or moved:
 * this plans time, not stock.
 */
export class SetMachineProgramSoleSlotUseCase {
  constructor(private readonly deps: MachineProgramDeps) {}

  async execute(input: SetMachineProgramSoleSlotInput): Promise<MachineProgramWriteResult> {
    if (!String(input.actor ?? "").trim()) throw new Error("Timing a sole requires the acting user.");
    const soleColour = attributeKey(String(input.soleColour ?? ""));
    if (!soleColour) return { accepted: false, outcome: "UNKNOWN_COLOUR", reason: "Name the sole colour to time." };

    return runProgramWrite(this.deps, async (tx) => {
      const program = await this.deps.repo.getMachineProgramForClose(String(input.programId ?? "").trim(), tx);
      if (!program) throw new MachineProgramRejectedError("PROGRAM_NOT_FOUND", "This program no longer exists.");
      requireOpenProgram(program.status);

      const shift: MachineShift = { startMinute: program.shiftStartMinute, endMinute: program.shiftEndMinute };
      if (input.slot) {
        const problem = checkSoleSlot(input.slot, shift);
        if (problem === "INVALID_TIME") {
          throw new MachineProgramRejectedError("INVALID_SHIFT", "Give the sole a start and a finish, with the finish later.");
        }
        if (problem === "OUTSIDE_SHIFT") {
          throw new MachineProgramRejectedError(
            "INVALID_SHIFT",
            `The machine runs ${formatShiftRange(shift)}. Time the sole inside that.`
          );
        }
      }

      const written = await this.deps.repo.setMachineProgramSoleSlot(
        {
          programId: program.id,
          injectorNo: Number(input.injectorNo ?? 0),
          soleColour,
          startMinute: input.slot ? input.slot.startMinute : null,
          endMinute: input.slot ? input.slot.endMinute : null,
          nowIso: tx.nowIso,
        },
        tx
      );
      if (written === 0) {
        throw new MachineProgramRejectedError("RUN_NOT_FOUND", `${soleColour} is not on injector ${input.injectorNo}.`);
      }

      await auditProgramChange(
        this.deps,
        {
          ...input,
          eventType: "MACHINE_PROGRAM_SOLE_SLOT_CHANGED",
          entityId: program.id,
          payload: {
            code: formatMachineProgramCode(program.programNumber),
            machineName: program.machineName,
            programDate: program.programDate,
            injectorNo: Number(input.injectorNo ?? 0),
            soleColour,
            slot: input.slot ? formatShiftRange(input.slot) : null,
            runs: written,
          },
        },
        tx
      );
      return { accepted: true, outcome: "SAVED", programId: program.id };
    });
  }
}
