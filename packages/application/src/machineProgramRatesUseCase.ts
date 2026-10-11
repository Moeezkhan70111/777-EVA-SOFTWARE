import {
  areValidContractorRates,
  toPaisa,
  type ContractorRates,
} from "@erp/domain";
import {
  MachineProgramRejectedError,
  auditProgramChange,
  requireOpenProgram,
  runProgramWrite,
  type MachineProgramDeps,
  type MachineProgramRepository,
  type MachineProgramWriteResult,
  type MachineProgramActor,
} from "./machineProgramUseCases.js";
import type { TransactionContext } from "./ports.js";

// Contractor pricing on a machine program: saving what an ARTICLE's work is paid at.
//
//   MP-000011 · SK6 7/10    machine 45.00    packing 18.00    printing 12.00   per DOZEN
//
// One row per article on the program (migration 063), so the same article moulded on two sole
// colours or on both injectors can never drift to two different machine rates. Saving the same
// article again is a CHANGE to its rates, not a second price.
//
// Two rules, both enforced here rather than on the screen:
//
//   * the program must still be open — a deleted program is read, never written (every other
//     program write says the same thing, through requireOpenProgram)
//   * the article must actually be ON the program. Pricing work the machine is not making would
//     leave a figure nobody can explain, so it is refused rather than stored.
//
// The rates arrive as the operator typed them, in rupees, and are converted to integer paisa
// here — the one place it happens for this feature (R15). Nothing is posted anywhere: what a
// contractor has EARNED depends on production, which this ERP does not yet record against a
// program, so this use case stores a rate and never an amount.

export interface SaveMachineProgramArticleRatesInput extends MachineProgramActor {
  programId: string;
  articleSizeId: string;
  /** Per DOZEN, in rupees as typed. Rounded to the paisa; a missing rate is zero, not unpriced. */
  machineRate: number;
  packingRate: number;
  printingRate: number;
}

/** What the database must answer and write for contractor pricing. */
export interface MachineProgramRatesRepository extends MachineProgramRepository {
  /** The program, as little of it as this write needs, read inside the lock. */
  getMachineProgramForRates(
    programId: string,
    tx: TransactionContext
  ): Promise<{ id: string; programNumber: number; status: string } | null>;
  /** Whether any run of the program is making this article. */
  machineProgramHasArticle(
    input: { programId: string; articleSizeId: string },
    tx: TransactionContext
  ): Promise<boolean>;
  /** Writes the article's three rates, replacing whatever it was priced at before. */
  upsertMachineProgramArticleRates(
    payload: {
      id: string; programId: string; articleSizeId: string;
      machineRatePaisa: number; packingRatePaisa: number; printingRatePaisa: number;
      actor: string; nowIso: string;
    },
    tx: TransactionContext
  ): Promise<void>;
  /** What the article is priced at now, for the audit record of what changed. */
  getMachineProgramArticleRates(
    input: { programId: string; articleSizeId: string },
    tx: TransactionContext
  ): Promise<ContractorRates | null>;
}

export interface MachineProgramRatesDeps extends MachineProgramDeps {
  repo: MachineProgramRatesRepository;
}

/** The three typed rupee rates as whole paisa. */
const ratesInPaisa = (input: SaveMachineProgramArticleRatesInput): ContractorRates => ({
  machineRatePaisa: toPaisa(Number(input.machineRate ?? 0)),
  packingRatePaisa: toPaisa(Number(input.packingRate ?? 0)),
  printingRatePaisa: toPaisa(Number(input.printingRate ?? 0)),
});

/**
 * Prices one article on one program — machine, packing and printing, per dozen.
 *
 * Saving it again replaces all three, so the screen never has to know whether the article has
 * been priced before. A rate of zero is a real answer ("printing is not paid for this article")
 * and is stored as zero; what is NOT the same is an article with no row at all, which every
 * reader treats as unpriced rather than as free.
 */
export class SaveMachineProgramArticleRatesUseCase {
  constructor(private readonly deps: MachineProgramRatesDeps) {}

  async execute(input: SaveMachineProgramArticleRatesInput): Promise<MachineProgramWriteResult> {
    if (!String(input.actor ?? "").trim()) throw new Error("Pricing a machine program requires the acting user.");

    const rates = ratesInPaisa(input);
    if (!areValidContractorRates(rates)) {
      return {
        accepted: false,
        outcome: "INVALID_RATE",
        reason: "A rate must be 0 or more, and no more than Rs 100,000 per dozen.",
      };
    }

    const programId = String(input.programId ?? "").trim();
    const articleSizeId = String(input.articleSizeId ?? "").trim();

    return runProgramWrite(this.deps, async (tx) => {
      const program = await this.deps.repo.getMachineProgramForRates(programId, tx);
      if (!program) {
        throw new MachineProgramRejectedError("PROGRAM_NOT_FOUND", "This program no longer exists. Open the machine again.");
      }
      requireOpenProgram(program.status);

      if (!(await this.deps.repo.machineProgramHasArticle({ programId, articleSizeId }, tx))) {
        throw new MachineProgramRejectedError(
          "ARTICLE_NOT_FOUND",
          "This article is not on the program, so its work cannot be priced. Add the article first."
        );
      }

      const before = await this.deps.repo.getMachineProgramArticleRates({ programId, articleSizeId }, tx);
      await this.deps.repo.upsertMachineProgramArticleRates(
        {
          id: this.deps.idGenerator.nextId(),
          programId,
          articleSizeId,
          ...rates,
          actor: input.actor,
          nowIso: tx.nowIso,
        },
        tx
      );

      // The rate a day's work was agreed at is worth being able to prove later, so both the old
      // and the new figures go on the record.
      await auditProgramChange(
        this.deps,
        {
          ...input,
          eventType: "MACHINE_PROGRAM_ARTICLE_PRICED",
          entityId: programId,
          payload: { articleSizeId, from: before, to: rates },
        },
        tx
      );

      return { accepted: true, outcome: "SAVED", programId };
    });
  }
}
