import { describe, expect, it } from "vitest";
import { BENTO_COLUMNS, baseSpan, bentoLayout, bentoSpans } from "./bentoLayout";

const rowsOf = (spans: readonly number[]): number[] => {
  const rows: number[] = [];
  let used = 0;
  for (const span of spans) {
    if (used + span > BENTO_COLUMNS) { rows.push(used); used = 0; }
    used += span;
  }
  rows.push(used);
  return rows;
};

describe("the pending articles' bento grid", () => {
  it("fills every row edge to edge, keeping the order", () => {
    // DC3 (5 colours), SK6 (1), SK12 (4), SK30 (4), SK46 (4), as on the owner's screen.
    const spans = bentoSpans([6, 3, 5, 5, 5]);
    expect(rowsOf(spans).every((used) => used === BENTO_COLUMNS)).toBe(true);
    // The spare columns are shared: DC3 and SK6 grow together, SK6 never to half the row on its own.
    expect(spans).toEqual([8, 4, 6, 6, 12]);
  });

  it("lets a lone card take the whole row", () => {
    expect(bentoSpans([4])).toEqual([12]);
    expect(bentoSpans([])).toEqual([]);
  });

  it("asks for more columns the more colours a table has, a quarter at least, the whole row at most", () => {
    expect(baseSpan(1, 1600, 16)).toBe(3);
    expect(baseSpan(4, 1600, 16)).toBeGreaterThan(baseSpan(2, 1600, 16));
    expect(baseSpan(30, 1600, 16)).toBe(BENTO_COLUMNS);
  });

  it("puts one card per row on a narrow screen, and before the grid is measured", () => {
    expect(bentoLayout([1, 2, 5], 600, 16)).toEqual([12, 12, 12]);
    expect(bentoLayout([1, 2, 5], 0, 16)).toEqual([12, 12, 12]);
  });
});
