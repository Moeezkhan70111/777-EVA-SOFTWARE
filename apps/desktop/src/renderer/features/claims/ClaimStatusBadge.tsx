import React from "react";
import { PARTY_CLAIM_REQUEST_STATUS, type PartyClaimRequestStatus } from "@erp/domain";
import { copy } from "../../config/copy";

// Waiting, posted or rejected: said in words with a mark, never by colour alone (R18).

const TONE: Readonly<Record<PartyClaimRequestStatus, string>> = {
  [PARTY_CLAIM_REQUEST_STATUS.PENDING]: "badge-warn",
  [PARTY_CLAIM_REQUEST_STATUS.POSTED]: "badge-ok",
  [PARTY_CLAIM_REQUEST_STATUS.REJECTED]: "badge-muted",
};

export const ClaimStatusBadge: React.FC<{ status: PartyClaimRequestStatus }> = ({ status }) => (
  <span className={`badge ${TONE[status]} claims-status`}>{copy.claims.status[status]}</span>
);
