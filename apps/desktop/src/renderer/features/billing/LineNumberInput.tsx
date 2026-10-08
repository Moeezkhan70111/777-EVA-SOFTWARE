import React, { useEffect, useRef, useState } from "react";

// The cells of a bill line: a plain text box for a number (no browser spinners), and a
// read-only figure. The box keeps its own draft text so partial entry ("0.5", "12.") is
// not wiped by the 0 → "" collapse on every keystroke; it re-syncs only when the value
// changes from outside (load, reset, price type change).

interface LineNumberInputProps {
  value: number;
  onChange: (value: number) => void;
  /** Accessible name — e.g. "Dozens for SK6 7/10". */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}

export const LineNumberInput: React.FC<LineNumberInputProps> = ({ value, onChange, label, placeholder, disabled, onKeyDown, inputRef }) => {
  const [text, setText] = useState(value === 0 ? "" : String(value));
  const lastValue = useRef(value);

  useEffect(() => {
    if (value !== lastValue.current) {
      lastValue.current = value;
      setText(value === 0 ? "" : String(value));
    }
  }, [value]);

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      className="bill-num-input"
      aria-label={label}
      value={text}
      placeholder={placeholder ?? "0"}
      disabled={disabled}
      onChange={(event) => {
        const raw = event.target.value.replace(/[^0-9.]/g, "");
        setText(raw);
        const parsed = Number.parseFloat(raw);
        const next = Number.isFinite(parsed) ? parsed : 0;
        lastValue.current = next;
        onChange(next);
      }}
      onFocus={(event) => event.target.select()}
      onKeyDown={onKeyDown}
    />
  );
};

/** Whole numbers plain, fractions to two places. */
export const formatFigure = (value: number): string => (Number.isFinite(value) ? (value % 1 === 0 ? String(value) : value.toFixed(2)) : "0");

export const ComputedCell: React.FC<{ value: number; strong?: boolean; muted?: boolean }> = ({ value, strong, muted }) => (
  <span className={`bill-figure${strong ? " bill-figure--strong" : ""}${muted ? " bill-figure--muted" : ""}`}>{formatFigure(value)}</span>
);
