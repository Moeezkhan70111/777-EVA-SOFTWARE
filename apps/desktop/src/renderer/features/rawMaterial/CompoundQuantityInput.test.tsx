import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompoundQuantityInput, compoundTotal, quantityUnits } from "./CompoundQuantityInput";
import type { ItemUnitLadder } from "../../types/desktopApi";

// Typing a count the way the store says it. The real case: NAWAAR, whose roll is 975 metres
// and whose metre the shop floor measures as 40 inches. The operator types "2 ROLL" and
// "37 INCH" and never multiplies anything out.

const NAWAAR: ItemUnitLadder = {
  itemId: "item-1",
  steps: [
    { id: "s1", stepOrder: 0, fromUnitId: "u-roll", fromUnit: "ROLL", toUnitId: "u-metre", toUnit: "METRE", factor: 975 },
    { id: "s2", stepOrder: 1, fromUnitId: "u-metre", fromUnit: "METRE", toUnitId: "u-inch", toUnit: "INCH", factor: 40 },
  ],
  baseUnit: "INCH",
  stockUnit: "INCH",
  stockUnitId: "u-inch",
};

const NO_LADDER: ItemUnitLadder = {
  itemId: "item-2",
  steps: [],
  baseUnit: null,
  stockUnit: "CAN",
  stockUnitId: "u-can",
};

describe("which boxes are offered", () => {
  it("one per rung of the ladder, biggest first", () => {
    expect(quantityUnits(NAWAAR)).toEqual(["ROLL", "METRE", "INCH"]);
  });

  it("one box in the material's own unit when it has no ladder", () => {
    expect(quantityUnits(NO_LADDER)).toEqual(["CAN"]);
  });

  it("falls back to the unit the caller knows while the ladder is still loading", () => {
    expect(quantityUnits(null, "DOZEN")).toEqual(["DOZEN"]);
    expect(quantityUnits(null)).toEqual([]);
  });
});

describe("what the typed boxes come to", () => {
  it("adds the rungs up into the unit the stock is held in", () => {
    expect(compoundTotal(NAWAAR, { ROLL: "2", INCH: "37" })).toBe(78_037);
    expect(compoundTotal(NAWAAR, { ROLL: "62" })).toBe(2_418_000);
  });

  it("is not a number until something is typed", () => {
    expect(Number.isNaN(compoundTotal(NAWAAR, {}))).toBe(true);
    expect(Number.isNaN(compoundTotal(NAWAAR, { ROLL: "   " }))).toBe(true);
  });

  it("passes a single box straight through", () => {
    expect(compoundTotal(NO_LADDER, { CAN: "-3" })).toBe(-3);
    expect(compoundTotal(null, { DOZEN: "4" }, "DOZEN")).toBe(4);
  });

  it("refuses something that is not a number", () => {
    expect(Number.isNaN(compoundTotal(NAWAAR, { ROLL: "two" }))).toBe(true);
  });
});

describe("the control itself", () => {
  it("shows a box per rung, each named by its unit, and reports what was typed", async () => {
    const onChange = vi.fn();
    render(
      <CompoundQuantityInput ladder={NAWAAR} value={{}} onChange={onChange} label="Correct the count by" idPrefix="t" />,
    );

    expect(screen.getByRole("group", { name: "Correct the count by" })).toBeInTheDocument();
    for (const unit of ["ROLL", "METRE", "INCH"]) {
      expect(screen.getByLabelText(unit)).toBeInTheDocument();
    }

    await userEvent.type(screen.getByLabelText("ROLL"), "2");
    expect(onChange).toHaveBeenLastCalledWith({ ROLL: "2" });
  });

  it("with a single unit the box itself carries the name, so the screen reads as it always did", () => {
    render(
      <CompoundQuantityInput ladder={NO_LADDER} value={{}} onChange={vi.fn()} label="Correct the count by" idPrefix="t" />,
    );
    expect(screen.getByLabelText("Correct the count by")).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("shows nothing at all when there is no unit to count in", () => {
    const { container } = render(
      <CompoundQuantityInput ladder={null} value={{}} onChange={vi.fn()} label="Correct the count by" idPrefix="t" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
