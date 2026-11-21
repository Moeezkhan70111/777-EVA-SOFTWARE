// Claim requests and what Accounts did with them, as the Claims screen reads them (docs/55).
//
//   CR-000041 · MP-000012 · ABC UPPER (supplier) · 2 pairs of SK6 7/10 RED — torn upper     PENDING
//   CR-000040 · MP-000011 · RAFIQ (packing)      · 1 pair of SK8 8/10 BLACK — lost        POSTED CL-000017 Rs 50.00
//
// Read only here. The store writes a request when it closes a program (machineProgramUpperReconciliation.ts); Accounts
// posts, rejects or reverses (partyClaimPosting.ts). A request's status is worked out from those records, never stored,
// so the store's record and Accounts' answer can each be written by the one computer that owns it.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import { PARTY_CLAIM_REQUEST_STATUS, claimRequestStatus, type ClaimPartyRole, type PartyClaimRequestStatus } from "@erp/domain";
import { orderByCode } from "./numberRange.js";

const text = (value: unknown): string => (value == null ? "" : String(value));
const textOrNull = (value: unknown): string | null => (value == null || String(value) === "" ? null : String(value));

/** A posted claim, or one reversed, as a request's history shows it. */
export interface ClaimPostingView {
  claimId: string;
  claimNumber: string;
  claimDate: string;
  ratePaisa: number;
  amountPaisa: number;
  postedBy: string;
  postedAt: string;
  reversedBy: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
}

export interface ClaimRequestView {
  requestId: string;
  requestNumber: string;
  requestDate: string;
  createdBy: string;
  createdAt: string;
  originDeviceId: string | null;
  partyId: string;
  partyName: string;
  role: ClaimPartyRole;
  programId: string;
  programCode: string;
  upperLineId: string;
  itemId: string;
  materialName: string;
  pairs: number;
  reason: string;
  status: PartyClaimRequestStatus;
  /** The claim standing on the ledger for it now, or null. */
  posted: ClaimPostingView | null;
  /** Every claim posted for it and later reversed, oldest first. */
  reversed: ClaimPostingView[];
  rejection: { reason: string; rejectedBy: string; rejectedAt: string } | null;
}

export type ClaimRequestFilter = PartyClaimRequestStatus | "ALL";

export interface ClaimRequestPage {
  rows: ClaimRequestView[];
  total: number;
  /** How many wait for Accounts, whatever the filter. */
  pending: number;
}

// A request's status in SQL, the same rule as claimRequestStatus: a rejection wins, then a POSTED claim.
const STATUS_SQL = `CASE
    WHEN EXISTS (SELECT 1 FROM party_claim_rejections j WHERE j.request_id = r.id) THEN '${PARTY_CLAIM_REQUEST_STATUS.REJECTED}'
    WHEN EXISTS (SELECT 1 FROM party_claims c WHERE c.request_id = r.id AND c.status = 'POSTED') THEN '${PARTY_CLAIM_REQUEST_STATUS.POSTED}'
    ELSE '${PARTY_CLAIM_REQUEST_STATUS.PENDING}' END`;

const REQUESTS_SQL = `
  SELECT r.*, p.party_name, ${STATUS_SQL} AS status
    FROM party_claim_requests r JOIN parties p ON p.id = r.party_id`;

const postingOf = (row: Record<string, unknown>): ClaimPostingView => ({
  claimId: text(row.id),
  claimNumber: text(row.claim_number),
  claimDate: text(row.claim_date),
  ratePaisa: Number(row.rate_paisa ?? 0),
  amountPaisa: Number(row.amount_paisa ?? 0),
  postedBy: text(row.created_by),
  postedAt: text(row.created_at),
  reversedBy: textOrNull(row.reversed_by),
  reversedAt: textOrNull(row.reversed_at),
  reversalReason: textOrNull(row.reversal_reason),
});

export const partyClaimRequestsMethods = {
  /** One page of requests, newest first. `filter` is a status, or ALL. */
  listPartyClaimRequests(this: SqliteDatabase, input: { filter?: ClaimRequestFilter; limit?: number; offset?: number } = {}): ClaimRequestPage {
    const filter = input.filter ?? PARTY_CLAIM_REQUEST_STATUS.PENDING;
    const limit = Math.min(Math.max(Math.trunc(Number(input.limit ?? 100)) || 100, 1), 500);
    const offset = Math.max(Math.trunc(Number(input.offset ?? 0)) || 0, 0);
    const where = filter === "ALL" ? "" : " WHERE status = ?";
    const args = filter === "ALL" ? [] : [filter];
    const rows = this.db
      .prepare(`SELECT * FROM (${REQUESTS_SQL}) r${where} ORDER BY r.request_date DESC, ${orderByCode("claimRequest", "r.request_number")} DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as Array<Record<string, unknown>>;
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM (${REQUESTS_SQL}) r${where}`).get(...args) as { n: number }).n);
    const pending = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM (${REQUESTS_SQL}) r WHERE status = ?`).get(PARTY_CLAIM_REQUEST_STATUS.PENDING) as { n: number }).n);
    return { rows: rows.map((row) => this.claimRequestViewOf(row)), total, pending };
  },

  /** One request with its whole history, or null. */
  getPartyClaimRequest(this: SqliteDatabase, requestId: string): ClaimRequestView | null {
    const row = this.db.prepare(`SELECT * FROM (${REQUESTS_SQL}) r WHERE r.id = ?`).get(text(requestId).trim()) as Record<string, unknown> | undefined;
    return row ? this.claimRequestViewOf(row) : null;
  },

  /** @internal A request row, with its claims and rejection. */
  claimRequestViewOf(this: SqliteDatabase, row: Record<string, unknown>): ClaimRequestView {
    const requestId = text(row.id);
    const claims = (this.db
      .prepare(`SELECT * FROM party_claims WHERE request_id = ? ORDER BY created_at, ${orderByCode("partyClaim", "claim_number")}`)
      .all(requestId) as Array<Record<string, unknown>>).map((claim) => ({ status: text(claim.status), view: postingOf(claim) }));
    const rejected = this.db.prepare("SELECT reason, rejected_by, rejected_at FROM party_claim_rejections WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
    const posted = claims.find((claim) => claim.status === "POSTED")?.view ?? null;
    return {
      requestId,
      requestNumber: text(row.request_number),
      requestDate: text(row.request_date),
      createdBy: text(row.created_by),
      createdAt: text(row.created_at),
      originDeviceId: textOrNull(row.origin_device_id),
      partyId: text(row.party_id),
      partyName: text(row.party_name),
      role: text(row.party_role) as ClaimPartyRole,
      programId: text(row.program_id),
      programCode: text(row.program_code),
      upperLineId: text(row.upper_line_id),
      itemId: text(row.item_id),
      materialName: text(row.material_name),
      pairs: Number(row.quantity_pairs ?? 0),
      reason: text(row.reason),
      status: claimRequestStatus({ rejected: rejected !== undefined, postedClaims: posted ? 1 : 0 }),
      posted,
      reversed: claims.filter((claim) => claim.status !== "POSTED").map((claim) => claim.view),
      rejection: rejected ? { reason: text(rejected.reason), rejectedBy: text(rejected.rejected_by), rejectedAt: text(rejected.rejected_at) } : null,
    };
  },
};

export type PartyClaimRequestsMethods = typeof partyClaimRequestsMethods;
