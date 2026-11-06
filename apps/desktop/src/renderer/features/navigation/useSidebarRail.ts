import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

// THE SIDEBAR'S WIDTH: slim (icons only) unless something asks for it to be open.
//
//   pinned   — the user chose to keep it open. Remembered on this computer, like the Store
//              page's split; the page then makes room for the open rail.
//   hovered  — the pointer is resting on it. The rail opens OVER the page, so nothing on the
//              page moves, and closes again when the pointer leaves.
//   keyboard — focus arrived by keyboard (Tab). A mouse click also focuses a row, and that must
//              not hold the rail open after the pointer has gone, so only :focus-visible counts.
//
// Both hover edges wait a moment: a pointer crossing the rail on its way somewhere does not
// open it, and brushing its edge while moving down the list does not snap it shut.

const PIN_STORAGE_KEY = "erp.sidebar.pinned";
export const OPEN_DELAY_MS = 260;
export const CLOSE_DELAY_MS = 220;
/** How long the rows take to fold away: a little over --sidebar-speed (theme.css). */
const SLIM_SETTLE_MS = 240;

const readPinned = (): boolean => {
  try {
    return window.localStorage.getItem(PIN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

const savePinned = (pinned: boolean) => {
  try {
    window.localStorage.setItem(PIN_STORAGE_KEY, pinned ? "1" : "0");
  } catch {
    // Storage refused: the choice holds for this visit only.
  }
};

const isKeyboardFocus = (element: Element): boolean => {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
};

/**
 * Opening the rail lets the list grow and scroll; closing it must not leave the icons where that
 * scroll put them, cut off under the top. So the slim list goes back to the top, and on a window
 * too short for all of them, the open page's picture is brought into view once the rows have folded.
 */
export const useSlimRailScroll = (panel: React.RefObject<HTMLElement | null>, expanded: boolean, openPage: string) => {
  useEffect(() => {
    if (expanded) return undefined;
    const list = panel.current?.querySelector(".navbar-nav");
    if (!list) return undefined;
    list.scrollTop = 0;
    const timer = window.setTimeout(() => {
      list.querySelector(".nav-group-head.has-active, .nav-top-btn.active")?.scrollIntoView?.({ block: "nearest" });
    }, SLIM_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [panel, expanded, openPage]);
};

export interface SidebarRail {
  pinned: boolean;
  expanded: boolean;
  togglePinned: () => void;
  /** Spread on the rail's panel. */
  railHandlers: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onMouseDown: () => void;
    onFocus: (event: React.FocusEvent<HTMLElement>) => void;
    onBlur: (event: React.FocusEvent<HTMLElement>) => void;
  };
}

export const useSidebarRail = (): SidebarRail => {
  const [pinned, setPinned] = useState(readPinned);
  const [hovered, setHovered] = useState(false);
  const [keyboardInside, setKeyboardInside] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const clearTimer = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  useEffect(() => clearTimer, [clearTimer]);

  const after = useCallback(
    (delay: number, next: boolean) => {
      clearTimer();
      timer.current = window.setTimeout(() => setHovered(next), delay);
    },
    [clearTimer]
  );

  const onMouseEnter = useCallback(() => after(OPEN_DELAY_MS, true), [after]);
  const onMouseLeave = useCallback(() => after(CLOSE_DELAY_MS, false), [after]);
  // Any press of the pointer hands the rail back to the pointer (hover decides), even on the row
  // that already has the keyboard's focus; a focus that arrives by click does the same.
  const onMouseDown = useCallback(() => setKeyboardInside(false), []);
  const onFocus = useCallback((event: React.FocusEvent<HTMLElement>) => {
    setKeyboardInside(isKeyboardFocus(event.target));
  }, []);
  const onBlur = useCallback((event: React.FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) setKeyboardInside(false);
  }, []);

  const togglePinned = useCallback(() => {
    const next = !pinned;
    setPinned(next);
    savePinned(next);
  }, [pinned]);

  return {
    pinned,
    expanded: pinned || hovered || keyboardInside,
    togglePinned,
    railHandlers: { onMouseEnter, onMouseLeave, onMouseDown, onFocus, onBlur },
  };
};
