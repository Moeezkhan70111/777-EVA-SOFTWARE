import { describe, expect, it } from "vitest";
import { CARTON_LAYOUT, cartonLayout } from "./cartonMatrixLayout";

// The card's layout: the name beside the matrix on a wide list, above it on a narrow one. Colours that do not fit
// scroll sideways (CartonMatrix); the layout no longer splits them.

describe("the card's layout", () => {
  it("keeps the name beside the matrix, with full Size and Total columns, on a wide list", () => {
    expect(cartonLayout(1500)).toEqual({ stacked: false, sizeWidth: 120, totalWidth: 120 });
  });

  it("puts the name above the matrix and narrows Size and Total on a narrow list", () => {
    expect(cartonLayout(840)).toEqual({ stacked: true, sizeWidth: 96, totalWidth: 96 });
    expect(cartonLayout(CARTON_LAYOUT.stackBelow - 1).stacked).toBe(true);
    expect(cartonLayout(CARTON_LAYOUT.stackBelow).stacked).toBe(false);
  });

  it("uses the wide layout before the list is measured", () => {
    expect(cartonLayout(0).stacked).toBe(false);
  });
});
