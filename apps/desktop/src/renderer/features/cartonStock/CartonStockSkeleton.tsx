import React from "react";
import { copy } from "../../config/copy";

// The Carton Stock page's shape while its figures load: grey bars where the search, the series
// picker and the article cards will be, so the page never sits blank. Screen readers hear one
// "Loading" status; the bars themselves are hidden from them.

const text = copy.cartonStock;
const ROWS = [0, 1, 2];
const COLUMNS = [0, 1, 2, 3];

/** One article card's outline: the name block on the left, a few rows of figures on the right. */
export const CartonCardSkeleton: React.FC = () => (
  <div className="cs-article cs-skeleton-card" aria-hidden="true">
    <div className="cs-skeleton-name">
      <span className="cs-skeleton cs-skeleton--title" />
    </div>
    <div className="cs-skeleton-table">
      {[-1, ...ROWS].map((row) => (
        <div key={row} className={row < 0 ? "cs-skeleton-row cs-skeleton-row--head" : "cs-skeleton-row"}>
          <span className="cs-skeleton cs-skeleton--pill" />
          {COLUMNS.map((column) => (
            <span key={column} className="cs-skeleton cs-skeleton--cell" />
          ))}
          <span className="cs-skeleton cs-skeleton--pill" />
        </div>
      ))}
    </div>
  </div>
);

/** A few cards' outlines, announced once as loading. */
export const CartonCardsSkeleton: React.FC<{ count: number; message: string }> = ({ count, message }) => (
  <div className="cs-articles" role="status" aria-live="polite" aria-busy="true" aria-label={message}>
    {Array.from({ length: count }, (_, index) => (
      <CartonCardSkeleton key={index} />
    ))}
  </div>
);

/** The whole page before its first figures arrive. */
export const CartonStockSkeleton: React.FC = () => (
  <div className="page-stack carton-stock-page">
    <div className="cs-panel">
      <div className="cs-toolbar" aria-hidden="true">
        <span className="cs-skeleton cs-skeleton--search" />
        <span className="cs-skeleton cs-skeleton--picker" />
      </div>
      <CartonCardsSkeleton count={4} message={text.loading} />
    </div>
  </div>
);
