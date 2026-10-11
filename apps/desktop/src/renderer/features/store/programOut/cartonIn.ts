import { copy } from "../../../config/copy";
import type { MachineProgramCartonInResult } from "../../../types/desktopApi";
import type { ScanStationFeedback } from "../../scanStation/scanStation";

// What the Store In operator reads after scanning one of the program's carton labels — in words,
// never colour alone. Every refusal is the main process's own sentence; only the heading is ours.

/** The Carton In scanner's resting state between scans. */
export const CARTON_IN_IDLE: ScanStationFeedback = {
  tone: "idle",
  title: copy.programOut.cartonInIdleTitle,
  message: copy.programOut.cartonInIdleMessage,
  result: null,
  seq: 0,
};

export const feedbackForCartonIn = (result: MachineProgramCartonInResult, seq: number): ScanStationFeedback => {
  const product = result.article ? [result.article, result.color, result.size].filter(Boolean).join(" · ") : undefined;
  if (result.accepted) {
    return {
      seq,
      tone: "success",
      title: copy.programOut.cartonInReceivedTitle,
      message: result.producedNow ? copy.programOut.cartonInProduced : copy.programOut.cartonInStoredOnly,
      result: { qrId: result.qrId, product, toStatus: "In Store", at: result.receivedAt, atLabel: "Stored in" },
    };
  }
  return {
    seq,
    tone: "error",
    title: copy.programOut.cartonInRefusals[result.outcome] ?? copy.programOut.cartonInRefusedTitle,
    message: result.reason ?? copy.states.loadFailedBody,
    result: { qrId: result.qrId, product },
  };
};
