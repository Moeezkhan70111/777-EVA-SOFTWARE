import { describe, expect, it } from "vitest";
import { sessionGroups } from "./sessionGroups";

// The session card groups the data layer's per-material totals by category, and says each line's
// packets and quantity apart ("1 packet", "1 BUNDLE") rather than as "1 · 1 BUNDLE".

describe("sessionGroups", () => {
  const groups = sessionGroups(
    [
      { itemDisplayName: "DANA — EVA — RED", categoryLabel: "DANA — EVA", packets: 1, quantity: 25, unitCode: "KG" },
      { itemDisplayName: "UPPER — LADIES — DC1 — 6/9", categoryLabel: "UPPER — LADIES", packets: 2, quantity: 2, unitCode: "BUNDLE" },
      { itemDisplayName: "OLD NAME", categoryLabel: "", packets: 1, quantity: 3, unitCode: "DOZ" },
      { itemDisplayName: "UPPER — LADIES — DC2", categoryLabel: "UPPER — LADIES", packets: 1, quantity: 2, unitCode: "BUNDLE" },
    ],
    "No category"
  );

  it("puts each category's materials together, categories in name order and no category last", () => {
    expect(groups.map((group) => group.label)).toEqual(["DANA · EVA", "UPPER · LADIES", "No category"]);
    expect(groups[1].lines.map((line) => line.name)).toEqual(["DC1", "DC2"]);
  });

  it("counts a category's packets and keeps each line's packets and quantity apart", () => {
    expect(groups[1].count).toBe(3);
    expect(groups[1].lines[0]).toMatchObject({ name: "DC1", detail: "6/9", count: 2, amount: "2 BUNDLE" });
  });

  it("keeps a name that does not start with its category whole", () => {
    expect(groups[2].lines[0]).toMatchObject({ name: "OLD NAME", amount: "3 DOZ" });
  });
});
