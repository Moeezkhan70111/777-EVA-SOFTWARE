import React, { useCallback } from "react";
import { formatQuantityInDozens } from "@erp/domain";
import { copy } from "../../config/copy";
import { SCAN_STATION_CSS, ScanPanel } from "../scanStation/scanStation";
import { useScanBox } from "../scanStation/useScanBox";
import { ReceiptsPanel } from "./ReceiptsPanel";
import { useProductionReceipts } from "./useProductionReceipts";
import { useReceiveProduction } from "./useReceiveProduction";

// RECEIVE PRODUCTION — the QR Generator's third tab (Phase 2):
//
//   Receive Production                                          RECEIVED TODAY  24 cartons · 12 DZN
//   Scan generated carton labels to record production received.
//   ┌ scan station ─────────────────────┐  ┌ Received production ─────────────────────────┐
//   │            RECEIVED               │  │ Carton QR   Article  Size  Colour  At  Status │
//   │  SK6 · 7/10 · BLACKGREY           │  │ …                                            │
//   │ [ Enter or scan carton QR ][Enter]│  │                                              │
//   └───────────────────────────────────┘  └──────────────────────────────────────────────┘
//
// The scanner is the main way in: a code arriving at scanner speed is sent on its own. A code typed
// by hand waits for Enter or the button, and is put back if refused. Both go to the same main-
// process operation (useReceiveProduction), one at a time. Nothing is recorded by opening, leaving
// or switching to this tab — only by a scan or an Enter.

const text = copy.receiveProduction;

interface ReceiveProductionTabProps {
  /** Opens Reconciliation, to choose the program there; absent when this user cannot open it. */
  onStartReconciliation?: () => void;
}

export const ReceiveProductionTab: React.FC<ReceiveProductionTabProps> = ({ onStartReconciliation }) => {
  const receipts = useProductionReceipts(text.failed);
  // Stable between renders, so the scan box's timers are not re-armed by every list refresh.
  const reloadReceipts = receipts.reload;
  const onReceived = useCallback(() => void reloadReceipts(), [reloadReceipts]);
  const receiving = useReceiveProduction(onReceived);
  const box = useScanBox({ armed: true, onScan: receiving.scan, refocusKey: receiving.feedback.seq, autoSubmit: "scanner-burst" });
  const total = receipts.page?.totalCartons ?? null;

  return (
    <div className="rp-tab">
      <style>{SCAN_STATION_CSS}</style>
      <header className="rp-head">
        <div>
          <h2 className="rp-title">{text.title}</h2>
          <p className="rp-subtitle">{text.subtitle}</p>
        </div>
        {onStartReconciliation ? (
          <button type="button" className="btn btn-secondary rp-reconcile" onClick={onStartReconciliation}>
            {text.startReconciliation}
          </button>
        ) : null}
        <div className="rp-count" aria-live="polite">
          <span className="rp-count-label">{text.countLabel}</span>
          <strong>{total === null ? "—" : text.countCartons(total)}</strong>
          {total === null ? null : <span className="rp-count-dozens">{formatQuantityInDozens(total)}</span>}
        </div>
      </header>

      <div className="rp-body">
        <div
          className="ssn ssn--embedded rp-station"
          onClick={(event) => {
            // Clicking empty space is never an action; it hands focus back to the scanner.
            const target = event.target as HTMLElement | null;
            if (target && !target.closest("button, a, input, select, textarea, [role='dialog']")) box.focusScanner();
          }}
        >
          <ScanPanel
            feedback={receiving.feedback}
            inputRef={box.inputRef}
            inputVal={box.inputVal}
            onInputChange={box.setInputVal}
            onKeyDown={box.onKeyDown}
            onFocusScanner={box.focusScanner}
            disabled={false}
            onSubmit={box.submit}
            submitLabel={text.enter}
            placeholder={text.placeholder}
            dockHint={text.dockHint}
          />
          {receiving.busy ? <p className="rp-busy" role="status">{text.busy}</p> : null}
        </div>
        <ReceiptsPanel receipts={receipts} />
      </div>
    </div>
  );
};
