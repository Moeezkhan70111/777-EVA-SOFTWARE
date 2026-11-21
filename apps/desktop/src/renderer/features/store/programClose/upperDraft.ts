import { CLAIM_PARTY_ROLE, accountedPairs, upperReconciliationProblem, type ClaimPartyRole, type UpperClaim, type UpperReconciliation } from "@erp/domain";
import type { ReconciliationEntryInput, ReconciliationLine } from "../../../types/desktopApi";

// What the store types for one short upper on the reconciliation, and how it becomes what is sent.
//
// The rule it must meet — every remaining pair given exactly one fate, every claim with its party and reason — is the
// domain's (upperReconciliationProblem), the same one the close applies inside the write lock. The screen uses it only
// to show the balance and say what is still missing.
//
// A claim here is a REQUEST: who, how many pairs, and why. The store never types an amount. Accounts prices and posts
// it on the accounts computer (Claims screen, docs/55).

/** One claim request's boxes, as typed. */
export interface ClaimDraft {
  key: string;
  role: ClaimPartyRole;
  supplierPartyId: string | null;
  pairs: string;
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

/** A new claim request. With one supplier behind the upper, it already names them. */
export const newClaim = (line: ReconciliationLine): ClaimDraft => ({
  key: `claim-${(nextKey += 1)}`,
  role: CLAIM_PARTY_ROLE.SUPPLIER,
  supplierPartyId: line.suppliers.length === 1 ? line.suppliers[0].partyId : null,
  pairs: "",
  reason: "",
});

/** Digits only: pairs are counted whole. */
export const cleanCount = (typed: string): string => typed.replace(/[^0-9]/g, "");

const count = (typed: string): number => (typed.trim() === "" ? 0 : Number(typed));

const claimOf = (draft: ClaimDraft): UpperClaim => ({
  role: draft.role,
  supplierPartyId: draft.role === CLAIM_PARTY_ROLE.SUPPLIER ? draft.supplierPartyId : null,
  pairs: count(draft.pairs),
  reason: draft.reason,
});

export const toReconciliation = (draft: UpperDraft): UpperReconciliation => ({
  cutSizeUppers: count(draft.cutSizeUppers),
  cutSizePairs: count(draft.cutSizePairs),
  claims: draft.claims.map(claimOf),
});

export const toEntry = (lineId: string, draft: UpperDraft): ReconciliationEntryInput => ({ lineId, ...toReconciliation(draft) });

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
