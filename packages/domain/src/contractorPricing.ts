import { QUANTITY_EPSILON } from "./machineProgram.js";

// Contractor pricing — what a machine program's work is paid at, and what that comes to.
//
//   MP-000011  MACHINE 1  10 Oct          machine ALAMGIR · packing DANIYAL
//     SK6  7/10   100 DOZEN   machine 45.00   packing 18.00   printing 12.00
//     SK12 1/6     50 DOZEN   machine 52.00   packing 20.00   printing  0.00
//
// Three jobs are paid for a dozen of slippers: running the machine, packing what it makes, and
// printing. Each has its own rate, each rate is PER DOZEN, and the rates belong to the ARTICLE —
// a bigger slipper is more work, and the same contractor is paid differently for each one.
//
// Machine work is the machine contractor's and packing work is the packing contractor's
// (migration 059, both snapshotted onto the program). PRINTING has no contractor of its own yet:
// it is a recorded cost, and a party can be attached later without changing this arithmetic.
//
// WHAT IS OWED IS NOT WHAT IS PROGRAMMED. A contractor earns on what is produced, and this ERP
// does not yet record production against a program (owner's decision, 2026-10-10: "it will be
// done when production comes"). So nothing here posts to a ledger and nothing is stored as an
// amount. `contractorChargeFor` takes whatever quantity it is given, and today the screens give
// it the PROGRAMMED quantity and call the answer what the day is COMMITTED to. When production
// arrives it is the same function, given the produced quantity.
//
// Money is integer paisa throughout (R15). A rate of 45.00 per dozen is 4500, and a charge is
// rounded to the paisa once, at the multiplication — never accumulated in rupees.

/** The three jobs a dozen is paid for. */
export const CONTRACTOR_WORK = {
  MACHINE: "MACHINE",
  PACKING: "PACKING",
  PRINTING: "PRINTING",
} as const;
export type ContractorWork = (typeof CONTRACTOR_WORK)[keyof typeof CONTRACTOR_WORK];

export const CONTRACTOR_WORK_KINDS: readonly ContractorWork[] = [
  CONTRACTOR_WORK.MACHINE,
  CONTRACTOR_WORK.PACKING,
  CONTRACTOR_WORK.PRINTING,
];

/** One article's three rates, per DOZEN, in integer paisa. */
export interface ContractorRates {
  machineRatePaisa: number;
  packingRatePaisa: number;
  printingRatePaisa: number;
}

/** What a quantity comes to at those rates, in integer paisa. */
export interface ContractorCharge {
  machinePaisa: number;
  packingPaisa: number;
  printingPaisa: number;
  totalPaisa: number;
}

export const ZERO_CHARGE: ContractorCharge = { machinePaisa: 0, packingPaisa: 0, printingPaisa: 0, totalPaisa: 0 };

/** Every rate zero — an article priced at nothing, which is not the same as an article unpriced. */
export const ZERO_RATES: ContractorRates = { machineRatePaisa: 0, packingRatePaisa: 0, printingRatePaisa: 0 };

/** True when at least one of the three rates has been set to something. */
export const hasAnyRate = (rates: ContractorRates | null | undefined): boolean =>
  rates != null && (rates.machineRatePaisa > 0 || rates.packingRatePaisa > 0 || rates.printingRatePaisa > 0);

/** The largest rate the books will take: Rs 100,000 per dozen, which no piece rate approaches. */
export const MAX_CONTRACTOR_RATE_PAISA = 100_000 * 100;

/**
 * Whether a rate may be saved: a whole number of paisa, not negative, not absurd.
 *
 * Zero is allowed and means "this job is not paid for this article" — printing on a plain
 * slipper, for instance. It is the application's boundary check, mirrored by the table's own
 * CHECK constraints.
 */
export const isValidContractorRatePaisa = (paisa: number): boolean =>
  Number.isSafeInteger(paisa) && paisa >= 0 && paisa <= MAX_CONTRACTOR_RATE_PAISA;

export const areValidContractorRates = (rates: ContractorRates): boolean =>
  CONTRACTOR_WORK_KINDS.every((kind) => isValidContractorRatePaisa(rateOf(rates, kind)));

/** One of the three rates, by job. */
export const rateOf = (rates: ContractorRates, work: ContractorWork): number =>
  work === CONTRACTOR_WORK.MACHINE
    ? rates.machineRatePaisa
    : work === CONTRACTOR_WORK.PACKING
      ? rates.packingRatePaisa
      : rates.printingRatePaisa;

/**
 * What `dozens` of an article comes to at its rates.
 *
 * The quantity may be fractional (half a dozen is a real line), so each job is rounded to the
 * paisa on its own multiplication and the total is the sum of those three — the figures shown
 * beside each other therefore always add up to the total shown under them.
 */
