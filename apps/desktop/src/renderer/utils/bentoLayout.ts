// THE BENTO GRID of a party's pending articles (owner, 25 Nov 2026: the tables sat ragged, each its own width, with
// holes beside them). Twelve columns; each article card takes as many as its table needs, and every row is filled
// edge to edge: when the next card does not fit, the row's spare columns are shared by its cards, each in proportion to
// its size (a one-colour card is not stretched to half the row on its own). The articles keep
// their A to Z order (nothing is shuffled to pack tighter), and cards in one row share one height (CSS).
//
// What a card needs is its table's comfortable width: the size column plus one column per colour. Below
// MIN_GRID_WIDTH the grid is one column and every card is full width (mobile first).
//
// Shared since 25 Nov 2026: Pending Orders' articles and Daily Production's article cards (R1).

export const BENTO_COLUMNS = 12;
/** The space between cards: the same as the grids' gap in theme.css (.ord-pending .ord-matrices, .pd-articles). */
export const BENTO_GAP_PX = 16;
/** A size column and the card's padding. */
const BASE_WIDTH_PX = 150;
/** One colour's column: room for the Urdu name and its swatch. */
const COLOUR_WIDTH_PX = 120;
/** No card narrower than a quarter of the row: a one-colour table still reads as a card, not a sliver. */
const MIN_SPAN = 3;
/** Narrower than this, one card per row. */
export const MIN_GRID_WIDTH = 720;

export const cardWidthPx = (colourCount: number): number => BASE_WIDTH_PX + COLOUR_WIDTH_PX * Math.max(1, colourCount);

/** The columns one card asks for in a grid this wide. */
export const baseSpan = (colourCount: number, gridWidth: number, gap: number): number => {
  if (gridWidth < MIN_GRID_WIDTH) return BENTO_COLUMNS;
  const column = (gridWidth - gap * (BENTO_COLUMNS - 1)) / BENTO_COLUMNS;
  const span = Math.ceil((cardWidthPx(colourCount) + gap) / (column + gap));
  return Math.min(BENTO_COLUMNS, Math.max(MIN_SPAN, span));
};

/** One row's spans grown to fill it: the spare columns shared in proportion, the odd ones to the largest remainders. */
const fillRow = (row: readonly number[]): number[] => {
  const used = row.reduce((sum, span) => sum + span, 0);
  const spare = BENTO_COLUMNS - used;
  const shares = row.map((span) => (spare * span) / used);
  const grown = row.map((span, index) => span + Math.floor(shares[index] ?? 0));
  let left = BENTO_COLUMNS - grown.reduce((sum, span) => sum + span, 0);
  const byRemainder = row.map((_, index) => index).sort((a, b) => ((shares[b] ?? 0) % 1) - ((shares[a] ?? 0) % 1) || a - b);
  for (const index of byRemainder) {
    if (left <= 0) break;
    grown[index] = (grown[index] ?? 0) + 1;
    left -= 1;
  }
  return grown;
};

/** Each card's span, in order, broken into rows of twelve, every row filled. */
export function bentoSpans(asked: readonly number[]): number[] {
  const rows: number[][] = [];
  let row: number[] = [];
  for (const span of asked) {
    if (row.length > 0 && row.reduce((sum, used) => sum + used, 0) + span > BENTO_COLUMNS) { rows.push(row); row = []; }
    row.push(span);
  }
  if (row.length > 0) rows.push(row);
  return rows.flatMap(fillRow);
}

/** The spans for these cards' colour counts in a grid this wide. Unmeasured (0): every card full width. */
export const bentoLayout = (colourCounts: readonly number[], gridWidth: number, gap: number): number[] =>
  bentoSpans(colourCounts.map((count) => baseSpan(count, gridWidth, gap)));
