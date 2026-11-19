import React from "react";
import type { LedgerSide, OpeningBalanceDirection } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatDate, formatDateTime } from "../../utils/dates";
import { archiveAmount } from "./ArchivedLedgerRow";
import type { OpeningStep } from "./openingBalanceReplies";
import type { OpeningBalanceState } from "./useOpeningBalance";
import type { OpeningBalanceMode } from "./useOpeningBalanceForm";

// A party's opening balance on its ledger screen (docs/53): the figure carried in from the old software, when it
// takes effect, where it came from and who posted it, with its history. Unlike the archive strip beside it, this
// figure IS in the live balance, and the strip says so in words. Only an administrator is offered the actions.

const text = copy.openingBalance;

const day = (iso: string): string => formatDate(iso, iso);

const Step: React.FC<{ step: OpeningStep; side: LedgerSide }> = ({ step, side }) => {
  const short: Record<OpeningBalanceDirection, string> = text.short[side];
  return (
    <li>
      <strong>{step.action === "POST" ? text.stepPost : text.stepReverse}</strong> Rs. {archiveAmount(step.amountPaisa)} {short[step.direction]} · {text.from(day(step.effectiveDate))} · {step.sourceReference}
      {step.reason && <> · <em>{step.reason}</em></>} · {step.recordedBy}, {formatDateTime(step.recordedAt)}
    </li>
  );
};

interface Props {
  side: LedgerSide;
  state: OpeningBalanceState;
  canChange: boolean;
  onOpen: (mode: OpeningBalanceMode) => void;
  onRetry: () => void;
}

export const OpeningBalanceStrip: React.FC<Props> = ({ side, state, canChange, onOpen, onRetry }) => {
  if (state.status === "idle") return null;
  if (state.status === "loading") return <p className="ledger-archive-strip opening-balance-strip" role="status">{text.loading}</p>;
  if (state.status === "error") {
    return (
      <div className="ledger-archive-strip opening-balance-strip ledger-archive-note" role="alert">
        <span>⚠ {state.reason ?? text.failed}</span>
        <button type="button" className="customer-ledger-print" onClick={onRetry}>{text.retry}</button>
      </div>
    );
  }
  const { view } = state;
  const current = view.current;
  const short: Record<OpeningBalanceDirection, string> = text.short[side];
  const lastStep = view.history.at(-1);
  const beforeLive = current && view.firstLiveDate && view.firstLiveDate < current.effectiveDate ? view.firstLiveDate : null;
  return (
    <section className="ledger-archive-strip opening-balance-strip" aria-label={text.title}>
      <div className="ledger-archive-heading">
        <strong>{text.title}</strong>
        {current ? <span>{text.includedNote}</span> : <span>{text.none}</span>}
      </div>
      {current && (
        <div className="ledger-archive-figures">
          <div className="ledger-archive-figure">
            <span>{short[current.direction]} · {text.from(day(current.effectiveDate))}</span>
            <strong>Rs. {archiveAmount(current.amountPaisa)}</strong>
          </div>
          <div className="ledger-archive-figure">
            <span>{text.sourceLabel}</span>
            <strong className="opening-balance-source">{current.sourceReference}</strong>
          </div>
        </div>
      )}
      {!current && lastStep?.action === "REVERSE" && <span>{text.reversedNote(lastStep.recordedBy, formatDateTime(lastStep.recordedAt))}</span>}
      {beforeLive && <p className="opening-balance-warning" role="note">{text.beforeLive(day(beforeLive))}</p>}
      {canChange && (
        <div className="ledger-archive-sources" role="group" aria-label={text.title}>
          {current ? (
            <>
              <button type="button" className="customer-ledger-print" onClick={() => onOpen("correct")}>{text.correct}</button>
              <button type="button" className="customer-ledger-print" onClick={() => onOpen("reverse")}>{text.reverse}</button>
            </>
          ) : (
            <button type="button" className="customer-ledger-print" onClick={() => onOpen("post")}>{text.set}</button>
          )}
        </div>
      )}
      {view.history.length > 0 && (
        <details className="ledger-import-details opening-balance-history">
          <summary>{text.history(view.history.length)}</summary>
          <ul>{view.history.map((step) => <Step key={step.id} step={step} side={side} />)}</ul>
        </details>
      )}
    </section>
  );
};
