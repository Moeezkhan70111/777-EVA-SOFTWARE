import React from "react";
import { copy } from "../../config/copy";

// [ Previous ]  Page 2 of 5  [ Next ] — one pager for the stations' paged lists (R1). Written for
// Receive Production and promoted here when Upper Move Out needed the same one.

interface PagerProps {
  page: number;
  pages: number;
  onPage: (page: number) => void;
}

export const Pager: React.FC<PagerProps> = ({ page, pages, onPage }) => (
  <nav className="station-pager" aria-label={copy.common.pageOf(page, pages)}>
    <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
      {copy.common.previous}
    </button>
    <span>{copy.common.pageOf(page, pages)}</span>
    <button type="button" className="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
      {copy.common.next}
    </button>
  </nav>
);
