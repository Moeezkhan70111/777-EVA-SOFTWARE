import { describe, expect, it } from "vitest";
import { copy } from "../../../config/copy";

// THE STORE PAGE'S WORDS (0.3.9), around its two scan panels — the switch, Issued today, Receipts,
// the machine programs. Operators read English as a second language, standing in a noisy store: a
// session is a SESSION, as the 0.3.7 panels call it (owner), there is no jargon, and the only mode
// names are Move in and Move out (owner, 0.4.2; Receiving and Issuing before). The panels themselves
// are 0.3.7's, words included.

/** Every string in a copy section, functions called with a sample argument. */
const textsOf = (section: unknown): string[] => {
  if (typeof section === "string") return [section];
  if (typeof section === "function") return [String((section as (...args: unknown[]) => unknown)("X", 2))];
  if (section && typeof section === "object") return Object.values(section).flatMap(textsOf);
  return [];
};

const STORE_PAGE_WORDS = [copy.storePage, copy.storeStation, copy.receiptsTab];
const texts = STORE_PAGE_WORDS.flatMap(textsOf);

describe("the Store page's wording", () => {
  it("has something to check", () => {
    expect(texts.length).toBeGreaterThan(40);
  });

  it.each([
    ["batch — the panels call it a session", /\bbatch(es)?\b/i],
    ["ready", /\bready\b/i],
    ["initialize", /initiali[sz]/i],
    ["entity", /\bentit(y|ies)\b/i],
    ["transaction", /\btransactions?\b/i],
    // Receiving and Issuing were the modes' names until 0.4.2; a page still saying them names a mode twice.
    ["a third name for a mode", /\b(scan in|scan out|store in|store out|receiving|issuing)\b/i],
  ])("never says %s", (_word, pattern) => {
    expect(texts.filter((text) => pattern.test(text))).toEqual([]);
  });

  it("says session on the mode switch, as the panels do", () => {
    expect(copy.storeStation.sessionOpen(12)).toBe("Session open · 12 packets");
    expect(copy.storeStation.sessionOpen(1)).toBe("Session open · 1 packet");
  });
});
