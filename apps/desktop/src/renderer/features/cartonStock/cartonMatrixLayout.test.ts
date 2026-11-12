import { describe, expect, it } from "vitest";
import { CARTON_LAYOUT, cartonLayout, colourBands } from "./cartonMatrixLayout";

// Nothing on the Carton Stock page scrolls sideways: colours that do not fit continue in a band underneath.

describe("how many colours fit side by side", () => {
  it("fits as many 90px colour columns as the card leaves beside the name, Size and Total", () => {
    // 1500 − 2 borders − 200 name − 120 size − 120 total = 1058, so 11 colours.
    expect(cartonLayout(1500)).toEqual({ stacked: false, maxColours: 11, sizeWidth: 120, totalWidth: 120 });
    // A middle-sized window puts the name above, so the colours get the whole width: 840 − 2 − 96 − 96 = 646, so 7.
    expect(cartonLayout(840)).toEqual({ stacked: true, maxColours: 7, sizeWidth: 96, totalWidth: 96 });
  });

  it("puts the name above the matrix and narrows Size and Total on a small screen", () => {
    // 300 − 2 − 96 − 96 = 106, so 1 colour per band.
    expect(cartonLayout(300)).toEqual({ stacked: true, maxColours: 1, sizeWidth: 96, totalWidth: 96 });
    expect(cartonLayout(CARTON_LAYOUT.stackBelow - 1).stacked).toBe(true);
    expect(cartonLayout(CARTON_LAYOUT.stackBelow).stacked).toBe(false);
  });

  it("always fits at least one colour, and puts no limit before the list is measured", () => {
    expect(cartonLayout(100).maxColours).toBe(1);
    expect(cartonLayout(0).maxColours).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("colour bands", () => {
  it("keeps one band when every colour fits", () => {
    expect(colourBands(5, 8)).toEqual([[0, 1, 2, 3, 4]]);
    expect(colourBands(3, Number.POSITIVE_INFINITY)).toEqual([[0, 1, 2]]);
  });

  it("splits evenly, never leaving a short last band when it can be avoided", () => {
    expect(colourBands(14, 10)).toEqual([[0, 1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12, 13]]);
    expect(colourBands(9, 4).map((band) => band.length)).toEqual([3, 3, 3]);
    expect(colourBands(10, 4).map((band) => band.length)).toEqual([4, 4, 2]);
  });

  it("shows every colour exactly once, in order", () => {
    for (const [count, max] of [[17, 5], [3, 1], [40, 7]] as const) {
      expect(colourBands(count, max).flat()).toEqual(Array.from({ length: count }, (_, index) => index));
      expect(Math.max(...colourBands(count, max).map((band) => band.length))).toBeLessThanOrEqual(max);
    }
  });
});
