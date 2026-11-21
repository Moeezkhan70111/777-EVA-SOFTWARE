import React from "react";
import { PARTY_CLAIM_REQUEST_STATUS } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatDateTime } from "../../app/format";
import { ClaimStatusBadge } from "./ClaimStatusBadge";
import { rupees } from "./useClaims";
import type { ClaimPosting, ClaimRequest } from "./claimReplies";

// One claim request, as a card (works from 360px up, R19):
//
//   CR-000041 · MP-000012                                              ⏳ Waiting for Accounts
//   ABC UPPER — Supplier
//   2 pairs of UPPER — SK6 RED — "torn upper"
//   Asked by aslam at the store, 21 Nov 2026 10:02
//   [ Price and post… ]  [ Reject… ]                      (only where claims may be posted)

const words = copy.claims;

export interface ClaimCardActions {
  onPost: (request: ClaimRequest) => void;
  onReject: (request: ClaimRequest) => void;
  onReverse: (request: ClaimRequest, claim: ClaimPosting) => void;
}

const History: React.FC<{ request: ClaimRequest }> = ({ request }) => {
  if (request.reversed.length === 0) return null;
  return (
    <details className="claims-history">
      <summary>{words.history} ({request.reversed.length})</summary>
      <ul>
        {request.reversed.map((claim) => (
          <li key={claim.claimId}>
            {words.reversedLine(claim.claimNumber, rupees(claim.amountPaisa), claim.reversalReason ?? "", claim.reversedBy ?? "", formatDateTime(claim.reversedAt))}
          </li>
        ))}
      </ul>
    </details>
  );
};

const Outcome: React.FC<{ request: ClaimRequest }> = ({ request }) => {
  if (request.posted) {
    const claim = request.posted;
    return (
      <p className="claims-outcome">
        <strong>{words.postedAs(claim.claimNumber, request.pairs, rupees(claim.ratePaisa), rupees(claim.amountPaisa))}</strong>
        <span className="claims-muted"> · {words.postedBy(claim.postedBy, formatDateTime(claim.postedAt))}</span>
      </p>
    );
  }
  if (request.rejection) {
    return <p className="claims-outcome">{words.rejectedBecause(request.rejection.reason, request.rejection.rejectedBy, formatDateTime(request.rejection.rejectedAt))}</p>;
  }
  return null;
};

const Actions: React.FC<{ request: ClaimRequest; actions: ClaimCardActions }> = ({ request, actions }) => {
  if (request.status === PARTY_CLAIM_REQUEST_STATUS.PENDING) {
    return (
      <div className="claims-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => actions.onPost(request)}>{words.price}</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => actions.onReject(request)}>{words.reject}</button>
      </div>
    );
  }
  if (request.posted) {
    const claim = request.posted;
    return (
      <div className="claims-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => actions.onReverse(request, claim)}>{words.reverse}</button>
      </div>
    );
  }
  return null;
};

export const ClaimRequestCard: React.FC<{ request: ClaimRequest; actions: ClaimCardActions | null }> = ({ request, actions }) => (
  <li className="claims-card" aria-label={words.request(request.requestNumber, request.programCode)}>
    <div className="claims-card-head">
      <strong className="claims-number">{words.request(request.requestNumber, request.programCode)}</strong>
      <ClaimStatusBadge status={request.status} />
    </div>
    <p className="claims-party">
      {request.partyName} <span className="claims-muted">— {words.roles[request.role]}</span>
    </p>
    <p>
      {words.pairsOf(request.pairs, request.materialName)} — “{request.reason}”
    </p>
    <p className="claims-muted">{words.askedBy(request.createdBy, formatDateTime(request.createdAt))}</p>
    <Outcome request={request} />
    <History request={request} />
    {actions ? <Actions request={request} actions={actions} /> : null}
  </li>
);
