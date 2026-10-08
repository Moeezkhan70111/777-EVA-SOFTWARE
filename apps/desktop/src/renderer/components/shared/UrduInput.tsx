import React from "react";
import { urduFieldValue, urduWhileTyping } from "../../utils/urdu";

// A text field that writes Urdu without an Urdu keyboard: what is typed in roman letters
// turns into Urdu word by word — each word as the space after it is typed, and the last
// word when the desk leaves the field. Urdu typed or pasted straight in is left alone.
// Every Urdu field in the ERP uses this, so they all behave the same way.

interface UrduInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** Accessible name when the field has no visible <label htmlFor>. */
  ariaLabel?: string;
}

export const UrduInput: React.FC<UrduInputProps> = ({ id, value, onChange, onBlur, placeholder, disabled, ariaLabel }) => {
  /** Leaving the field finishes the word still in roman letters, so nothing is saved half-converted. */
  const finishTyping = () => {
    const finished = urduFieldValue(value);
    if (finished !== value) onChange(finished);
    onBlur?.();
  };

  return (
    <input
      id={id}
      type="text"
      className="form-input urdu-input"
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => onChange(urduWhileTyping(event.target.value))}
      onBlur={finishTyping}
      lang="ur"
      dir="rtl"
      inputMode="text"
      autoComplete="off"
    />
  );
};
