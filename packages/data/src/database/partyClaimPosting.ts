// Accounts prices, posts, rejects and reverses claims (docs/55).
//
//   postClaimFromRequest    CR-000041, Rs 50 a pair   →  CL-000017  2 × Rs 50 = Rs 100 deducted on the party's ledger
//   rejectClaimRequest      CR-000041, "the supplier replaced the uppers"   →  nothing is claimed for it
//   reversePartyClaim       CL-000017, "wrong rate"   →  off every ledger, kept with who and why. The request is
//                                                        pending again, to be posted at the right amount.
//
// Run on the computer holding the ACCOUNTS lease (leaseChannels.ts). Each is ONE transaction under the write lock:
// what the request asks for and whether it is already answered is read inside it, never taken from the screen.
//
// NOTHING ELSE MOVES. A claim writes party_claims, a rejection party_claim_rejections, and nothing else: no stock, cash,
// production, program or carton figure, here or on any computer that receives it. The store's request is never changed.
//
// DUPLICATE-SAFE. A request has at most one POSTED claim (idx_party_claims_one_posted_per_request), and the screen sends
// the new claim's id, so a retry of a post that already went through is answered with it instead of a second claim.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import {
  PARTY_CLAIM_REQUEST_STATUS,
  PARTY_CLAIM_STATUS,
  claimAmountPaisa,
  claimDecisionReasonProblem,
  claimRatePaisaProblem,
  formatPartyClaimCode,
} from "@erp/domain";
import { allocateNumberInRange, readLocalDeviceId } from "./numberRange.js";
import type { ClaimRequestView } from "./partyClaimRequests.js";

const text = (value: unknown): string => (value == null ? "" : String(value));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PostClaimInput {
  /** The new claim's id, made by the screen once per attempt: a repeat with it is answered, not posted again. */
  claimId: string;
  requestId: string;
  /** The amount for one pair, in integer paisa. */
  ratePaisa: number;
  actor: string;
}

/** Runs `write` in one BEGIN IMMEDIATE transaction, rolled back whole if it throws. */
function inTransaction<T>(db: SqliteDatabase, write: () => T): T {
  db.db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    const result = write();
    db.db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.db.exec("ROLLBACK"); } catch { /* no transaction to roll back */ }
    throw error;
  }
}

const needActor = (actor: string): string => {
  const who = text(actor).trim();
  if (!who) throw new Error("Posting a claim needs the signed-in user.");
  return who;
};

