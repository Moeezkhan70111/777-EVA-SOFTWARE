import { describe, expect, it } from "vitest";
import { issuingScanState, receivingScanState } from "./scanState";

// What a station says while it waits (0.3.9): a question when the operator must choose, an
// instruction when they must scan — never a status word like "ready" while it waits for them.

describe("receivingScanState", () => {
  it("asks whose delivery it is until a session is open", () => {
    expect(receivingScanState({ canScan: false, partyName: null, packets: 0 })).toEqual({
      kind: "idle",
      title: "Whose delivery is this?",
      line: "Choose the supplier, then press Start scanning.",
    });
  });

  it("asks for the first packet, saying who it is counted from", () => {
    expect(receivingScanState({ canScan: true, partyName: "SHEHZAD RUBBER", packets: 0 })).toEqual({
      kind: "ready",
      title: "Scan the first packet",
      line: "Each packet is counted as received from SHEHZAD RUBBER.",
    });
  });

  it("asks for the next packet once the batch holds one", () => {
    expect(receivingScanState({ canScan: true, partyName: "SHEHZAD RUBBER", packets: 12 })).toMatchObject({
      kind: "scanning",
      title: "Scan the next packet",
    });
  });

  it("never says ready", () => {
    for (const facts of [
      { canScan: false, partyName: null, packets: 0 },
      { canScan: true, partyName: "X", packets: 0 },
      { canScan: true, partyName: "X", packets: 3 },
    ]) {
      const state = receivingScanState(facts);
      expect(`${state.title} ${state.line}`).not.toMatch(/ready/i);
    }
  });
});

describe("issuingScanState", () => {
  it("asks who the material is for while the batch has no party, however many packets it once had", () => {
    expect(issuingScanState({ canScan: false, partyName: "DANIYAL", packets: 41 })).toEqual({
      kind: "idle",
      title: "Who is this material for?",
      line: "Choose who the packets are going to, then press Start scanning.",
    });
  });

  it("says who each packet is counted to", () => {
    expect(issuingScanState({ canScan: true, partyName: "DANIYAL", packets: 0 })).toMatchObject({ title: "Scan the first packet", line: "Each packet is counted as issued to DANIYAL." });
    expect(issuingScanState({ canScan: true, partyName: "DANIYAL", packets: 12 }).title).toBe("Scan the next packet");
  });
});
