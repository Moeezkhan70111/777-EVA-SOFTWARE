import React, { useEffect, useState } from "react";
import { parseGatepassQr } from "@erp/domain";
import { NavArrowIcon } from "./NavArrowIcon";

// The document pager: one control for every numbered document — Gatepass, Move In voucher.
//
//   ◄ Previous  [ GP- 42   of 57 ]  Load  Next ►        a stored document
//   ◄ Previous  [ GP- 58   new    ]  Load  Next ►        the one being written now
//
// The box always shows a number. On a stored document it is that document's number; while a new one is being
// written it is the number that document WILL get, when the caller knows it, so a number that does not exist yet is
// never mistaken for one that does ("new" beside it). Overtype it and press Enter (or Load) to open any other
// number; ◄ ► step through them one at a time.
//
// COMPACT (Gatepass, owner, 24 Nov 2026, Hick's law):   ‹  [ GP- 42   of 57 ]  ›
// The arrows are icons (their names stay for screen readers), and Load shows only once a different number has been
// typed, so the pager reads as one control and its toolbar keeps fewer choices. Enter opens the number as always.
//
// STEPPING. By default ◄ ► step by one (current - 1, current + 1), which is right for a series with no gaps. A
// series numbered from each computer's own block (100,000 on the second computer) has gaps, so its caller passes the
// stored neighbours, previousNumber and nextNumber, and the arrows go straight to them.

export interface DocumentNavigatorLabels {
  /** The group's name, for screen readers: "Go to Gatepass". */
  group: string;
  /** The number box's name: "Gatepass number". */
  number: string;
  previous: string;
  next: string;
  load: string;
  /** Inside the empty box. An instruction, not a value. */
  placeholder: string;
  /** Beside a stored number: "of 57". */
  ofLatest: (latest: number) => string;
  /** Beside the number a new document will get. */
  unsaved: string;
}

interface DocumentNavigatorProps {
  /** "GP -", "SIV -": printed before the number. */
  prefix: string;
  labels: DocumentNavigatorLabels;
  /** Number of the document on screen; null while writing a new one. */
  current: number | null;
  /** Highest number that exists (0 or null when none). */
  latest: number | null;
  /** The number a new document will get; defaults to latest + 1. Null when it cannot be known here. */
  newNumber?: number | null;
  /** The stored document before / after the current one, for a series with gaps. Leave out to step by one. */
  previousNumber?: number | null;
  nextNumber?: number | null;
  busy: boolean;
  onGo: (documentNumber: number) => void;
  /** ► past the latest document: back to the new one. */
  onNew: () => void;
  /** Prefix for the controls' test ids: "gatepass" gives gatepass-prev, gatepass-next, … */
  testIdPrefix: string;
  /** Icon arrows, and Load only once another number is typed (see COMPACT above). */
  compact?: boolean;
  /** A sale voucher's gatepass QR scanned into the box opens that gatepass (owner, 26 Nov 2026; gatepassQr.ts). */
  onScanGatepass?: (gatepassId: string) => void;
}

export const DocumentNavigator: React.FC<DocumentNavigatorProps> = (props) => {
  const { prefix, labels, current, latest, busy, onGo, onNew, testIdPrefix, compact = false } = props;
  const newNumber = props.newNumber !== undefined ? props.newNumber : latest === null ? null : latest + 1;
  /** What the box shows: the stored document's number, or the number the new one will get. */
  const shownNumber = current ?? newNumber;
  const [text, setText] = useState(shownNumber === null ? "" : String(shownNumber));

  // The numbers arrive from their own read, so this also fills the box the moment they land.
  useEffect(() => {
    setText(shownNumber === null ? "" : String(shownNumber));
  }, [shownNumber]);

  const prevTarget = previousTarget(current, latest, props.previousNumber);
  const canPrev = !busy && prevTarget !== null && prevTarget >= 1;
  const canNext = !busy && current !== null;

  const load = () => {
    const scanned = props.onScanGatepass ? parseGatepassQr(text) : null;
    if (scanned) {
      setText(shownNumber === null ? "" : String(shownNumber));
      props.onScanGatepass?.(scanned.gatepassId);
      return;
    }
    const number = Number(text.trim());
    if (!Number.isInteger(number) || number < 1) {
      setText(shownNumber === null ? "" : String(shownNumber));
      return;
    }
    // Already showing it: the stored document on screen, or the new one's own number.
    if (number === current || (current === null && number === newNumber)) return;
    onGo(number);
  };

  const next = () => {
    if (current === null) return;
    const target = props.nextNumber !== undefined ? props.nextNumber : latest !== null && current >= latest ? null : current + 1;
    if (target === null) onNew();
    else onGo(target);
  };

  const total = current !== null ? labels.ofLatest(latest ?? current) : newNumber === null ? "" : labels.unsaved;
  const typedAnother = text.trim() !== (shownNumber === null ? "" : String(shownNumber));
  const showLoad = !compact || typedAnother;

  return (
    <div className={`gp-nav${compact ? " gp-nav--compact" : ""}`} role="group" aria-label={labels.group}>
      <button
        type="button"
        className="gp-nav-btn"
        aria-label={labels.previous}
        title={labels.previous}
        disabled={!canPrev}
        onClick={() => prevTarget !== null && onGo(prevTarget)}
        data-testid={`${testIdPrefix}-prev`}
      >
        {compact ? <NavArrowIcon direction="left" /> : "◄ Previous"}
      </button>

      {/* Prefix, number and count are one segment, so "GP-42 of 57" reads as a single fact. */}
      <span className="gp-nav-field">
        <span className="gp-nav-prefix" aria-hidden="true">
          {prefix}{" "}
        </span>
        <input
          className="gp-nav-input"
          type="text"
          inputMode="numeric"
          aria-label={labels.number}
          placeholder={labels.placeholder}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              load();
            }
          }}
          data-testid={`${testIdPrefix}-number-input`}
        />
        <span className="gp-nav-total">{total}</span>
      </span>
      {showLoad ? (
        <button type="button" className="btn btn-secondary gp-nav-load" disabled={busy} onClick={load} data-testid={`${testIdPrefix}-load`}>
          {labels.load}
        </button>
      ) : null}
      <button
        type="button"
        className="gp-nav-btn"
        aria-label={labels.next}
        title={labels.next}
        disabled={!canNext}
        onClick={next}
        data-testid={`${testIdPrefix}-next`}
      >
        {compact ? <NavArrowIcon direction="right" /> : "Next ►"}
      </button>
    </div>
  );
};

/** Where ◄ goes: the stored neighbour when the caller knows it, else one back (or the latest, from a new one). */
const previousTarget = (current: number | null, latest: number | null, previousNumber: number | null | undefined): number | null => {
  if (previousNumber !== undefined) return previousNumber;
  return current === null ? latest : current - 1;
};
