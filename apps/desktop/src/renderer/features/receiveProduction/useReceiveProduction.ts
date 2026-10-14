import { useCallback, useRef, useState } from "react";
import { RECEIVE_PRODUCTION_OUTCOME } from "@erp/domain";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { ReceiveProductionResult } from "../../types/desktopApi";
import type { ScanStationFeedback } from "../scanStation/scanStation";
import { READY_FEEDBACK, feedbackFor } from "./receiveFeedback";

// One scan, scanned or typed — both arrive here and go to the SAME main-process operation, which
// decides everything. The screen never says RECEIVED until the database has said so.
//
// An UNCERTAIN outcome — the call itself failed, so the carton may or may not have been recorded —
// is settled by asking the database whether this carton is produced, never by guessing or by
// retrying blindly. (A retry could not double-receive anyway: the main process refuses a second
// receipt of the same carton.)

const text = copy.receiveProduction;

export interface ReceiveProductionState {
  feedback: ScanStationFeedback;
  busy: boolean;
  /** Receives one code. Answers false when it was not received, so a typed code can be corrected. */
  scan: (code: string) => Promise<boolean>;
}

export const useReceiveProduction = (onChanged: () => void): ReceiveProductionState => {
  const api = useDesktopApi();
  const [feedback, setFeedback] = useState<ScanStationFeedback>(READY_FEEDBACK);
  const [busy, setBusy] = useState(false);
  const seqRef = useRef(0);

  const show = useCallback((result: ReceiveProductionResult, code: string) => {
    seqRef.current += 1;
    setFeedback(feedbackFor(result, code, seqRef.current));
  }, []);

  /** The call failed: is the carton recorded or not, according to the database? */
  const settleUncertain = useCallback(
    async (code: string): Promise<ReceiveProductionResult> => {
      try {
        const known = await api.findProductionReceipt(code);
        if (known.accepted && known.receipt) {
          return { accepted: true, outcome: RECEIVE_PRODUCTION_OUTCOME.RECEIVED, qrId: known.receipt.qrId, receipt: known.receipt, reason: text.recoveredMessage };
        }
      } catch {
        // Still unreachable: say so, and let the operator scan again.
      }
      return { accepted: false, outcome: RECEIVE_PRODUCTION_OUTCOME.ERROR, qrId: code, reason: text.errorMessage };
    },
    [api]
  );

  const scan = useCallback(
    async (code: string): Promise<boolean> => {
      setBusy(true);
      try {
        let result: ReceiveProductionResult;
        try {
          result = await api.receiveProduction(code);
        } catch {
          setFeedback((previous) => ({ ...previous, tone: "warn", title: text.checkingTitle, message: "", result: null }));
          result = await settleUncertain(code);
        }
        show(result, code);
        if (result.accepted || result.outcome === RECEIVE_PRODUCTION_OUTCOME.ALREADY_RECEIVED) onChanged();
        return result.accepted;
      } finally {
        setBusy(false);
      }
    },
    [api, onChanged, settleUncertain, show]
  );

  return { feedback, busy, scan };
};
