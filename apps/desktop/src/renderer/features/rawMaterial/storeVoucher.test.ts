import { describe, expect, it } from "vitest";
import { quantityTotalLine } from "./storeVoucher";

// The per-unit total under the printed receipt and on the Store page's session card: quantities
// add up only within a unit, so a mixed session shows one total per unit, never one wrong sum.

describe("quantityTotalLine", () => {
  it("adds up a session of one unit to one total", () => {
    expect(
      quantityTotalLine([
        { itemDisplayName: "UPPER — LADIES — DC1", packets: 1, quantity: 1, unitCode: "BUNDLE" },
        { itemDisplayName: "UPPER — LADIES — DC2", packets: 1, quantity: 2, unitCode: "BUNDLE" },
      ])
    ).toBe("3 BUNDLE");
  });

  it("gives a mixed session one total per unit", () => {
    expect(
      quantityTotalLine([
        { itemDisplayName: "DANA — EVA — RED", packets: 2, quantity: 50, unitCode: "KG" },
        { itemDisplayName: "UPPER — LADIES — DC1", packets: 1, quantity: 1, unitCode: "BUNDLE" },
        { itemDisplayName: "UPPER — LADIES — DC2", packets: 1, quantity: 2, unitCode: "BUNDLE" },
      ])
    ).toBe("50 KG + 3 BUNDLE");
  });

  it("says nothing for an empty session", () => {
    expect(quantityTotalLine([])).toBe("");
  });
});
