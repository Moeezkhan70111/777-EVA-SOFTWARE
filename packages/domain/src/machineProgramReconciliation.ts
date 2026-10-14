import { cartonsToPairs } from "./units.js";

// RECONCILIATION — closing a machine program against the cartons that came back.
//
//   6 DOZEN of uppers issued   →  12 cartons due back  (1 DOZEN = 2 cartons, 6 pairs a carton)
//   6 cartons back             →  6 cartons = 36 pairs still to account for. Each is one of:
//
//     RETURN UPPER     a sealed packet scanned back into the store          (before closing)
//     B CARTON         came off the machine in mixed colours: MIX labels    (before closing)
//     CUT SIZE UPPER   loose uppers from an opened packet, back in the store (on closing)
//     CUT SIZE PAIRS   slippers made but never packed in a carton           (on closing)
//     CLAIM            damaged or lost — claimed, at an amount, to the upper's SUPPLIER or the
//                      MACHINE or PACKING contractor, and deducted on their ledger (on closing)
//
// A returned packet and a B carton change the cartons themselves (fewer due, more back), so they
// are done first and the shortfall shrinks; what is left is accounted for when the program closes,
// and the ways must add up to it EXACTLY. Counted in PAIRS, never in dozens: 5 pairs is not a
// two-decimal dozen, and a reconciliation that does not add up to the last pair is not one.

/** Who a LOST upper was claimed against, on programs closed before priced claims (legacy rows). */
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

/** Who a claim for damaged or lost uppers is made against. */
export const CLAIM_PARTY_ROLE = {
  /** The supplier of the upper — it was damaged as it came. */
  SUPPLIER: "SUPPLIER",
  /** The machine contractor — damaged or lost in production. */
  MACHINE: "MACHINE",
  /** The packing contractor — damaged or lost in packing. */
  PACKING: "PACKING",
} as const;
export type ClaimPartyRole = (typeof CLAIM_PARTY_ROLE)[keyof typeof CLAIM_PARTY_ROLE];

/** A posted claim stands on the party's ledger; a reversed one no longer does. */
export const PARTY_CLAIM_STATUS = { POSTED: "POSTED", REVERSED: "REVERSED" } as const;
export type PartyClaimStatus = (typeof PARTY_CLAIM_STATUS)[keyof typeof PARTY_CLAIM_STATUS];

/** One claim for damaged or lost pairs: who, how many, at what amount a pair, and why. */
export interface UpperClaim {
  role: ClaimPartyRole;
  /** The supplier claimed against. Contractors are the program's own, so they are not chosen here. */
  supplierPartyId: string | null;
  pairs: number;
  /** The amount claimed for ONE pair, in integer paisa. */
  ratePaisa: number;
  reason: string;
}

/** What the store says became of one upper line's remaining pairs when the program closes. */
export interface UpperReconciliation {
  /** Loose uppers from an opened packet, back in the store. */
  cutSizeUppers: number;
  /** Slippers made but never packed in a carton, back in the store. */
  cutSizePairs: number;
  claims: UpperClaim[];
}

/** What one claim deducts from the party: pairs × the amount a pair — exact, in paisa. */
export const claimAmountPaisa = (claim: Pick<UpperClaim, "pairs" | "ratePaisa">): number => claim.pairs * claim.ratePaisa;

/** How many of the remaining pairs a reconciliation accounts for. */
export const accountedPairs = (entry: UpperReconciliation): number =>
  entry.cutSizeUppers + entry.cutSizePairs + entry.claims.reduce((total, claim) => total + claim.pairs, 0);

const isPairCount = (value: number): boolean => Number.isInteger(value) && value >= 0;

/** Why one claim cannot be made, or null. */
const claimProblem = (claim: UpperClaim): string | null => {
  if (!Number.isInteger(claim.pairs) || claim.pairs < 1) return "A claim is for whole pairs, at least 1.";
  if (!Object.values(CLAIM_PARTY_ROLE).includes(claim.role)) return "Choose who the claim is against.";
  if (claim.role === CLAIM_PARTY_ROLE.SUPPLIER && !claim.supplierPartyId) return "Choose the supplier the claim is against.";
  if (!Number.isInteger(claim.ratePaisa) || claim.ratePaisa < 1) return "Type the amount claimed for one pair — more than 0.";
  if (!claim.reason.trim()) return "Say why the pairs are claimed — the claim needs a reason.";
  return null;
};

/**
 * Why one line's reconciliation cannot be saved, or null when it accounts for every remaining pair.
 *
 * The ways must add up to the remaining pairs EXACTLY — fewer leaves pairs nobody answered for,
 * more would claim or return pairs that were never missing. Every claim needs its party, its
 * amount and its reason.
 */
export const upperReconciliationProblem = (remainingPairs: number, entry: UpperReconciliation): string | null => {
  if (![entry.cutSizeUppers, entry.cutSizePairs].every(isPairCount)) return "Count pairs in whole numbers, 0 or more.";
  for (const claim of entry.claims) {
    const problem = claimProblem(claim);
    if (problem) return problem;
  }
  const accounted = accountedPairs(entry);
  if (accounted === remainingPairs) return null;
  return accounted < remainingPairs
    ? `${remainingPairs - accounted} of the ${remainingPairs} remaining pairs are not accounted for yet.`
    : `That accounts for ${accounted} pairs, but only ${remainingPairs} remain.`;
};

/**
 * Why `count` of an upper line's missing cartons cannot become B cartons, or null. A B carton is
 * a whole carton that physically came back, so it can stand for at most the cartons still missing.
 */
export const upperBConversionProblem = (count: number, missingCartons: number): string | null => {
  if (!Number.isInteger(count) || count < 1) return "Type how many B cartons — a whole number, at least 1.";
  if (count > missingCartons) {
    return missingCartons === 0
      ? "No carton of this upper is missing, so there is nothing to make B."
      : `Only ${missingCartons} carton${missingCartons === 1 ? " is" : "s are"} missing, so at most ${missingCartons} can be B cartons.`;
  }
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
