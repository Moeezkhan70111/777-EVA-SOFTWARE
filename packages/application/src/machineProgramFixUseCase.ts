import { attributeKey, checkFixQuantity, roundQuantity, sameAttributeValue } from "@erp/domain";
import {
  MachineProgramRejectedError,
  checkRunHeader,
  requireOpenProgram,
  resolveProgramForDate,
  runProgramWrite,
  type MachineProgramActor,
  type MachineProgramDeps,
  type MachineProgramWriteResult,
} from "./machineProgramUseCases.js";
import type { TransactionContext } from "./ports.js";

// FIX articles on a machine program: no upper, two soles.
//
//   a normal article   BLACK sole  +  an UPPER going on it     quantity lives on the upper line
//   a FIX article      OUTER sole  +  INNER sole, no upper     quantity lives on the run
//
// Which articles these are is a fact about the PRODUCT SUB GROUP (has_no_upper, migration 067),
// read here inside the write lock rather than trusted from the screen — the dialog decides which
// questions to ask, this decides what may be saved.
//
// A fix run RESERVES NOTHING. There is no upper to promise and Dana has never been reserved by a
// program, so nothing here touches a balance, a stock event or the Reserved arithmetic. The
// quantity is the plan for the machine, and Store Out has nothing to issue against it.
//
// The two kinds can never be mixed on one article:
//
//   * saving a fix run for an article that HAS uppers is refused here
//   * saving an upper line for a FIX article is refused in SaveMachineProgramLineUseCase
//
// so an article's sub group being reclassified later cannot leave a run that is half of each.

export interface SaveMachineProgramFixRunInput extends MachineProgramActor {
  machineId: string;
  /** The program's calendar day, YYYY-MM-DD. */
  programDate: string;
  shift?: { startMinute: number; endMinute: number } | null;
  /** The run being changed, or null to add one. */
  runId?: string | null;
  /** The sole the article is moulded in. */
  soleColour: string;
  /** The second sole. What makes this a fix run at all. */
  innerSoleColour: string;
  articleSizeId: string;
  quantity: number;
}

/**
 * Saves one FIX run: two soles, an article + size, and how many are to be made.
 *
 * A fix run belongs to the PROGRAM, not to an injector — EVR FIX is not moulded on the injectors
 * (owner, 2026-10-12; migration 073). It is saved with no injector, and adding the same article +
 * size again CHANGES the program's run for it rather than making a rival one.
 */
export class SaveMachineProgramFixRunUseCase {
  constructor(private readonly deps: MachineProgramDeps) {}

  async execute(input: SaveMachineProgramFixRunInput): Promise<MachineProgramWriteResult> {
    const actor = String(input.actor ?? "").trim();
    if (!actor) throw new Error("Saving a machine program requires the acting user.");
    if (!checkFixQuantity(input.quantity)) {
      return { accepted: false, outcome: "INVALID_QUANTITY", reason: "Type how many — a number above 0, with at most two decimals." };
    }
    const innerSoleColour = attributeKey(input.innerSoleColour);
    if (!innerSoleColour) {
      return { accepted: false, outcome: "UNKNOWN_COLOUR", reason: "Choose the inner sole colour." };
    }
    if (!this.deps.repo.isKnownSoleColour(innerSoleColour)) {
      return { accepted: false, outcome: "UNKNOWN_COLOUR", reason: "Choose the inner sole colour from the colours shown." };
    }

    return runProgramWrite(this.deps, async (tx) => {
      // The outer sole and the article + size go through the same check a normal run does, so a
      // fix run can never name a colour or a product the masters do not have.
      const header = await checkRunHeader(this.deps.repo, { soleColour: input.soleColour, articleSizeId: input.articleSizeId }, tx);

      if (!(await this.deps.repo.articleHasNoUpperForWrite(header.articleSizeId, tx))) {
        throw new MachineProgramRejectedError(
          "WRONG_ARTICLE",
          `${header.article} ${header.size} is made with an upper. Add its uppers instead of a second sole.`
        );
      }

      const program = await resolveProgramForDate(
        this.deps,
        { machineId: input.machineId, programDate: input.programDate, shift: input.shift ?? null, actor, actorUserId: input.actorUserId ?? null, deviceId: input.deviceId ?? null },
        tx
      );
      requireOpenProgram(program.status);

      const quantity = roundQuantity(input.quantity);
      const unitId = await this.deps.repo.defaultProgramUnitId(tx);

      // One fix run per article + size on the program: a second save of the same one changes it.
      const existingId =
        (input.runId ? String(input.runId).trim() : "") ||
        (await this.deps.repo.findMachineProgramFixRun(
          { programId: program.id, articleSizeId: header.articleSizeId },
          tx
        )) ||
        "";

      if (existingId) {
        // A carton QR carries the OUTER sole, and a printed identity is permanent. So once this
        // run's cartons are labelled, its soles are what those labels say — changing them here
        // would leave the printed cartons naming a colour the run no longer makes. (This is how
        // program 2's DC3 cartons came to say BLACK on a COMMANDO run, 2026-10-12.) The quantity
        // stays editable: raising it simply owes the difference.
        const current = await this.deps.repo.getMachineProgramFixRunForWrite(existingId, tx);
        if (current && current.labelledCartons > 0) {
          const solesChanged =
            !sameAttributeValue(current.soleColour, header.soleColour) ||
            !sameAttributeValue(current.innerSoleColour, innerSoleColour);
          if (solesChanged) {
            throw new MachineProgramRejectedError(
              "CARTONS_LABELLED",
              `${current.labelledCartons} carton labels are already printed for ${header.article} ${header.size} in ${current.soleColour}, so its soles cannot change — those labels name that colour. Void them in QR Management first, or make this colour on its own run.`
            );
          }
        }
        await this.deps.repo.updateMachineProgramFixRun(
          { id: existingId, soleColour: header.soleColour, innerSoleColour, quantity, updatedAt: tx.nowIso },
          tx
        );
        await this.audit(input, actor, "MACHINE_PROGRAM_FIX_RUN_CHANGED", program.id, {
          runId: existingId, ...header, innerSoleColour, quantity,
        }, tx);
        return { accepted: true, outcome: "SAVED", programId: program.id, runId: existingId };
      }

      const id = this.deps.idGenerator.nextId();
      await this.deps.repo.insertMachineProgramFixRun(
        {
          id,
          programId: program.id,
          // No injector: the fix runs are numbered among themselves.
          runNo: await this.deps.repo.nextMachineProgramRunNo(program.id, null, tx),
          soleColour: header.soleColour,
          innerSoleColour,
          articleSizeId: header.articleSizeId,
          quantity,
          unitId,
          createdBy: actor,
          createdAt: tx.nowIso,
        },
        tx
      );
      await this.audit(input, actor, "MACHINE_PROGRAM_FIX_RUN_ADDED", program.id, {
        runId: id, ...header, innerSoleColour, quantity,
      }, tx);
      return { accepted: true, outcome: "SAVED", programId: program.id, runId: id };
    });
  }

  private audit(
    input: SaveMachineProgramFixRunInput,
    actor: string,
    eventType: string,
    programId: string,
    payload: Record<string, unknown>,
    tx: TransactionContext
  ): Promise<void> {
    return this.deps.repo.appendAuditLog(
      {
        id: this.deps.idGenerator.nextId(),
        eventType,
        entityType: "MACHINE_PROGRAM",
        entityId: programId,
        actorUserId: input.actorUserId ?? null,
        actorDeviceId: input.deviceId ?? null,
        occurredAt: tx.nowIso,
        payload: { ...payload, actor },
      },
      tx
    );
  }
}
