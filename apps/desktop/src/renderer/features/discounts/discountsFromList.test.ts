import { describe, expect, it } from "vitest";
import { discountOf, readDiscountList } from "./discountsFromList";

const PARTIES = [
  { id: "p1", partyName: "ABDUL GHANI HYDERABAD", partyNameUrdu: "عبدل غنی حیدرآباد" },
  { id: "p2", partyName: "QZ Hyderabad", partyNameUrdu: "حیدرآباد QZ" },
  { id: "p3", partyName: "Kilaash Chappal Hyderabad" },
];

describe("readDiscountList", () => {
  it("reads a pasted table, Excel cells and Urdu names, skipping the header and ruling line", () => {
    const text = "| Party | Discount |\n| --- | --- |\n| ABDUL GHANI HYDERABAD | 12 |\nqz  hyderabad\t7.5\n| عبدل غنی حیدرآباد | Rs 13 |";
    const reading = readDiscountList(text, PARTIES);
    expect(reading.matched).toEqual([
      { partyId: "p1", partyName: "ABDUL GHANI HYDERABAD", discountPerPair: 13 },
      { partyId: "p2", partyName: "QZ Hyderabad", discountPerPair: 7.5 },
    ]);
    expect(reading.repeated).toEqual(["ABDUL GHANI HYDERABAD"]);
    expect(reading.unmatched).toEqual([]);
  });

  it("lists names that are not customers and lines without a usable discount, and uses neither", () => {
    const reading = readDiscountList("NOBODY TRADERS | 10\nKilaash Chappal Hyderabad | ten\nKilaash Chappal Hyderabad | -4", PARTIES);
    expect(reading.matched).toEqual([]);
    expect(reading.unmatched).toEqual(["NOBODY TRADERS"]);
    expect(reading.invalid).toEqual(["Kilaash Chappal Hyderabad | ten", "Kilaash Chappal Hyderabad | -4"]);
  });

  it("takes a discount loosely and keeps it exact", () => {
    expect(discountOf("1,000")).toBe(1000);
    expect(discountOf("12.50")).toBe(12.5);
    expect(discountOf("12.555")).toBeNull();
    expect(discountOf("")).toBeNull();
  });
});
