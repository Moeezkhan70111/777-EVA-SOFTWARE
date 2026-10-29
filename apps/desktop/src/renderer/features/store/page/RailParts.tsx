import React, { useId } from "react";
import { copy } from "../../../config/copy";
import { PartyTypeBadge } from "../../parties/PartyTypeBadge";
import type { ScanBox } from "../../scanStation/useScanBox";

// The scan rail's pieces (0.3.9) that are not the scan itself.

/**
 * WHO. A plain strip: FROM the supplier (Receiving) or GOING TO the party (Issuing), and its type
 * as a soft pill; "Not chosen yet" before there is one.
 */
export const WhoStrip: React.FC<{ mode: "in" | "out"; label: string; name: string | null; partyType: string | undefined }> = ({
  mode,
  label,
  name,
  partyType,
}) => (
  <header className={`sp-who sp-who--${mode}`} data-testid="who-strip">
    <span className="sp-marker">{label}</span>
    <span className="sp-who-name">{name ?? copy.storeScan.notChosen}</span>
    {name ? <PartyTypeBadge partyType={partyType} /> : null}
  </header>
);

/**
 * THE SCANNER'S BOX — always visible, under the strip. A hardware scanner types into it, and so does
 * the operator when a label will not scan: the same box. It shows the code as it arrives and clears
 * when the scan completes; its focus ring says at a glance that the station is live. Off, with what
 * to do first, until the station can take a scan. It takes the focus back by itself (useScanBox).
 */
export const RailScanInput: React.FC<{ scanBox: ScanBox; canScan: boolean; notReady: string }> = ({ scanBox, canScan, notReady }) => {
  const id = useId();
  return (
    <div className="sp-scan-field">
      <label className="sr-only" htmlFor={id}>
        {copy.storeScan.scannerInput}
      </label>
      <input
        id={id}
        ref={scanBox.inputRef}
        className="sp-scan-input"
        value={scanBox.inputVal}
        onChange={(event) => scanBox.setInputVal(event.target.value)}
        onKeyDown={scanBox.onKeyDown}
        placeholder={canScan ? copy.storeScan.scanPlaceholder : notReady}
        disabled={!canScan}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
    </div>
  );
};

interface EndStepProps {
  code: string;
  packets: string;
  quantity: string;
  onPrint: () => void;
  onEnd: () => void;
  onKeep: () => void;
  canPrint: boolean;
}

/** Ending a batch is one deliberate step, and printing the slip belongs to it, not the live rail. */
export const EndStep: React.FC<EndStepProps> = ({ code, packets, quantity, onPrint, onEnd, onKeep, canPrint }) => (
  <section className="sp-end" aria-label={copy.storeScan.endTitle(code)}>
    <h3 className="sp-end-title">{copy.storeScan.endTitle(code)}</h3>
    <p className="sp-end-line">{copy.storeScan.endLine(packets, quantity)}</p>
    <div className="sp-rail-actions">
      <button type="button" className="btn btn-secondary" onClick={onPrint} disabled={!canPrint}>
        {copy.storeStation.printSlip}
      </button>
      <button type="button" className="btn btn-primary" onClick={onEnd}>
        {copy.storeStation.endBatch}
      </button>
    </div>
    <button type="button" className="sp-text-btn" onClick={onKeep}>
      {copy.storeScan.keepScanning}
    </button>
  </section>
);

/** The quiet footer of a running batch: its number, and End batch. */
export const BatchFooter: React.FC<{ code: string; onEnd: () => void }> = ({ code, onEnd }) => (
  <footer className="sp-foot">
    <span className="sp-foot-line" data-testid="session-line">
      {code}
    </span>
    <button type="button" className="btn btn-secondary" onClick={onEnd}>
      {copy.storeStation.endBatch}
    </button>
  </footer>
);
