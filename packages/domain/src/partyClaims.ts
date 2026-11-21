// CLAIMS — what the store asks for, and what Accounts posts (docs/55).
//
//   STORE (PC2), closing a program      CR-000041  2 pairs of SK6 7/10 RED against ABC UPPER — torn upper   no money
//   ACCOUNTS (PC1), Claims screen       CL-000017  2 × Rs 50 = Rs 100 deducted on ABC UPPER's ledger        posted
//
// A claim REQUEST is physical: how many pairs went missing on a program and who is answerable. It never moves money.
// A CLAIM is financial: Accounts prices a request and posts it, and only then is it on the party's ledger. A request
// is answered once: posted, or rejected with a reason. A posted claim may be reversed with a reason, which takes it
// off every ledger and lets Accounts post the request again at the right amount.

/** Where one request stands. Worked out from the records, never stored: a request is the store's, its answer Accounts'. */
export const PARTY_CLAIM_REQUEST_STATUS = {
  /** Waiting for Accounts to price it, or to price it again after a reversal. */
  PENDING: "PENDING",
  /** A claim stands on the party's ledger for it. */
  POSTED: "POSTED",
  /** Accounts decided nothing is claimed, and said why. */
  REJECTED: "REJECTED",
} as const;
export type PartyClaimRequestStatus = (typeof PARTY_CLAIM_REQUEST_STATUS)[keyof typeof PARTY_CLAIM_REQUEST_STATUS];

/** A request's status from what has been recorded against it. A rejection is final, so it wins. */
export const claimRequestStatus = (facts: { rejected: boolean; postedClaims: number }): PartyClaimRequestStatus => {
  if (facts.rejected) return PARTY_CLAIM_REQUEST_STATUS.REJECTED;
  return facts.postedClaims > 0 ? PARTY_CLAIM_REQUEST_STATUS.POSTED : PARTY_CLAIM_REQUEST_STATUS.PENDING;
};

/** The most one pair can be claimed at: Rs 100,000. A larger figure is a typing mistake, not a claim. */
export const MAX_CLAIM_RATE_PAISA = 10_000_000;

/** The longest reason kept for a rejection or a reversal. */
export const MAX_CLAIM_DECISION_REASON_LENGTH = 500;

/** Why an amount a pair cannot be posted, or null. Integer paisa only (R15). */
export const claimRatePaisaProblem = (ratePaisa: number): string | null => {
  if (!Number.isInteger(ratePaisa) || ratePaisa < 1) return "Type the amount claimed for one pair — more than 0.";
  if (ratePaisa > MAX_CLAIM_RATE_PAISA) return "That amount for one pair is too large. Check the figure.";
  return null;
};

/** Why a rejection's or a reversal's reason cannot be kept, or null. Both always need one. */
export const claimDecisionReasonProblem = (reason: unknown): string | null => {
  const typed = typeof reason === "string" ? reason.trim() : "";
  if (typed === "") return "Say why. The reason is kept with the claim's history.";
  if (typed.length > MAX_CLAIM_DECISION_REASON_LENGTH) return `Keep the reason under ${MAX_CLAIM_DECISION_REASON_LENGTH} characters.`;
  return null;
};

/** `CR-000041`: the number a claim request is known by on the store and the accounts computer alike. */
export const formatClaimRequestCode = (value: number): string => `CR-${String(value).padStart(6, "0")}`;

/** `CL-000017`: a posted claim's number, on every ledger. */
export const formatPartyClaimCode = (value: number): string => `CL-${String(value).padStart(6, "0")}`;
