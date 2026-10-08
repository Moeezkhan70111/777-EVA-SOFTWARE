import React from "react";
import { compoundToBase, type UnitLadderStep as LadderMaths, ladderUnits } from "@erp/domain";
import type { ItemUnitLadder } from "../../types/desktopApi";

// Typing a count the way the store says it: "2 ROLL and 37 INCH", one box per rung.
//
// The operator never does the multiplication. Each box is one unit on the material's ladder,
// and what comes out is a single figure in the unit the stock is actually held in — the
// arithmetic is @erp/domain's, the same arithmetic that shows a balance back in these words.
//
// A material with no ladder gets one box in its own unit, which is what the screen always
// had. So this is the same control either way.

export interface CompoundQuantityInputProps {
  ladder: ItemUnitLadder | null;
  /** The typed figure per unit, e.g. { ROLL: "2", INCH: "37" }. Blank entries count as zero. */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  /** Labels the group for a screen reader, e.g. "Correct the count by". */
  label: string;
  disabled?: boolean;
  /** Shown in the smallest box, e.g. "e.g. -3". */
  placeholder?: string;
  idPrefix: string;
  /** The unit to use when the material has no ladder yet — its own stock unit. */
  fallbackUnit?: string;
}

/**
 * The units to offer boxes for: the ladder's, else the one the stock is held in.
 *
 * There is ALWAYS at least one box. A material with no ladder — and a ladder that has not
 * loaded yet — still has to be countable, so it falls back to the unit the caller knows.
 */
export const quantityUnits = (ladder: ItemUnitLadder | null, fallbackUnit?: string): string[] => {
  const steps = ladderSteps(ladder);
  if (steps.length > 0) return ladderUnits(steps);
  const single = ladder?.stockUnit ?? fallbackUnit ?? "";
  return single ? [single] : [];
};

/** The ladder in the shape the domain arithmetic takes. */
export const ladderSteps = (ladder: ItemUnitLadder | null): LadderMaths[] =>
  (ladder?.steps ?? []).map((step) => ({ fromUnit: step.fromUnit, toUnit: step.toUnit, factor: step.factor }));

/**
 * What was typed, as one figure in the unit the stock is held in. With no ladder the single
 * box IS that unit, so its number passes straight through.
 */
export const compoundTotal = (
  ladder: ItemUnitLadder | null,
  value: Record<string, string>,
  fallbackUnit?: string,
): number => {
  const steps = ladderSteps(ladder);
  const parts = quantityUnits(ladder, fallbackUnit).map((unit) => ({ unit, quantity: Number(value[unit] ?? "") }));
  if (steps.length === 0) {
    const only = parts[0];
    return only && Number.isFinite(only.quantity) ? only.quantity : NaN;
  }
  const typed = parts.filter((part) => String(value[part.unit] ?? "").trim() !== "");
  if (typed.length === 0) return NaN;
  if (typed.some((part) => !Number.isFinite(part.quantity))) return NaN;
  return compoundToBase(steps, typed);
};

export const CompoundQuantityInput: React.FC<CompoundQuantityInputProps> = ({
  ladder,
  value,
  onChange,
  label,
  disabled,
  placeholder,
  idPrefix,
  fallbackUnit,
}) => {
  const units = quantityUnits(ladder, fallbackUnit);
  if (units.length === 0) return null;

  // With one unit there is nothing compound about it, so the box simply carries the name of
  // the thing being asked for and wears its unit as a suffix — what the screen always had.
  if (units.length === 1) {
    const unit = units[0]!;
    return (
      <div className="rm-compound">
        <span className="rm-compound-cell">
          <input
            id={`${idPrefix}-${unit}`}
            type="number"
            step="any"
            className="form-input rm-compound-input"
            aria-label={label}
            disabled={disabled}
            value={value[unit] ?? ""}
            placeholder={placeholder}
            onChange={(event) => onChange({ ...value, [unit]: event.target.value })}
          />
          <span className="rm-compound-unit">{unit}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="rm-compound" role="group" aria-label={label}>
      {units.map((unit, index) => (
        <span className="rm-compound-cell" key={unit}>
          <input
            id={`${idPrefix}-${unit}`}
            type="number"
            step="any"
            className="form-input rm-compound-input"
            disabled={disabled}
            value={value[unit] ?? ""}
            placeholder={index === units.length - 1 ? placeholder : undefined}
            onChange={(event) => onChange({ ...value, [unit]: event.target.value })}
          />
          <label className="rm-compound-unit" htmlFor={`${idPrefix}-${unit}`}>
            {unit}
          </label>
        </span>
      ))}
    </div>
  );
};
