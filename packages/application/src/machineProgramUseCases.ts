import {
  DEFAULT_MACHINE_SHIFT,
  MACHINE_PROGRAM_STATUS,
  RAW_MATERIAL_KIND,
  attributeKey,
  checkMachineShift,
  checkProgramQuantity,
  isInjectorNo,
  roundQuantity,
  sameAttributeValue,
  type MachineContractorRole,
  type MachineShift,
} from "@erp/domain";
import type { EventPublisher, IdGenerator, TransactionContext, TransactionManager } from "./ports.js";

// Machine Program — writing the plan for one machine on one date.
//
//   machine + date → injector 1 / 2 → sole run (sole colour, article + size) → upper lines
//
// A program is a RESERVATION, not a movement. Nothing here writes a stock balance, a stock
// event, a packet status or a QR event. The upper lines say how much of which upper is promised
// to the machine. The uppers leave the store later, when the storekeeper scans them on Raw
// Material Output, and that scan is what consumes a line.
//
// Every change is saved as it is made — one upper line, one run, one removal — and every rule is
// re-checked inside the write lock, never trusted from the screen:
//
//   * the machine exists, is active, and has a contractor (the program keeps a copy of it)
//   * one program per machine per date — a second save on the same date adds to the first
//   * the sole colour is one the store knows, and the article + size is in the Product Master
//   * an upper line is an UPPER whose ARTICLE and SIZE are exactly the run's, and whose quantity
//     fits inside what is free of that upper NOW
//   * a line is never lowered below what has already been scanned out for it

export const formatMachineProgramCode = (programNumber: number): string => `MP-${String(programNumber).padStart(6, "0")}`;

const PROGRAM_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type MachineProgramOutcome =
  | "SAVED"
  | "REMOVED"
  | "CANCELLED"
  | "ASSIGNED"
  | "INVALID_DATE"
  | "INVALID_SHIFT"
  | "INVALID_INJECTOR"
  | "INVALID_QUANTITY"
  | "MACHINE_NOT_FOUND"
  | "MACHINE_INACTIVE"
  | "NO_CONTRACTOR"
  | "NO_PACKING_CONTRACTOR"
  | "CONTRACTOR_NOT_FOUND"
  | "CONTRACTOR_INACTIVE"
  | "NOT_A_CONTRACTOR"
  | "UNKNOWN_COLOUR"
  | "ARTICLE_NOT_FOUND"
  | "RUN_NOT_FOUND"
  | "LINE_NOT_FOUND"
  | "PROGRAM_NOT_FOUND"
  | "PROGRAM_CLOSED"
  | "MATERIAL_NOT_FOUND"
  | "NOT_AN_UPPER"
  | "WRONG_ARTICLE"
  | "MATERIAL_NOT_ALLOCATABLE"
  | "ALREADY_ON_PROGRAM"
  | "BELOW_CONSUMED"
  | "NOT_ENOUGH_STOCK"
  /** Something on it has already been scanned out, so it cannot be taken off. */
  | "IN_USE";

export interface MachineProgramWriteResult {
  accepted: boolean;
  outcome: MachineProgramOutcome;
  reason?: string;
  programId?: string;
  runId?: string;
  lineId?: string;
  /** On NOT_ENOUGH_STOCK: what IS free right now, so the screen can offer it. */
  available?: number;
  unitCode?: string | null;
  /** Upper lines a run edit took off (article or size changed). */
  removedLines?: number;
  /** On a delete: what went back into circulation, and what had already left the store. */
  releasedQuantity?: number;
  consumedQuantity?: number;
}

/** Thrown inside the transaction to abort with a typed outcome and no writes. */
export class MachineProgramRejectedError extends Error {
  constructor(
    readonly outcome: Exclude<MachineProgramOutcome, "SAVED" | "REMOVED" | "CANCELLED" | "ASSIGNED">,
    message: string,
    readonly details: Partial<MachineProgramWriteResult> = {}
  ) {
    super(message);
    this.name = "MachineProgramRejectedError";
  }
}

export interface MachineProgramActor {
  actor: string;
  actorUserId?: string | null;
  deviceId?: string | null;
}

/** A run as a write sees it, read inside the lock. */
export interface MachineProgramRunForWrite {
  id: string;
  programId: string;
  programStatus: string;
  machineId: string;
  machineSectionId: string;
  injectorNo: number;
  articleSizeId: string;
  article: string;
  size: string;
  lineCount: number;
  consumedQuantity: number;
  /** True once any packet has been scanned against any of its lines, even if it came back. */
  hasScans: boolean;
}

