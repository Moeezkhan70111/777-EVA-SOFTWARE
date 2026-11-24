import { describe, expect, it } from "vitest";
import { buildStockGrid } from "../../utils/gatepassGrid";
import { missingColoursOf, sizesMissingColour } from "./colourGaps";
import type { GatepassStockRow } from "../../types/desktopApi";

// Owner, 24 Nov 2026: SK46 is made in BLACKRED in 8/10 but not in 7/10, so the 7/10 card has no BLACKRED row. The card
// now says which of the article's colours its size is not made in.

const row = (size: string, color: string): GatepassStockRow =>
  ({ productVariantId: `SK46-${color}-${size}`, article: "SK46", color, size, groupName: null, storeQuantity: 0, reservedQuantity: 0, reflectedQuantity: 0 }) as GatepassStockRow;

const GRID = buildStockGrid([
  row("7/10", "BLACKBLUE"), row("7/10", "NAVY"),
  row("8/10", "BLACKBLUE"), row("8/10", "BLACKRED"), row("8/10", "BLACKNEON"),
  row("4/6", "BLACKBLUE"),
]);

describe("colour gaps", () => {
  it("names the article's colours a size is not made in", () => {
    expect(missingColoursOf(GRID, "SK46", "7/10")).toEqual(["BLACKNEON", "BLACKRED"]);
    expect(missingColoursOf(GRID, "SK46", "8/10")).toEqual(["NAVY"]);
    expect(missingColoursOf(GRID, "SK12", "7/10")).toEqual([]);
  });

  it("says every size a colour would be added to", () => {
    expect(sizesMissingColour(GRID, "SK46", "BLACKRED")).toEqual(["4/6", "7/10"]);
  });
});
