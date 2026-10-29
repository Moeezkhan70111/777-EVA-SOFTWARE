import React from "react";
import { ScanDock, type ScanStationFeedback } from "../../scanStation/scanStation";
import type { ScanBox } from "../../scanStation/useScanBox";
import type { ScanState } from "../stations/scanState";

/** The answer box: green for done, amber for "try again", red for refused. The words say which too. */
const RESULT_CLASS: Record<ScanStationFeedback["tone"], string> = {
  idle: "",
  success: "sp-result--success",
  warn: "sp-result--warn",
  error: "sp-result--error",
};

// THE SCAN STATE BLOCK — the headline is the station's true state (Not scanning yet / Ready /
// Scanning), the box under it is the scanner's, and the last answer is said in words under that:
// a refused packet must be read, not missed.

interface RailScanBlockProps {
  state: ScanState;
  feedback: ScanStationFeedback;
  scanBox: ScanBox;
}

export const RailScanBlock: React.FC<RailScanBlockProps> = ({ state, feedback, scanBox }) => {
  const canScan = state.kind !== "idle";
  return (
    <section className={`sp-rail-section sp-state sp-state--${state.kind}`} aria-live="polite">
      <h3 className="sp-state-title" data-testid="scan-state">
        {state.title}
      </h3>
      <p className="sp-state-line">{state.line}</p>
      <ScanDock
        inputRef={scanBox.inputRef}
        inputVal={scanBox.inputVal}
        onInputChange={scanBox.setInputVal}
        onKeyDown={scanBox.onKeyDown}
        onFocusScanner={scanBox.focusScanner}
        disabled={!canScan}
        disabledHint={state.line}
      />
      {feedback.tone === "idle" ? null : (
        <p className={`sp-result ${RESULT_CLASS[feedback.tone]}`} data-testid="scan-status">
          <strong>{feedback.title}</strong>
          {feedback.message}
        </p>
      )}
    </section>
  );
};
