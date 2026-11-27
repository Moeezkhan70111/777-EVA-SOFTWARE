import React from "react";
import { copy } from "../../config/copy";

// One labelled input of the Salaries pop-ups (Add Employee, Increment), in the themed dialog's look (Modal themed):
// the label, a "*" said in words for a required field (R18), the input with its unit beside the figure ("Rs", "%":
// affordance, so the box says what it takes), suggestions already used (recognition over recall), and its problem
// under it, tied to it for a screen reader. One shape for both forms (R1).

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
  /** The unit written before the figure ("Rs") or after it ("%"). */
  prefix?: string;
  suffix?: string;
  /** Values already used, offered as the person types (a datalist). */
  suggestions?: readonly string[];
  /** A figure: right-aligned, tabular, and given more weight. */
  figure?: boolean;
}

export const SalaryField: React.FC<SalaryFieldProps> = (props) => {
  const { id, label, value, problem, onChange, required = false, type = "text", inputMode, placeholder, maxLength, autoFocus, prefix, suffix, suggestions, figure = false } = props;
  const listId = suggestions && suggestions.length > 0 ? `${id}-list` : undefined;
  const input = (
    <input id={id} className={figure ? "form-input sal-figure-input" : "form-input"} type={type} inputMode={inputMode} value={value} placeholder={placeholder}
      maxLength={maxLength} autoFocus={autoFocus} autoComplete="off" required={required} list={listId}
      aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${id}-problem` : undefined}
      onChange={(event) => onChange(event.target.value)} />
  );
  return (
    <div className="form-group sal-field">
      <label className="input-label" htmlFor={id}>
        {label}{required ? <span className="sal-required" aria-hidden="true"> *</span> : null}{required ? <span className="sr-only"> ({copy.salaries.required})</span> : null}
      </label>
      {prefix || suffix ? (
        <div className="sal-input-wrap">
          {prefix ? <span className="sal-unit" aria-hidden="true">{prefix}</span> : null}
          {input}
          {suffix ? <span className="sal-unit" aria-hidden="true">{suffix}</span> : null}
        </div>
      ) : input}
      {listId && suggestions ? <datalist id={listId}>{suggestions.map((option) => <option key={option} value={option} />)}</datalist> : null}
      {problem ? <p id={`${id}-problem`} className="sal-problem" role="alert">⚠ {problem}</p> : null}
    </div>
  );
};
