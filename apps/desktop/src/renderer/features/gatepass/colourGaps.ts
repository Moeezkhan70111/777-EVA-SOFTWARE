import { compareNatural, type StockGrid } from "../../utils/gatepassGrid";

// COLOURS AN ARTICLE HAS, BUT NOT IN THIS SIZE (owner, 24 Nov 2026: "the colours BLACKRED and BLACKNEON in SK46 7/10 are
// not showing"). A gatepass line names a product, an article + colour + size of Product Master. SK46 is made in
// BLACKRED in 8/10, 10/12 and 11/13 but not in 7/10, so 7/10 has no BLACKRED product to put on a gatepass: the card was
// right not to list it, and silent about why. These say which colours those are, so the card can say so, and offer an
// administrator to add them (missing sizes, as Enter Orders does).

/** Colours the article is made in on any of its sizes, but not in `size`, in natural order. */
export const missingColoursOf = (grid: StockGrid, article: string, size: string): string[] => {
  const ofArticle = new Set<string>();
  let here: Record<string, unknown> = {};
  for (const row of grid.rows) {
    if (row.article !== article) continue;
    for (const colour of Object.keys(row.cells)) ofArticle.add(colour);
    if (row.size === size) here = row.cells;
  }
  return [...ofArticle].filter((colour) => !(colour in here)).sort(compareNatural);
};

/** Every size of the article that is not made in `colour`: what adding the colour adds (addColorToArticle). */
export const sizesMissingColour = (grid: StockGrid, article: string, colour: string): string[] =>
  grid.rows.filter((row) => row.article === article && !(colour in row.cells)).map((row) => row.size);
