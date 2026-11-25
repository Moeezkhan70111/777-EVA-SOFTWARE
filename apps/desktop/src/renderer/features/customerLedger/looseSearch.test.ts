import { describe, expect, it } from "vitest";
import { amountText, looseMatches, looseText } from "./looseSearch";

describe("the ledger search takes what people type (Postel's law)", () => {
  it("reads voucher numbers without their separators and leading zeros", () => {
    expect(looseText("RV-00001")).toBe("rv1");
    expect(looseMatches(["RV-00001"], "rv1")).toBe(true);
    expect(looseMatches(["RV-00001"], "RV 1")).toBe(true);
    expect(looseMatches(["RV-00001"], "rv-00001")).toBe(true);
    expect(looseMatches(["RV-00001"], "rv12")).toBe(false);
  });

  it("finds an amount typed with or without commas or Rs.", () => {
    const row = ["SV-14", amountText(353_880)];
    expect(looseMatches(row, "353,880")).toBe(true);
    expect(looseMatches(row, "353880")).toBe(true);
    expect(looseMatches(row, "Rs. 353,880")).toBe(true);
    expect(looseMatches(row, "353,881")).toBe(false);
  });

  it("wants every word, in any order, and matches everything when empty", () => {
    expect(looseMatches(["Received on account", "Cash"], "cash received")).toBe(true);
    expect(looseMatches(["Received on account", "Cash"], "cheque received")).toBe(false);
    expect(looseMatches(["anything"], "  ")).toBe(true);
  });
});
