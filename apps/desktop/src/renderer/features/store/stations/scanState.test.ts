import { describe, expect, it } from "vitest";
import { issuingScanState, receivingScanState } from "./scanState";

// What a station says while it waits (0.3.9): a question while it cannot take a scan, and what to
// scan once it can. Never "ready" over a box that cannot take a scan, as "READY TO SCAN" was.

describe("receivingScanState", () => {
  it("is not scanning until a session is open, and asks whose delivery it is", () => {
    expect(receivingScanState({ canScan: false, partyName: null, packets: 0 })).toEqual({
      kind: "idle",
      title: "Not scanning",
      line: "Whose delivery is this?",
    });
  });

  it("is ready, naming the supplier, once a session is open with nothing in it", () => {
    expect(receivingScanState({ canScan: true, partyName: "SHEHZAD RUBBER", packets: 0 })).toEqual({
      kind: "ready",
      title: "Ready",
      line: "Scan the first packet from SHEHZAD RUBBER.",
    });
  });

  it("asks for the next packet once the session holds one", () => {
    expect(receivingScanState({ canScan: true, partyName: "SHEHZAD RUBBER", packets: 12 })).toEqual({
      kind: "scanning",
      title: "Ready",
      line: "Scan the next packet from SHEHZAD RUBBER.",
    });
  });
});

describe("issuingScanState", () => {
  it("is not scanning while the session has no party, however many packets it once had, and asks who it is for", () => {
    expect(issuingScanState({ canScan: false, partyName: "DANIYAL", packets: 41 })).toMatchObject({
      kind: "idle",
      line: "Who is this material for?",
    });
  });

  it("names the party it is going to, first and next", () => {
    expect(issuingScanState({ canScan: true, partyName: "DANIYAL", packets: 0 }).line).toBe("Scan the first packet going to DANIYAL.");
    expect(issuingScanState({ canScan: true, partyName: "DANIYAL", packets: 12 }).line).toBe("Scan the next packet going to DANIYAL.");
  });
});
