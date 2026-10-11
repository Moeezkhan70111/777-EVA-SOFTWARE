import React from "react";
import { copy } from "../../../config/copy";
import { StateView } from "../../../components/shared/StateView";
import { ProgramScanSection } from "./ProgramScanSection";
import { useCartonIn } from "./useCartonIn";

// CARTON IN — Store In's one action on a machine program: the carton labels printed for it are
// scanned as they come back from the machine, and each one is produced and stored in.
//
// The scanner opens once at least one carton run has been printed: until then there is no label
// of this program's that could come back. Whether a scanned label IS this program's, and whether
// it can be stored in, is the main process's to say.

const CartonIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9zm9 2.2 6.4-3.2L12 3.3 5.6 6.5 12 9.7zm-1 1.8L4.6 8.3v7.2L11 18.7v-7.2zm2 7.2 6.4-3.2V8.3L13 11.5v7.2z" />
  </svg>
);

interface ProgramCartonInProps {
  token: string;
  programId: string;
  /** How many carton runs have been printed for the program. */
  printedRuns: number;
  /** Re-reads the program, so the "back in store" counts are the database's. */
  onReceived: () => Promise<void>;
}

export const ProgramCartonIn: React.FC<ProgramCartonInProps> = ({ token, programId, printedRuns, onReceived }) => {
  const cartonIn = useCartonIn({ token, programId, onReceived });
  return (
    <ProgramScanSection
      title={copy.programOut.cartonInTitle}
      line={copy.programOut.cartonInLine}
      icon={<CartonIcon />}
      startLabel={copy.programOut.startScan}
      canScan={printedRuns > 0}
      notice={<StateView kind="empty" compact title={copy.programOut.cartonInNoneTitle} hint={copy.programOut.cartonInNoneHint} />}
      feedback={cartonIn.feedback}
      onScan={cartonIn.scan}
      busy={cartonIn.busy}
      busyLabel={copy.programOut.cartonInBusy}
      disabledHint={copy.programOut.cartonInDisabled}
    />
  );
};
