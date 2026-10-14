import { CLAIM_PARTY_ROLE, accountedPairs, claimAmountPaisa, toPaisa, upperReconciliationProblem, type ClaimPartyRole, type UpperClaim, type UpperReconciliation } from "@erp/domain";
import type { ReconciliationEntryInput, ReconciliationLine } from "../../../types/desktopApi";

// What the store types for one short upper on the reconciliation, and how it becomes what is sent.
//
// The rule it must meet — every remaining pair given exactly one fate, every claim with its party,
// amount and reason — is the domain's (upperReconciliationProblem), the same one the close applies
// inside the write lock. The screen uses it only to show the balance and say what is still missing.

/** One claim's boxes, as typed. The amount is rupees as typed; it is turned into paisa once, here. */
export interface ClaimDraft {
  key: string;
  role: ClaimPartyRole;
  supplierPartyId: string | null;
  pairs: string;
  rate: string;
  reason: string;
}

/** One short upper's boxes, as typed. An empty box is 0 pairs. */
export interface UpperDraft {
  cutSizeUppers: string;
  cutSizePairs: string;
  claims: ClaimDraft[];
}

export const emptyUpperDraft = (): UpperDraft => ({ cutSizeUppers: "", cutSizePairs: "", claims: [] });

let nextKey = 0;

/** A new claim. With one supplier behind the upper, it already names them. */
export const newClaim = (line: ReconciliationLine): ClaimDraft => ({
  key: `claim-${(nextKey += 1)}`,
  role: CLAIM_PARTY_ROLE.SUPPLIER,
  supplierPartyId: line.suppliers.length === 1 ? line.suppliers[0].partyId : null,
  pairs: "",
  rate: "",
  reason: "",
});

/** Digits only: pairs are counted whole. */
export const cleanCount = (typed: string): string => typed.replace(/[^0-9]/g, "");

/** Rupees with at most two decimals, as a person types them. */
export const cleanRupees = (typed: string): string => {
  const kept = typed.replace(/[^0-9.]/g, "");
  const [whole, ...rest] = kept.split(".");
  return rest.length === 0 ? whole : `${whole}.${rest.join("").slice(0, 2)}`;
};

const count = (typed: string): number => (typed.trim() === "" ? 0 : Number(typed));

/** The amount a pair in paisa, or NaN when the box is not a sum of money — which the rule refuses. */
export const ratePaisaOf = (typed: string): number => (/^\d+(\.\d{1,2})?$/.test(typed.trim()) ? toPaisa(Number(typed)) : Number.NaN);

const claimOf = (draft: ClaimDraft): UpperClaim => ({
  role: draft.role,
  supplierPartyId: draft.role === CLAIM_PARTY_ROLE.SUPPLIER ? draft.supplierPartyId : null,
  pairs: count(draft.pairs),
  ratePaisa: ratePaisaOf(draft.rate),
  reason: draft.reason,
});

export const toReconciliation = (draft: UpperDraft): UpperReconciliation => ({
  cutSizeUppers: count(draft.cutSizeUppers),
  cutSizePairs: count(draft.cutSizePairs),
  claims: draft.claims.map(claimOf),
});

export const toEntry = (lineId: string, draft: UpperDraft): ReconciliationEntryInput => ({ lineId, ...toReconciliation(draft) });

/** What one claim deducts, in paisa — 0 until both boxes are filled in. */
export const claimTotalPaisa = (draft: ClaimDraft): number => {
  const claim = claimOf(draft);
  return Number.isFinite(claim.ratePaisa) && Number.isInteger(claim.pairs) ? claimAmountPaisa(claim) : 0;
};

/** The line's balance, live: what each way accounts for and what is still unresolved. */
export const upperBalance = (line: ReconciliationLine, draft: UpperDraft) => {
  const entry = toReconciliation(draft);
  const claimed = entry.claims.reduce((total, claim) => total + (Number.isFinite(claim.pairs) ? claim.pairs : 0), 0);
  return {
    remaining: line.shortfallUppers,
    cutSizeUppers: entry.cutSizeUppers,
    cutSizePairs: entry.cutSizePairs,
    claimed,
    unresolved: line.shortfallUppers - accountedPairs({ ...entry, claims: [] }) - claimed,
  };
};

/** Why this line cannot be closed yet, or null when every remaining pair is accounted for. */
export const upperDraftProblem = (line: ReconciliationLine, draft: UpperDraft): string | null =>
  upperReconciliationProblem(line.shortfallUppers, toReconciliation(draft));
