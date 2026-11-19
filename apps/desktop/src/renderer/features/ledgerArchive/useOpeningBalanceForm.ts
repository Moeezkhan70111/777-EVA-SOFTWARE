import { useCallback, useState } from "react";
import {
  archiveBalanceForSide,
  naturalDirection,
  openingBalanceProblems,
  openingFromSideBalance,
  parseArchiveAmount,
  reversalReasonProblems,
  type LedgerSide,
  type OpeningBalanceDirection,
} from "@erp/domain";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { formatDate, toIsoDate } from "../../utils/dates";
import type { ArchiveStatement } from "./archiveReplies";
import { readOpeningBalanceView, type OpeningBalanceView } from "./openingBalanceReplies";

// THE OPENING BALANCE FORM (docs/53): what the person typed, checked by the domain's own rules before it is sent,
// and sent once under one request id, so a retry after a lost answer cannot post twice. The main process checks it
// all again; nothing here decides whether a figure is acceptable on its own.

export type OpeningBalanceMode = "post" | "correct" | "reverse";

export interface OpeningBalanceFields {
  direction: OpeningBalanceDirection;
  amountText: string;
  effectiveDate: string;
  sourceReference: string;
  archiveStatementId: string;
  note: string;
  reason: string;
}

const text = copy.openingBalance;

/** Rupees as typed, in whole paisa: "353,880", "353880.50". Null when it is not an amount. */
const paisaOf = (amountText: string): number | null => (amountText.trim() === "" ? null : parseArchiveAmount(amountText));

/** The day after an ISO day: an opening balance takes effect the day after the old ledger closed. */
const dayAfter = (iso: string): string => {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1)).toISOString().slice(0, 10);
};

function initialFields(side: LedgerSide, mode: OpeningBalanceMode, view: OpeningBalanceView | null): OpeningBalanceFields {
  const current = mode === "post" ? null : view?.current ?? null;
  return {
    direction: current?.direction ?? naturalDirection(side),
    amountText: current ? String(current.amountPaisa / 100) : "",
    effectiveDate: current?.effectiveDate ?? toIsoDate(),
    sourceReference: current?.sourceReference ?? "",
    archiveStatementId: current?.archiveStatementId ?? "",
    note: "",
    reason: "",
  };
}

/** The problems with what is typed, in the words the person reads. */
export function formProblems(mode: OpeningBalanceMode, fields: OpeningBalanceFields): string[] {
  const reasonProblems = mode === "post" ? [] : reversalReasonProblems(fields.reason);
  if (mode === "reverse") return reasonProblems;
  const amountPaisa = paisaOf(fields.amountText);
  const problems = openingBalanceProblems({ ...fields, amountPaisa: amountPaisa ?? undefined });
  const amountProblem = amountPaisa === null && fields.amountText.trim() !== "" ? [text.notAmount] : [];
  return [...amountProblem, ...problems, ...reasonProblems];
}

export function useOpeningBalanceForm(args: { side: LedgerSide; mode: OpeningBalanceMode; partyId: string; view: OpeningBalanceView | null; onDone: () => void }) {
  const { side, mode, partyId, view, onDone } = args;
  const api = useDesktopApi();
  const [fields, setFields] = useState<OpeningBalanceFields>(() => initialFields(side, mode, view));
  const [requestId] = useState(() => crypto.randomUUID());
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const change = useCallback(<K extends keyof OpeningBalanceFields>(key: K, value: OpeningBalanceFields[K]) => setFields((before) => ({ ...before, [key]: value })), []);

  /** Fills the figures from an archived statement's closing balance, read the way it was printed. */
  const fillFromStatement = useCallback((statement: ArchiveStatement) => {
    const position = openingFromSideBalance(side, archiveBalanceForSide(statement.closingBalancePaisa, side, statement.balanceRule));
    if (!position) {
      setProblems([text.archiveZero]);
      return;
    }
    const code = statement.originalPartyCode ? ` ${statement.originalPartyCode}` : "";
    setFields((before) => ({
      ...before,
      direction: position.direction,
      amountText: String(position.amountPaisa / 100),
      effectiveDate: dayAfter(statement.periodTo),
      sourceReference: `Old software ledger${code}, closed ${formatDate(statement.periodTo, statement.periodTo)}`,
      archiveStatementId: statement.id,
    }));
    setProblems([]);
  }, [side]);

  const submit = useCallback(async () => {
    const found = formProblems(mode, fields);
    setProblems(found);
    if (found.length > 0) return;
    setSaving(true);
    setRefusal(null);
    const posting = { direction: fields.direction, amountPaisa: paisaOf(fields.amountText), effectiveDate: fields.effectiveDate, sourceReference: fields.sourceReference, archiveStatementId: fields.archiveStatementId, note: fields.note };
    const base = { requestId, partyId };
    const send =
      mode === "post" ? api.postPartyOpeningBalance({ ...base, ...posting })
      : mode === "correct" ? api.correctPartyOpeningBalance({ ...base, ...posting, expectedVersion: view?.version, reason: fields.reason })
      : api.reversePartyOpeningBalance({ ...base, expectedVersion: view?.version, reason: fields.reason });
    const reply = readOpeningBalanceView(await send.catch(() => null));
    setSaving(false);
    if (reply.ok) onDone();
    else setRefusal(reply.reason ?? text.failed);
  }, [api, fields, mode, onDone, partyId, requestId, view?.version]);

  return { fields, change, fillFromStatement, submit, problems, saving, refusal };
}
