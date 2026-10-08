import { describe, expect, it } from "vitest";
import { billTotals, lineFromGatepass, lineFromSavedItem, rateForPriceType, savedLineFollowsRule, withFigures } from "./billLines";
import { projectPartyCredit } from "./partyCredit";

describe("bill lines", () => {
  it("derives every figure from dozens, rate per pair and less per pair — the domain formula, not the screen's own arithmetic", () => {
    const line = lineFromGatepass({ productVariantId: "v-1", article: "SK6", size: "7/10", dozens: 10.5 }, { normalRate: 550, pairDisc: 10, discSource: "ARTICLE" });
    expect(line).toMatchObject({ priceType: "NORMAL", dznQty: 10.5, pairRate: 550, pairDisc: 10, discSource: "ARTICLE", unitQty: 21, dznRate: 6600, amount: 69300, dznDisc: 120, totalDisc: 1260, total: 68040 });
  });

  it("B-TYPE never carries a discount, whatever was typed or resolved", () => {
    const line = withFigures({ productVariantId: "v-1", article: "SK6", size: "7/10", priceType: "B_TYPE", normalRate: 550, dznQty: 2, pairRate: 380, pairDisc: 25, discSource: "ARTICLE" });
    expect(line.pairDisc).toBe(0);
    expect(line.totalDisc).toBe(0);
    expect(line.total).toBe(line.amount);
  });

  it("reads a saved line back as dozens, rate and less per pair (from the stored total less)", () => {
    const line = lineFromSavedItem({ id: "li-1", productVariantId: "v-1", quantity: 10, priceType: "NORMAL", unitPrice: 550, discount: 1200, discountPerPair: 10, discountSource: "ARTICLE", totalPrice: 64800, article: "SK6", color: "BLUE", size: "7/10" });
    expect(line).toMatchObject({ id: "li-1", dznQty: 10, pairRate: 550, pairDisc: 10, discSource: "ARTICLE", total: 64800, priceType: "NORMAL", normalRate: null });
    expect("color" in line).toBe(false);
  });

  it("keeps a saved line's price type, so a B-TYPE line reopens as B-TYPE with no less", () => {
    const line = lineFromSavedItem({ id: "li-b", productVariantId: "v-1", quantity: 2, priceType: "B_TYPE", unitPrice: 380, discount: 0, discountPerPair: 0, discountSource: "NONE", totalPrice: 9120, article: "SK6", color: "BLUE", size: "7/10" });
    expect(line).toMatchObject({ priceType: "B_TYPE", pairRate: 380, pairDisc: 0, discSource: "", total: 9120 });
  });

  it("tells a line left on the party's rule from one the clerk typed a figure on", () => {
    const saved = { id: "li-1", productVariantId: "v-1", quantity: 10, priceType: "NORMAL" as const, unitPrice: 550, totalPrice: 0, article: "SK6", color: "BLUE", size: "7/10" };
    // The rule gave Rs 10 / pair and the line carries exactly that (10 dozen × 12 × 10).
    expect(savedLineFollowsRule({ ...saved, discount: 1200, discountPerPair: 10, discountSource: "ARTICLE" })).toBe(true);
    // No rule when it was saved, no less: still on the rule (there just was none).
    expect(savedLineFollowsRule({ ...saved, discount: 0, discountPerPair: 0, discountSource: "NONE" })).toBe(true);
    // The clerk typed a lower less than the rule's — theirs to keep, and unlabelled.
    const typed = { ...saved, discount: 600, discountPerPair: 10, discountSource: "ARTICLE" as const };
    expect(savedLineFollowsRule(typed)).toBe(false);
    expect(lineFromSavedItem(typed)).toMatchObject({ pairDisc: 5, discSource: "" });
  });

  it("sums dozens, gross, less and net across the bill", () => {
    const a = lineFromGatepass({ productVariantId: "v-1", article: "SK6", size: "7/10", dozens: 10 }, { normalRate: 550, pairDisc: 10, discSource: "ARTICLE" });
    const b = lineFromGatepass({ productVariantId: "v-2", article: "SK9", size: "11/13", dozens: 5 }, { normalRate: 600, pairDisc: 0, discSource: "" });
    expect(billTotals([a, b])).toEqual({ dzn: 15, gross: 102000, disc: 1200, net: 100800 });
    expect(billTotals([])).toEqual({ dzn: 0, gross: 0, disc: 0, net: 0 });
  });

  it("switches rate with the price type from the NORMAL price, and refuses to invent B-TYPE without one", () => {
    expect(rateForPriceType("NORMAL", 550)).toEqual({ ok: true, rate: 550 });
    expect(rateForPriceType("B_TYPE", 550)).toEqual({ ok: true, rate: 380 });
    expect(rateForPriceType("B_TYPE", 450)).toEqual({ ok: true, rate: 300 });
    expect(rateForPriceType("B_TYPE", null)).toEqual({ ok: false });
    expect(rateForPriceType("NORMAL", 0)).toEqual({ ok: false });
  });
});

describe("projectPartyCredit", () => {
  it("projects the balance after the bill against the limit, the way the save-time check does", () => {
    expect(projectPartyCredit({ balance: 185000, limit: 250000, billTotal: 100800 })).toEqual({ balance: 185000, limit: 250000, projected: 285800, available: 65000, exceedsBy: 35800 });
    expect(projectPartyCredit({ balance: 185000, limit: 300000, billTotal: 100800 })).toEqual({ balance: 185000, limit: 300000, projected: 285800, available: 115000, exceedsBy: 0 });
    expect(projectPartyCredit({ balance: 320000, limit: 300000, billTotal: 0 })).toMatchObject({ available: 0, exceedsBy: 20000 });
  });

  it("has nothing to say about a limit when the party has none", () => {
    expect(projectPartyCredit({ balance: 185000, limit: null, billTotal: 100800 })).toEqual({ balance: 185000, limit: null, projected: 285800, available: null, exceedsBy: 0 });
  });
});
