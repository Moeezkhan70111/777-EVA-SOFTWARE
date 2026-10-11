import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copy } from "../../../config/copy";
import { isCompleteQr, sanitizeScanInput } from "../../../utils/qr";
import { isValidRawMaterialQrId } from "@erp/domain";
import { StateView } from "../../../components/shared/StateView";
import { SCAN_STATION_CSS, ScanPanel } from "../../scanStation/scanStation";
import { CartonRunList, IssuedPacketList } from "./ProgramOutCartons";
import { DanaIssuePanel } from "./DanaIssuePanel";
import { ProgramIssueBands, ProgramIssueTotals } from "./ProgramIssueBands";
import { ProgramIssueHeader } from "./ProgramIssueHeader";
import { canIssueMore, injectorsOnProgram, programBands, programStatusLabel } from "./programOut";
import type { ProgramOutState } from "./useProgramOut";

// MACHINE PROGRAM ISSUE — one program, read top to bottom.
//
//   ← Machine Program Issue                              ● Program Ready
//   📄 MP-000008  ⚙ MACHINE 1  📅 09 Oct  👤 ALAMGIR  📦 Daniyal  🕐 06–06
//   ┌ Dana Issue ──────────────────── ● BLACK·EVA [−0+] ─ [Issue Dana] ┐
//   ┌ Upper Out ───────────────────────────────────── [ Start Scan ] ──┐
//   ┌ Injector 1 │ Sole Color : BLACK ─────────────────────────────────┐
//   │  SK30 7/10  20/20 Completed   SK12 7/10  10/30 In Progress       │
//   ┌ 🏭 Total Injectors 1        📦 Total Dozen (Upper) 70 ───────────┐
//
// The order is the operator's own: what is this → put the Dana out → take the uppers out →
// how far through am I → what does the day come to. The two things that MOVE STOCK are the two
// with a button, and they sit above the figures they change.
//
// START SCAN opens the scanner; it does not stage anything. One scan is still one movement,
// committed before the operator's hand is off the trigger, so a packet can never be "scanned
// but not out". The button exists so the program can be read without a live scan box stealing
// focus — a wedge scanner types into whichever field has it, and a stray scan while somebody is
// reading the page must not move stock.
//
// Nothing here decides whether a packet may be issued, moves stock, or works out a carton count.

interface ProgramOutPanelProps {
  state: ProgramOutState;
  /** Closes the program and goes back to the ordinary Store Out page. */
  onClose: () => void;
  /** Leaves Store Out altogether, for the Store Station job chooser. */
  onChangeJob: () => void;
}

