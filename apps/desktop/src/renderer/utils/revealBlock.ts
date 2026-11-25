// Scrolls an article's block into full view after it grows (owner, 24 Nov 2026: after choosing a colour, the sizes and
// their boxes were below the fold and had to be scrolled to by hand). Shared since 25 Nov 2026: Enter Orders' article
// blocks and Manual Production's grid (R1).
//
// Only as far as needed: the block's bottom comes into view, but never so far that its top (the article's name and
// colours) leaves the top of the view; a block taller than the view stops with its top at the top. Smooth, unless the
// operator asked for less motion.

const MARGIN_PX = 16;

const isScroller = (element: HTMLElement): boolean => {
  const overflow = window.getComputedStyle(element).overflowY;
  return (overflow === "auto" || overflow === "scroll") && element.scrollHeight > element.clientHeight;
};

/** The nearest ancestor that scrolls, or the page. */
const scrollerOf = (element: HTMLElement): HTMLElement | null => {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) if (isScroller(parent)) return parent;
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
};

/** How far to scroll down: enough to show the bottom, never more than keeps the top in view. Zero when it shows. */
export const revealDistance = (block: { top: number; bottom: number }, view: { top: number; bottom: number }, margin = MARGIN_PX): number => {
  const below = block.bottom - view.bottom + margin;
  if (below <= 0) return 0;
  const roomAbove = Math.max(0, block.top - view.top - margin);
  return Math.min(below, roomAbove);
};

export const revealBlock = (block: HTMLElement | null): void => {
  if (!block) return;
  const scroller = scrollerOf(block);
  if (!scroller || typeof scroller.scrollBy !== "function") return;
  const isPage = scroller === document.scrollingElement;
  const view = isPage ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
  const distance = revealDistance(block.getBoundingClientRect(), view);
  if (distance <= 0) return;
  const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  scroller.scrollBy({ top: distance, behavior: reduceMotion ? "auto" : "smooth" });
};

/** After the browser has laid out what just changed (the new grid), reveal the block. */
export const revealBlockSoon = (block: HTMLElement | null): void => {
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => revealBlock(block)));
};
