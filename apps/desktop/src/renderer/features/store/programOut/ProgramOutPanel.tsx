import React, { useMemo } from "react";
import { copy } from "../../../config/copy";
import { StateView } from "../../../components/shared/StateView";
import { SCAN_STATION_CSS } from "../../scanStation/scanStation";
import { CartonRunList } from "./CartonLabels";
import { IssuedPacketList } from "./ProgramOutCartons";
import { DanaIssuePanel } from "./DanaIssuePanel";
import { ProgramIssueBands, ProgramIssueTotals } from "./ProgramIssueBands";
import { ProgramIssueHeader } from "./ProgramIssueHeader";
import { ProgramScanSection } from "./ProgramScanSection";
import { ProgramCloseSection } from "../programClose/ProgramCloseSection";
import { isProgramClosed, type ProgramCloseState } from "../programClose/useProgramClose";
import { canIssueMore, injectorsOnProgram, isFixOnlyProgram, programBands, programStatusLabel } from "./programOut";
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
// EVR FIX (every article a FIX article): no upper, so no Upper Out, no upper cards and no
// "(Upper)" on the total. Dana Issue and the cartons stay — the soles are still Dana, and the
// cartons are still labelled and scanned back. A program with any upper article is unchanged.
//
// VIEW ONLY (Store In): the same program, read the same way, without the two sections that take
// stock OUT — Dana Issue and Upper Out. Store In scans the program's cartons back on its own scan
// station on the right (CartonInStation), so there is never a second scanner here.

const UpperIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M2 17.5c0-1 .6-1.8 1.5-2.1l3.2-1.1a3 3 0 0 0 1.4-1l2.3-3a2 2 0 0 1 3.2 0l1 1.3c.4.6 1 1 1.7 1.2l3.6 1a2.6 2.6 0 0 1 1.9 2.5V19H2v-1.5zM4 7h3v2.2L4.6 10A2 2 0 0 1 4 8.6V7z" />
  </svg>
);

interface ProgramOutPanelProps {
  state: ProgramOutState;
  /** Closes the program and goes back to the page it was opened from. */
  onClose: () => void;
  /** Store In: read the program and complete it; nothing can be issued. Its cartons are scanned
   *  in on the page's own scan station on the right (CartonInStation), not here. */
  viewOnly?: boolean;
  /** The page's one close state for this program (useProgramCloseFor). */
  close: ProgramCloseState;
}

export const ProgramOutPanel: React.FC<ProgramOutPanelProps> = ({ state, onClose, viewOnly = false, close }) => {
  const { program, cartonRuns, printedRuns, blockedCartons, printingKey, history } = state;
  const { cartonProgress } = state;
  const bands = useMemo(() => (program ? programBands(program, cartonProgress) : []), [program, cartonProgress]);
  const closed = isProgramClosed(close);

  if (!program) return null;
  const canIssue = canIssueMore(program);
  // EVR FIX has no upper: nothing goes out as one, so the upper sections are not shown for it.
  // Any program with an upper article on it keeps them all (isFixOnlyProgram).
  const fixOnly = isFixOnlyProgram(program);

  return (
    <div className="mpi-page">
      <style>{SCAN_STATION_CSS}</style>

      <ProgramIssueHeader
        program={program}
        title={viewOnly ? copy.programOut.viewTitle : copy.programOut.issueTitle}
        backLabel={viewOnly ? copy.programOut.viewBack : copy.programOut.back}
        onBack={onClose}
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

      {viewOnly ? null : (
        <>
          <DanaIssuePanel
            programId={program.id}
            token={state.token}
            enabled={program.displayStatus !== "CANCELLED" && !closed}
            onIssued={() => void state.reload()}
          />
          {fixOnly ? null : (
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
          )}
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
      <ProgramCloseSection
        close={close}
        allowComplete={viewOnly}
        bCartons={
          viewOnly
            ? {
                token: state.token,
                programId: program.id,
                programCode: program.code,
                // The B run changes the program's cartons AND how it stands, so both are re-read.
                onConverted: async () => {
                  await state.reload();
                  await close.load();
                },
              }
            : undefined
        }
      />

      {/* Store Out counts uppers going out; Store In counts the cartons coming back for them.
          EVR FIX has no upper card to show, and no "no uppers yet" to say about it either: its
          cartons are followed in Cartons to label above. */}
      {fixOnly ? null : <ProgramIssueBands bands={bands} mode={viewOnly ? "cartons" : "issue"} />}

      <ProgramIssueTotals
        injectors={injectorsOnProgram(program)}
        total={program.productionQuantity}
        unitCode={program.unitCode}
        fixOnly={fixOnly}
      />

      <IssuedPacketList history={history} />
    </div>
  );
};
