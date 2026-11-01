import React from "react";
import { copy } from "../../config/copy";

// [ Previous ]  Page 2 of 5  [ Next ] — one pager for the stations' paged lists (R1). Written for
// Receive Production and promoted here when Upper Move Out needed the same one.
//
// NUMBERED (1 Nov 2026, the Stock tab): ‹ 1 … 4 5 6 … 20 › — round arrows and the pages around
// the current one, each a button; the current page says so with aria-current.

interface PagerProps {
  page: number;
  pages: number;
  onPage: (page: number) => void;
  /** Page numbers between round arrows, in place of Previous / Page n of m / Next. */
  numbered?: boolean;
}

/**
 * Which page buttons to show: all of them for a short list, else the first, the last, and the
 * current page with one on either side, with a gap where pages are left out.
 */
export const pageWindow = (page: number, pages: number): Array<number | "gap"> => {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);
  const shown = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const sorted = [...shown].sort((a, b) => a - b);
  const result: Array<number | "gap"> = [];
  sorted.forEach((n, index) => {
    if (index > 0 && n - sorted[index - 1] > 1) result.push("gap");
    result.push(n);
  });
  return result;
};

const Arrow: React.FC<{ direction: "left" | "right" }> = ({ direction }) => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d={direction === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const NumberedPager: React.FC<Omit<PagerProps, "numbered">> = ({ page, pages, onPage }) => (
  <nav className="pager-numbered" aria-label={copy.common.pageOf(page, pages)}>
    <button type="button" className="pager-round" aria-label={copy.common.previous} disabled={page <= 1} onClick={() => onPage(page - 1)}>
      <Arrow direction="left" />
    </button>
    {pageWindow(page, pages).map((entry, index) =>
      entry === "gap" ? (
        <span key={`gap-${index}`} className="pager-gap" aria-hidden="true">…</span>
      ) : (
        <button
          key={entry}
          type="button"
          className="pager-round"
          aria-current={entry === page ? "page" : undefined}
          aria-label={copy.common.pageOf(entry, pages)}
          onClick={() => onPage(entry)}
        >
          {entry}
        </button>
      )
    )}
    <button type="button" className="pager-round" aria-label={copy.common.next} disabled={page >= pages} onClick={() => onPage(page + 1)}>
      <Arrow direction="right" />
    </button>
  </nav>
);

export const Pager: React.FC<PagerProps> = ({ page, pages, onPage, numbered = false }) =>
  numbered ? (
    <NumberedPager page={page} pages={pages} onPage={onPage} />
  ) : (
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
