// How an article's matrix fits the screen without scrolling sideways. When its colours do not all fit
// in one row of columns, they continue in a second band underneath (then a third), each band with the
// sizes down its side. Only the last band carries the Total. Nothing is hidden and nothing scrolls:
// an operator reads down, the way the rest of the page reads.
//
// These widths are the one source for the card's columns: the page hands them to the CSS as variables.

export const CARTON_LAYOUT = {
  /** The article's name block on the left of each card. */
  nameWidth: 200,
  sizeWidth: 120,
  totalWidth: 120,
  /** The narrowest a colour column may be and still show its name and swatch. */
  colourMinWidth: 90,
  /** Below this list width, the name sits above the matrix and the Size and Total columns narrow. */
  stackBelow: 1000,
  narrowSizeWidth: 96,
  narrowTotalWidth: 96,
  /** The card's border, left and right. */
  cardBorders: 2,
} as const;

export interface CartonLayout {
  /** The name above the matrix rather than beside it. */
  stacked: boolean;
  /** How many colours one band may hold. Unlimited until the list has been measured. */
  maxColours: number;
  sizeWidth: number;
  totalWidth: number;
}

/** The layout for a list this wide (in CSS pixels). 0 means not measured yet: one band, as before. */
export const cartonLayout = (listWidth: number): CartonLayout => {
  const { nameWidth, sizeWidth, totalWidth, colourMinWidth, stackBelow, narrowSizeWidth, narrowTotalWidth, cardBorders } = CARTON_LAYOUT;
  if (!(listWidth > 0)) return { stacked: false, maxColours: Number.POSITIVE_INFINITY, sizeWidth, totalWidth };
  const stacked = listWidth < stackBelow;
  const size = stacked ? narrowSizeWidth : sizeWidth;
  const total = stacked ? narrowTotalWidth : totalWidth;
  const tableWidth = listWidth - cardBorders - (stacked ? 0 : nameWidth);
  const maxColours = Math.max(Math.floor((tableWidth - size - total) / colourMinWidth), 1);
  return { stacked, maxColours, sizeWidth: size, totalWidth: total };
};

/**
 * The colour columns (their indexes) of each band, as even as they come: 14 colours that fit 10 to a
 * band make two bands of 7, not 10 and 4.
 */
export const colourBands = (colourCount: number, maxColours: number): number[][] => {
  const columns = Array.from({ length: colourCount }, (_, index) => index);
  if (colourCount <= maxColours) return [columns];
  const bandCount = Math.ceil(colourCount / maxColours);
  const perBand = Math.ceil(colourCount / bandCount);
  const bands: number[][] = [];
  for (let start = 0; start < colourCount; start += perBand) bands.push(columns.slice(start, start + perBand));
  return bands;
};