export const contractorChargeFor = (rates: ContractorRates | null | undefined, dozens: number): ContractorCharge => {
  if (!rates || !Number.isFinite(dozens) || dozens <= 0) return ZERO_CHARGE;
  const machinePaisa = Math.round(rates.machineRatePaisa * dozens);
  const packingPaisa = Math.round(rates.packingRatePaisa * dozens);
  const printingPaisa = Math.round(rates.printingRatePaisa * dozens);
  return { machinePaisa, packingPaisa, printingPaisa, totalPaisa: machinePaisa + packingPaisa + printingPaisa };
};

export const addCharges = (...charges: ContractorCharge[]): ContractorCharge =>
  charges.reduce(
    (sum, charge) => ({
      machinePaisa: sum.machinePaisa + charge.machinePaisa,
      packingPaisa: sum.packingPaisa + charge.packingPaisa,
      printingPaisa: sum.printingPaisa + charge.printingPaisa,
      totalPaisa: sum.totalPaisa + charge.totalPaisa,
    }),
    ZERO_CHARGE
  );

// ─── One program's pricing ────────────────────────────────────────────────────

/** An article's rates as they are stored against a program. */
export interface ArticleRatesRecord extends ContractorRates {
  articleSizeId: string;
}

/** The part of a run this arithmetic needs: which article, and how much of it. */
export interface PricedRunInput {
  articleSizeId: string;
  article: string;
  size: string;
  /** The run's programmed quantity, in the unit its upper lines are counted in (DOZEN). */
  totalQuantity: number;
  unitCode: string | null;
}

/** One article on the program, with what it is priced at and what that commits the day to. */
export interface PricedArticle {
  articleSizeId: string;
  article: string;
  size: string;
  /** Programmed quantity, summed over every run of this article on the program. */
  quantity: number;
  unitCode: string | null;
  /** Null when nobody has priced this article yet — never read as zero. */
  rates: ContractorRates | null;
  /** What the programmed quantity comes to. Null exactly when `rates` is. */
  committed: ContractorCharge | null;
}

export interface ProgramContractorPricing {
  /** One row per article on the program, in the order its runs appear. */
  articles: PricedArticle[];
  /** Σ over the priced articles. Articles with no rates add nothing — they are counted instead. */
  committed: ContractorCharge;
  /** How many articles on the program still have no rates. */
  unpricedArticles: number;
  /** True when every article on the program is priced. */
  fullyPriced: boolean;
}

/**
 * The program's pricing table: one row per ARTICLE, whatever it is spread across.
 *
 * The same article can be moulded on two sole colours or on both injectors; to the person paying
 * it is one article at one rate, so its runs are summed into one row. An article nobody has
 * priced yet is listed with no rates and adds nothing to the total — it is reported as unpriced
 * instead, because a missing rate is not a rate of zero.
 */
export const programContractorPricing = (input: {
  runs: readonly PricedRunInput[];
  rates: readonly ArticleRatesRecord[];
}): ProgramContractorPricing => {
  const byArticle = new Map<string, PricedArticle>();
  const rateFor = new Map(input.rates.map((row) => [row.articleSizeId, row]));

  for (const run of input.runs) {
    const existing = byArticle.get(run.articleSizeId);
    if (existing) {
      existing.quantity += run.totalQuantity;
      continue;
    }
    const stored = rateFor.get(run.articleSizeId);
    byArticle.set(run.articleSizeId, {
      articleSizeId: run.articleSizeId,
      article: run.article,
      size: run.size,
      quantity: run.totalQuantity,
      unitCode: run.unitCode,
      rates: stored
        ? {
            machineRatePaisa: stored.machineRatePaisa,
            packingRatePaisa: stored.packingRatePaisa,
            printingRatePaisa: stored.printingRatePaisa,
          }
        : null,
      committed: null,
    });
  }

  const articles = [...byArticle.values()];
  for (const article of articles) {
    article.committed = article.rates ? contractorChargeFor(article.rates, article.quantity) : null;
  }

  const priced = articles.filter((article) => article.committed !== null);
  const unpricedArticles = articles.length - priced.length;
  return {
    articles,
    committed: addCharges(...priced.map((article) => article.committed as ContractorCharge)),
    unpricedArticles,
    fullyPriced: articles.length > 0 && unpricedArticles === 0,
  };
};

/**
 * Whether a quantity is worth pricing at all — the one place the epsilon is applied, so an
 * article left on the program with a rounding crumb of quantity is not called unpriced work.
 */
export const isPriceableQuantity = (quantity: number): boolean =>
  Number.isFinite(quantity) && quantity > QUANTITY_EPSILON;