/** A line as a write sees it, read inside the lock. */
export interface MachineProgramLineForWrite {
  id: string;
  runId: string;
  programId: string;
  programStatus: string;
  itemId: string;
  quantity: number;
  consumed: number;
  /** True once any packet has been scanned against it, even if it came back. Such a line is a record. */
  hasScans: boolean;
}

/** What the data layer must be able to answer for a program to be written safely. */
export interface MachineProgramRepository {
  getMachineForProgram(
    machineId: string,
    tx: TransactionContext
  ): Promise<{
    id: string; name: string; sectionId: string; status: string;
    contractorPartyId: string | null; packingContractorPartyId: string | null;
  } | null>;
  getContractorForProgram(
    partyId: string,
    tx: TransactionContext
  ): Promise<{ id: string; partyName: string; partyType: string; status: string } | null>;
  setMachineContractor(
    input: { machineId: string; role: MachineContractorRole; contractorPartyId: string; nowIso: string },
    tx: TransactionContext
  ): Promise<void>;
  getMachineProgramByDateForWrite(
    machineId: string,
    programDate: string,
    tx: TransactionContext
  ): Promise<{ id: string; status: string; shiftStartMinute: number; shiftEndMinute: number } | null>;
  allocateMachineProgramNumber(tx: TransactionContext): Promise<number>;
  insertMachineProgram(
    payload: {
      id: string; programNumber: number; machineId: string; machineName: string; contractorPartyId: string;
      contractorName: string; packingContractorPartyId: string; packingContractorName: string;
      programDate: string; shiftStartMinute: number; shiftEndMinute: number;
      createdBy: string; createdAt: string;
    },
    tx: TransactionContext
  ): Promise<void>;
  getArticleSizeForProgram(
    articleSizeId: string,
    tx: TransactionContext
  ): Promise<{ id: string; article: string; size: string; active: boolean } | null>;
  isKnownSoleColour(colour: string): boolean;
  getMachineProgramRunForWrite(runId: string, tx: TransactionContext): Promise<MachineProgramRunForWrite | null>;
  nextMachineProgramRunNo(programId: string, injectorNo: number, tx: TransactionContext): Promise<number>;
  insertMachineProgramRun(
    payload: {
      id: string; programId: string; injectorNo: number; runNo: number; soleColour: string;
      articleSizeId: string; createdBy: string; createdAt: string;
    },
    tx: TransactionContext
  ): Promise<void>;
  updateMachineProgramRun(
    payload: { id: string; soleColour: string; articleSizeId: string; updatedAt: string },
    tx: TransactionContext
  ): Promise<void>;
  /** Deletes a run AND its lines. Only ever called when nothing on it has been scanned out. */
  deleteMachineProgramRun(runId: string, tx: TransactionContext): Promise<void>;
  /** Deletes every line of a run, keeping the run. Same precondition. */
  deleteMachineProgramRunLines(runId: string, tx: TransactionContext): Promise<void>;
  getMachineProgramUpperAvailability(
    input: { itemId: string; machineSectionId: string; excludeLineId: string | null },
    tx: TransactionContext
  ): Promise<{
    itemId: string; displayName: string; kind: string; article: string; size: string; unitId: string | null;
    unitCode: string | null; itemAvailable: number; allocatable: boolean; notAllocatableReason: string | null;
  } | null>;
  getMachineProgramLineForWrite(lineId: string, tx: TransactionContext): Promise<MachineProgramLineForWrite | null>;
  /** The line this run already has for this upper, or null. One upper is one line on a run. */
  findMachineProgramLineForItem(runId: string, itemId: string, tx: TransactionContext): Promise<string | null>;
  nextMachineProgramLineNo(runId: string, tx: TransactionContext): Promise<number>;
  insertMachineProgramLine(
    payload: {
      id: string; runId: string; lineNo: number; itemId: string; quantity: number;
      unitId: string; availableAtSave: number; createdBy: string; createdAt: string;
    },
    tx: TransactionContext
  ): Promise<void>;
  updateMachineProgramLine(payload: { id: string; quantity: number; availableAtSave: number; updatedAt: string }, tx: TransactionContext): Promise<void>;
  deleteMachineProgramLine(lineId: string, tx: TransactionContext): Promise<void>;
  countMachineProgramRunLines(runId: string, tx: TransactionContext): Promise<number>;
  machineProgramIsFullyConsumed(programId: string, tx: TransactionContext): Promise<boolean>;
  closeMachineProgram(
    input: { programId: string; status: "COMPLETED" | "CANCELLED"; actor: string | null; reason: string | null; nowIso: string },
    tx: TransactionContext
  ): Promise<boolean>;
  reopenMachineProgram(programId: string, nowIso: string, tx: TransactionContext): Promise<boolean>;
  setMachineProgramShift(
    payload: { programId: string; shiftStartMinute: number; shiftEndMinute: number; nowIso: string },
    tx: TransactionContext
  ): Promise<void>;
  getMachineProgramForClose(
    programId: string,
    tx: TransactionContext
  ): Promise<{
    id: string; programNumber: number; machineName: string; contractorName: string; programDate: string; status: string;
    totalQuantity: number; consumedQuantity: number; outstandingQuantity: number;
  } | null>;
  appendAuditLog(
    payload: {
      id: string; eventType: string; entityType: string; entityId: string; actorUserId: string | null;
      actorDeviceId: string | null; occurredAt: string; payload: Record<string, unknown>;
    },
    tx: TransactionContext
  ): Promise<void>;
}