export const ProgramOutPanel: React.FC<ProgramOutPanelProps> = ({ state, onClose, onChangeJob }) => {
  const { program, issuing, feedback, issued, cartonRuns, printedRuns, printingKey, history } = state;
  const [scanning, setScanning] = useState(false);
  const [inputVal, setInputVal] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const queueRef = useRef<string[]>([]);
  const processingRef = useRef(false);

  const focusScanner = useCallback(() => inputRef.current?.focus(), []);
  const armed = Boolean(program && canIssueMore(program) && scanning);

  // The scanner types into whichever field has focus, so the scan box keeps it while armed.
  useEffect(() => {
    if (armed) focusScanner();
  }, [armed, feedback.seq, focusScanner]);

  // A program that can take nothing more closes its own scanner rather than staying armed for
  // scans it would only refuse.
  useEffect(() => {
    if (scanning && program && !canIssueMore(program)) setScanning(false);
  }, [program, scanning]);

  // Scans are serialised: a wedge scanner can fire the next code before the last movement has
  // committed, and two overlapping writes would each be judged against a store the other moved.
  const drainQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        await state.scan(queueRef.current.shift()!);
      }
    } finally {
      processingRef.current = false;
      focusScanner();
    }
  }, [focusScanner, state]);

  const submitScan = useCallback(
    (raw: string) => {
      const cleaned = sanitizeScanInput(raw);
      if (!cleaned || cleaned.length < 3) return;
      setInputVal("");
      queueRef.current.push(cleaned);
      void drainQueue();
    },
    [drainQueue]
  );

  // Hardware scanners type the whole code in one burst and many send no suffix key, so the box
  // submits as soon as the buffer looks like a complete label — the same rule as every station.
  useEffect(() => {
    if (!inputVal || !armed) return;
    const cleaned = sanitizeScanInput(inputVal);
    if (!cleaned) return;
    if (isValidRawMaterialQrId(cleaned) || isCompleteQr(cleaned)) {
      const timer = setTimeout(() => submitScan(cleaned), 40);
      return () => clearTimeout(timer);
    }
    if (cleaned.length >= 5) {
      const timer = setTimeout(() => submitScan(cleaned), 120);
      return () => clearTimeout(timer);
    }
  }, [inputVal, armed, submitScan]);

  const bands = useMemo(() => (program ? programBands(program) : []), [program]);
  // Packets the main process could not work cartons out for, one line per material: twenty
  // packets of the same colourless upper are one thing to fix, not twenty warnings to read.
  const blocked = useMemo(() => {
    const byItem = new Map<string, (typeof issued)[number]>();
    for (const packet of issued) {
      if (!packet.cartons && !byItem.has(packet.itemId)) byItem.set(packet.itemId, packet);
    }
    return [...byItem.values()];
  }, [issued]);

  if (!program) return null;
  const canIssue = canIssueMore(program);

  return (
    <div className="mpi-page">
      <style>{SCAN_STATION_CSS}</style>

      <ProgramIssueHeader program={program} onBack={onClose} onChangeJob={onChangeJob} />

      {state.error ? (
        <p className="mpi-error" role="alert">
          ⚠ {state.error}{" "}
          {/* Re-reads the program from the event log: the figures on screen are never the
              authority, so the way out of an error is always to ask the database again. */}
          <button type="button" className="mpo-retry" onClick={() => void state.reload()}>
            {copy.common.retry}
          </button>
        </p>
      ) : null}

      <DanaIssuePanel
        programId={program.id}
        token={state.token}
        enabled={program.displayStatus !== "CANCELLED"}
        onIssued={() => void state.reload()}
      />

      <section className="mpi-section" aria-label={copy.programOut.upperOutTitle}>
        <header className="mpi-section-head">
          <span className="mpi-section-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M2 17.5c0-1 .6-1.8 1.5-2.1l3.2-1.1a3 3 0 0 0 1.4-1l2.3-3a2 2 0 0 1 3.2 0l1 1.3c.4.6 1 1 1.7 1.2l3.6 1a2.6 2.6 0 0 1 1.9 2.5V19H2v-1.5zM4 7h3v2.2L4.6 10A2 2 0 0 1 4 8.6V7z" />
            </svg>
          </span>
          <div>
            <h2 className="mpi-section-title">{copy.programOut.upperOutTitle}</h2>
            <p className="mpi-section-line">{copy.programOut.upperOutLine}</p>
          </div>
          {!scanning ? (
            <button type="button" className="mpi-action" onClick={() => setScanning(true)} disabled={!canIssue}>
              <span className="mpi-action-mark" aria-hidden="true">
                ||||
              </span>
              {program.consumedQuantity > 0 ? copy.programOut.resumeScan : copy.programOut.startScan}
            </button>
          ) : (
            <button type="button" className="mpi-action mpi-action--quiet" onClick={() => setScanning(false)}>
              {copy.programOut.stopScan}
            </button>
          )}
        </header>

        {!canIssue ? (
          <StateView
            kind="empty"
            compact
            title={programStatusLabel(program.displayStatus)}
            hint={copy.programOut.completedBody(program.code)}
          />
        ) : null}

        {scanning ? (
          <div
            className="mpi-scan"
            onClick={(event) => {
              // Clicking empty space is never an action; it hands focus back to the scanner.
              const target = event.target as HTMLElement | null;
              if (target && !target.closest("button, a, input, select, textarea, [role='dialog']")) focusScanner();
            }}
          >
            <div className="ssn ssn--embedded mpi-station">
              <ScanPanel
                feedback={feedback}
                inputRef={inputRef}
                inputVal={inputVal}
                onInputChange={setInputVal}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitScan(inputVal);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setInputVal("");
                  }
                }}
                onFocusScanner={focusScanner}
                disabled={!armed}
                disabledHint={copy.programOut.scanDisabled}
              />
            </div>
            <div className="mpi-scan-side">
              {/* The box stays armed while a scan commits so a scanner burst is never dropped;
                  the movement in progress is said out loud instead. */}
              {issuing ? (
                <p className="mpo-busy" role="status">
                  {copy.programOut.scanBusy}
                </p>
              ) : null}
              <CartonRunList
                runs={cartonRuns}
                printed={printedRuns}
                printingKey={printingKey}
                onPrint={(run) => void state.printCartons(run)}
                blocked={blocked}
              />
            </div>
          </div>
        ) : null}
      </section>

      <ProgramIssueBands bands={bands} />

      <ProgramIssueTotals
        injectors={injectorsOnProgram(program)}
        total={program.productionQuantity}
        unitCode={program.unitCode}
      />

      <IssuedPacketList history={history} />
    </div>
  );
};
