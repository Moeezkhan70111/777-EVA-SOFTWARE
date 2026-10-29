import React, { useState } from "react";
import { copy } from "../../../config/copy";
import { PartyTypeBadge } from "../../parties/PartyTypeBadge";
import { ScanDock } from "../../scanStation/scanStation";
import type { ScanBox } from "../../scanStation/useScanBox";

// The scan rail's pieces (0.3.9) that are not the scan itself.

/**
 * ZONE 1 — WHO. A thin strip in the mode's colour: FROM the supplier (Receiving) or GOING TO the
 * party (Issuing), and its type; "Not chosen yet" before there is one.
 */
export const WhoStrip: React.FC<{ mode: "in" | "out"; label: string; name: string | null; partyType: string | undefined }> = ({
  mode,
  label,
  name,
  partyType,
}) => (
  <header className={`sp-who sp-who--${mode}`} data-testid="who-strip">
    <span className="sp-who-label">{label}</span>
    <span className="sp-who-name">{name ?? copy.storeScan.notChosen}</span>
    {name ? <PartyTypeBadge partyType={partyType} /> : null}
  </header>
);

/**
 * The scanner's box. A hardware scanner types into it unseen; "Type a code" shows it for when the
 * scanner fails. Hidden only from the eye: it keeps its label and can always take the focus.
 */
export const ScanCapture: React.FC<{ scanBox: ScanBox; canScan: boolean; hint: string; typing: boolean }> = ({ scanBox, canScan, hint, typing }) => (
  <div className={typing ? "sp-capture" : "sp-capture sp-capture--unseen"}>
    <ScanDock
      inputRef={scanBox.inputRef}
      inputVal={scanBox.inputVal}
      onInputChange={scanBox.setInputVal}
      onKeyDown={scanBox.onKeyDown}
      onFocusScanner={scanBox.focusScanner}
      onSubmit={typing ? scanBox.submit : undefined}
      disabled={!canScan}
      disabledHint={hint}
    />
  </div>
);

/** "Type a code" ⇄ "Hide the box", for when the scanner fails. */
export const useTyping = (scanBox: ScanBox) => {
  const [typing, setTyping] = useState(false);
  const toggle = () => {
    setTyping((now) => !now);
    setTimeout(scanBox.focusScanner, 0);
  };
  return { typing, toggle };
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

/** Ending a session is one deliberate step, and printing the slip belongs to it, not the live rail. */
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

/** ZONE 3 — the quiet footer of a running session: its number and total, Type a code, End session. */
export const SessionFooter: React.FC<{ line: string; typing: boolean; onToggleTyping: () => void; onEnd: () => void }> = ({
  line,
  typing,
  onToggleTyping,
  onEnd,
}) => (
  <footer className="sp-foot">
    <span className="sp-foot-line" data-testid="session-line">
      {line}
    </span>
    <div className="sp-foot-actions">
      <button type="button" className="sp-text-btn" aria-pressed={typing} onClick={onToggleTyping}>
        {typing ? copy.storeScan.hideTyping : copy.storeScan.typeCode}
      </button>
      <button type="button" className="btn btn-secondary" onClick={onEnd}>
        {copy.storeStation.endBatch}
      </button>
    </div>
  </footer>
);