export const partyClaimPostingMethods = {
  /** Prices a pending request and posts it to the party's ledger. Answers with the request as it stands after. */
  postClaimFromRequest(this: SqliteDatabase, input: PostClaimInput): ClaimRequestView {
    const actor = needActor(input.actor);
    const claimId = text(input.claimId).trim();
    if (!UUID.test(claimId)) throw new Error("The claim could not be posted. Reload the Claims screen and try again.");
    const rateProblem = claimRatePaisaProblem(Number(input.ratePaisa));
    if (rateProblem) throw new Error(rateProblem);

    return inTransaction(this, () => {
      const request = this.claimRequestForDecision(input.requestId);
      const repeat = this.db.prepare("SELECT request_id FROM party_claims WHERE id = ?").get(claimId) as { request_id?: string } | undefined;
      if (repeat) {
        if (repeat.request_id !== request.requestId) throw new Error("The claim could not be posted. Reload the Claims screen and try again.");
        return this.getPartyClaimRequest(request.requestId)!;
      }
      if (request.status === PARTY_CLAIM_REQUEST_STATUS.REJECTED) throw new Error(`${request.requestNumber} was rejected, so nothing can be claimed for it.`);
      if (request.posted) throw new Error(`${request.requestNumber} is already posted as ${request.posted.claimNumber}. Reverse that claim first to post it again.`);

      const ratePaisa = Number(input.ratePaisa);
      const claimNumber = formatPartyClaimCode(allocateNumberInRange(this, "partyClaim"));
      this.db
        .prepare(
          `INSERT INTO party_claims (id, claim_number, party_id, party_role, program_id, upper_line_id, item_id, quantity_pairs,
             rate_paisa, amount_paisa, reason, claim_date, status, created_by, created_at, origin_device_id,
             request_id, program_code, material_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          claimId, claimNumber, request.partyId, request.role, request.programId, request.upperLineId, request.itemId, request.pairs,
          ratePaisa, claimAmountPaisa({ pairs: request.pairs, ratePaisa }), request.reason, this.localYmd(new Date()),
          PARTY_CLAIM_STATUS.POSTED, actor, new Date().toISOString(), readLocalDeviceId(this),
          request.requestId, request.programCode, request.materialName
        );
      return this.getPartyClaimRequest(request.requestId)!;
    });
  },

  /** Answers a pending request with "nothing is claimed", and why. Final: a rejected request cannot be posted. */
  rejectClaimRequest(this: SqliteDatabase, input: { requestId: string; reason: unknown; actor: string }): ClaimRequestView {
    const actor = needActor(input.actor);
    const reasonProblem = claimDecisionReasonProblem(input.reason);
    if (reasonProblem) throw new Error(reasonProblem);

    return inTransaction(this, () => {
      const request = this.claimRequestForDecision(input.requestId);
      if (request.status === PARTY_CLAIM_REQUEST_STATUS.REJECTED) throw new Error(`${request.requestNumber} is already rejected.`);
      if (request.posted) throw new Error(`${request.requestNumber} is posted as ${request.posted.claimNumber}. Reverse that claim instead.`);
      this.db
        .prepare("INSERT INTO party_claim_rejections (id, request_id, reason, rejected_by, rejected_at, origin_device_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(crypto.randomUUID(), request.requestId, text(input.reason).trim(), actor, new Date().toISOString(), readLocalDeviceId(this));
      return this.getPartyClaimRequest(request.requestId)!;
    });
  },

  /**
   * Takes a posted claim off every ledger, keeping it with who reversed it and why. Its request, if it has one, is
   * pending again. Answers with the claim's number.
   */
  reversePartyClaim(this: SqliteDatabase, input: { claimId: string; reason: unknown; actor: string }): { claimNumber: string; requestId: string | null } {
    const actor = needActor(input.actor);
    const reasonProblem = claimDecisionReasonProblem(input.reason);
    if (reasonProblem) throw new Error(reasonProblem);

    return inTransaction(this, () => {
      const claim = this.db.prepare("SELECT claim_number, status, request_id FROM party_claims WHERE id = ?").get(text(input.claimId).trim()) as Record<string, unknown> | undefined;
      if (!claim) throw new Error("That claim is not on this computer. Reload the Claims screen.");
      if (text(claim.status) !== PARTY_CLAIM_STATUS.POSTED) throw new Error(`${text(claim.claim_number)} is already reversed.`);
      this.db
        .prepare("UPDATE party_claims SET status = ?, reversed_by = ?, reversed_at = ?, reversal_reason = ? WHERE id = ? AND status = ?")
        .run(PARTY_CLAIM_STATUS.REVERSED, actor, new Date().toISOString(), text(input.reason).trim(), text(input.claimId).trim(), PARTY_CLAIM_STATUS.POSTED);
      return { claimNumber: text(claim.claim_number), requestId: claim.request_id == null ? null : text(claim.request_id) };
    });
  },

  /** @internal The request a decision is about, read inside the caller's transaction. */
  claimRequestForDecision(this: SqliteDatabase, requestId: string): ClaimRequestView {
    const request = this.getPartyClaimRequest(requestId);
    if (!request) throw new Error("That claim request is not on this computer yet. Wait for the store's records to arrive, then reload.");
    return request;
  },
};

export type PartyClaimPostingMethods = typeof partyClaimPostingMethods;
