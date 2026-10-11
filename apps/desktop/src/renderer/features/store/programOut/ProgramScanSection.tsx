import React, { useEffect, useState } from "react";
import { copy } from "../../../config/copy";
import { ScanPanel, type ScanStationFeedback } from "../../scanStation/scanStation";
import { useScanBox } from "./useScanBox";

// One scanner section on a machine program — Upper Out (Store Out) and Carton In (Store In):
//
//   ┌ [icon] Title ─────────────────────────────────────── [ Start Scan ] ┐
//   │ line                                                                │
//   │ (the notice when nothing can be scanned)                           │
//   │ ┌ scan panel ┐  (what is being committed right now)                 │
//
// START SCAN opens the scanner; it does not stage anything. One scan is still one movement,
// committed before the operator's hand is off the trigger. The button exists so the program can
// be read without a live scan box stealing focus — a stray scan while somebody is reading the page
// must not move stock. A section that can take nothing more closes its own scanner.

interface ProgramScanSectionProps {
  title: string;
  line: string;
  icon: React.ReactNode;
  /** "Start Scan" or "Resume Scan". */
  startLabel: string;
  /** False once nothing more can be scanned here; the button is disabled and the scanner closes. */
  canScan: boolean;
  /** Shown in place of the scanner when it cannot be used, saying why. */
  notice?: React.ReactNode;
  feedback: ScanStationFeedback;
  onScan: (code: string) => Promise<void>;
  /** True while a scan is being committed. */
  busy: boolean;
  busyLabel: string;
  disabledHint: string;
}

export const ProgramScanSection: React.FC<ProgramScanSectionProps> = (props) => {
  const { title, line, icon, startLabel, canScan, notice, feedback, onScan, busy, busyLabel, disabledHint } = props;
  const [scanning, setScanning] = useState(false);
  const armed = canScan && scanning;
  const box = useScanBox({ armed, onScan, refocusKey: feedback.seq });

  useEffect(() => {
    if (scanning && !canScan) setScanning(false);
  }, [canScan, scanning]);

  return (
    <section className="mpi-section" aria-label={title}>
      <header className="mpi-section-head">
        <span className="mpi-section-mark" aria-hidden="true">
          {icon}
        </span>
        <div>
          <h2 className="mpi-section-title">{title}</h2>
          <p className="mpi-section-line">{line}</p>
        </div>
        {!scanning ? (
          <button type="button" className="mpi-action" onClick={() => setScanning(true)} disabled={!canScan}>
            <span className="mpi-action-mark" aria-hidden="true">
              ||||
            </span>
            {startLabel}
          </button>
        ) : (
          <button type="button" className="mpi-action mpi-action--quiet" onClick={() => setScanning(false)}>
            {copy.programOut.stopScan}
          </button>
        )}
      </header>

      {!canScan ? notice : null}

      {scanning ? (
        <div
          className="mpi-scan"
          onClick={(event) => {
            // Clicking empty space is never an action; it hands focus back to the scanner.
            const target = event.target as HTMLElement | null;
            if (target && !target.closest("button, a, input, select, textarea, [role='dialog']")) box.focusScanner();
          }}
        >
          <div className="ssn ssn--embedded mpi-station">
            <ScanPanel
              feedback={feedback}
              inputRef={box.inputRef}
              inputVal={box.inputVal}
              onInputChange={box.setInputVal}
              onKeyDown={box.onKeyDown}
              onFocusScanner={box.focusScanner}
              disabled={!armed}
              disabledHint={disabledHint}
            />
          </div>
          <div className="mpi-scan-side">
            {/* The box stays armed while a scan commits so a scanner burst is never dropped;
                the movement in progress is said out loud instead. */}
            {busy ? (
              <p className="mpo-busy" role="status">
                {busyLabel}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
};
