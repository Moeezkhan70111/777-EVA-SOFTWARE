import { describe, expect, it } from "vitest";
import { copy } from "../../../config/copy";

// THE STORE PAGE'S WORDS (0.3.9). Operators read English as a second language, standing in a noisy
// store: every label says what happens, in plain words. To them a session is a BATCH; nothing says
// "ready" while the screen waits for them; there is no jargon; and the only mode names are
// Receiving and Issuing.

/** Every string in a copy section, functions called with a sample argument. */
const textsOf = (section: unknown): string[] => {
  if (typeof section === "string") return [section];
  if (typeof section === "function") return [String((section as (...args: unknown[]) => unknown)("X", 2))];
  if (section && typeof section === "object") return Object.values(section).flatMap(textsOf);
  return [];
};

const STORE_PAGE_WORDS = [copy.storePage, copy.storeStation, copy.storeScan, copy.receiptsTab];
const texts = STORE_PAGE_WORDS.flatMap(textsOf);

describe("the Store page's wording", () => {
  it("has something to check", () => {
    expect(texts.length).toBeGreaterThan(80);
  });

  it.each([
    ["session", /\bsessions?\b/i],
    ["ready", /\bready\b/i],
    ["initialize", /initiali[sz]/i],
    ["entity", /\bentit(y|ies)\b/i],
    ["transaction", /\btransactions?\b/i],
    // The carton pages are named Carton Move In / Out; a refusal pointing there is right.
    ["a third name for a mode", /\b(scan in|scan out|store in|store out)\b|(?<!carton )\bmove (in|out)\b/i],
  ])("never says %s", (_word, pattern) => {
    expect(texts.filter((text) => pattern.test(text))).toEqual([]);
  });

  it("says Start scanning and End batch", () => {
    expect(copy.storeStation.startScanning).toBe("Start scanning");
    expect(copy.storeStation.endBatch).toBe("End batch");
    expect(copy.storeStation.lastBatch).toBe("Last batch");
  });

  it("asks a question where the operator has to act", () => {
    expect(copy.storeStation.issuing.idleTitle).toBe("Who is this material for?");
    expect(copy.storeStation.receiving.idleTitle).toBe("Whose delivery is this?");
  });
});
