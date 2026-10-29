import { describe, expect, it } from "vitest";
import { issuingScanState, receivingScanState } from "./scanState";

// The headline above a scan box is the truth, always (0.3.9): never "Ready" over a box that cannot
// take a scan, as "READY TO SCAN" was.

describe("receivingScanState", () => {
  it("is not scanning yet until a session is open, and says what to do", () => {
    expect(receivingScanState({ canScan: false, partyName: null, packets: 0 })).toEqual({
      kind: "idle",
      title: "Not scanning yet",
      line: "Choose the supplier, then press Start session.",
    });
  });

  it("is ready, naming the supplier, once a session is open with nothing in it", () => {
    expect(receivingScanState({ canScan: true, partyName: "SHEHZAD RUBBER", packets: 0 })).toMatchObject({
      kind: "ready",
      title: "Ready",
      line: "Scan a packet from SHEHZAD RUBBER.",
    });
  });

  it("is scanning, with the count, from the first packet on", () => {
    expect(receivingScanState({ canScan: true, partyName: "SHEHZAD RUBBER", packets: 1 }).line).toBe("1 packet received in this session.");
    expect(receivingScanState({ canScan: true, partyName: "SHEHZAD RUBBER", packets: 1200 })).toMatchObject({
      kind: "scanning",
      title: "Scanning",
      line: "1,200 packets received in this session.",
    });
  });
});

describe("issuingScanState", () => {
  it("is not scanning yet while the session has no party, however many packets it once had", () => {
    expect(issuingScanState({ canScan: false, partyName: "DANIYAL", packets: 41 })).toMatchObject({
      kind: "idle",
      line: "Choose who the packets are going to, then press Start issuing.",
    });
  });

  it("is ready, naming the party, then scanning with the count", () => {
    expect(issuingScanState({ canScan: true, partyName: "DANIYAL", packets: 0 }).line).toBe("Scan a packet going to DANIYAL.");
    expect(issuingScanState({ canScan: true, partyName: "DANIYAL", packets: 12 }).line).toBe("12 packets issued in this session.");
  });
});
