import { describe, expect, it } from "vitest";
import { revealDistance } from "./revealBlock";

// How far an article's block scrolls after it grows: enough to show its sizes, never so far that its name goes.
describe("revealDistance", () => {
  const view = { top: 100, bottom: 700 };
  it("does nothing when the block already shows", () => {
    expect(revealDistance({ top: 200, bottom: 600 }, view)).toBe(0);
  });
  it("scrolls just enough to show the bottom, with a margin", () => {
    expect(revealDistance({ top: 300, bottom: 800 }, view)).toBe(116);
  });
  it("stops with the top at the top when the block is taller than the view", () => {
    expect(revealDistance({ top: 300, bottom: 1500 }, view)).toBe(184);
  });
  it("never scrolls a block whose top is already at the top", () => {
    expect(revealDistance({ top: 110, bottom: 1500 }, view)).toBe(0);
  });
});
