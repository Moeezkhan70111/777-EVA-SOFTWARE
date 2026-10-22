import { useEffect, type RefObject } from "react";

/**
 * Closes a pop-up (a menu, a panel) when the user clicks or taps anywhere outside it, or presses
 * Escape — the way every drop-down on the desktop behaves.
 *
 * `ref` wraps BOTH the pop-up and the button that opens it, so pressing the button again is its
 * own toggle rather than an outside click that closes and reopens it in one go. The listeners
 * only exist while the pop-up is open.
 *
 * `alsoInside` is for a pop-up that is PORTALLED, and therefore is not a descendant of `ref` —
 * the sync indicator's panel, which has to escape the rail's scroll clipping. Without it, every
 * click on the panel's own buttons counts as an outside click and shuts the panel before the
 * button does anything.
 */
export const useDismissOnOutsideClick = (
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
  alsoInside?: RefObject<HTMLElement | null>
): void => {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent | MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (alsoInside?.current?.contains(target)) return;
      if (ref.current) onDismiss();
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
  }, [open, onDismiss, ref, alsoInside]);
};
