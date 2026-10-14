// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseReconciliationEntries } from "./reconciliationInput";

// What the renderer sends to close a program, checked at the process boundary: the shape only.
// Whether the counts add up is the domain's rule, applied by the data layer.

describe("parseReconciliationEntries", () => {
  it("takes what the screen sends, and keeps a supplier only on a supplier claim", () => {
    const parsed = parseReconciliationEntries([
      {
        lineId: "line-1", cutSizeUppers: 2, cutSizePairs: 3,
        claims: [
          { role: "SUPPLIER", supplierPartyId: "s-1", pairs: 1, ratePaisa: 5000, reason: "torn" },
          { role: "PACKING", supplierPartyId: "s-1", pairs: 1, ratePaisa: 4000, reason: "lost" },
        ],
      },
    ]);
    expect(parsed).toEqual([
      {
        lineId: "line-1", cutSizeUppers: 2, cutSizePairs: 3,
        claims: [
          { role: "SUPPLIER", supplierPartyId: "s-1", pairs: 1, ratePaisa: 5000, reason: "torn" },
          { role: "PACKING", supplierPartyId: null, pairs: 1, ratePaisa: 4000, reason: "lost" },
        ],
      },
    ]);
  });

  it("never coerces: a missing or textual count reaches the rule as NaN, which it refuses", () => {
    const parsed = parseReconciliationEntries([{ lineId: "line-1", cutSizeUppers: "4", claims: [{ role: "MACHINE", pairs: "1", ratePaisa: null, reason: "x" }] }]);
    expect(Array.isArray(parsed)).toBe(true);
    if (!Array.isArray(parsed)) return;
    expect(parsed[0].cutSizeUppers).toBeNaN();
    expect(parsed[0].cutSizePairs).toBeNaN();
    expect(parsed[0].claims[0].pairs).toBeNaN();
    expect(parsed[0].claims[0].ratePaisa).toBeNaN();
  });

  it("refuses a claim against a party this ERP does not know", () => {
    expect(parseReconciliationEntries([{ lineId: "line-1", claims: [{ role: "CUSTOMER", pairs: 1 }] }])).toMatch(/Choose who each claim is against/);
  });

  it("reads anything that is not a list as no entries", () => {
    expect(parseReconciliationEntries("nonsense")).toEqual([]);
  });
});
