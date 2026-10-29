import { copy } from "../../../config/copy";

// THE SCAN STATE (0.3.9) — what a store scan station says about itself, decided from the facts and
// nothing else, so the headline can never say "ready" over a box that cannot take a scan:
//
//   idle      no session that can take a scan yet   "Not scanning yet" + what to do next
//   ready     a session is open, nothing scanned    "Ready" + what to scan
//   scanning  one packet or more in the session     "Scanning" + the count
//
// Receiving can take a scan once a session is open. Issuing only once its session is open AND
// locked to a party (0.3.8): an open session with no party yet is still "not scanning yet".

export type ScanStateKind = "idle" | "ready" | "scanning";

export interface ScanState {
  kind: ScanStateKind;
  title: string;
  line: string;
}

/** What a station knows: whether it can take a scan, who it is for, and how many it holds. */
export interface StationFacts {
  /** A session is open that can take a scan (Issuing: open and locked to a party). */
  canScan: boolean;
  /** The supplier or party the session is for. */
  partyName: string | null;
  packets: number;
}

interface StationWords {
  idleTitle: string;
  idleLine: string;
  readyTitle: string;
  readyLine: (party: string) => string;
  scanningTitle: string;
  scanningLine: (packets: number) => string;
}

const stateFor = (facts: StationFacts, words: StationWords): ScanState => {
  if (!facts.canScan) return { kind: "idle", title: words.idleTitle, line: words.idleLine };
  if (facts.packets === 0) return { kind: "ready", title: words.readyTitle, line: words.readyLine(facts.partyName ?? "—") };
  return { kind: "scanning", title: words.scanningTitle, line: words.scanningLine(facts.packets) };
};

export const receivingScanState = (facts: StationFacts): ScanState => stateFor(facts, copy.storeStation.receiving);

export const issuingScanState = (facts: StationFacts): ScanState => stateFor(facts, copy.storeStation.issuing);