export interface MachineProgramDeps {
  txManager: TransactionManager;
  repo: MachineProgramRepository;
  eventPublisher: EventPublisher;
  idGenerator: IdGenerator;
}

const optionalText = (value: string | null | undefined): string | null => {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
};

/**
 * Runs one program write in one transaction. A rule that refuses throws
 * MachineProgramRejectedError, which rolls everything back and comes out as a typed refusal.
 */
export const runProgramWrite = async (
  deps: MachineProgramDeps,
  work: (tx: TransactionContext) => Promise<MachineProgramWriteResult>
): Promise<MachineProgramWriteResult> => {
  try {
    const result = await deps.txManager.runInTransaction(work);
    await deps.eventPublisher.publish("MachineProgramChanged.v1", { programId: result.programId ?? null, outcome: result.outcome });
    return result;
  } catch (error) {
    if (error instanceof MachineProgramRejectedError) {
      return { accepted: false, outcome: error.outcome, reason: error.message, ...error.details };
    }
    throw error;
  }
};

/** Writes one audit row for a program change. */
export const auditProgramChange = (
  deps: MachineProgramDeps,
  input: MachineProgramActor & { eventType: string; entityId: string; payload: Record<string, unknown> },
  tx: TransactionContext
): Promise<void> =>
  deps.repo.appendAuditLog(
    {
      id: deps.idGenerator.nextId(),
      eventType: input.eventType,
      entityType: "MACHINE_PROGRAM",
      entityId: input.entityId,
      actorUserId: input.actorUserId ?? null,
      actorDeviceId: input.deviceId ?? null,
      occurredAt: tx.nowIso,
      payload: { ...input.payload, actor: input.actor },
    },
    tx
  );

/**
 * A program is COMPLETED once everything on it has left the store, and back in service the
 * moment that stops being true (a line raised, a line added, a packet received back).
 */
export const settleProgramStatus = async (
  repo: MachineProgramRepository,
  programId: string,
  currentStatus: string,
  actor: string | null,
  tx: TransactionContext
): Promise<void> => {
  const fullyConsumed = await repo.machineProgramIsFullyConsumed(programId, tx);
  if (currentStatus === MACHINE_PROGRAM_STATUS.PROGRAMMED && fullyConsumed) {
    await repo.closeMachineProgram({ programId, status: MACHINE_PROGRAM_STATUS.COMPLETED, actor, reason: null, nowIso: tx.nowIso }, tx);
  } else if (currentStatus === MACHINE_PROGRAM_STATUS.COMPLETED && !fullyConsumed) {
    await repo.reopenMachineProgram(programId, tx.nowIso, tx);
  }
};

/** A deleted program can be read, never written. */
export const requireOpenProgram = (status: string): void => {
  if (status === MACHINE_PROGRAM_STATUS.CANCELLED) {
    throw new MachineProgramRejectedError("PROGRAM_CLOSED", "This program has been deleted. Go back and open the machine again.");
  }
};

