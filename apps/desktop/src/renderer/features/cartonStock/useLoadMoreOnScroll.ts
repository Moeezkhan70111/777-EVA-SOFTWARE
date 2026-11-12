import { useEffect, useRef } from "react";

// Calls `onNearEnd` when the element it marks comes within reach of the screen while scrolling, so
// a long list asks for its next part before the operator reaches the bottom. It watches only while
// `active` (more to load, nothing loading), and starts watching afresh each time it becomes active:
// when the newly loaded part still leaves the end in view, it asks again at once.

/** How far below the visible area the end may be when the next part is asked for. */
const REACH = "600px";

/** The nearest ancestor that scrolls up and down: the page's own scroller, not the window. */
const scrollingAncestor = (node: HTMLElement): HTMLElement | null => {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = window.getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") return parent;
  }
  return null;
};

export const useLoadMoreOnScroll = <T extends HTMLElement>(onNearEnd: () => void, active: boolean) => {
  const marker = useRef<T>(null);
  const callback = useRef(onNearEnd);

  useEffect(() => {
    callback.current = onNearEnd;
  }, [onNearEnd]);

  useEffect(() => {
    const node = marker.current;
    if (!active || !node || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current();
      },
      { root: scrollingAncestor(node), rootMargin: `0px 0px ${REACH} 0px` }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [active]);

  return marker;
};
