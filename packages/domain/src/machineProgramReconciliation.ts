import { cartonsToPairs } from "./units.js";

// RECONCILIATION — closing a machine program against the cartons that came back.
//
//   4 DOZEN of uppers issued  →  8 cartons due back  (1 DOZEN = 2 cartons)
//   8 back                    →  the program closes, complete
//   7 back                    →  1 carton short = 6 uppers to account for, and every one of them
//                                is either:
//
//     CUT SIZE   it came back to the store (e.g. 4 of the 6)
//     WASTAGE    it was damaged          → claim to the upper's SUPPLIER
//     LOST       it was lost on the floor → claim to the MACHINE or the PACKING contractor
//
// Counted in UPPERS (pairs), never in dozens: 4 uppers is a third of a dozen, which a two-decimal
// dozen cannot hold exactly, and a reconciliation that does not add up to the last upper is not
// one. Every claim carries the reason it was made (owner, 2026-10-11).

/** Who a LOST upper is claimed against. */
export const RECONCILIATION_LOSS_PARTY = {
  /** Lost in production — the machine contractor. */
  MACHINE: "MACHINE",
  /** Lost in packing — the packing contractor. */
  PACKING: "PACKING",
} as const;
export type ReconciliationLossParty = (typeof RECONCILIATION_LOSS_PARTY)[keyof typeof RECONCILIATION_LOSS_PARTY];

/** How a program was closed. */
export const MACHINE_PROGRAM_CLOSE_OUTCOME = {
  /** Every carton due came back. */
  COMPLETE: "COMPLETE",
  /** Cartons were short, and the uppers they stand for were accounted for. (EVR FIX never closes short.) */
  RECONCILED: "RECONCILED",
} as const;
export type MachineProgramCloseOutcome = (typeof MACHINE_PROGRAM_CLOSE_OUTCOME)[keyof typeof MACHINE_PROGRAM_CLOSE_OUTCOME];

/** The uppers one upper line has to account for: its missing cartons, as uppers. */
export const shortfallUppers = (cartonsDue: number, cartonsBack: number): number =>
  cartonsToPairs(Math.max(0, cartonsDue - cartonsBack));

/** What the store says became of one upper line's missing uppers. */
export interface ReconciliationEntry {
  cutSize: number;
  wastage: number;
  /** The upper's supplier the wastage is claimed against. Required when there is wastage. */
  wastagePartyId: string | null;
  wastageReason: string;
  lost: number;
  /** Which contractor the loss is claimed against. Required when there is a loss. */
  lostParty: ReconciliationLossParty | null;
  lostReason: string;
}

const isUpperCount = (value: number): boolean => Number.isInteger(value) && value >= 0;

/**
 * Why one line's reconciliation cannot be saved, or null when it accounts for every missing upper.
 *
 * The three ways must add up to the shortfall EXACTLY — fewer leaves uppers nobody answered for,
 * more claims uppers that were never missing. A claim needs its party and its reason.
 */
export const reconciliationEntryProblem = (shortfall: number, entry: ReconciliationEntry): string | null => {
  if (![entry.cutSize, entry.wastage, entry.lost].every(isUpperCount)) {
    return "Count uppers in whole numbers, 0 or more.";
  }
  const accounted = entry.cutSize + entry.wastage + entry.lost;
  if (accounted !== shortfall) {
    return accounted < shortfall
      ? `${shortfall - accounted} of the ${shortfall} missing uppers are not accounted for yet.`
      : `That accounts for ${accounted} uppers, but only ${shortfall} are missing.`;
  }
  if (entry.wastage > 0 && !entry.wastagePartyId) return "Choose the supplier the wastage is claimed against.";
  if (entry.wastage > 0 && !entry.wastageReason.trim()) return "Say why the uppers were wasted — the claim needs a reason.";
  if (entry.lost > 0 && !entry.lostParty) return "Choose who lost the uppers: the machine or the packing contractor.";
  if (entry.lost > 0 && !entry.lostReason.trim()) return "Say how the uppers were lost — the claim needs a reason.";
  return null;
};

// ─── B cartons (EVR FIX) ──────────────────────────────────────────────────────
//
//   20 labels printed, 10 back  →  "10 B cartons"  →  10 labels voided, 10 new MIX labels, grade B
//
// A carton that came off the machine in mixed colours is a B carton: its colour label no longer
// tells the truth, so it is labelled again as MIX with a B on it, and THAT label comes back.

/** The grade a carton QR run can carry. Only B exists; an ordinary run has none. */
export const CARTON_GRADE = { B: "B" } as const;
export type CartonGrade = (typeof CARTON_GRADE)[keyof typeof CARTON_GRADE];

/** What a B carton's label says for its colour: B cartons are mixed colours. */
export const B_CARTON_COLOUR = "MIX";

/**
 * Why `count` labels cannot be turned into B cartons, or null. Only a label that was printed and
 * has not come back can be converted — `convertible` of them — and a carton is a whole carton.
 */
export const bConversionProblem = (count: number, convertible: number): string | null => {
  if (!Number.isInteger(count) || count < 1) return "Type how many B cartons — a whole number, at least 1.";
  if (count > convertible) {
    return convertible === 0
      ? "Every label of this article is back or already converted, so there is nothing to make B."
      : `Only ${convertible} label${convertible === 1 ? " is" : "s are"} not back, so at most ${convertible} can be B cartons.`;
  }
  return null;
};
