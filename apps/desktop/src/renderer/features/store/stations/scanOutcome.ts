import { copy } from "../../../config/copy";
import { formatTime } from "../../../utils/dates";

// THE ANSWER TO ONE SCAN (0.3.9), as the operator needs it in the half-second they glance up: did
// it take, and was it the right packet. Built from the business layer's reply — nothing is decided
// here — and drawn by ScanZone on the Store page's rails and the full-screen stations alike.
//
//   accepted  what went in or out: the material, how much, the packet's code
//   refused   why, in one sentence; what happened; what to do now
//   waiting   no scan yet in this sitting (the station's scan state says what to do)

export interface AcceptedScan {
  kind: "accepted";
  seq: number;
  material: string;
  quantity: string | null;
  code: string | null;
  /** A machine program the packet was counted against, when one was waiting for it. */
  note: string | null;
}

export interface RefusedScan {
  kind: "refused";
  seq: number;
  reason: string;
  code: string | null;
  happened: string | null;
  todo: string;
}

export interface WaitingScan {
  kind: "waiting";
  seq: number;
}

export type ScanOutcome = AcceptedScan | RefusedScan | WaitingScan;

export const WAITING: WaitingScan = { kind: "waiting", seq: 0 };

/** "2 DOZ", or nothing when the packing is unknown. */
export const quantityOf = (quantity?: number, unitCode?: string | null): string | null =>
  quantity == null ? null : `${quantity} ${unitCode ?? ""}`.trim();

/** One scan the session already holds, as the summary lists it. */
export interface SessionScan {
  qrId: string;
  at: string;
}

/**
 * "You scanned it at 10:42, as packet 12 of this session." — or null when this session never had it.
 * This is how a double scan is explained: the first one is right there in the session.
 */
export const earlierInSession = (scans: readonly SessionScan[], qrId: string | undefined): string | null => {
  if (!qrId) return null;
  const index = scans.findIndex((scan) => scan.qrId === qrId);
  return index < 0 ? null : copy.storeScan.scannedEarlier(formatTime(scans[index].at), index + 1);
};
