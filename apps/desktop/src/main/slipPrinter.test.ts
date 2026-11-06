import { describe, expect, it } from "vitest";
import { findSlipPrinter, slipPageSize } from "./slipPrinter";

describe("findSlipPrinter", () => {
  const OFFICE = [{ name: "Hewlett-Packard HP LaserJet Pro MFP M127fn" }, { name: "Microsoft Print to PDF" }];

  it("finds the Star by its model, however this computer names it", () => {
    expect(findSlipPrinter([...OFFICE, { name: "Star TSP800II (TSP847II)" }])).toBe("Star TSP800II (TSP847II)");
    expect(findSlipPrinter([{ name: "star tsp800ii cutter" }, ...OFFICE])).toBe("star tsp800ii cutter");
  });

  it("never settles for another printer", () => {
    expect(findSlipPrinter(OFFICE)).toBeNull();
    expect(findSlipPrinter([])).toBeNull();
  });
});

describe("slipPageSize", () => {
  it("is the width of the roll, and as long as the slip plus the feed to the cutter", () => {
    // 1920 CSS pixels are 20 inches: 508 mm, and 8 mm of feed.
    expect(slipPageSize(1920)).toEqual({ width: 104000, height: 516000 });
  });

  it("stays taller than wide for a short slip, and stops at about a metre", () => {
    expect(slipPageSize(100).height).toBe(120000);
    expect(slipPageSize(100000).height).toBe(1000000);
  });
});
