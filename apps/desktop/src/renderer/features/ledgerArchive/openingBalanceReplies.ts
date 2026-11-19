import type { LedgerSide, OpeningBalanceAction, OpeningBalanceDirection, ReconciliationStatus } from "@erp/domain";
import { RECONCILIATION_STATUS, isLedgerArchiveSide, isOpeningBalanceDirection } from "@erp/domain";
import { int, isRecord, readAll, refused, str, strOrNull, type Reply } from "./archiveReplies";

// THE MAIN PROCESS'S ANSWERS ABOUT OPENING BALANCES AND THE RECONCILIATION, CHECKED (R25, docs/53). A figure that does
// not read as whole paisa, or a direction that is not DEBIT or CREDIT, fails the whole answer: the screen shows an
// error, never a half-read balance.

export interface OpeningStep {
  id: string;
  version: number;
  action: OpeningBalanceAction;
  direction: OpeningBalanceDirection;
  amountPaisa: number;
  effectiveDate: string;
  sourceReference: string;
  note: string | null;
  reason: string | null;
  recordedBy: string;
  recordedAt: string;
}

export interface OpeningPosition {
  direction: OpeningBalanceDirection;
  amountPaisa: number;
  effectiveDate: string;
  sourceReference: string;
  archiveStatementId: string | null;
}

export interface OpeningBalanceView {
  partyId: string;
  side: LedgerSide;
  current: OpeningPosition | null;
  version: number;
  history: OpeningStep[];
  firstLiveDate: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ACTIONS: ReadonlySet<string> = new Set(["POST", "REVERSE"]);

function readPosition(raw: unknown): OpeningPosition | null {
  if (!isRecord(raw) || !isOpeningBalanceDirection(raw.direction)) return null;
  const amountPaisa = int(raw.amountPaisa);
  if (amountPaisa === null || amountPaisa <= 0 || !DAY.test(str(raw.effectiveDate))) return null;
  return { direction: raw.direction, amountPaisa, effectiveDate: str(raw.effectiveDate), sourceReference: str(raw.sourceReference), archiveStatementId: strOrNull(raw.archiveStatementId) };
}

function readStep(raw: unknown): OpeningStep | null {
  const position = readPosition(raw);
  if (!isRecord(raw) || position === null || !ACTIONS.has(str(raw.action))) return null;
  const version = int(raw.version);
  if (version === null) return null;
  return {
    ...position,
    id: str(raw.id),
    version,
    action: str(raw.action) as OpeningBalanceAction,
    note: strOrNull(raw.note),
    reason: strOrNull(raw.reason),
    recordedBy: str(raw.recordedBy),
    recordedAt: str(raw.recordedAt),
  };
}

export function readOpeningBalanceView(raw: unknown): Reply<OpeningBalanceView> {
  if (!isRecord(raw) || raw.accepted !== true || !isRecord(raw.view)) return refused(raw);
  const view = raw.view;
  const version = int(view.version);
  const history = readAll(view.history, readStep);
  const current = view.current === null ? null : readPosition(view.current);
  if (!isLedgerArchiveSide(view.side) || version === null || history === null || (view.current !== null && current === null)) return { ok: false, reason: null };
  return { ok: true, value: { partyId: str(view.partyId), side: view.side, current, version, history, firstLiveDate: strOrNull(view.firstLiveDate) } };
}

// ─── The reconciliation ─────────────────────────────────────────────────────

export interface ReconciliationRow {
  partyId: string;
  partyName: string;
  partyCode: string;
  originalPartyCode: string;
  status: ReconciliationStatus;
  statementCount: number;
  archiveOpeningPaisa: number | null;
  archiveDebitPaisa: number;
  archiveCreditPaisa: number;
  archiveClosingPaisa: number | null;
  archiveTo: string | null;
  openingPaisa: number | null;
  openingEffectiveDate: string | null;
  differencePaisa: number | null;
  liveBalancePaisa: number | null;
  notes: string[];
}

const STATUSES: ReadonlySet<string> = new Set(Object.values(RECONCILIATION_STATUS));
/** A figure that may be absent: null stays null, anything else must be whole paisa. */
const optional = (value: unknown): { ok: boolean; value: number | null } => (value === null ? { ok: true, value: null } : { ok: int(value) !== null, value: int(value) });

function readRow(raw: unknown): ReconciliationRow | null {
  if (!isRecord(raw) || !str(raw.partyId) || !STATUSES.has(str(raw.status))) return null;
  const figures = [raw.archiveOpeningPaisa, raw.archiveClosingPaisa, raw.openingPaisa, raw.differencePaisa, raw.liveBalancePaisa].map(optional);
  const debit = int(raw.archiveDebitPaisa);
  const credit = int(raw.archiveCreditPaisa);
  const statements = int(raw.statementCount);
  if (figures.some((figure) => !figure.ok) || debit === null || credit === null || statements === null) return null;
  const [archiveOpeningPaisa, archiveClosingPaisa, openingPaisa, differencePaisa, liveBalancePaisa] = figures.map((figure) => figure.value);
  return {
    partyId: str(raw.partyId),
    partyName: str(raw.partyName),
    partyCode: str(raw.partyCode),
    originalPartyCode: str(raw.originalPartyCode),
    status: str(raw.status) as ReconciliationStatus,
    statementCount: statements,
    archiveOpeningPaisa,
    archiveDebitPaisa: debit,
    archiveCreditPaisa: credit,
    archiveClosingPaisa,
    archiveTo: strOrNull(raw.archiveTo),
    openingPaisa,
    openingEffectiveDate: strOrNull(raw.openingEffectiveDate),
    differencePaisa,
    liveBalancePaisa,
    notes: Array.isArray(raw.notes) ? raw.notes.filter((note): note is string => typeof note === "string") : [],
  };
}

export function readReconciliation(raw: unknown): Reply<ReconciliationRow[]> {
  if (!isRecord(raw) || raw.accepted !== true || !isRecord(raw.report)) return refused(raw);
  const rows = readAll(raw.report.rows, readRow);
  return rows === null ? { ok: false, reason: null } : { ok: true, value: rows };
}
