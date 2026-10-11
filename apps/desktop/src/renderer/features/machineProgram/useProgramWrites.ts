import { useCallback, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { copy } from "../../config/copy";
import type { MachineShift } from "@erp/domain";
import type { MachineProgramRunHeader, MachineProgramWriteResult, SaveMachineProgramLineInput } from "../../types/desktopApi";

// Every change a Machine Program screen makes, in one place. Each one is saved the moment it is
// made, and answers either with the saved result or with the sentence that explains why it was
// refused. After a save the caller re-reads the program — the screen never patches its own copy.
//
// `stockVersion` is how the store's figures are re-read too: it changes on every save, and the
// reads keyed on it (useUppers) then go back to the data layer instead of answering from what
// they read before the save.

export type WriteAnswer = { ok: true; result: MachineProgramWriteResult } | { ok: false; reason: string };

const answerOf = (result: MachineProgramWriteResult): WriteAnswer =>
  result.accepted ? { ok: true, result } : { ok: false, reason: result.reason ?? copy.common.unknownError };

export const useProgramWrites = (onSaved: () => void) => {
  const api = useDesktopApi();
  // How many saves have gone through. Every program change reserves or releases stock, so the
  // store's own figures are read again on each one: the reads that show what is free are keyed
  // on this, and a reservation this screen has just made must never be missing from the figure
  // the next row is measured against.
  const [stockVersion, setStockVersion] = useState(0);

  const run = useCallback(
    async (write: () => Promise<MachineProgramWriteResult>): Promise<WriteAnswer> => {
      try {
        const answer = answerOf(await write());
        if (answer.ok) {
          setStockVersion((version) => version + 1);
          onSaved();
        }
        return answer;
      } catch (cause) {
        return { ok: false, reason: cause instanceof Error ? cause.message : copy.common.unknownError };
      }
    },
    [onSaved]
  );

  return {
    stockVersion,
    saveLine: (input: SaveMachineProgramLineInput) => run(() => api.saveMachineProgramLine(input)),
    changeRun: (runId: string, header: MachineProgramRunHeader) => run(() => api.saveMachineProgramRun({ runId, ...header })),
    /**
<<<<<<< HEAD
     * A FIX article: two sole colours and a quantity, with no upper. Answers like saveLine, so the
     * caller has the program it went on — the article's pricing is saved onto that next.
     */
    saveFixRun: (input: {
=======
     * A FIX article: two sole colours and a quantity, with no upper.
     *
     * Answers with the sentence that explains a refusal, or null when it saved — the dialog
     * shows it in place rather than closing on a save that did not happen.
     */
    saveFixRun: async (input: {
>>>>>>> 3269f98a641b7a34ca7c94a185e4a1e67738de8f
      machineId: string;
      programDate: string;
      shift: MachineShift;
      injectorNo: number;
      soleColour: string;
      innerSoleColour: string;
      articleSizeId: string;
      quantity: number;
<<<<<<< HEAD
    }) => run(() => api.saveMachineProgramFixRun(input)),
=======
    }): Promise<string | null> => {
      const answer = await run(() => api.saveMachineProgramFixRun(input));
      return answer.ok ? null : answer.reason;
    },
>>>>>>> 3269f98a641b7a34ca7c94a185e4a1e67738de8f
    saveArticleRates: (input: { programId: string; articleSizeId: string; machineRate: number; packingRate: number; printingRate: number }) =>
      run(() => api.saveMachineProgramArticleRates(input)),
    removeLine: (lineId: string) => run(() => api.removeMachineProgramLine({ lineId })),
    removeRun: (runId: string) => run(() => api.removeMachineProgramRun({ runId })),
    deleteProgram: (programId: string) => run(() => api.deleteMachineProgram({ programId })),
    setShift: (programId: string, shift: MachineShift) => run(() => api.setMachineProgramShift({ programId, shift })),
  };
};

export type ProgramWrites = ReturnType<typeof useProgramWrites>;
