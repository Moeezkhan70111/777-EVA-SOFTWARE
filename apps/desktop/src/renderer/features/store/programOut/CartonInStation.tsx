import React from "react";
import { copy } from "../../../config/copy";
import { StateView } from "../../../components/shared/StateView";
import { ScanPanel } from "../../scanStation/scanStation";
import { useCartonIn } from "./useCartonIn";
import { useScanBox } from "./useScanBox";

// CARTON IN — Store In's scan station while a machine program is open.
//
//   ┌ ▣ Carton In · MP-000012 ───────────────────────────────┐
//   │ Scan each carton label printed for this program …      │
//   │ ┌ READY FOR CARTONS ─────────────────────────────────┐ │
//   │ │ [ scan box ]                                       │ │
//   └────────────────────────────────────────────────────────┘
//
// It takes the place of Scan Material on the RIGHT of Store In — the page's one scan station —
// rather than a second scanner beside the program. The Scan Material station stays mounted behind
// it (StoreInPage), so an open receiving session is never lost; closing the program brings it back.
//
// The box is armed as soon as there is a printed label to come back, because this panel exists to
// scan. One scan is one carton: the main process checks it was printed for THIS program, produces
// it and stores it in, or refuses and writes nothing (useCartonIn).

const CartonIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9zm9 2.2 6.4-3.2L12 3.3 5.6 6.5 12 9.7zm-1 1.8L4.6 8.3v7.2L11 18.7v-7.2zm2 7.2 6.4-3.2V8.3L13 11.5v7.2z" />
  </svg>
);

interface CartonInStationProps {
  token: string;
  programId: string;
  programCode: string;
  /** How many carton runs have been printed for the program. */
  printedRuns: number;
  /** Closed (complete or reconciled): its figures are final, so nothing more is stored in. */
  closed: boolean;
  /** Re-reads the program, so the "back in store" counts are the database's. */
  onReceived: () => Promise<void>;
}

export const CartonInStation: React.FC<CartonInStationProps> = ({ token, programId, programCode, printedRuns, closed, onReceived }) => {
  const cartonIn = useCartonIn({ token, programId, onReceived });
  const canScan = printedRuns > 0 && !closed;
  const box = useScanBox({ armed: canScan, onScan: cartonIn.scan, refocusKey: cartonIn.feedback.seq });
  const text = copy.programOut;

  return (
    <div className="si-carton-in">
      <header className="si-scan-head">
        <span className="si-scan-mark" aria-hidden="true">
          <CartonIcon />
        </span>
        <div>
          <h2 className="si-scan-title">{text.cartonInStationTitle(programCode)}</h2>
          <p className="si-scan-line">{text.cartonInLine}</p>
        </div>
      </header>

      {closed ? <StateView kind="empty" compact title={text.cartonInClosedTitle} hint={text.cartonInClosedHint} /> : null}
      {!closed && printedRuns === 0 ? (
        <StateView kind="empty" compact title={text.cartonInNoneTitle} hint={text.cartonInNoneHint} />
      ) : null}

      {canScan ? (
        <div
          className="ssn ssn--embedded"
          onClick={(event) => {
            // Clicking empty space is never an action; it hands focus back to the scanner.
            const target = event.target as HTMLElement | null;
            if (target && !target.closest("button, a, input, select, textarea, [role='dialog']")) box.focusScanner();
          }}
        >
          <ScanPanel
            feedback={cartonIn.feedback}
            inputRef={box.inputRef}
            inputVal={box.inputVal}
            onInputChange={box.setInputVal}
            onKeyDown={box.onKeyDown}
            onFocusScanner={box.focusScanner}
            disabled={!canScan}
            disabledHint={text.cartonInDisabled}
          />
          {cartonIn.busy ? (
            <p className="mpo-busy" role="status">
              {text.cartonInBusy}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
