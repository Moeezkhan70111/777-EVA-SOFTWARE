import { describe, expect, it } from "vitest";
import { categoryCounts, groupStockPage, sortForStock, stockNameParts } from "./stockGroups";

// The Stock tab groups its materials by category and sub-category: each group sits together, a
// page is cut into its groups, and each category says what it holds across the whole list.

const item = (name: string, top: string, sub: string, onHand: number) => ({
  id: name,
  display_name: name,
  top_category_name: top,
  sub_category_name: sub,
  quantity_on_hand: onHand,
});

const ITEMS = [
  item("THREAD — NYLON — T-40 — MIDNIGHT BLUE", "THREAD", "NYLON", 1240),
  item("BUCKLES — D-BUCKLE — 1.5 INCH — GOL", "BUCKLES", "D-BUCKLE", 4810),
  item("BUCKLES — 2 INCH — PLAIN", "BUCKLES", "", 0),
  item("BUCKLES — D-BUCKLE — 1 INCH — DOUBLE PIROYI", "BUCKLES", "D-BUCKLE", 4800),
];

describe("stockGroups", () => {
  const sorted = sortForStock(ITEMS);

  it("orders by category, then sub-category with the category's own materials first, then name", () => {
    expect(sorted.map((row) => row.display_name)).toEqual([
      "BUCKLES — 2 INCH — PLAIN",
      "BUCKLES — D-BUCKLE — 1 INCH — DOUBLE PIROYI",
      "BUCKLES — D-BUCKLE — 1.5 INCH — GOL",
      "THREAD — NYLON — T-40 — MIDNIGHT BLUE",
    ]);
  });

  it("orders numbers in names by value: DC5 before DC47", () => {
    const names = sortForStock([item("UPPER — DC47", "UPPER", "", 1), item("UPPER — DC5", "UPPER", "", 1)]).map((row) => row.display_name);
    expect(names).toEqual(["UPPER — DC5", "UPPER — DC47"]);
  });

  it("cuts a page into its categories and their sub-categories", () => {
    const groups = groupStockPage(sorted);
    expect(groups.map((group) => group.category)).toEqual(["BUCKLES", "THREAD"]);
    expect(groups[0].subGroups.map((sub) => `${sub.subCategory}:${sub.items.length}`)).toEqual([":1", "D-BUCKLE:2"]);
  });

  it("counts each category's materials and those with something in store", () => {
    expect(categoryCounts(ITEMS).get("BUCKLES")).toEqual({ materials: 3, inStock: 2 });
  });

  it("splits a name into what leads and the rest, without the category", () => {
    expect(stockNameParts(sorted[1])).toEqual({ lead: "1 INCH", rest: "DOUBLE PIROYI" });
    expect(stockNameParts(sorted[0])).toEqual({ lead: "2 INCH", rest: "PLAIN" });
  });
});
