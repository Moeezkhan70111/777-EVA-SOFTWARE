import React from "react";
import { copy } from "../../../config/copy";
import { CartonInStation } from "../programOut/CartonInStation";
import { ProgramOutPanel } from "../programOut/ProgramOutPanel";
import { isProgramClosed } from "../programClose/useProgramClose";
import { BarcodeWell } from "../stations/ScanZone";
import type { StoreMode } from "./storeTabs";
import type { StoreProgram } from "./useStoreProgram";

// AN OPEN MACHINE PROGRAM ON THE STORE PAGE (0.3.9), shown the way its mode works with it — exactly
// what Store In and Store Out showed:
//
//   Receiving  the program read, never issued against; its cartons scanned back in on the rail
//              (Carton In), and completed or reconciled here.
//   Issuing    Machine Move Out: Dana Issue and Upper Out. Upper Out has its own scanner in the
//              program, so the Scan out rail is paused — one armed box on the page, never two.

/** The work area while a program is open. Closing it brings back the tabs as they were. */
export const ProgramWork: React.FC<{ store: StoreProgram; mode: StoreMode }> = ({ store, mode }) => (
  <div className="sp-work">
    <section className="sp-work-pane" aria-label={store.program.program?.code ?? copy.storePage.programs.title}>
      <ProgramOutPanel state={store.program} onClose={store.program.close} viewOnly={mode === "receiving"} close={store.close} />
    </section>
  </div>
);

/** The rail while a program is open: Carton In for Receiving, a paused Scan out for Issuing. */
export const ProgramRail: React.FC<{ store: StoreProgram; mode: StoreMode; token: string }> = ({ store, mode, token }) => {
  const program = store.program.program;
  if (!program) return null;
  if (mode === "receiving") {
    return (
      <aside className="sp-rail" aria-label={copy.programOut.cartonInStationTitle(program.code)}>
        <CartonInStation
          token={token}
          programId={program.id}
          programCode={program.code}
          printedRuns={store.program.printedRuns.length}
          closed={isProgramClosed(store.close)}
          onReceived={store.program.reload}
        />
      </aside>
    );
  }
  return (
    <aside className="sp-rail" aria-label={copy.storePage.scanOut}>
      <header className="sp-who sp-who--out">
        <span className="sp-marker">{copy.storePage.issuing}</span>
      </header>
      <div className="sp-rail-scan">
        <section className="sz sz--out sz--waiting" data-testid="scan-zone" data-state="waiting">
          <BarcodeWell />
          <p className="sz-question" data-testid="scan-state">
            {copy.storePage.programs.pausedTitle(program.code)}
          </p>
          <p className="sz-line">{copy.storePage.programs.scanOutPaused}</p>
          <p className="sz-line">{copy.storePage.programs.closeToResume}</p>
        </section>
      </div>
    </aside>
  );
};
