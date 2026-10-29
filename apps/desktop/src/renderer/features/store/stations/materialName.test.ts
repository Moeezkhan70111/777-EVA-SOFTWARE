import { describe, expect, it } from "vitest";
import { splitMaterialName } from "./materialName";

const PATHS = ["UPPER", "UPPER — RUBBER UPPER", "DANA — EVA", "NAWAAR"];

describe("splitMaterialName", () => {
  it("puts the category above and the distinguishing part as the headline, with middle dots", () => {
    expect(splitMaterialName("UPPER — RUBBER UPPER — SK52 — BLACK BLUE — 8/10", PATHS)).toEqual({
      category: "Upper · Rubber upper",
      name: "SK52 · BLACK BLUE · 8/10",
    });
  });

  it("splits by the store's own category paths, not by position", () => {
    // NAWAAR has no sub-category: "5 SOOTAR" is the material's own, not a category.
    expect(splitMaterialName("NAWAAR — 5 SOOTAR — BLACK", PATHS)).toEqual({ category: "Nawaar", name: "5 SOOTAR · BLACK" });
    expect(splitMaterialName("DANA — EVA — RED", PATHS)).toEqual({ category: "Dana · Eva", name: "RED" });
  });

  it("takes the longest path that fits", () => {
    expect(splitMaterialName("UPPER — RUBBER UPPER — SK6", PATHS).category).toBe("Upper · Rubber upper");
  });

  it("keeps the whole name as the headline when no category starts it", () => {
    expect(splitMaterialName("RUBBER UPPER — SK6 — RED — 7/10", PATHS)).toEqual({ category: null, name: "RUBBER UPPER · SK6 · RED · 7/10" });
    expect(splitMaterialName("PLAIN", [])).toEqual({ category: null, name: "PLAIN" });
  });
});
