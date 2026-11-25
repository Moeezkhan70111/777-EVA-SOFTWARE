import { describe, expect, it } from "vitest";
import { canAddColour } from "./useCanAddColour";

// THE ONE RULE for adding a colour to an article, on every quantity-by-colour page (25 Nov 2026): the main process's
// own, an administrator on the computer that writes Product Master. Anyone else, anywhere else, is not offered it.
describe("who may add a colour to an article", () => {
  it("an administrator on the Product Master computer, and nobody else", () => {
    expect(canAddColour({ isAdmin: true, writesProductMaster: true })).toBe(true);
    expect(canAddColour({ isAdmin: true, writesProductMaster: false })).toBe(false);
    expect(canAddColour({ isAdmin: false, writesProductMaster: true })).toBe(false);
    expect(canAddColour({ isAdmin: false, writesProductMaster: false })).toBe(false);
  });
});
