import { describe, expect, it } from "vitest";
import { entryGrid } from "./stockAdjustmentDraft";
import { canStepDown, stepEntries, stepTotals, stepped } from "./stepperDraft";

const choice = (size: string, color: string, inStore: number, hasOpening = false) => ({
  articleSizeId: `as-${size}`, size, color, inStore, hasOpening, colorMissing: false,
});

describe("the + / − view", () => {
  it("keeps a signed change per cell and drops a cell pressed back to nothing", () => {
    let steps = stepped({}, "a", 1);
    steps = stepped(steps, "a", 1);
    expect(steps).toEqual({ a: 2 });
    expect(stepped(stepped({}, "a", 1), "a", -1)).toEqual({});
  });

  it("makes an Increase for a rise and a Decrease for a fall, in whole cartons", () => {
    const choices = [choice("7/10", "RED", 10), choice("10/13", "RED", 0), choice("7/10", "BLUE", 4)];
    const lines = stepEntries("SK6", choices, { "as-7/10|RED": -3, "as-10/13|RED": 2 }, "ADJUSTMENT");
    expect(lines.map(({ size, color, direction, cartons }) => ({ size, color, direction, cartons }))).toEqual([
      { size: "7/10", color: "RED", direction: "OUT", cartons: 3 },
      { size: "10/13", color: "RED", direction: "IN", cartons: 2 },
    ]);
  });

  it("on Opening Stock leaves out sizes already opened and only takes back what was added", () => {
    const lines = stepEntries("SK6", [choice("7/10", "RED", 10, true)], { "as-7/10|RED": 2 }, "OPENING");
    expect(lines).toEqual([]);
    expect(canStepDown("OPENING", 0)).toBe(false);
    expect(canStepDown("OPENING", 1)).toBe(true);
    expect(canStepDown("ADJUSTMENT", 0)).toBe(true);
  });

  it("adds the card up after the changes, as Carton Stock does", () => {
    const grid = entryGrid([choice("7/10", "RED", 10), choice("10/13", "RED", 0), choice("7/10", "BLUE", 4)]);
    expect(stepTotals(grid, { "as-10/13|RED": 2, "as-7/10|BLUE": -1 })).toEqual({ bySize: [13, 2], byColour: [3, 12], grand: 15 });
  });
});
