import { describe, expect, it } from "vitest";
import { DISCOUNT_KIND, articleLabel, boxText, cellKey, currentDiscounts, discountChanges, reportLinesFor } from "./discountPolicy";

// The Discount Policy page's rules (owner, 28 Nov 2026): each box starts with the customer's current discount, and Save
// sends only what changed, typed loosely and kept exactly.

const line = (partyId: string, type: string, label: string, discountPerPair: number) => ({ partyId, partyName: partyId.toUpperCase(), type, label, discountPerPair });
const REPORT = [
  line("p1", "PRODUCT_GROUP", "EVR GENTS", 35), line("p2", "PRODUCT_GROUP", "EVR GENTS", 50), line("p1", "PRODUCT_GROUP", "EVR KIDS", 20),
  line("p1", "ARTICLE", "SK6 / Size 7/10", 5), line("p1", "ARTICLE", "SK6", 4),
];

describe("the discount policy rules", () => {
  it("knows each customer's current discount on a group, and on an article's sizes", () => {
    const gents = currentDiscounts(REPORT, DISCOUNT_KIND.PRODUCT_GROUP, new Map([["", "EVR GENTS"]]));
    expect([...gents]).toEqual([[cellKey("p1"), 3500], [cellKey("p2"), 5000]]);
    const sizes = currentDiscounts(REPORT, DISCOUNT_KIND.ARTICLE, new Map([["7/10", articleLabel("SK6", "7/10")], ["10/13", articleLabel("SK6", "10/13")]]));
    expect([...sizes]).toEqual([[cellKey("p1", "7/10"), 500]]);
  });

  it("shows the current discount in a box until it is typed in", () => {
    const current = new Map([[cellKey("p1"), 3500]]);
    expect(boxText(cellKey("p1"), {}, current)).toBe("35");
    expect(boxText(cellKey("p1"), { [cellKey("p1")]: "" }, current)).toBe("");
    expect(boxText(cellKey("p2"), {}, current)).toBe("");
  });

  it("saves only boxes changed from their current discount, read loosely", () => {
    const current = new Map([[cellKey("p1"), 3500], [cellKey("p2"), 5000]]);
    const { changes, problems } = discountChanges({ [cellKey("p1")]: " 40 ", [cellKey("p2")]: "50", [cellKey("p3")]: "1,000", [cellKey("p4")]: "0" }, current);
    expect(changes.map((change) => [change.partyId, change.rupees])).toEqual([["p1", 40], ["p3", 1000]]);
    expect(problems.size).toBe(0);
  });

  it("says what to do with an emptied box, and with something that is not an amount", () => {
    const current = new Map([[cellKey("p1"), 3500]]);
    const { changes, problems } = discountChanges({ [cellKey("p1")]: "", [cellKey("p2")]: "abc" }, current);
    expect(changes).toEqual([]);
    expect(problems.get(cellKey("p1"))).toMatch(/Type 0/);
    expect(problems.get(cellKey("p2"))).toMatch(/rupees/);
  });

  it("filters the report by kind, leaving out what has no discount", () => {
    expect(reportLinesFor([...REPORT, line("p3", "PRODUCT_GROUP", "EVR GENTS", 0)], DISCOUNT_KIND.ARTICLE).map((row) => row.label)).toEqual(["SK6 / Size 7/10", "SK6"]);
    expect(reportLinesFor([...REPORT, line("p3", "PRODUCT_GROUP", "EVR GENTS", 0)], "ALL")).toHaveLength(5);
  });
});
