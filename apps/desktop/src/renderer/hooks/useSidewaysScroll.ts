import { useCallback, useEffect, useState } from "react";

// Whether a box's content is wider than the box, and whether it is scrolled to either end. The Carton
// Stock card uses it to show its "scroll sideways" strip only when there is something to scroll to,
// and to say which way the rest of the colours are. Watches the box's size and its scrolling.

/** How much of the visible width one arrow press moves: most of it, so a column stays in view for context. */
const STEP_OF_VISIBLE = 0.8;
/** Within this many pixels of an end counts as at it (sub-pixel widths never land exactly). */
const END_SLACK = 2;

export interface SidewaysScroll {
  overflows: boolean;
  atStart: boolean;
  atEnd: boolean;
}

const NOTHING_TO_SCROLL: SidewaysScroll = { overflows: false, atStart: true, atEnd: true };

const readScroll = (box: HTMLElement): SidewaysScroll => {
  const hidden = box.scrollWidth - box.clientWidth;
  if (hidden <= END_SLACK) return NOTHING_TO_SCROLL;
  return { overflows: true, atStart: box.scrollLeft <= END_SLACK, atEnd: box.scrollLeft >= hidden - END_SLACK };
};

const sameScroll = (a: SidewaysScroll, b: SidewaysScroll): boolean =>
  a.overflows === b.overflows && a.atStart === b.atStart && a.atEnd === b.atEnd;

export const useSidewaysScroll = <T extends HTMLElement>() => {
  const [box, setBox] = useState<T | null>(null);
  const [scroll, setScroll] = useState<SidewaysScroll>(NOTHING_TO_SCROLL);

  useEffect(() => {
    if (!box) return undefined;
    const update = () => setScroll((before) => {
      const now = readScroll(box);
      return sameScroll(before, now) ? before : now;
    });
    update();
    box.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(box);
    if (box.firstElementChild) observer?.observe(box.firstElementChild);
    return () => {
      box.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [box]);

  const step = useCallback(
    (direction: -1 | 1) => {
      if (!box) return;
      box.scrollBy({ left: direction * Math.max(box.clientWidth * STEP_OF_VISIBLE, 1), behavior: "smooth" });
    },
    [box]
  );

  return { ref: setBox, scroll, step } as const;
};
