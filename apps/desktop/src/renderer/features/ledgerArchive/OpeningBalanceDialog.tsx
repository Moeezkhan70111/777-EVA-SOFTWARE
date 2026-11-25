import React, { useEffect, useRef } from "react";
import type { LedgerSide, OpeningBalanceDirection } from "@erp/domain";
import { Modal } from "../../components/shared/Modal";
import { copy } from "../../config/copy";
import { formatDate } from "../../utils/dates";
import type { ArchiveStatement } from "./archiveReplies";
import { archiveAmount } from "./ArchivedLedgerRow";
import type { OpeningBalanceView } from "./openingBalanceReplies";
import { useOpeningBalanceForm, type OpeningBalanceFields, type OpeningBalanceMode } from "./useOpeningBalanceForm";

// Set, correct or reverse a party's opening balance (docs/53). Every figure is labelled, the direction is said in the
// ledger's own words, and nothing is posted until the person presses the button. A correction and a reversal need a
// reason, and both keep the figure they replace in the history.

const text = copy.openingBalance;
const TITLE: Record<OpeningBalanceMode, string> = { post: text.postTitle, correct: text.correctTitle, reverse: text.reverseTitle };
const INTRO: Record<OpeningBalanceMode, string> = { post: text.intro, correct: text.correctIntro, reverse: text.reverseIntro };
const SAVE: Record<OpeningBalanceMode, string> = { post: text.save, correct: text.saveCorrection, reverse: text.saveReversal };

interface Props {
  side: LedgerSide;
  mode: OpeningBalanceMode;
  partyId: string;
  partyName: string;
  view: OpeningBalanceView | null;
  statements: readonly ArchiveStatement[];
  onDone: () => void;
  onClose: () => void;
  /** Opened from "Carry it into the balance": start filled from the latest statement (Tesler's law). Still posted only on the button. */
  prefill?: boolean;
}

type Change = <K extends keyof OpeningBalanceFields>(key: K, value: OpeningBalanceFields[K]) => void;

const Field: React.FC<{ id: string; label: string; children: React.ReactNode }> = ({ id, label, children }) => (
  <div className="opening-balance-field">
    <label htmlFor={id}>{label}</label>
    {children}
  </div>
);

const Figures: React.FC<{ side: LedgerSide; fields: OpeningBalanceFields; change: Change; statements: readonly ArchiveStatement[] }> = ({ side, fields, change, statements }) => {
  const directions: Record<OpeningBalanceDirection, string> = text.direction[side];
  return (
    <>
      <fieldset className="opening-balance-directions">
        <legend>{text.directionLabel}</legend>
        {(Object.keys(directions) as OpeningBalanceDirection[]).map((direction) => (
          <label key={direction} className="opening-balance-direction">
            <input type="radio" name="opening-direction" value={direction} checked={fields.direction === direction} onChange={() => change("direction", direction)} />
            {directions[direction]}
          </label>
        ))}
      </fieldset>
      <Field id="opening-amount" label={text.amountLabel}>
        <input id="opening-amount" inputMode="decimal" value={fields.amountText} placeholder={text.amountPlaceholder} onChange={(event) => change("amountText", event.target.value)} />
      </Field>
      <Field id="opening-date" label={text.dateLabel}>
        <input id="opening-date" type="date" value={fields.effectiveDate} onChange={(event) => change("effectiveDate", event.target.value)} />
      </Field>
      <Field id="opening-source" label={text.sourceLabel}>
        <input id="opening-source" value={fields.sourceReference} placeholder={text.sourcePlaceholder} onChange={(event) => change("sourceReference", event.target.value)} />
      </Field>
      {statements.length > 0 && (
        <Field id="opening-statement" label={text.statementLabel}>
          <select id="opening-statement" value={fields.archiveStatementId} onChange={(event) => change("archiveStatementId", event.target.value)}>
            <option value="">{text.noStatement}</option>
            {statements.map((statement) => <option key={statement.id} value={statement.id}>{text.statementOption(statement.sourceFileName, formatDate(statement.periodTo, statement.periodTo))}</option>)}
          </select>
        </Field>
      )}
      <Field id="opening-note" label={text.noteLabel}>
        <input id="opening-note" value={fields.note} onChange={(event) => change("note", event.target.value)} />
      </Field>
    </>
  );
};

/** The figure a correction or reversal acts on, as it stands. */
const Posted: React.FC<{ side: LedgerSide; view: OpeningBalanceView | null }> = ({ side, view }) => {
  if (!view?.current) return null;
  const short: Record<OpeningBalanceDirection, string> = text.short[side];
  return (
    <p className="opening-balance-posted">
      <strong>{text.current}:</strong> Rs. {archiveAmount(view.current.amountPaisa)} {short[view.current.direction]} · {text.from(formatDate(view.current.effectiveDate, view.current.effectiveDate))} · {view.current.sourceReference}
    </p>
  );
};

export const OpeningBalanceDialog: React.FC<Props> = ({ side, mode, partyId, partyName, view, statements, onDone, onClose, prefill = false }) => {
  const form = useOpeningBalanceForm({ side, mode, partyId, view, onDone });
  const latest = [...statements].sort((a, b) => a.periodTo.localeCompare(b.periodTo)).at(-1);
  const { fillFromStatement } = form;
  const prefillFrom = prefill && mode === "post" ? latest : undefined;
  // Once only: a statement read again while the dialog is open never overwrites what was typed since.
  const prefilled = useRef(false);
  useEffect(() => {
    if (!prefillFrom || prefilled.current) return;
    prefilled.current = true;
    fillFromStatement(prefillFrom);
  }, [prefillFrom, fillFromStatement]);
  const footer = (
    <>
      <button type="button" className="customer-ledger-print" onClick={onClose}>{text.cancel}</button>
      <button type="button" className="customer-ledger-action" disabled={form.saving} onClick={() => void form.submit()}>{form.saving ? text.saving : SAVE[mode]}</button>
    </>
  );
  return (
    <Modal title={TITLE[mode]} subtitle={`${partyName} · ${INTRO[mode]}`} onClose={onClose} footer={footer}>
      <div className="opening-balance-form">
        <Posted side={side} view={mode === "post" ? null : view} />
        {mode !== "reverse" && latest && (
          <button type="button" className="customer-ledger-print" onClick={() => form.fillFromStatement(latest)}>{text.useArchive}</button>
        )}
        {mode !== "reverse" && <Figures side={side} fields={form.fields} change={form.change} statements={statements} />}
        {mode !== "post" && (
          <Field id="opening-reason" label={text.reasonLabel}>
            <input id="opening-reason" value={form.fields.reason} placeholder={text.reasonPlaceholder} onChange={(event) => form.change("reason", event.target.value)} />
          </Field>
        )}
        {form.problems.length > 0 && (
          <ul className="ledger-import-error" role="alert">{form.problems.map((problem) => <li key={problem}>⚠ {problem}</li>)}</ul>
        )}
        {form.refusal && <p className="ledger-import-error" role="alert">✕ {form.refusal}</p>}
      </div>
    </Modal>
  );
};
