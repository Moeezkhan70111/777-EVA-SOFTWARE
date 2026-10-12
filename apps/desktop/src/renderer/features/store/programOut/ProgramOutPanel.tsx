import React, { useEffect, useMemo } from "react";
import { copy } from "../../../config/copy";
import { StateView } from "../../../components/shared/StateView";
import { SCAN_STATION_CSS } from "../../scanStation/scanStation";
import { CartonRunList, IssuedPacketList } from "./ProgramOutCartons";
import { DanaIssuePanel } from "./DanaIssuePanel";
import { ProgramIssueBands, ProgramIssueTotals } from "./ProgramIssueBands";
import { ProgramIssueHeader } from "./ProgramIssueHeader";
import { ProgramCartonIn } from "./ProgramCartonIn";
import { ProgramScanSection } from "./ProgramScanSection";
import { ProgramCloseSection } from "../programClose/ProgramCloseSection";
import { useProgramClose } from "../programClose/useProgramClose";
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
// START SCAN opens the scanner (ProgramScanSection); it does not stage anything. One scan is
// still one movement, so a packet can never be "scanned but not out".
//
// Nothing here decides whether a packet may be issued, moves stock, or works out a carton count.
//
// VIEW ONLY (Store In): the same program, read the same way, without the two sections that take
// stock OUT — Dana Issue and Upper Out. In their place is Store In's own job on a program: Carton
// In, scanning the program's printed carton labels back into the store.

const UpperIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M2 17.5c0-1 .6-1.8 1.5-2.1l3.2-1.1a3 3 0 0 0 1.4-1l2.3-3a2 2 0 0 1 3.2 0l1 1.3c.4.6 1 1 1.7 1.2l3.6 1a2.6 2.6 0 0 1 1.9 2.5V19H2v-1.5zM4 7h3v2.2L4.6 10A2 2 0 0 1 4 8.6V7z" />
  </svg>
);

interface ProgramOutPanelProps {
  state: ProgramOutState;
  /** Closes the program and goes back to the page it was opened from. */
  onClose: () => void;
  /** Leaves Store Out altogether, for the Store Station job chooser. */
  onChangeJob?: () => void;
  /** Store In: read the program and scan its cartons back in; nothing can be issued. */
  viewOnly?: boolean;
}

export const ProgramOutPanel: React.FC<ProgramOutPanelProps> = ({ state, onClose, onChangeJob, viewOnly = false }) => {
  const { program, cartonRuns, printedRuns, blockedCartons, printingKey, history } = state;
  const { cartonProgress } = state;
  const bands = useMemo(() => (program ? programBands(program, cartonProgress) : []), [program, cartonProgress]);
  const close = useProgramClose({ token: state.token, programId: program?.id ?? "", onClosed: state.reload });
  const { load: loadClose } = close;
  // Every carton stored in changes how the program stands, so Complete Program counts afresh.
  useEffect(() => {
    void loadClose();
  }, [cartonProgress, loadClose]);
  // Closed is final: nothing more is issued, printed or stored in against the program.
  const closed = Boolean(close.reconciliation?.closure);

  if (!program) return null;
  const canIssue = canIssueMore(program);

  return (
    <div className="mpi-page">
      <style>{SCAN_STATION_CSS}</style>

      <ProgramIssueHeader
        program={program}
        title={viewOnly ? copy.programOut.viewTitle : copy.programOut.issueTitle}
        backLabel={viewOnly ? copy.programOut.viewBack : copy.programOut.back}
        onBack={onClose}
        onChangeJob={onChangeJob}
      />

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

      {viewOnly ? (
        <ProgramCartonIn
          token={state.token}
          programId={program.id}
          printedRuns={printedRuns.length}
          closed={closed}
          onReceived={state.reload}
        />
      ) : (
        <>
          <DanaIssuePanel
            programId={program.id}
            token={state.token}
            enabled={program.displayStatus !== "CANCELLED" && !closed}
            onIssued={() => void state.reload()}
          />
          <ProgramScanSection
            title={copy.programOut.upperOutTitle}
            line={copy.programOut.upperOutLine}
            icon={<UpperIcon />}
            startLabel={program.consumedQuantity > 0 ? copy.programOut.resumeScan : copy.programOut.startScan}
            canScan={canIssue}
            notice={
              <StateView
                kind="empty"
                compact
                title={programStatusLabel(program.displayStatus)}
                hint={state.issueBlockedReason ?? copy.programOut.completedBody(program.code)}
              />
            }
            feedback={state.feedback}
            onScan={state.scan}
            busy={state.issuing}
            busyLabel={copy.programOut.scanBusy}
            disabledHint={copy.programOut.scanDisabled}
          />
        </>
      )}

      {/* Always on screen, scanner open or not: the cartons owed for everything this program has
          taken out, in any sitting, each run with its own Print button. */}
      <CartonRunList
        runs={cartonRuns}
        printed={printedRuns}
        printingKey={printingKey}
        onPrint={(run) => void state.printCartons(run)}
        onReprint={(run) => void state.reprintCartons(run)}
        blocked={blockedCartons}
        blockedFix={state.blockedFixCartons}
        locked={closed}
      />

      {/* Store In completes the program; Store Out shows how it was closed, once it is. */}
      <ProgramCloseSection close={close} allowComplete={viewOnly} />

      {/* Store Out counts uppers going out; Store In counts the cartons coming back for them. */}
      <ProgramIssueBands bands={bands} mode={viewOnly ? "cartons" : "issue"} />

      <ProgramIssueTotals
        injectors={injectorsOnProgram(program)}
        total={program.productionQuantity}
        unitCode={program.unitCode}
      />

      <IssuedPacketList history={history} />
    </div>
  );
};
