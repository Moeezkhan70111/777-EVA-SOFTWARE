import React, { useEffect, useState } from "react";
import { copy } from "../../config/copy";

// The document pager, for the Gatepass number — the same control the voucher forms use.
//
//   ‹  [ GP- 42   of 57 ]  ›  Load        a stored document
//   ‹  [ GP- 58   new    ]  ›  Load        the one being written now
//
// The box always shows a number. On a stored document it is that document's number; while a
// new one is being written it is the number that document WILL get (latest + 1), which is
// what the desk writes on the paper before anything is saved. Overtype it and press Enter
// (or Load) to open any other number; ‹ › step through them one at a time.
//
// The word beside the number says which of the two it is: "of 57" for a stored document (so
// the arrows explain themselves — you can see where you are in the run) and "new" for the
// unsaved one, so a number that does not exist yet is never mistaken for one that does.

interface GatepassNavigatorProps {
  /** Number of the document on screen; null while writing a new one. */
  current: number | null;
  /** Highest number that exists (0 when none); null until known. */
  latest: number | null;
  busy: boolean;
  onGo: (gatepassNumber: number) => void;
  /** › past the latest document: back to the new one. */
  onNew: () => void;
}

export const GatepassNavigator: React.FC<GatepassNavigatorProps> = ({
  current,
  latest,
  busy,
  onGo,
  onNew,
}) => {
  // Numbers are assigned in order and never reused, so the next one is simply latest + 1.
  const nextNumber = latest === null ? null : latest + 1;
  /** What the box shows: the stored document's number, or the number the new one will get. */
  const shownNumber = current ?? nextNumber;
  const [text, setText] = useState(
    shownNumber === null ? "" : String(shownNumber),
  );

  // `latest` arrives from its own read, so this also fills the box the moment it lands.
  useEffect(() => {
    setText(shownNumber === null ? "" : String(shownNumber));
  }, [shownNumber]);

  const prevTarget = current === null ? latest : current - 1;
  const canPrev = !busy && prevTarget !== null && prevTarget >= 1;
  const canNext = !busy && current !== null;

  const load = () => {
    const number = Number(text.trim());
    if (!Number.isInteger(number) || number < 1) {
      setText(shownNumber === null ? "" : String(shownNumber));
      return;
    }
    // Already showing it: the stored document on screen, or the new one's own number —
    // Load on an untouched new form would otherwise report the number as "not found".
    if (number === current || (current === null && number === nextNumber))
      return;
    onGo(number);
  };

  const next = () => {
    if (current === null) return;
    if (latest !== null && current >= latest) onNew();
    else onGo(current + 1);
  };

  return (
    <div className="gp-nav" role="group" aria-label={copy.gatepass.navigator}>
      <button
        type="button"
        className="gp-nav-btn"
        aria-label={copy.gatepass.previousGatepass}
        title={copy.gatepass.previousGatepass}
        disabled={!canPrev}
        onClick={() => prevTarget !== null && onGo(prevTarget)}
        data-testid="gatepass-prev"
      >
        ◄ Previous
      </button>

      {/* Prefix, number and count are one segment, so "GP-42 of 57" reads as a single fact. */}
      <span className="gp-nav-field">
        <span className="gp-nav-prefix" aria-hidden="true">
          GP -{" "}
        </span>
        <input
          className="gp-nav-input"
          type="text"
          inputMode="numeric"
          aria-label={copy.gatepass.gatepassNumber}
          // An instruction, not a state: "GP- New" read as a number called "New". Which
          // document is on screen is already said by the page title and the step indicator.
          placeholder={copy.gatepass.numberPlaceholder}
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
          data-testid="gatepass-number-input"
        />
        <span className="gp-nav-total">
          {current !== null
            ? copy.gatepass.ofLatest(latest ?? current)
            : latest === null
              ? ""
              : copy.gatepass.unsavedNumber}
        </span>
      </span>
      <button
        type="button"
        className="btn btn-secondary gp-nav-load"
        disabled={busy}
        onClick={load}
        data-testid="gatepass-load"
      >
        {copy.gatepass.load}
      </button>
      <button
        type="button"
        className="gp-nav-btn"
        aria-label={copy.gatepass.nextGatepass}
        title={copy.gatepass.nextGatepass}
        disabled={!canNext}
        onClick={next}
        data-testid="gatepass-next"
      >
        Next ►
      </button>
    </div>
  );
};
