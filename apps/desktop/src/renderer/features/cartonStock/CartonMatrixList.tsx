import React from "react";
import type { CartonMatrixArticle } from "@erp/domain";
import { CartonMatrix } from "./CartonMatrix";
import { CARTON_LAYOUT, cartonLayout } from "./cartonMatrixLayout";
import { useElementWidth } from "./useElementWidth";

// A list of article cards, each a Size x Colour matrix with its totals (CartonMatrix). One list for Carton Stock and
// the Daily Production page, which draws a day's production the same way (R1). The list is measured once: every
// card is as wide as it, and below CARTON_LAYOUT.stackBelow the name sits above the matrix.

/** The cards' column widths come from cartonMatrixLayout, the one source for them. */
const LIST_STYLE = {
  "--cs-name-width": `${CARTON_LAYOUT.nameWidth}px`,
  "--cs-colour-min": `${CARTON_LAYOUT.colourMinWidth}px`,
} as React.CSSProperties;

interface CartonMatrixListProps {
  articles: readonly CartonMatrixArticle[];
  /** Each table's accessible name. Carton Stock's own ("SK6 cartons in store") when not given. */
  tableLabel?: (article: string) => string;
  /** A control for each card, under its name (the Manual Production page's Edit). None when not given. */
  renderAction?: (article: CartonMatrixArticle) => React.ReactNode;
}

export const CartonMatrixList: React.FC<CartonMatrixListProps> = ({ articles, tableLabel, renderAction }) => {
  const [listRef, listWidth] = useElementWidth<HTMLDivElement>();
  const layout = cartonLayout(listWidth);
  return (
    <div ref={listRef} className={layout.stacked ? "cs-articles cs-articles--stacked" : "cs-articles"} style={LIST_STYLE}>
      {articles.map((article) => (
        <CartonMatrix key={article.key} article={article} layout={layout} tableLabel={tableLabel} action={renderAction?.(article)} />
      ))}
    </div>
  );
};
