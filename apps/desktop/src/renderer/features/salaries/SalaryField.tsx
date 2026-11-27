import React from "react";
import { copy } from "../../config/copy";

// One labelled input of the Salaries forms (Add Employee, Increment): the label, a "*" said in words for a required
// field (R18), the input, and its problem under it, tied to it for a screen reader. One shape for both forms (R1).

export interface SalaryFieldProps {
  /** The input's id. Its problem line takes the id with "-problem" after it. */
  id: string;
  label: string;
  value: string;
  problem: string | undefined;
  onChange: (value: string) => void;
  required?: boolean;
  type?: "text" | "date" | "tel";
  inputMode?: "decimal" | "tel";
  placeholder?: string;
  maxLength?: number;
  autoFocus?: boolean;
}

export const SalaryField: React.FC<SalaryFieldProps> = ({ id, label, value, problem, onChange, required = false, type = "text", inputMode, placeholder, maxLength, autoFocus }) => (
  <div className="form-group">
    <label className="input-label" htmlFor={id}>
      {label}{required ? <span className="sal-required"> * <span className="sr-only">{copy.salaries.required}</span></span> : null}
    </label>
    <input id={id} className="form-input" type={type} inputMode={inputMode} value={value} placeholder={placeholder} maxLength={maxLength} autoFocus={autoFocus}
      autoComplete="off" required={required} aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${id}-problem` : undefined}
      onChange={(event) => onChange(event.target.value)} />
    {problem ? <p id={`${id}-problem`} className="sal-problem" role="alert">⚠ {problem}</p> : null}
  </div>
);
