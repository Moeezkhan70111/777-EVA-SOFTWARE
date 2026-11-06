/**
 * Where a store scan panel's session stands (0.3.9), as the Receiving and Issuing panels report it
 * to the Store page: its mode switch shows both, even the hidden one, so a session left open on
 * the other side is seen from this one.
 */
export interface StationStatus {
  /** The open session's id, or null. Issuing's rides machine program batches onto its slip. */
  sessionId: string | null;
  open: boolean;
  packets: number;
  /** What those packets hold: "20", or "25 KG + 20 DOZ" for a session of several units. */
  quantity: string;
}

export const NO_SESSION: StationStatus = { sessionId: null, open: false, packets: 0, quantity: "" };
