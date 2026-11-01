import React, { useState } from "react";
import { copy } from "../../config/copy";

// One password input with its Show/Hide toggle. The sign-in screen had two copies of this markup;
// it is one component so the switch to cloud accounts reuses it rather than adding a third (R1).

export const PasswordField = ({
  id,
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete: "current-password" | "new-password";
  hint?: string;
}) => {
  const [visible, setVisible] = useState(false);
  return (
    <div className="input-group">
      <label className="input-label" htmlFor={id}>
        {label}
      </label>
      <div className="password-wrap">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((shown) => !shown)}
          aria-label={visible ? copy.auth.hideHiddenLabel : copy.auth.showHiddenLabel}
        >
          {visible ? copy.auth.hideHidden : copy.auth.showHidden}
        </button>
      </div>
      {hint ? (
        <p className="text-muted text-small" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
};
