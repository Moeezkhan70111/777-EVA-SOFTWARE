import React from "react";
import { copy } from "../../config/copy";

// One renderer for a category attribute, used both to CREATE a material and to FILTER the
// list by it. The two screens this replaced wrote the same switch twice (renderCreateField /
// renderFilterControl) and had already drifted apart — one uppercased typed text, the other
// did not.
//
// `mode` is the only difference that survives: creating offers "Select…" and can add a new
// dropdown option, filtering offers "All" and cannot.

interface AttributeFieldProps {
  field: Record<string, unknown>;
  value: string;
  mode: "create" | "filter";
  onChange: (fieldKey: string, value: string) => void;
  /** Create mode only: opens the "add a new option" prompt for a dropdown attribute. */
  onAddOption?: (field: Record<string, unknown>) => void;
}

export const AttributeField: React.FC<AttributeFieldProps> = ({ field, value, mode, onChange, onAddOption }) => {
  const fieldKey = String(field.field_key);
  const fieldType = String(field.field_type);
  const required = mode === "create" && Boolean(field.is_required);
  const controlId = `attr-${mode}-${String(field.id)}`;
  const options = Array.isArray(field.options) ? (field.options as Array<Record<string, unknown>>) : [];

  const label = (
    <label className="input-label" htmlFor={controlId}>
      {String(field.label)}
      {required ? <span className="required-mark"> *</span> : null}
    </label>
  );

  if (fieldType === "DROPDOWN") {
    const select = (
      <select
        id={controlId}
        className="form-input"
        value={value}
        onChange={(event) => onChange(fieldKey, event.target.value)}
      >
        <option value="">{mode === "create" ? "Select…" : copy.filters.all}</option>
        {options.map((option) => (
          <option key={String(option.option_value)} value={String(option.option_value)}>
            {String(option.display_label ?? option.option_value)}
          </option>
        ))}
      </select>
    );

    return (
      <div className="form-group" key={String(field.id)}>
        {label}
        {mode === "create" && onAddOption ? (
          <div className="input-with-button">
            {select}
            <button
              type="button"
              className="btn btn-icon"
              title={`Add a new ${String(field.label)}`}
              aria-label={`Add a new ${String(field.label)}`}
              onClick={() => onAddOption(field)}
            >
              +
            </button>
          </div>
        ) : (
          select
        )}
      </div>
    );
  }

  return (
    <div className="form-group" key={String(field.id)}>
      {label}
      <input
        id={controlId}
        className="form-input"
        type={fieldType === "NUMBER" && mode === "create" ? "number" : "text"}
        value={value}
        placeholder={mode === "filter" ? copy.filters.all : undefined}
        onChange={(event) =>
          onChange(fieldKey, fieldType === "NUMBER" && mode === "create" ? event.target.value : event.target.value.toUpperCase())
        }
      />
    </div>
  );
};
