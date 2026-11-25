import { describe, expect, it } from "vitest";
import { buildStockGrid } from "../../utils/gatepassGrid";
import { sizesMissingColour } from "./colourGaps";
import type { GatepassStockRow } from "../../types/desktopApi";

// Owner, 24 Nov 2026: SK46 is made in BLACKRED in 8/10 but not in 7/10, so the 7/10 cell of the grid has no box. Adding
// the colour adds it to every size it is missing from.

const row = (size: string, color: string): GatepassStockRow =>
  ({ productVariantId: `SK46-${color}-${size}`, article: "SK46", color, size, groupName: null, storeQuantity: 0, reservedQuantity: 0, reflectedQuantity: 0 }) as GatepassStockRow;

const GRID = buildStockGrid([
  row("7/10", "BLACKBLUE"), row("7/10", "NAVY"),
  row("8/10", "BLACKBLUE"), row("8/10", "BLACKRED"), row("8/10", "BLACKNEON"),
  row("4/6", "BLACKBLUE"),
]);

describe("colour gaps", () => {
  it("says every size a colour would be added to", () => {
    expect(sizesMissingColour(GRID, "SK46", "BLACKRED")).toEqual(["4/6", "7/10"]);
  });
});
