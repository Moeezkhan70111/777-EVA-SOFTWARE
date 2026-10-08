import React, { useState } from "react";
import { copy } from "../../config/copy";

// No bill on screen: bills are made from gatepasses, so this is where the next one starts —
// the desk types the gatepass number (from the notice or the paper) and the bill fills in.

interface GatepassBillPickerProps {
  busy: boolean;
  onPick: (gatepassNumber: number) => void;
}

export const GatepassBillPicker: React.FC<GatepassBillPickerProps> = ({ busy, onPick }) => {
  const [text, setText] = useState("");
  const number = Number(text.trim());
  const valid = text.trim() !== "" && Number.isInteger(number) && number >= 1;

  const pick = () => {
    if (!valid) return;
    onPick(number);
  };

  return (
    <div className="bill-empty" role="status" data-testid="bill-empty">
      <span className="state-view-title">{copy.billing.emptyTitle}</span>
      <span className="state-view-hint">{copy.billing.emptyHint}</span>
      <div className="gp-nav bill-empty-picker">
        {/* Prefix and number share one bordered box, as they do on the Gatepass pager. */}
        <span className="gp-nav-field">
          <span className="gp-nav-prefix" aria-hidden="true">GP-</span>
          <input
            className="gp-nav-input"
            type="text"
            inputMode="numeric"
            aria-label={copy.billing.gatepassNumber}
            value={text}
            disabled={busy}
            autoFocus
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                pick();
              }
            }}
            data-testid="bill-gatepass-number"
          />
        </span>
        <button type="button" className="btn btn-primary gp-nav-load" disabled={busy || !valid} onClick={pick} data-testid="bill-gatepass-pick">
          {copy.billing.billGatepass}
        </button>
      </div>
    </div>
  );
};
