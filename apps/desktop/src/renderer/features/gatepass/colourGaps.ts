import type { StockGrid } from "../../utils/gatepassGrid";

// COLOURS AN ARTICLE HAS, BUT NOT IN EVERY SIZE (owner, 24 Nov 2026: "the colours BLACKRED and BLACKNEON in SK46 7/10
// are not showing"). A gatepass line names a product, an article + colour + size of Product Master. SK46 is made in
// BLACKRED in 8/10 but not in 7/10, so 7/10 has no BLACKRED product to put on a gatepass. Since 25 Nov 2026 the
// article's grid shows every colour across every size, and that cell says so (MissingSizeCell); an administrator
// adds the colour from it, to every size this names.

/** Every size of the article that is not made in `colour`: what adding the colour adds (addColorToArticle). */
export const sizesMissingColour = (grid: StockGrid, article: string, colour: string): string[] =>
  grid.rows.filter((row) => row.article === article && !(colour in row.cells)).map((row) => row.size);
