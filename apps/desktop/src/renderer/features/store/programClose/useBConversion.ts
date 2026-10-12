import { useCallback } from "react";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { useNotifications } from "../../../state/NotificationsContext";
import { copy } from "../../../config/copy";
import type { ReconciliationFixRun } from "../../../types/desktopApi";
import { openCartonRunLabels } from "../programOut/useProgramOut";

// Reconciliation for EVR FIX: turning a FIX run's labels that did not come back into B cartons.
//
// The main process chooses which labels, voids them and generates the B run in one transaction
// (convertFixCartonsToB). This hook only asks, prints what came back — B in the corner, COLOUR MIX —
// and has the program re-read, so every count on screen is the database's.

interface UseBConversionInput {
  token: string;
  programId: string;
  programCode: string;
  /** Re-reads the program and how it stands, after the B labels exist. */
  onConverted: () => Promise<void>;
}

/** Turns `count` of the run's missing labels into B cartons. Answers with the refusal, or null. */
export type ConvertToB = (run: ReconciliationFixRun, count: number) => Promise<string | null>;

export const useBConversion = ({ token, programId, programCode, onConverted }: UseBConversionInput): ConvertToB => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const text = copy.programClose;

  return useCallback(
    async (run, count) => {
      let result: Awaited<ReturnType<typeof api.convertMachineProgramCartonsToB>>;
      try {
        result = await api.convertMachineProgramCartonsToB({ programId, runId: run.runId, count }, { token });
      } catch (caught) {
        return caught instanceof Error ? caught.message : copy.states.loadFailedBody;
      }
      if (!result.accepted || !result.qrCodes || result.qrCodes.length === 0) return result.reason ?? copy.states.loadFailedBody;

      // The labels exist now, printed or not: a blocked window is fixed with Reprint, never by
      // generating them again.
      const what = text.bRunName(run.article, run.size);
      const opened = openCartonRunLabels(what, result.qrCodes, programCode, null, "B");
      if (!opened) push("error", copy.toast.popupBlocked, copy.programOut.cartonBlocked);
      else push("success", text.bGeneratedTitle, text.bGeneratedBody(result.qrCodes.length, what));
      await onConverted();
      return null;
    },
    [api, onConverted, programCode, programId, push, text, token]
  );
};
