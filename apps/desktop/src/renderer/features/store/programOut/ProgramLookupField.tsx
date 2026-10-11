import React, { useEffect, useRef, useState } from "react";
import { copy } from "../../../config/copy";
import { sanitizeScanInput } from "../../../utils/qr";

// The lookup at the top of Store Out: one box that takes a scanned program QR or a typed number.
//
//   Machine program  [ Scan QR or enter Machine Program No. ]  [ Open ]
//
// Deliberately one box and not two. A hardware scanner types into whichever field has focus and
// sends Enter, so "scan it" and "type it" are the same gesture here — which is why there is no
// mouse step: the box takes focus on arrival, Enter submits, and Escape clears it.
//
// It resolves nothing itself. What was typed goes to the main process, which decides whether it
// names a program and whether that program may be issued against.

interface ProgramLookupFieldProps {
  onOpen: (lookup: string) => void;
  /** True while the main process is resolving, so a scanner burst cannot queue two lookups. */
  busy?: boolean;
  /** Set when the last lookup was refused; shown beside the box, cleared as soon as it is retyped. */
  error?: string | null;
  /** Takes focus on mount. Off while a program is already open — the scan box wants the focus then. */
  autoFocus?: boolean;
}

export const ProgramLookupField: React.FC<ProgramLookupFieldProps> = ({ onOpen, busy = false, error, autoFocus = true }) => {
  const [value, setValue] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // A new refusal is worth showing again even if the operator had dismissed the last one.
  useEffect(() => {
    setDismissed(false);
  }, [error]);

  const submit = () => {
    const cleaned = sanitizeScanInput(value);
    if (!cleaned || busy) return;
    onOpen(cleaned);
  };

  const shown = error && !dismissed ? error : null;

  return (
    <div className="mpo-lookup">
      <label className="mpo-lookup-label" htmlFor="mpo-lookup-input">
        {copy.programOut.lookupLabel}
      </label>
      <div className="mpo-lookup-row">
        <input
          id="mpo-lookup-input"
          ref={inputRef}
          className="mpo-lookup-input"
          value={value}
          placeholder={copy.programOut.lookupPlaceholder}
          aria-label={copy.programOut.lookupPlaceholder}
          aria-describedby="mpo-lookup-help"
          aria-invalid={shown ? true : undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => {
            setValue(event.target.value);
            setDismissed(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setValue("");
            }
          }}
        />
        <button type="button" className="mpo-lookup-btn" onClick={submit} disabled={busy || !value.trim()}>
          {busy ? copy.programOut.opening : copy.programOut.lookupAction}
        </button>
      </div>
      <p className="mpo-lookup-help" id="mpo-lookup-help">
        {copy.programOut.lookupHelp}
      </p>
      {shown ? (
        <p className="mpo-lookup-error" role="alert">
          ⚠ {shown}
        </p>
      ) : null}
    </div>
  );
};
