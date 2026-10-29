import React from "react";
import type { ScanOutcome } from "./scanOutcome";
import type { ScanState } from "./scanState";

// THE SCAN ZONE (0.3.9) — the one block an operator glances at after the beep. It answers one
// question, did it take and was it the right packet, in one of three states that fill the same block:
//
//   ACCEPTED  pale green: ✓ RECEIVED, the material (the largest text on the page), how much, the code
//   REFUSED   pale red with a red left border, role="alert": ✕ NOT RECEIVED, why in one sentence,
//             the code, what happened, what to do
//   WAITING   plain white: a barcode in a soft square, the question to answer (or what to scan),
//             one line saying what happens, then whatever helps answer it
//
// Never colour alone: the icon and the words say which state it is, so it reads in greyscale.

const TickIcon = () => (
  <svg className="sz-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="currentColor" />
    <path d="m7.5 12.5 3 3 6-6.5" stroke="var(--white)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CrossIcon = () => (
  <svg className="sz-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="currentColor" />
    <path d="m8.5 8.5 7 7m0-7-7 7" stroke="var(--white)" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);

/** A barcode, in the soft square the waiting state opens with. */
export const BarcodeWell = () => (
  <span className="sz-well" aria-hidden="true">
    <svg viewBox="0 0 32 32" fill="none">
      <path d="M6 9v14M10 9v14M13 9v14M17 9v14M20 9v14M23 9v14M26 9v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M8 9v14M15 9v14M24.5 9v14" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  </span>
);

interface ScanZoneProps {
  /** Receiving ("in") or Issuing ("out"): the quantity is drawn in that mode's colour. */
  mode: "in" | "out";
  outcome: ScanOutcome;
  /** What the station can do now: while it cannot take a scan it is always waiting. */
  state: ScanState;
  /** "Received" / "Issued", and "Not received" / "Not issued". */
  doneWord: string;
  notDoneWord: string;
  /** Under the question while waiting — the party picker and Start button on the rails. */
  children?: React.ReactNode;
}

export const ScanZone: React.FC<ScanZoneProps> = ({ mode, outcome, state, doneWord, notDoneWord, children }) => {
  if (state.kind === "idle" || outcome.kind === "waiting") {
    return (
      <section className={`sz sz--${mode} sz--waiting`} aria-live="polite" data-testid="scan-zone" data-state="waiting">
        <BarcodeWell />
        <p className="sz-question" data-testid="scan-state">
          {state.title}
        </p>
        <p className="sz-line">{state.line}</p>
        {children}
      </section>
    );
  }
  if (outcome.kind === "accepted") {
    return (
      <section className={`sz sz--${mode} sz--accepted`} aria-live="polite" data-testid="scan-zone" data-state="accepted">
        <p className="sz-kicker" data-testid="scan-state">
          <TickIcon />
          {doneWord}
        </p>
        <p className="sz-material">{outcome.material}</p>
        {outcome.quantity ? <p className="sz-quantity">{outcome.quantity}</p> : null}
        {outcome.code ? <p className="sz-code">{outcome.code}</p> : null}
        {outcome.note ? <p className="sz-note">{outcome.note}</p> : null}
      </section>
    );
  }
  return (
    <section className={`sz sz--${mode} sz--refused`} role="alert" data-testid="scan-zone" data-state="refused">
      <p className="sz-kicker" data-testid="scan-state">
        <CrossIcon />
        {notDoneWord}
      </p>
      <p className="sz-reason">{outcome.reason}</p>
      {outcome.code ? <p className="sz-code">{outcome.code}</p> : null}
      {outcome.happened ? <p className="sz-happened">{outcome.happened}</p> : null}
      <p className="sz-todo">{outcome.todo}</p>
    </section>
  );
};
