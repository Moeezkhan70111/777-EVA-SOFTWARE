import React from "react";
import { copy } from "../../config/copy";
import { RAIL_ICONS } from "../../features/navigation/NavIcons";
import { useSidewaysScroll, type SidewaysScroll } from "../../hooks/useSidewaysScroll";

// A table of colours that may be wider than its card (Carton Stock, Stock Adjustment). It scrolls sideways, and the
// owner wants that impossible to miss (13 Nov 2026): when there is more to see, a strip above says how many colours
// there are and to scroll, with big arrow buttons that do it; the side with more fades out; the scrollbar is thick
// and coloured. When everything fits, none of that shows.
//
// `pinnedStart` and `pinnedEnd` are the widths of any columns the table holds in place (position: sticky), so the
// fades fall on the colours rather than over them.

const text = copy.sidewaysScroll;

interface SidewaysScrollAreaProps {
  /** The scrolling region's accessible name. */
  label: string;
  /** How many colours the table has, for the strip's words. */
  colourCount: number;
  pinnedStart?: number;
  pinnedEnd?: number;
  children: React.ReactNode;
}

const ScrollStrip: React.FC<{ colourCount: number; scroll: SidewaysScroll; onStep: (direction: -1 | 1) => void }> = ({ colourCount, scroll, onStep }) => (
  <div className="sideways-strip">
    <button type="button" className="sideways-btn sideways-btn--left" aria-label={text.left} disabled={scroll.atStart} onClick={() => onStep(-1)}>
      <span className="sideways-icon" aria-hidden="true">{RAIL_ICONS.chevronUp}</span>
    </button>
    <p className="sideways-hint">
      <span aria-hidden="true">⇆ </span>
      {text.hint(colourCount)}
    </p>
    <button type="button" className="sideways-btn sideways-btn--right" aria-label={text.right} disabled={scroll.atEnd} onClick={() => onStep(1)}>
      <span className="sideways-icon" aria-hidden="true">{RAIL_ICONS.chevronUp}</span>
    </button>
  </div>
);

/** The frame round the scrolling box. The fades sit on it, not on the box, so they stay at the edges. */
const frameClass = (scroll: SidewaysScroll): string => {
  const classes = ["sideways-frame"];
  if (scroll.overflows && !scroll.atStart) classes.push("has-more-left");
  if (scroll.overflows && !scroll.atEnd) classes.push("has-more-right");
  return classes.join(" ");
};

export const SidewaysScrollArea: React.FC<SidewaysScrollAreaProps> = ({ label, colourCount, pinnedStart = 0, pinnedEnd = 0, children }) => {
  const { ref, scroll, step } = useSidewaysScroll<HTMLDivElement>();
  const fades = { "--sideways-pinned-start": `${pinnedStart}px`, "--sideways-pinned-end": `${pinnedEnd}px` } as React.CSSProperties;
  return (
    <div className="sideways-area">
      {scroll.overflows ? <ScrollStrip colourCount={colourCount} scroll={scroll} onStep={step} /> : null}
      <div className={frameClass(scroll)} style={fades}>
        <div ref={ref} className="sideways-scroll" role="region" aria-label={label} tabIndex={0}>
          {children}
        </div>
      </div>
    </div>
  );
};