/** The sole colour and the article + size of a run, both checked against the masters. */
export const checkRunHeader = async (
  repo: MachineProgramRepository,
  header: { soleColour: string; articleSizeId: string },
  tx: TransactionContext
): Promise<{ soleColour: string; articleSizeId: string; article: string; size: string }> => {
  const soleColour = attributeKey(header.soleColour);
  if (!repo.isKnownSoleColour(soleColour)) {
    throw new MachineProgramRejectedError("UNKNOWN_COLOUR", "Choose the sole colour from the colours shown.");
  }
  const articleSize = await repo.getArticleSizeForProgram(String(header.articleSizeId ?? "").trim(), tx);
  if (!articleSize || !articleSize.active) {
    throw new MachineProgramRejectedError("ARTICLE_NOT_FOUND", "This article and size is not in the Product Master. Choose another.");
  }
  return { soleColour, articleSizeId: articleSize.id, article: articleSize.article, size: articleSize.size };
};

// ─── Saving one upper line ─────────────────────────────────────────────────────

export interface SaveMachineProgramLineInput extends MachineProgramActor {
  machineId: string;
  /** The program's calendar day, YYYY-MM-DD. */
  programDate: string;
  /** The shift to give the date's program when this is the first thing saved on it. */
  shift?: MachineShift | null;
  injectorNo: number;
  /** The run this line goes on. Absent for the first line of a new run — then `run` is given. */
  runId?: string | null;
  run?: { soleColour: string; articleSizeId: string } | null;
  /** Present when changing the quantity of a line already on the run. */
  lineId?: string | null;
  itemId: string;
  quantity: number;
}

/**
 * Adds an upper colour to a sole run, or changes how much of it the run takes.
 *
 * The first line of a run creates the run, and the first run of a date creates that date's
 * program — copying the machine's contractor onto it. All of it in one transaction, so a
 * refused quantity leaves no half-made program behind.
 */
export class SaveMachineProgramLineUseCase {
  constructor(private readonly deps: MachineProgramDeps) {}

  async execute(input: SaveMachineProgramLineInput): Promise<MachineProgramWriteResult> {
    const actor = String(input.actor ?? "").trim();
    if (!actor) throw new Error("Saving a machine program requires the acting user.");
    if (!PROGRAM_DATE_PATTERN.test(String(input.programDate ?? ""))) {
      return { accepted: false, outcome: "INVALID_DATE", reason: "Choose the date this program is for." };
    }
    if (!isInjectorNo(input.injectorNo)) {
      return { accepted: false, outcome: "INVALID_INJECTOR", reason: "Choose Injector 1 or Injector 2." };
    }
    if (input.shift && !checkMachineShift(input.shift)) {
      return { accepted: false, outcome: "INVALID_SHIFT", reason: "Choose the shift this program runs." };
    }
    if (checkProgramQuantity(input.quantity, { available: Number.POSITIVE_INFINITY }) === "INVALID_QUANTITY") {
      return { accepted: false, outcome: "INVALID_QUANTITY", reason: "Type how many — a number above 0, with at most two decimals." };
    }

    return runProgramWrite(this.deps, async (tx) => {
      const run = await this.resolveRun(input, actor, tx);
      const lineId = optionalText(input.lineId)
        ? await this.changeLine(input, run, actor, tx)
        : await this.addLine(input, run, actor, tx);
      await settleProgramStatus(this.deps.repo, run.programId, run.programStatus, actor, tx);
      return { accepted: true, outcome: "SAVED", programId: run.programId, runId: run.id, lineId };
    });
  }

  /** The run the line goes on: the one named, or a new one on the date's program. */
  private async resolveRun(input: SaveMachineProgramLineInput, actor: string, tx: TransactionContext): Promise<MachineProgramRunForWrite> {
    const runId = optionalText(input.runId);
    if (runId) {
      const run = await this.deps.repo.getMachineProgramRunForWrite(runId, tx);
      if (!run || run.machineId !== String(input.machineId ?? "").trim() || run.injectorNo !== input.injectorNo) {
        throw new MachineProgramRejectedError("RUN_NOT_FOUND", "This sole is no longer on the program. Go back and open it again.");
      }
      requireOpenProgram(run.programStatus);
      return run;
    }
    if (!input.run) throw new MachineProgramRejectedError("RUN_NOT_FOUND", "Choose the sole colour, the article and the size first.");

    const header = await checkRunHeader(this.deps.repo, input.run, tx);
    const program = await this.programForDate(input, actor, tx);
    const id = this.deps.idGenerator.nextId();
    const runNo = await this.deps.repo.nextMachineProgramRunNo(program.id, input.injectorNo, tx);
    await this.deps.repo.insertMachineProgramRun(
      { id, programId: program.id, injectorNo: input.injectorNo, runNo, ...header, createdBy: actor, createdAt: tx.nowIso },
      tx
    );
    const created = await this.deps.repo.getMachineProgramRunForWrite(id, tx);
    if (!created) throw new Error("The new sole run could not be read back.");
    return created;
  }

