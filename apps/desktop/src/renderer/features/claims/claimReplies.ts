import { CLAIM_PARTY_ROLE, PARTY_CLAIM_REQUEST_STATUS, type ClaimPartyRole, type PartyClaimRequestStatus } from "@erp/domain";
import { int, isRecord, readAll, refused, str, strOrNull, type Reply } from "../ledgerArchive/archiveReplies";

// THE MAIN PROCESS'S ANSWERS ABOUT CLAIMS, CHECKED (R25, docs/55). A status this screen does not know, or a figure that
// is not whole paisa, fails the whole answer: the screen says it could not load, never shows a half-read claim.

export interface ClaimPosting {
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

export interface ClaimRequest {
  requestId: string;
  requestNumber: string;
  requestDate: string;
  createdBy: string;
  createdAt: string;
  partyId: string;
  partyName: string;
  role: ClaimPartyRole;
  programCode: string;
  materialName: string;
  pairs: number;
  reason: string;
  status: PartyClaimRequestStatus;
  posted: ClaimPosting | null;
  reversed: ClaimPosting[];
  rejection: { reason: string; rejectedBy: string; rejectedAt: string } | null;
}

export interface ClaimPage {
  rows: ClaimRequest[];
  total: number;
  pending: number;
}

const ROLES: ReadonlySet<string> = new Set(Object.values(CLAIM_PARTY_ROLE));
const STATUSES: ReadonlySet<string> = new Set(Object.values(PARTY_CLAIM_REQUEST_STATUS));

function readPosting(raw: unknown): ClaimPosting | null {
  if (!isRecord(raw) || !str(raw.claimId) || !str(raw.claimNumber)) return null;
  const ratePaisa = int(raw.ratePaisa);
  const amountPaisa = int(raw.amountPaisa);
  if (ratePaisa === null || amountPaisa === null) return null;
  return {
    claimId: str(raw.claimId),
    claimNumber: str(raw.claimNumber),
    claimDate: str(raw.claimDate),
    ratePaisa,
    amountPaisa,
    postedBy: str(raw.postedBy),
    postedAt: str(raw.postedAt),
    reversedBy: strOrNull(raw.reversedBy),
    reversedAt: strOrNull(raw.reversedAt),
    reversalReason: strOrNull(raw.reversalReason),
  };
}

function readRejection(raw: unknown): ClaimRequest["rejection"] | undefined {
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;
  return { reason: str(raw.reason), rejectedBy: str(raw.rejectedBy), rejectedAt: str(raw.rejectedAt) };
}

export function readClaimRequest(raw: unknown): ClaimRequest | null {
  if (!isRecord(raw) || !str(raw.requestId) || !ROLES.has(str(raw.role)) || !STATUSES.has(str(raw.status))) return null;
  const pairs = int(raw.pairs);
  const posted = raw.posted === null ? null : readPosting(raw.posted);
  const reversed = readAll(raw.reversed, readPosting);
  const rejection = readRejection(raw.rejection);
  if (pairs === null || pairs < 1 || (raw.posted !== null && posted === null) || reversed === null || rejection === undefined) return null;
  return {
    requestId: str(raw.requestId),
    requestNumber: str(raw.requestNumber),
    requestDate: str(raw.requestDate),
    createdBy: str(raw.createdBy),
    createdAt: str(raw.createdAt),
    partyId: str(raw.partyId),
    partyName: str(raw.partyName),
    role: str(raw.role) as ClaimPartyRole,
    programCode: str(raw.programCode),
    materialName: str(raw.materialName),
    pairs,
    reason: str(raw.reason),
    status: str(raw.status) as PartyClaimRequestStatus,
    posted,
    reversed,
    rejection,
  };
}

export function readClaimPage(raw: unknown): Reply<ClaimPage> {
  if (!isRecord(raw) || raw.accepted !== true || !isRecord(raw.page)) return refused(raw);
  const rows = readAll(raw.page.rows, readClaimRequest);
  const total = int(raw.page.total);
  const pending = int(raw.page.pending);
  if (rows === null || total === null || pending === null) return { ok: false, reason: null };
  return { ok: true, value: { rows, total, pending } };
}

/** A post or a rejection: the request as it stands after. */
export function readClaimDecision(raw: unknown): Reply<ClaimRequest> {
  if (!isRecord(raw) || raw.accepted !== true) return refused(raw);
  const request = readClaimRequest(raw.result);
  return request ? { ok: true, value: request } : { ok: false, reason: null };
}

/** A reversal: the number of the claim taken off the ledgers. */
export function readClaimReversal(raw: unknown): Reply<{ claimNumber: string }> {
  if (!isRecord(raw) || raw.accepted !== true || !isRecord(raw.result) || !str(raw.result.claimNumber)) return refused(raw);
  return { ok: true, value: { claimNumber: str(raw.result.claimNumber) } };
}
