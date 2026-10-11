import { useEffect, type RefObject } from "react";

/**
 * Closes a pop-up (a menu, a panel) when the user clicks or taps anywhere outside it, or presses
 * Escape — the way every drop-down on the desktop behaves.
 *
 * `ref` wraps BOTH the pop-up and the button that opens it, so pressing the button again is its
 * own toggle rather than an outside click that closes and reopens it in one go. The listeners
 * only exist while the pop-up is open.
 */
export const useDismissOnOutsideClick = (ref: RefObject<HTMLElement | null>, open: boolean, onDismiss: () => void): void => {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent | MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onDismiss, ref]);
};
