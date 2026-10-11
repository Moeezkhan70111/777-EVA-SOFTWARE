import { useCallback, useRef, useState } from "react";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { copy } from "../../../config/copy";
import { playScanSound } from "../../../utils/playScanSound";
import type { MachineProgramCartonInResult } from "../../../types/desktopApi";
import type { ScanStationFeedback } from "../../scanStation/scanStation";
import { CARTON_IN_IDLE, feedbackForCartonIn } from "./cartonIn";

// CARTON IN — Store In scanning one open program's carton labels as the machine sends them back.
//
// One scan is one carton: the main process checks the label was printed for THIS program, then
// produces it and stores it in, in one transaction, or refuses and writes nothing. This hook only
// asks, says the answer, and has the program re-read so "3 of 4 back" is the database's figure.

interface UseCartonInInput {
  token: string;
  programId: string;
  /** Re-reads the program's cartons after a carton is stored in. */
  onReceived: () => Promise<void>;
}

export interface CartonInState {
  feedback: ScanStationFeedback;
  busy: boolean;
  scan: (rawScan: string) => Promise<void>;
}

export const useCartonIn = ({ token, programId, onReceived }: UseCartonInInput): CartonInState => {
  const api = useDesktopApi();
  const [feedback, setFeedback] = useState<ScanStationFeedback>(CARTON_IN_IDLE);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const scan = useCallback(
    async (rawScan: string) => {
      seq.current += 1;
      setBusy(true);
      let result: MachineProgramCartonInResult;
      try {
        result = await api.machineProgramCartonIn({ programId, rawScan }, { token });
      } catch {
        result = { accepted: false, outcome: "ERROR", reason: copy.states.loadFailedBody };
      } finally {
        setBusy(false);
      }
      setFeedback(feedbackForCartonIn(result, seq.current));
      playScanSound(result.accepted ? "success" : "error");
      if (result.accepted) await onReceived();
    },
    [api, onReceived, programId, token]
  );

  return { feedback, busy, scan };
};
