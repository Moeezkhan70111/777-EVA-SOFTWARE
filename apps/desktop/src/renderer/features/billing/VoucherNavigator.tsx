import React, { useState } from "react";
import { parseGatepassQr } from "@erp/domain";
import { NavArrowIcon } from "../../components/shared/NavArrowIcon";
import { copy } from "../../config/copy";

// ‹ [ No. # ] › — walks the saved bills by number; › past the last one shows the New bill state (where a gatepass
// number starts the next bill). The Gatepass pager's compact look (owner, 24 Nov 2026, Hick's law): icon arrows, and
// Go only once a number has been typed. Enter goes as always.

interface VoucherNavigatorProps {
  canPrev: boolean;
  canNext: boolean;
  busy: boolean;
  onPrev: () => void;
  onNext: () => void;
  onGo: (voucherNumber: string) => void;
  /** A bill's gatepass QR scanned into the number box opens that gatepass (owner, 26 Nov 2026). */
  onScanGatepass?: (gatepassId: string) => void;
}

export const VoucherNavigator: React.FC<VoucherNavigatorProps> = ({ canPrev, canNext, busy, onPrev, onNext, onGo, onScanGatepass }) => {
  const [text, setText] = useState("");

  const go = () => {
    const number = text.trim();
    if (!number) return;
    const scanned = onScanGatepass ? parseGatepassQr(number) : null;
    setText("");
    if (scanned) { onScanGatepass?.(scanned.gatepassId); return; }
    onGo(number);
  };

  return (
    <div className="gp-nav gp-nav--compact" role="group" aria-label={copy.billing.title}>
      <button type="button" className="gp-nav-btn" aria-label={copy.billing.previous} title={copy.billing.previous} disabled={busy || !canPrev} onClick={onPrev} data-testid="voucher-prev">
        <NavArrowIcon direction="left" />
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
      {text.trim() ? (
        <button type="button" className="btn btn-secondary gp-nav-load" disabled={busy} onClick={go} data-testid="voucher-go">
          {copy.billing.go}
        </button>
      ) : null}
      <button type="button" className="gp-nav-btn" aria-label={copy.billing.next} title={copy.billing.next} disabled={busy || !canNext} onClick={onNext} data-testid="voucher-next">
        <NavArrowIcon direction="right" />
      </button>
    </div>
  );
};