  /** The machine's program for the date, made now if this is the first thing on it. */
  private async programForDate(input: SaveMachineProgramLineInput, actor: string, tx: TransactionContext) {
    const machine = await this.deps.repo.getMachineForProgram(String(input.machineId ?? "").trim(), tx);
    if (!machine) throw new MachineProgramRejectedError("MACHINE_NOT_FOUND", "This machine is no longer set up. Go back and choose another.");
    if (machine.status !== "ACTIVE") throw new MachineProgramRejectedError("MACHINE_INACTIVE", `${machine.name} has been retired and cannot be programmed.`);

    const existing = await this.deps.repo.getMachineProgramByDateForWrite(machine.id, input.programDate, tx);
    if (existing) return existing;

    // A program the screen never named a shift for runs the day shift, which is what the floor
    // works by default. An existing program keeps the shift it was made with — adding an upper
    // to it never rewrites it.
    const shift: MachineShift = input.shift ?? DEFAULT_MACHINE_SHIFT;

    // A machine is worked by two contractors and the day's output is paid against both, so a
    // program cannot be made until both are set and both are still active.
    if (!machine.contractorPartyId) {
      throw new MachineProgramRejectedError("NO_CONTRACTOR", `Choose the machine contractor for ${machine.name} before making its program.`);
    }
    if (!machine.packingContractorPartyId) {
      throw new MachineProgramRejectedError("NO_PACKING_CONTRACTOR", `Choose the packing contractor for ${machine.name} before making its program.`);
    }
    const contractor = await this.deps.repo.getContractorForProgram(machine.contractorPartyId, tx);
    if (!contractor || contractor.status !== "ACTIVE") {
      throw new MachineProgramRejectedError("CONTRACTOR_INACTIVE", `The machine contractor on ${machine.name} is no longer active. Change the contractor first.`);
    }
    const packer = await this.deps.repo.getContractorForProgram(machine.packingContractorPartyId, tx);
    if (!packer || packer.status !== "ACTIVE") {
      throw new MachineProgramRejectedError("CONTRACTOR_INACTIVE", `The packing contractor on ${machine.name} is no longer active. Change the contractor first.`);
    }

    const id = this.deps.idGenerator.nextId();
    const programNumber = await this.deps.repo.allocateMachineProgramNumber(tx);
    await this.deps.repo.insertMachineProgram(
      {
        id, programNumber, machineId: machine.id, machineName: machine.name, contractorPartyId: contractor.id,
        contractorName: contractor.partyName, packingContractorPartyId: packer.id, packingContractorName: packer.partyName,
        programDate: input.programDate,
        shiftStartMinute: shift.startMinute, shiftEndMinute: shift.endMinute,
        createdBy: actor, createdAt: tx.nowIso,
      },
      tx
    );
    await auditProgramChange(
      this.deps,
      { ...input, actor, eventType: "MACHINE_PROGRAM_CREATED", entityId: id, payload: { code: formatMachineProgramCode(programNumber), machineName: machine.name, contractorName: contractor.partyName, packingContractorName: packer.partyName, programDate: input.programDate, shift } },
      tx
    );
    return { id, status: MACHINE_PROGRAM_STATUS.PROGRAMMED, shiftStartMinute: shift.startMinute, shiftEndMinute: shift.endMinute };
  }

  private async addLine(input: SaveMachineProgramLineInput, run: MachineProgramRunForWrite, actor: string, tx: TransactionContext): Promise<string> {
    const stock = await this.checkUpper(input.itemId, run, null, tx);
    const duplicate = await this.deps.repo.findMachineProgramLineForItem(run.id, stock.itemId, tx);
    if (duplicate) {
      throw new MachineProgramRejectedError("ALREADY_ON_PROGRAM", "This upper is already on this sole. Change its quantity instead.", { lineId: duplicate });
    }
    refuseQuantity(input.quantity, stock.itemAvailable, 0, stock.unitCode);
    if (!stock.unitId) throw new MachineProgramRejectedError("MATERIAL_NOT_FOUND", `${stock.displayName} has no unit set in the Raw Material Master.`);

    const id = this.deps.idGenerator.nextId();
    await this.deps.repo.insertMachineProgramLine(
      {
        id, runId: run.id, lineNo: await this.deps.repo.nextMachineProgramLineNo(run.id, tx), itemId: stock.itemId,
        quantity: roundQuantity(input.quantity), unitId: stock.unitId, availableAtSave: stock.itemAvailable, createdBy: actor, createdAt: tx.nowIso,
      },
      tx
    );
    await auditProgramChange(this.deps, { ...input, actor, eventType: "MACHINE_PROGRAM_LINE_ADDED", entityId: run.programId, payload: { runId: run.id, lineId: id, itemId: stock.itemId, item: stock.displayName, quantity: input.quantity, unit: stock.unitCode, availableAtSave: stock.itemAvailable } }, tx);
    return id;
  }

