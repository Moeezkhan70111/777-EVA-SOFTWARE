import React, { useState } from "react";
import { checkProgramQuantity, roundQuantity } from "@erp/domain";
import type { MachineProgramRunRecord, MachineProgramUpperLineRecord } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { formatAmount } from "./machineProgram";
import type { ProgramWrites } from "./useProgramWrites";

// QTY TO RUN — the one figure on the program that is typed rather than chosen.
//
//   [  10  ]
//   ⚠ Only 25 DOZEN can be put on this program.
//
// It is saved when the operator leaves the box or presses Enter, never on every keystroke: a
// quantity half-typed is not a quantity, and each save is one transaction against the store as
// it is at that moment. Escape puts the saved figure back.
//
// The same rule the backend applies (@erp/domain checkProgramQuantity) runs as the operator
// types, so a wrong number is explained before it is sent — but it is only a courtesy. The save
// is checked again inside the write lock, and its refusal is what is shown here.

interface QuantityCellProps {
  machineId: string;
  programDate: string;
  run: MachineProgramRunRecord;
  line: MachineProgramUpperLineRecord;
  /** The most this line may hold right now: what is free in the store plus its own quantity. */
  limit: number;
  /** True while the store's figure is still being read — the limit is not known yet. */
  loadingLimit: boolean;
  writes: ProgramWrites;
}

export const QuantityCell: React.FC<QuantityCellProps> = ({ machineId, programDate, run, line, limit, loadingLimit, writes }) => {
  const saved = String(roundQuantity(line.quantity));
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

  const quantity = text.trim() === "" ? Number.NaN : Number(text);
  // checkProgramQuantity measures `quantity - consumed` against `available`, so `available` is
  // the ceiling with what has already been scanned out taken off it. `limit` is the whole
  // ceiling — the store's free stock with this line's own reservation added back — and that is
  // the figure the Available Stock column shows, so the two can never disagree.
  const problem = describe(
    text.trim() === "" || loadingLimit ? null : checkProgramQuantity(quantity, { available: limit - line.consumed, consumed: line.consumed }),
    limit,
    line.consumed,
    line.unitCode
  );

  const commit = async () => {
    if (text === saved || saving) return;
    if (text.trim() === "" || problem) return; // The box keeps the refusal on screen until it is fixed.
    setSaving(true);
    setRefused(null);
    const answer = await writes.saveLine({
      machineId,
      programDate,
      injectorNo: run.injectorNo,
      runId: run.id,
      lineId: line.id,
      itemId: line.itemId,
      quantity,
    });
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
        aria-label={`${copy.machineProgram.changeQuantity} ${line.upperColour} — ${run.article} ${run.size}`}
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
      {line.consumed > 0 ? <span className="mpx-qty-note">{copy.machineProgram.taken(formatAmount(line.consumed, line.unitCode))}</span> : null}
      {problem || refused ? (
        <span className="mpx-qty-problem" role="alert">
          ⚠ {problem ?? refused}
        </span>
      ) : null}
    </span>
  );
};

const describe = (
  problem: ReturnType<typeof checkProgramQuantity> | null,
  limit: number,
  consumed: number,
  unitCode: string | null
): string | null => {
  if (problem === "INVALID_QUANTITY") return copy.machineProgram.quantityInvalid;
  if (problem === "BELOW_CONSUMED") return copy.machineProgram.quantityBelowTaken(formatAmount(consumed, unitCode));
  if (problem === "NOT_ENOUGH_STOCK") return copy.machineProgram.quantityTooMany(formatAmount(limit, unitCode));
  return null;
};
