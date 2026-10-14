// What the renderer sends to close a machine program, checked at the process boundary (R25).
//
// Only the SHAPE is checked here: every count arrives as a number or as NaN, every claim names a
// role this ERP knows. Whether the counts add up, and whether a claim's party may be claimed
// against, is the domain's rule and the data layer's check, applied inside the write lock.

import { CLAIM_PARTY_ROLE, asOptionalString, asString, isRecord, optionalOneOf, type ClaimPartyRole, type UpperClaim, type UpperReconciliation } from "@erp/domain";

export type ReconciliationEntryInput = UpperReconciliation & { lineId: string };

/** Deliberately NOT coerced: an empty box must reach the rule as something it refuses. */
const count = (value: unknown): number => (typeof value === "number" ? value : Number.NaN);

const claimOf = (value: Record<string, unknown>): UpperClaim | string => {
  const role: ClaimPartyRole | undefined = optionalOneOf(value.role, Object.values(CLAIM_PARTY_ROLE));
  if (!role) return "Choose who each claim is against: the supplier, the machine or the packing contractor.";
  return {
    role,
    supplierPartyId: role === CLAIM_PARTY_ROLE.SUPPLIER ? asOptionalString(value.supplierPartyId) ?? null : null,
    pairs: count(value.pairs),
    ratePaisa: count(value.ratePaisa),
    reason: asString(value.reason),
  };
};

/** The entries as the data layer takes them, or the sentence saying what was malformed. */
export const parseReconciliationEntries = (raw: unknown): ReconciliationEntryInput[] | string => {
  const entries: ReconciliationEntryInput[] = [];
  for (const entry of (Array.isArray(raw) ? raw : []).filter(isRecord)) {
    const claims: UpperClaim[] = [];
    for (const claim of (Array.isArray(entry.claims) ? entry.claims : []).filter(isRecord)) {
      const parsed = claimOf(claim);
      if (typeof parsed === "string") return parsed;
      claims.push(parsed);
    }
    entries.push({ lineId: asString(entry.lineId), cutSizeUppers: count(entry.cutSizeUppers), cutSizePairs: count(entry.cutSizePairs), claims });
  }
  return entries;
};
