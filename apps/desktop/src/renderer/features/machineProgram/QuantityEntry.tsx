import React, { useState } from "react";
import { checkProgramQuantity, roundQuantity } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatAmount } from "./machineProgram";

// HOW MANY? — one big box, the unit beside it, and the two figures that matter under it:
//
//   HOW MANY?   [ 30 ] DOZEN
//   Available 50 DOZEN · Remaining 20 DOZEN
//
// The same rule the backend applies (@erp/domain checkProgramQuantity) runs as the operator
// types, so a wrong number is explained before Add is pressed — but it is only a courtesy: the
// save is checked again inside the write lock, against the store as it is at that moment.

interface QuantityEntryProps {
  /** What is being counted — "BLACK UPPER · ABC UPPER". */
  title: string;
  unitCode: string | null;
  /** The most this line may hold in total right now. */
  limit: number;
  /** Already scanned out for the line — it may never go below this. */
  consumed?: number;
  initial?: number | null;
  submitLabel: string;
  /** Saves, and answers with a refusal to show, or null when it was saved. */
  onSubmit: (quantity: number) => Promise<string | null>;
  onCancel: () => void;
}

export const QuantityEntry: React.FC<QuantityEntryProps> = ({ title, unitCode, limit, consumed = 0, initial, submitLabel, onSubmit, onCancel }) => {
  const [text, setText] = useState(initial != null ? String(initial) : "");
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const quantity = text.trim() === "" ? Number.NaN : Number(text);
  const problem = text.trim() === "" ? null : describe(checkProgramQuantity(quantity, { available: limit - consumed, consumed }), limit, consumed, unitCode);
  const remaining = Number.isFinite(quantity) && !problem ? roundQuantity(limit - quantity) : null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (problem || !Number.isFinite(quantity)) return;
    setSaving(true);
    setRefused(null);
    try {
      setRefused(await onSubmit(quantity));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="mp-panel mp-quantity" onSubmit={(event) => void submit(event)}>
      <p className="mp-quantity-what">{title}</p>
      <label className="mp-quantity-row">
        <span className="mp-question">{copy.machineProgram.howMany}</span>
        <input
          className="form-input mp-quantity-input"
          inputMode="decimal"
          autoFocus
          value={text}
          aria-describedby="mp-quantity-figures"
          aria-invalid={problem ? true : undefined}
          onChange={(event) => setText(event.target.value.replace(",", "."))}
        />
        <span className="mp-quantity-unit">{unitCode}</span>
      </label>

      <p id="mp-quantity-figures" className="mp-quantity-figures">
        <span>
          {copy.machineProgram.available} <b>{formatAmount(limit, unitCode)}</b>
        </span>
        {remaining != null ? (
          <span>
            {copy.machineProgram.remaining} <b>{formatAmount(remaining, unitCode)}</b>
          </span>
        ) : null}
      </p>
      {consumed > 0 ? <p className="mp-note">{copy.machineProgram.taken(formatAmount(consumed, unitCode))}</p> : null}

      {problem || refused ? (
        <p className="mp-problem" role="alert">
          ⚠ {problem ?? refused}
        </p>
      ) : null}

      <div className="mp-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {copy.common.cancel}
        </button>
        <button type="submit" className="btn btn-primary btn-lg" disabled={saving || problem !== null || !Number.isFinite(quantity)}>
          {saving ? copy.machineProgram.saving : submitLabel}
        </button>
      </div>
    </form>
  );
};

const describe = (problem: ReturnType<typeof checkProgramQuantity>, limit: number, consumed: number, unitCode: string | null): string | null => {
  if (problem === "INVALID_QUANTITY") return copy.machineProgram.quantityInvalid;
  if (problem === "BELOW_CONSUMED") return copy.machineProgram.quantityBelowTaken(formatAmount(consumed, unitCode));
  if (problem === "NOT_ENOUGH_STOCK") return copy.machineProgram.quantityTooMany(formatAmount(limit, unitCode));
  return null;
};
