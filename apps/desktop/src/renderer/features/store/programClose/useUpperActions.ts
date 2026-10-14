import { useCallback } from "react";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { useNotifications } from "../../../state/NotificationsContext";
import { copy } from "../../../config/copy";
import type { ReconciliationLine, UpperReturnResult } from "../../../types/desktopApi";
import { openCartonRunLabels } from "../programOut/useProgramOut";

// The two things an upper line's reconciliation does at once, before the program closes:
//
//   RETURN UPPER   a sealed packet scanned back — stock in, fewer cartons due
//   B CARTONS      MIX labels printed, the line's labels not back cancelled
//
// Both are decided and written by the main process; these hooks ask, then have the program and
// how it stands re-read, so every figure on screen is the database's — never a guess of the screen.

interface UpperActionsInput {
  token: string;
  programId: string;
  programCode: string;
  /** Re-reads the program and how it stands. */
  onChanged: () => Promise<void>;
}

/** Answers with the refusal to show, or null when it was done. */
export type ConvertUpperToB = (line: ReconciliationLine, count: number) => Promise<string | null>;
export type ReturnUpper = (rawScan: string) => Promise<UpperReturnResult>;

export const useUpperActions = ({ token, programId, programCode, onChanged }: UpperActionsInput): { returnUpper: ReturnUpper; convertToB: ConvertUpperToB } => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const text = copy.programClose;

  const returnUpper = useCallback<ReturnUpper>(
    async (rawScan) => {
      let result: UpperReturnResult;
      try {
        result = await api.returnMachineProgramUpper({ programId, rawScan }, { token });
      } catch (caught) {
        return { accepted: false, outcome: "ERROR", reason: caught instanceof Error ? caught.message : copy.states.loadFailedBody };
      }
      if (result.accepted) await onChanged();
      return result;
    },
    [api, onChanged, programId, token]
  );

  const convertToB = useCallback<ConvertUpperToB>(
    async (line, count) => {
      let result: Awaited<ReturnType<typeof api.convertMachineProgramUpperCartonsToB>>;
      try {
        result = await api.convertMachineProgramUpperCartonsToB({ programId, lineId: line.lineId, count }, { token });
      } catch (caught) {
        return caught instanceof Error ? caught.message : copy.states.loadFailedBody;
      }
      if (!result.accepted || !result.qrCodes || result.qrCodes.length === 0) return result.reason ?? copy.states.loadFailedBody;

      // The labels exist now, printed or not: a blocked window is fixed with Reprint, never by
      // generating them again.
      const what = text.bRunName(line.article, line.size);
      if (!openCartonRunLabels(what, result.qrCodes, programCode, null, "B")) push("error", copy.toast.popupBlocked, copy.programOut.cartonBlocked);
      else push("success", text.bGeneratedTitle, text.bGeneratedBody(result.qrCodes.length, what));
      await onChanged();
      return null;
    },
    [api, onChanged, programCode, programId, push, text, token]
  );

  return { returnUpper, convertToB };
};
