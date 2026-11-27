import { describe, expect, it } from "vitest";
import { discountMatrix } from "./discountMatrix";

// The Discount Policy PDF as a grid (owner, 28 Nov 2026): one row per party, one column per group.

const rule = (partyId: string, partyName: string, label: string, discountPerPair: number, type = "PRODUCT_GROUP") => ({ partyId, partyName, type, label, discountPerPair });

describe("the discount grid", () => {
  it("puts each party on one row and each group in its own column, Gents, Kids, Ladies, parties A to Z", () => {
    const grid = discountMatrix([
      rule("p2", "PARTY 2", "EVR LADIES", 50), rule("p1", "PARTY 1", "EVR GENTS", 10), rule("p2", "PARTY 2", "EVR GENTS", 50),
      rule("p1", "PARTY 1", "EVR KIDS", 20), rule("p1", "PARTY 1", "EVR LADIES", 50), rule("p2", "PARTY 2", "EVR KIDS", 10),
    ]);
    expect(grid.columns.map((column) => column.label)).toEqual(["EVR GENTS", "EVR KIDS", "EVR LADIES"]);
    expect(grid.rows.map((row) => [row.partyName, ...grid.columns.map((column) => row.cells[column.key])])).toEqual([
      ["PARTY 1", 10, 20, 50],
      ["PARTY 2", 50, 10, 50],
    ]);
  });

  it("leaves a cell empty where a party has no rule, and puts groups before series, articles and ranges", () => {
    const grid = discountMatrix([
      rule("p1", "PARTY 1", "SK6", 5, "ARTICLE"), rule("p1", "PARTY 1", "EVR GENTS", 10), rule("p2", "PARTY 2", "X SERIES", 7, "ARTICLE_SERIES"),
    ]);
    expect(grid.columns.map((column) => column.label)).toEqual(["EVR GENTS", "X SERIES", "SK6"]);
    expect(grid.rows[1]?.cells[grid.columns[0]!.key]).toBeUndefined();
  });

  it("is empty for an empty report", () => {
    expect(discountMatrix([])).toEqual({ columns: [], rows: [] });
  });
});
