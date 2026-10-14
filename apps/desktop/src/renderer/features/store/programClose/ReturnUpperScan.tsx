import React, { useRef, useState } from "react";
import { copy } from "../../../config/copy";
import type { UpperReturnResult } from "../../../types/desktopApi";
import type { ReturnUpper } from "./useUpperActions";

// RETURN UPPER — a sealed packet that came back unused, scanned once.
//
//   Return Upper   [ Scan or type the packet's QR ]  [ Return ]
//   ✓ 2 DOZEN of RAGZINE UPPER — SK6 — RED — 7/10 back in stock
//   ⚠ This packet has already been received.
//
// The box clears and keeps focus after every scan, so packet after packet goes in from the
// scanner. Whether a packet may come back, and what it adds, is the main process's to say.

const text = copy.programClose;
const SHOWN = 5;

interface Outcome {
  key: number;
  ok: boolean;
  message: string;
}

const messageOf = (result: UpperReturnResult): string =>
  result.accepted
    ? text.returned(String(result.packingQuantity ?? ""), result.packingUnitCode ?? "", result.itemDisplayName ?? result.qrId ?? "")
    : result.reason ?? copy.states.loadFailedBody;

export const ReturnUpperScan: React.FC<{ onReturn: ReturnUpper; disabled: boolean }> = ({ onReturn, disabled }) => {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const scan = typed.trim();
    if (!scan || busy) return;
    setBusy(true);
    const result = await onReturn(scan);
    setBusy(false);
    setTyped("");
    setOutcomes((previous) => [{ key: Date.now(), ok: result.accepted, message: messageOf(result) }, ...previous].slice(0, SHOWN));
    input.current?.focus();
  };

  return (
    <section className="mur-return" aria-label={text.returnTitle}>
      <div className="mur-return-head">
        <h4 className="mur-action-title">{text.returnTitle}</h4>
        <p className="mur-action-hint">{text.returnLine}</p>
      </div>
      <form className="mur-return-form" onSubmit={(event) => void submit(event)}>
        <input
          ref={input}
          className="form-input"
          type="text"
          value={typed}
          placeholder={text.returnInput}
          aria-label={text.returnInput}
          disabled={disabled || busy}
          onChange={(event) => setTyped(event.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={disabled || busy || !typed.trim()}>
          {busy ? text.returning : text.returnAction}
        </button>
      </form>
      {outcomes.length > 0 ? (
        <ul className="mur-return-log" aria-live="polite">
          {outcomes.map((outcome) => (
            <li key={outcome.key} className={outcome.ok ? "is-ok" : "is-refused"}>
              {outcome.ok ? "✓ " : "⚠ "}
              {outcome.message}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};
