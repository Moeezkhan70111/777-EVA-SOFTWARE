import React, { useState } from "react";
import { copy } from "../../config/copy";
import type { WriteAnswer } from "./useProgramWrites";

// QTY TO RUN — the one figure on the program that is typed rather than chosen:
//
//   [  10  ]
//   ⚠ Only 25 DOZEN can be put on this program.
//
// The box itself, with no opinion about what a quantity means. An upper line is measured against
// what the store has free; a FIX run is measured against nothing at all, because it reserves
// nothing. Those two rules live with their rows (QuantityCell, FixQuantityCell) and arrive here
// as `problemOf` and `onSave`, so the floor types every quantity on the program the same way.
//
// It is saved when the operator leaves the box or presses Enter, never on every keystroke: a
// quantity half-typed is not a quantity, and each save is one transaction against the program as
// it is at that moment. Escape puts the saved figure back.
//
// Whatever `problemOf` says is a courtesy shown while the operator types. The save is checked
// again inside the write lock, and its refusal is what is shown here.

interface QuantityBoxProps {
  /** The saved figure the box opens on, and follows when it changes underneath. */
  saved: string;
  ariaLabel: string;
  /** Why what has been typed cannot be saved, or null. Never called with an empty box. */
  problemOf: (text: string) => string | null;
  onSave: (quantity: number) => Promise<WriteAnswer>;
  /** Beside the box: what has already been taken against this row, and such. */
  note?: React.ReactNode;
}

export const QuantityBox: React.FC<QuantityBoxProps> = ({ saved, ariaLabel, problemOf, onSave, note }) => {
  const [text, setText] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  // The program is re-read after every save, so the saved figure is the authority: when it
  // changes under the box (another terminal, a scan), the box follows it.
  const [lastSaved, setLastSaved] = useState(saved);
  if (saved !== lastSaved) {
    setLastSaved(saved);
    setText(saved);
    setRefused(null);
  }

  const problem = text.trim() === "" ? null : problemOf(text);

  const commit = async () => {
    if (text === saved || saving) return;
    if (text.trim() === "" || problem) return; // The box keeps the refusal on screen until it is fixed.
    setSaving(true);
    setRefused(null);
    const answer = await onSave(Number(text));
    setSaving(false);
    if (!answer.ok) {
      setRefused(answer.reason);
      setText(saved);
    }
  };

  const revert = () => {
    setText(saved);
    setRefused(null);
  };

  return (
    <span className="mpx-qty-cell">
      <input
        className={`mpx-qty-input${problem || refused ? " is-wrong" : ""}`}
        inputMode="decimal"
        value={text}
        disabled={saving}
        aria-label={ariaLabel}
        aria-invalid={problem || refused ? true : undefined}
        onChange={(event) => {
          setText(event.target.value.replace(",", "."));
          setRefused(null);
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") revert();
        }}
      />
      {saving ? <span className="mpx-qty-note">{copy.machineProgram.saving}</span> : null}
      {note}
      {problem || refused ? (
        <span className="mpx-qty-problem" role="alert">
          ⚠ {problem ?? refused}
        </span>
      ) : null}
    </span>
  );
};
