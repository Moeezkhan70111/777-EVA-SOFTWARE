import { useCallback, useEffect, useRef, useState } from "react";
import { UPPER_ISSUE_OUTCOME } from "@erp/domain";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { MachineRecord, UpperIssueResult } from "../../types/desktopApi";
import type { ScanStationFeedback } from "../scanStation/scanStation";
import { feedbackForIssue, idleFeedback } from "./upperFeedback";
import { leaseRefusalText } from "../../../shared/leaseRefusal";

// One upper scan, scanned or typed, for the chosen machine — both arrive here and go to the SAME
// main-process operation, which decides everything (machine, packet, stock). The screen never says
// ISSUED until the database has said so.
//
// An UNCERTAIN outcome — the call itself failed — is settled by asking the database whether this
// packet was issued to this machine, never by retrying blindly. (A retry could not issue it twice
// anyway: the packet's guarded status move allows one issue.)

const text = copy.upperMoveOut;

export interface UpperIssueState {
  feedback: ScanStationFeedback;
  busy: boolean;
  /** Issues one code to the chosen machine. Answers false when it was not issued. */
  scan: (code: string) => Promise<boolean>;
}

export const useUpperIssue = (machine: MachineRecord | null, onChanged: () => void): UpperIssueState => {
  const api = useDesktopApi();
  const seqRef = useRef(0);
  const [feedback, setFeedback] = useState<ScanStationFeedback>(() => idleFeedback(null, 0));
  const [busy, setBusy] = useState(false);
  const machineId = machine?.id ?? null;
  const machineName = machine?.name ?? null;

  // A new machine starts from READY for it (nothing already issued is touched).
  useEffect(() => {
    seqRef.current += 1;
    setFeedback(idleFeedback(machineName, seqRef.current));
  }, [machineId, machineName]);

  const settleUncertain = useCallback(
    async (code: string, id: string, name: string): Promise<UpperIssueResult> => {
      try {
        const known = await api.findUpperIssue(code);
        if (known.accepted && known.issue && known.issue.machineId === id) {
          return { accepted: true, outcome: UPPER_ISSUE_OUTCOME.ISSUED, qrId: known.issue.qrId, issue: known.issue, reason: text.recoveredMessage(name) };
        }
      } catch {
        // Still unreachable: say so, and let the operator scan again.
      }
      return { accepted: false, outcome: UPPER_ISSUE_OUTCOME.ERROR, qrId: code, reason: text.errorMessage };
    },
    [api]
  );

  const scan = useCallback(
    async (code: string): Promise<boolean> => {
      seqRef.current += 1;
      if (!machineId || !machineName) {
        setFeedback({ ...idleFeedback(null, seqRef.current), result: { qrId: code } });
        return false;
      }
      setBusy(true);
      try {
        let result: UpperIssueResult;
        try {
          result = await api.issueUpperToMachine(code, machineId);
        } catch (error) {
          // Refused because the store is written elsewhere: nothing happened, so there is nothing to check.
          const refused = leaseRefusalText(error);
          if (refused !== null) {
            seqRef.current += 1;
            setFeedback({ tone: "error", title: copy.writeLease.readOnlyTitle, message: refused, result: { qrId: code }, seq: seqRef.current });
            return false;
          }
          setFeedback((previous) => ({ ...previous, tone: "warn", title: text.checkingTitle, message: "", result: null }));
          result = await settleUncertain(code, machineId, machineName);
        }
        seqRef.current += 1;
        setFeedback(feedbackForIssue(result, code, machineName, seqRef.current));
        if (result.accepted || result.outcome === UPPER_ISSUE_OUTCOME.ALREADY_ISSUED) onChanged();
        return result.accepted;
      } finally {
        setBusy(false);
      }
    },
    [api, machineId, machineName, onChanged, settleUncertain]
  );

  return { feedback, busy, scan };
};
