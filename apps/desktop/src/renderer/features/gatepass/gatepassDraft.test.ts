import { describe, expect, it } from "vitest";
import { buildStockGrid, rowKeyOf } from "../../utils/gatepassGrid";
import type { GatepassStockRow } from "../../types/desktopApi";
import { buildDraft, buildDraftFromDocument, checkQuantity, createBlocker, listArticleOptions, stepQuantity } from "./gatepassDraft";

// SK6 in two sizes and three colours, SK12 in one size, one colour — out of order on
// purpose, so the draft's own ordering is what is asserted. RED 7/10 carries a reservation
// (Current 120, Reserved 20, Reflected 100) and NAVY 4/6 is fully reserved.
const stockRow = (productVariantId: string, article: string, color: string, size: string, storeQuantity: number, reservedQuantity = 0): GatepassStockRow => ({
  productVariantId,
  article,
  color,
  size,
  groupName: null,
  storeQuantity,
  reservedQuantity,
  reflectedQuantity: storeQuantity - reservedQuantity,
});

const STOCK: GatepassStockRow[] = [
  stockRow("v-sk12-black-46", "SK12", "BLACK", "4/6", 40),
  stockRow("v-sk6-red-710", "SK6", "RED", "7/10", 120, 20),
  stockRow("v-sk6-red-46", "SK6", "RED", "4/6", 50),
  stockRow("v-sk6-blue-710", "SK6", "BLUE", "7/10", 80),
  stockRow("v-sk6-navy-46", "SK6", "NAVY", "4/6", 15, 15),
  stockRow("v-sk6-green-710", "SK6", "GREEN", "7/10", 0),
];

const grid = buildStockGrid(STOCK);
const SK6_710 = rowKeyOf("SK6", "7/10");
const SK6_46 = rowKeyOf("SK6", "4/6");
const SK12_46 = rowKeyOf("SK12", "4/6");

describe("checkQuantity", () => {
  it("treats empty and zero as not selected, rejects text, negatives, fractions and anything above Reflected Stock", () => {
    expect(checkQuantity("", 10)).toEqual({ value: 0, error: null });
    expect(checkQuantity("0", 10)).toEqual({ value: 0, error: null });
    expect(checkQuantity(" 7 ", 10)).toEqual({ value: 7, error: null });
    expect(checkQuantity("10", 10)).toEqual({ value: 10, error: null });
    expect(checkQuantity("abc", 10).error).toMatch(/whole number/i);
    expect(checkQuantity("-1", 10).error).toMatch(/negative/i);
    expect(checkQuantity("1.5", 10).error).toMatch(/whole cartons/i);
    expect(checkQuantity("11", 10)).toEqual({ value: null, error: "Only 10 available (Reflected Stock)" });
  });
});

describe("stepQuantity", () => {
  it("moves one carton at a time and never leaves 0…available", () => {
    expect(stepQuantity("", 1, 5)).toBe(1);
    expect(stepQuantity("4", 1, 5)).toBe(5);
    expect(stepQuantity("5", 1, 5)).toBe(5);
    expect(stepQuantity("1", -1, 5)).toBe(0);
    expect(stepQuantity("0", -1, 5)).toBe(0);
    // Unusable text starts again from 0; too much comes back to Reflected Stock.
    expect(stepQuantity("abc", 1, 5)).toBe(1);
    expect(stepQuantity("9", -1, 5)).toBe(5);
  });
});

describe("buildStockGrid", () => {
  it("keeps Current Stock, Reserved and Reflected Stock apart per colour, caps the input at Reflected Stock, and keeps a fully reserved colour on the grid", () => {
    const red = grid.rows.find((r) => r.key === SK6_710)!.cells.RED;
    expect(red).toEqual({ productVariantId: "v-sk6-red-710", currentStock: 120, reserved: 20, reflected: 100, available: 100 });
    const navy = grid.rows.find((r) => r.key === SK6_46)!.cells.NAVY;
    expect(navy).toEqual({ productVariantId: "v-sk6-navy-46", currentStock: 15, reserved: 15, reflected: 0, available: 0 });
    // Nothing physically In Store: not on the grid at all.
    expect(grid.rows.find((r) => r.key === SK6_710)!.cells.GREEN).toBeUndefined();
    // Over-committed (a free move-out took stock a gatepass still owes): the input allows nothing, the figure stays honest.
    const over = buildStockGrid([stockRow("v-x", "SK6", "RED", "7/10", 2, 3)]).rows[0].cells.RED;
    expect(over).toMatchObject({ currentStock: 2, reserved: 3, reflected: -1, available: 0 });
  });
});

