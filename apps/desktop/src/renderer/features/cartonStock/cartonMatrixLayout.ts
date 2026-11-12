// How an article's card fits the list. On a wide list the article's name sits in a block on the left; below
// `stackBelow` it sits above the matrix and the Size and Total columns narrow. Colours that do not fit scroll
// sideways inside the card, with a strip above the table saying so and arrows to do it (CartonMatrix).
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
} as const;

export interface CartonLayout {
  /** The name above the matrix rather than beside it. */
  stacked: boolean;
  sizeWidth: number;
  totalWidth: number;
}

/** The layout for a list this wide (in CSS pixels). 0 means not measured yet: the wide layout. */
export const cartonLayout = (listWidth: number): CartonLayout => {
  const { sizeWidth, totalWidth, stackBelow, narrowSizeWidth, narrowTotalWidth } = CARTON_LAYOUT;
  const stacked = listWidth > 0 && listWidth < stackBelow;
  return stacked
    ? { stacked, sizeWidth: narrowSizeWidth, totalWidth: narrowTotalWidth }
    : { stacked, sizeWidth, totalWidth };
};