  private async changeLine(input: SaveMachineProgramLineInput, run: MachineProgramRunForWrite, actor: string, tx: TransactionContext): Promise<string> {
    const line = await this.deps.repo.getMachineProgramLineForWrite(String(input.lineId).trim(), tx);
    if (!line || line.runId !== run.id) {
      throw new MachineProgramRejectedError("LINE_NOT_FOUND", "This upper is no longer on the program. Go back and open it again.");
    }
    const stock = await this.checkUpper(line.itemId, run, line.id, tx);
    const available = stock.itemAvailable;
    refuseQuantity(input.quantity, available, line.consumed, stock.unitCode);

    await this.deps.repo.updateMachineProgramLine({ id: line.id, quantity: roundQuantity(input.quantity), availableAtSave: available, updatedAt: tx.nowIso }, tx);
    await auditProgramChange(this.deps, { ...input, actor, eventType: "MACHINE_PROGRAM_LINE_CHANGED", entityId: run.programId, payload: { runId: run.id, lineId: line.id, item: stock.displayName, from: line.quantity, to: input.quantity, consumed: line.consumed, availableAtSave: available } }, tx);
    return line.id;
  }

  /** The upper must exist, be an UPPER for exactly this article + size, and reach this machine. */
  private async checkUpper(itemId: string, run: MachineProgramRunForWrite, excludeLineId: string | null, tx: TransactionContext) {
    const stock = await this.deps.repo.getMachineProgramUpperAvailability(
      { itemId: String(itemId ?? "").trim(), machineSectionId: run.machineSectionId, excludeLineId },
      tx
    );
    if (!stock) throw new MachineProgramRejectedError("MATERIAL_NOT_FOUND", "This upper is no longer in the Raw Material Master. Refresh and choose again.");
    if (attributeKey(stock.kind) !== RAW_MATERIAL_KIND.UPPER) {
      throw new MachineProgramRejectedError("NOT_AN_UPPER", `${stock.displayName} is not an upper.`);
    }
    if (!sameAttributeValue(stock.article, run.article) || !sameAttributeValue(stock.size, run.size)) {
      throw new MachineProgramRejectedError("WRONG_ARTICLE", `${stock.displayName} is not for ${run.article} ${run.size}.`);
    }
    if (!stock.allocatable) {
      throw new MachineProgramRejectedError("MATERIAL_NOT_ALLOCATABLE", stock.notAllocatableReason ?? `${stock.displayName} cannot be put on this machine.`);
    }
    return stock;
  }
}

/** Turns a quantity the rules refuse into the sentence the operator reads. */
const refuseQuantity = (quantity: number, available: number, consumed: number, unitCode: string | null): void => {
  const problem = checkProgramQuantity(quantity, { available, consumed });
  const unit = unitCode ?? "";
  if (problem === "INVALID_QUANTITY") {
    throw new MachineProgramRejectedError("INVALID_QUANTITY", "Type how many — a number above 0, with at most two decimals.");
  }
  if (problem === "BELOW_CONSUMED") {
    throw new MachineProgramRejectedError(
      "BELOW_CONSUMED",
      `${roundQuantity(consumed)} ${unit} of this upper have already been scanned out. It cannot go below that.`.replace(/\s+/g, " ")
    );
  }
  if (problem === "NOT_ENOUGH_STOCK") {
    const most = roundQuantity(consumed + available);
    throw new MachineProgramRejectedError(
      "NOT_ENOUGH_STOCK",
      available <= 0 && consumed <= 0
        ? "None of this upper is free any more. Another program has taken it."
        : `Only ${most} ${unit} can be put on this program. The rest is already promised.`.replace(/\s+/g, " "),
      { available: most, unitCode }
    );
  }
};