describe("buildDraft", () => {
  it("keeps articles in the order they were added, colours in natural order, and drops colours with no store stock", () => {
    const draft = buildDraft(grid, [SK12_46, SK6_710], {});
    expect(draft.articles.map((a) => a.key)).toEqual([SK12_46, SK6_710]);
    expect(draft.articles[1].colours.map((c) => [c.colour, c.currentStock, c.reserved, c.reflected, c.available])).toEqual([
      ["BLUE", 80, 0, 80, 80],
      ["RED", 120, 20, 100, 100],
    ]);
    expect(draft.total).toBe(0);
    expect(draft.lines).toEqual([]);
  });

  it("adds up per article and overall, counts only colours with cartons, and sends lines in document order with the Reflected Stock seen", () => {
    const draft = buildDraft(grid, [SK12_46, SK6_710, SK6_46], {
      "v-sk6-red-710": "50",
      "v-sk6-blue-710": "20",
      "v-sk12-black-46": "5",
      "v-sk6-red-46": "0",
    });
    const sk6 = draft.articles.find((a) => a.key === SK6_710)!;
    expect(sk6.total).toBe(70);
    expect(sk6.selectedCount).toBe(2);
    expect(draft.articles.find((a) => a.key === SK6_46)!.total).toBe(0);
    expect(draft.articleCount).toBe(2);
    expect(draft.colourCount).toBe(3);
    expect(draft.total).toBe(75);
    expect(draft.errorCount).toBe(0);
    // Article, size, then colour — the way the book (and the print-out) reads.
    expect(draft.lines).toEqual([
      { productVariantId: "v-sk6-blue-710", quantity: 20, reflectedStockSeen: 80 },
      { productVariantId: "v-sk6-red-710", quantity: 50, reflectedStockSeen: 100 },
      { productVariantId: "v-sk12-black-46", quantity: 5, reflectedStockSeen: 40 },
    ]);
  });

  it("refuses more than Reflected Stock even when Current Stock would cover it, and leaves a bad line out of what would be sent", () => {
    // RED 7/10: 120 In Store, 20 reserved → 101 is refused although the store physically holds it.
    const draft = buildDraft(grid, [SK6_710], { "v-sk6-red-710": "101", "v-sk6-blue-710": "10" });
    const sk6 = draft.articles[0];
    expect(sk6.errorCount).toBe(1);
    expect(sk6.colours.find((c) => c.colour === "RED")!.check.error).toBe("Only 100 available (Reflected Stock)");
    expect(draft.errorCount).toBe(1);
    expect(draft.total).toBe(10);
    expect(draft.lines).toEqual([{ productVariantId: "v-sk6-blue-710", quantity: 10, reflectedStockSeen: 80 }]);
    // Exactly Reflected Stock is fine.
    expect(buildDraft(grid, [SK6_710], { "v-sk6-red-710": "100" }).errorCount).toBe(0);
    // A fully reserved colour cannot take even one carton.
    expect(buildDraft(grid, [SK6_46], { "v-sk6-navy-46": "1" }).articles[0].colours.find((c) => c.colour === "NAVY")!.check.error).toBe("Only 0 available (Reflected Stock)");
  });

  it("ignores an added key the store no longer holds", () => {
    const draft = buildDraft(grid, [rowKeyOf("SK99", "1/2")], {});
    expect(draft.articles).toEqual([]);
  });
});

describe("createBlocker", () => {
  it("wants a party, then no errors, then at least one line", () => {
    const empty = buildDraft(grid, [SK6_710], {});
    expect(createBlocker(empty, "")).toBe("Select a party first.");
    expect(createBlocker(empty, "p-1")).toBe("Add an article and enter at least one quantity.");
    const bad = buildDraft(grid, [SK6_710], { "v-sk6-red-710": "999" });
    expect(createBlocker(bad, "p-1")).toBe("Fix the highlighted quantities first.");
    const good = buildDraft(grid, [SK6_710], { "v-sk6-red-710": "1" });
    expect(createBlocker(good, "p-1")).toBeNull();
  });
});

describe("listArticleOptions", () => {
  it("offers every article + size in store — name and size only", () => {
    expect(listArticleOptions(grid)).toEqual([
      { id: SK6_46, label: "SK6 · 4/6" },
      { id: SK6_710, label: "SK6 · 7/10" },
      { id: SK12_46, label: "SK12 · 4/6" },
    ]);
  });
});

describe("buildDraftFromDocument", () => {
  it("shows a stored document in the draft's shape: article + size cards, colours in natural order, stock at creation, move-out progress, no errors", () => {
    const draft = buildDraftFromDocument({
      lines: [
        { id: "l1", lineNo: 1, productVariantId: "v-sk12-black-46", groupName: null, article: "SK12", color: "BLACK", size: "4/6", quantity: 30, storeQuantityAtCreation: 40, dispatchedFromStoreQuantity: 0, outstandingQuantity: 30 },
        { id: "l2", lineNo: 2, productVariantId: "v-sk6-red-710", groupName: null, article: "SK6", color: "RED", size: "7/10", quantity: 50, storeQuantityAtCreation: 120, dispatchedFromStoreQuantity: 50, outstandingQuantity: 0 },
        { id: "l3", lineNo: 3, productVariantId: "v-sk6-blue-710", groupName: null, article: "SK6", color: "BLUE", size: "7/10", quantity: 20, storeQuantityAtCreation: 80, dispatchedFromStoreQuantity: 5, outstandingQuantity: 15 },
      ],
    });
    expect(draft.articles.map((a) => [a.key, a.total, a.selectedCount])).toEqual([
      [SK6_710, 70, 2],
      [SK12_46, 30, 1],
    ]);
    expect(draft.articles[0].colours.map((c) => [c.colour, c.currentStock, c.text, c.check, c.progress])).toEqual([
      ["BLUE", 80, "20", { value: 20, error: null }, { dispatchedFromStore: 5, outstanding: 15 }],
      ["RED", 120, "50", { value: 50, error: null }, { dispatchedFromStore: 50, outstanding: 0 }],
    ]);
    expect(draft.total).toBe(100);
    expect(draft.articleCount).toBe(2);
    expect(draft.colourCount).toBe(3);
    expect(draft.errorCount).toBe(0);
  });
});
