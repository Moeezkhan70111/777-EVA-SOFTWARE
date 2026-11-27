import { describe, expect, it } from "vitest";
import type { CustomerOrder } from "../../types/desktopApi";
import { articleGrid, blockLines, blockProblems, blockTotals, cellKey, draftFromOrder, draftReady, draftSteps, newBlock, withoutRemoved, withProducts } from "./orderDraft";

const PRODUCTS = [
  { productVariantId: "red-6", size: "6", color: "RED" },
  { productVariantId: "red-7", size: "7", color: "RED" },
  { productVariantId: "blue-6", size: "6", color: "BLUE" },
  { productVariantId: "black-7", size: "7", color: "BLACK" },
];

describe("the order draft", () => {
  it("lays an article out as sizes down and colours across, with a box only where the product is made", () => {
    const grid = articleGrid(PRODUCTS);
    expect(grid.sizes.map((size) => size.size)).toEqual(["6", "7"]);
    expect(grid.colours).toEqual(["BLACK", "BLUE", "RED"]);
    expect(grid.cells.get(cellKey("7", "BLUE"))).toBeUndefined();
    expect(grid.cells.get(cellKey("6", "RED"))).toBe("red-6");
  });

  // Owner, 24 Nov 2026: typed in DOZENS, kept and sent in cartons (1 dozen = 2 cartons).
  // Owner, 27 Nov 2026: "DONT MAKE IT SELECT THE COLOR FIRST. OPEN ALL THE COLORS IN THE TABLE".
  it("opens every colour at once, takes dozens, and totals and sends them as cartons, an empty box no line", () => {
    let block = newBlock("SK6", PRODUCTS);
    expect(block.colours).toEqual(["BLACK", "BLUE", "RED"]);
    block = { ...block, typed: { "red-6": "10", "red-7": "20.5", "blue-6": "15" } };
    const totals = blockTotals(block);
    expect(Object.fromEntries(totals.byColour)).toEqual({ BLACK: 0, BLUE: 30, RED: 61 });
    expect(totals.total).toBe(91);
    expect(blockLines(block)).toEqual([
      { productVariantId: "red-6", quantity: 20 },
      { productVariantId: "red-7", quantity: 41 },
      { productVariantId: "blue-6", quantity: 30 },
    ]);
  });

  it("a colour added to the article opens as a column, and what was typed stays", () => {
    const block = { ...newBlock("SK6", PRODUCTS), typed: { "red-6": "10" } };
    const added = withProducts(block, [...PRODUCTS, { productVariantId: "white-6", size: "6", color: "WHITE" }]);
    expect(added.colours).toEqual(["BLACK", "BLUE", "RED", "WHITE"]);
    expect(added.typed).toEqual({ "red-6": "10" });
  });

  it("a colour removed from the article loses its column, and what was typed in it", () => {
    const block = { ...newBlock("SK6", PRODUCTS), typed: { "red-6": "10", "black-7": "3" } };
    const removed = withoutRemoved(block, PRODUCTS.filter((product) => product.color !== "BLACK"));
    expect(removed.colours).toEqual(["BLUE", "RED"]);
    expect(removed.typed).toEqual({ "red-6": "10" });
  });

  it("refuses a quantity that is not whole or half dozens above 0, and one below what was already dispatched", () => {
    // 2 dozen is 4 cartons, below the 5 cartons (2.5 dozen) already dispatched.
    const block = { ...newBlock("SK6", PRODUCTS), typed: { "red-6": "2.25", "red-7": "2" }, dispatched: { "red-7": 5 } };
    const problems = blockProblems(block);
    expect(problems.get("red-6")).toMatch(/whole or half dozens/);
    expect(problems.get("red-7")).toBe("At least 2.5 dozen: already dispatched.");
    expect(draftReady({ partyId: "p", note: "", blocks: [block] })).toBe(false);
  });

  it("is ready only with a party, a line, and no problem", () => {
    const block = { ...newBlock("SK6", PRODUCTS), typed: { "red-6": "4" } };
    expect(draftReady({ partyId: "", note: "", blocks: [block] })).toBe(false);
    expect(draftReady({ partyId: "p", note: "", blocks: [] })).toBe(false);
    expect(draftReady({ partyId: "p", note: "", blocks: [block] })).toBe(true);
  });

  it("brings a stored order back as blocks, every colour open and dispatched figures kept", () => {
    const order = {
      partyId: "p", note: "by Friday",
      lines: [
        { id: "l1", lineNo: 1, productVariantId: "red-6", article: "SK6", color: "RED", size: "6", quantity: 10, dispatched: 4, pending: 6 },
        { id: "l2", lineNo: 2, productVariantId: "x-1", article: "SK9", color: "TAN", size: "8", quantity: 3, dispatched: 0, pending: 3 },
      ],
    } as unknown as CustomerOrder;
    const draft = draftFromOrder(order, (article) => (article === "SK6" ? PRODUCTS : []));
    expect(draft.blocks.map((block) => [block.article, block.colours, block.typed])).toEqual([
      ["SK6", ["BLACK", "BLUE", "RED"], { "red-6": "5" }],
      ["SK9", ["TAN"], { "x-1": "1.5" }],
    ]);
    expect(draft.blocks[0]?.dispatched).toEqual({ "red-6": 4 });
    expect(draft.blocks[1]?.products).toHaveLength(1);
  });

  it("says which of the three steps are done and what to do next", () => {
    const block = newBlock("SK6", PRODUCTS);
    expect(draftSteps({ partyId: "", note: "", blocks: [] })).toEqual({ party: false, articles: false, dozens: false, next: "party" });
    expect(draftSteps({ partyId: "p", note: "", blocks: [] }).next).toBe("articles");
    expect(draftSteps({ partyId: "p", note: "", blocks: [block] }).next).toBe("dozens");
    expect(draftSteps({ partyId: "p", note: "", blocks: [{ ...block, typed: { "red-6": "0.3" } }] }).next).toBe("fix");
    expect(draftSteps({ partyId: "p", note: "", blocks: [{ ...block, typed: { "red-6": "4" } }] })).toEqual({ party: true, articles: true, dozens: true, next: "ready" });
  });
});
