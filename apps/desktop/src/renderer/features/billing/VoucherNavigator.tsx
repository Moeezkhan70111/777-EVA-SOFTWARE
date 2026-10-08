import React, { useState } from "react";
import { copy } from "../../config/copy";

// ‹ Prev · [ Go to # ] Go · Next › — walks the saved bills by number; › past the last one
// shows the New bill state (where a gatepass number starts the next bill).

interface VoucherNavigatorProps {
  canPrev: boolean;
  canNext: boolean;
  busy: boolean;
  onPrev: () => void;
  onNext: () => void;
  onGo: (voucherNumber: string) => void;
}

export const VoucherNavigator: React.FC<VoucherNavigatorProps> = ({ canPrev, canNext, busy, onPrev, onNext, onGo }) => {
  const [text, setText] = useState("");

  const go = () => {
    const number = text.trim();
    if (!number) return;
    onGo(number);
    setText("");
  };

  return (
    <div className="gp-nav" role="group" aria-label={copy.billing.title}>
      <button type="button" className="gp-nav-btn" aria-label={copy.billing.previous} title={copy.billing.previous} disabled={busy || !canPrev} onClick={onPrev} data-testid="voucher-prev">
        ◄ Previous
      </button>
      <span className="gp-nav-field">
        <span className="gp-nav-prefix" aria-hidden="true">No.</span>
        <input
          className="gp-nav-input"
          type="text"
          inputMode="numeric"
          aria-label={copy.billing.goToNumber}
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              go();
            }
          }}
          data-testid="voucher-number-input"
        />
      </span>
      <button type="button" className="gp-nav-btn" aria-label={copy.billing.next} title={copy.billing.next} disabled={busy || !canNext} onClick={onNext} data-testid="voucher-next">
        Next ►
      </button>
      <button type="button" className="btn btn-secondary gp-nav-load" disabled={busy || !text.trim()} onClick={go} data-testid="voucher-go">
        {copy.billing.go}
      </button>
    </div>
  );
};
