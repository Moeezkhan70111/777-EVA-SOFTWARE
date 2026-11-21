import { isLedgerArchiveSide, isOpeningBalanceDirection, type LedgerSide, type OpeningBalanceDirection } from "@erp/domain";
import { int, isRecord, readAll, refused, str, strOrNull, type Reply } from "./archiveReplies";

// THE MAIN PROCESS'S ANSWERS ABOUT OPENING BALANCES AT A CUTOVER, CHECKED (R25, docs/53). A READY party must carry a
// direction, a whole positive amount and the statement it was read from; anything else fails the whole answer, so the
// screen can never post a half-read figure.

export interface BulkProposal {
  partyId: string;
  partyName: string;
  partyCode: string;
  originalPartyCode: string;
  status: "READY" | "SKIP";
  skipReason: string | null;
  direction: OpeningBalanceDirection | null;
  amountPaisa: number | null;
  archiveStatementId: string | null;
  balanceAsOf: string | null;
  linesOnOrAfterCutover: number;
  warnings: string[];
}

export interface BulkPreview {
  side: LedgerSide;
  cutoverDate: string;
  proposals: BulkProposal[];
}

const texts = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : []);

function readReady(raw: Record<string, unknown>): Pick<BulkProposal, "direction" | "amountPaisa" | "archiveStatementId"> | null {
  const amountPaisa = int(raw.amountPaisa);
  const archiveStatementId = strOrNull(raw.archiveStatementId);
  if (!isOpeningBalanceDirection(raw.direction) || amountPaisa === null || amountPaisa <= 0 || archiveStatementId === null) return null;
  return { direction: raw.direction, amountPaisa, archiveStatementId };
}

function readProposal(raw: unknown): BulkProposal | null {
  if (!isRecord(raw) || !str(raw.partyId) || (raw.status !== "READY" && raw.status !== "SKIP")) return null;
  const lines = int(raw.linesOnOrAfterCutover);
  const ready = raw.status === "READY" ? readReady(raw) : { direction: null, amountPaisa: null, archiveStatementId: null };
  if (ready === null || lines === null) return null;
  return {
    partyId: str(raw.partyId),
    partyName: str(raw.partyName),
    partyCode: str(raw.partyCode),
    originalPartyCode: str(raw.originalPartyCode),
    status: raw.status,
    skipReason: strOrNull(raw.skipReason),
    ...ready,
    balanceAsOf: strOrNull(raw.balanceAsOf),
    linesOnOrAfterCutover: lines,
    warnings: texts(raw.warnings),
  };
}

export function readBulkPreview(raw: unknown): Reply<BulkPreview> {
  if (!isRecord(raw) || raw.accepted !== true || !isRecord(raw.preview)) return refused(raw);
  const preview = raw.preview;
  const proposals = readAll(preview.proposals, readProposal);
  if (!isLedgerArchiveSide(preview.side) || proposals === null || !/^\d{4}-\d{2}-\d{2}$/.test(str(preview.cutoverDate))) return { ok: false, reason: null };
  return { ok: true, value: { side: preview.side, cutoverDate: str(preview.cutoverDate), proposals } };
}

export interface BulkPostOutcome {
  duplicate: boolean;
  posted: number;
}

export function readBulkPostOutcome(raw: unknown): Reply<BulkPostOutcome> {
  if (!isRecord(raw) || raw.accepted !== true || !isRecord(raw.result)) return refused(raw);
  const posted = int(raw.result.posted);
  return posted === null ? { ok: false, reason: null } : { ok: true, value: { duplicate: raw.result.duplicate === true, posted } };
}
