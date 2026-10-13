import React, { useEffect, useRef, useState } from "react";
import { copy } from "../../config/copy";
import { RawMaterialOutputPage } from "../../pages/RawMaterialOutputPage";
import { StateView } from "../../components/shared/StateView";
import { HandMovePanel } from "./HandMovePanel";
import { ProgramLookupField } from "./programOut/ProgramLookupField";
import { ProgramOutPanel } from "./programOut/ProgramOutPanel";
import { useProgramOut } from "./programOut/useProgramOut";
import { useProgramCloseFor } from "./programClose/useProgramClose";
import { ScanInIcon, StockIcon } from "./StoreIcons";

// STORE OUT — one page for everything that leaves the store.
//
//   ┌ Move Out ───────────────────────────────────────────────────────────┐
//   │ Machine program  [ Scan QR or enter Machine Program No. ]  [Open]   │
//   ├───────────────────────────────────┬──────────────────────────────────┤
//   │ ✋ Move Out by Hand               │ ⌁ Scan Out                       │
//   │ for loose stock with no label     │ the Raw Material Output station  │
//   └───────────────────────────────────┴──────────────────────────────────┘
//
// Two ways out, side by side, because the store uses both in the same breath: the labelled
// packets are scanned, and the nawaar cut off a roll is typed. Neither is a step of the other,
// so neither is behind a tab.
//
// The scan station on the right is the existing Raw Material Output page, embedded. Nothing
// here scans, converts or moves stock by itself.
//
// THE MACHINE PROGRAM LOOKUP at the top is the third way out, and the only one that is a
// workflow rather than a station: a program issued by Production authorises exactly which
// uppers may be fetched for it, so opening one REPLACES the two panes with that program's own
// Machine Move Out screen. One scan target at a time — a hardware scanner types into whichever
// box has focus. Closing the program puts the page back exactly as it was.
//
// While no program is open the Scan Out station on the right holds the keyboard, because that is
// the high-volume station and it is armed as soon as its session opens. A program sheet scanned
// into it is therefore handed back up to the lookup instead of being refused — otherwise the
// gesture the lookup exists for ("scan the sheet") would land in the wrong box and fail.

interface StoreOutPageProps {
  token: string;
  onBack: () => void;
  /** Opens Daily Report Store Out. */
  onOpenReport: () => void;
  /**
   * A machine program to open on arrival, from a notification. The id is the program's stored
   * identifier — never its printed number — and is still resolved and judged in the main process.
   */
  initialProgramId?: string;
  /** Called once the arrival program has been opened, so a later re-render does not reopen it. */
  onInitialProgramConsumed?: () => void;
}

export const StoreOutPage: React.FC<StoreOutPageProps> = ({
  token,
  onBack,
  onOpenReport,
  initialProgramId,
  onInitialProgramConsumed,
}) => {
  // Packets issued against a program ride on this terminal's own issue session when there is
  // one, so they print on the same slip as everything else that left. It is deliberately NOT
  // required: a session that has been closed must never stop a committed movement.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const programOut = useProgramOut({ token, sessionId });
  const programClose = useProgramCloseFor(programOut);
  const openedFor = useRef<string | null>(null);
  const { open: openProgram } = programOut;
  // Read through a ref: App hands this down as an inline arrow, and depending on it would
  // re-run the effect on every render of the shell.
  const consumedRef = useRef(onInitialProgramConsumed);
  consumedRef.current = onInitialProgramConsumed;

  // A notification opens the program it names, once.
  useEffect(() => {
    if (!initialProgramId || openedFor.current === initialProgramId) return;
    openedFor.current = initialProgramId;
    void openProgram(initialProgramId).then(() => consumedRef.current?.());
  }, [initialProgramId, openProgram]);

  if (programOut.program) {
    return (
      <div className="si-page mo-page mo-page--program">
        <ProgramOutPanel state={programOut} onClose={programOut.close} onChangeJob={onBack} close={programClose} />
      </div>
    );
  }

  return (
    <div className="si-page mo-page">
      <header className="si-head">
        <span className="si-head-mark si-head-mark--out" aria-hidden="true">
          <StockIcon />
        </span>
        <div>
          <h1 className="si-title">{copy.moveOut.title}</h1>
          <p className="si-sub">{copy.moveOut.line}</p>
        </div>
        <button type="button" className="mo-back" onClick={onOpenReport}>
          {copy.storeDailyReport.openReport}
        </button>
        <button type="button" className="mo-back mo-back--next" onClick={onBack}>
          {copy.store.changeJob}
        </button>
      </header>

      <ProgramLookupField
        onOpen={(lookup) => void programOut.open(lookup)}
        busy={programOut.loading}
        error={programOut.error}
      />

      {programOut.loading ? <StateView kind="loading" compact message={copy.programOut.opening} /> : null}

      <div className="si-body">
        <section className="si-main mo-main" aria-label={copy.moveOut.manualTitle}>
          <header className="mo-pane-head">
            <span className="si-scan-mark" aria-hidden="true">
              <StockIcon />
            </span>
            <div>
              <h2 className="si-scan-title">{copy.moveOut.manualTitle}</h2>
              <p className="si-scan-line">{copy.moveOut.manualLine}</p>
            </div>
          </header>
          <HandMovePanel direction="OUT" token={token} />
        </section>

        <aside className="si-scan mo-scan" aria-label={copy.moveOut.scanTitle}>
          <header className="si-scan-head">
            <span className="si-scan-mark" aria-hidden="true">
              <ScanInIcon />
            </span>
            <div>
              <h2 className="si-scan-title">{copy.moveOut.scanTitle}</h2>
              <p className="si-scan-line">{copy.moveOut.scanLine}</p>
            </div>
          </header>
          {/* Never keyed: a manual move changes stock, not this station's open session, and
              remounting it would throw that session away mid-delivery. */}
          <RawMaterialOutputPage
            token={token}
            embedded
            onSessionChange={setSessionId}
            onMachineProgramScan={(code) => void programOut.open(code)}
          />
        </aside>
      </div>
    </div>
  );
};
