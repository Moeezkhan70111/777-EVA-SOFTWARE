import { useEffect, useRef } from "react";
import type { StoreMode } from "./storeTabs";

// KEYS 1 AND 2 pick the Store page's mode — but a scanner types digits too, and in a burst. So a key
// counts only when it is a SINGLE press:
//
//   * no field that takes typing has the focus (a scan box, a search, a form);
//   * no key came just before it, and none comes just after — a scanner types a whole code within
//     milliseconds of each key, a person never does;
//   * no Ctrl, Alt or Meta.
//
// The pick waits a beat to see whether another key follows, and is dropped if one does.

/** Keys closer together than this are a scanner, not a person. */
export const SCANNER_BURST_GAP_MS = 60;

const KEY_MODE: Record<string, StoreMode> = { "1": "receiving", "2": "issuing" };

const typingTarget = (element: Element | null): boolean =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  element instanceof HTMLSelectElement ||
  (element instanceof HTMLElement && element.isContentEditable);

export const useModeKeys = (onPick: (mode: StoreMode) => void): void => {
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    let lastKeyAt = Number.NEGATIVE_INFINITY;
    let pending: ReturnType<typeof setTimeout> | undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      const now = Date.now();
      const inBurst = now - lastKeyAt < SCANNER_BURST_GAP_MS;
      lastKeyAt = now;
      // Another key arrived while a pick was waiting: that was a burst, not a press.
      if (pending !== undefined) {
        clearTimeout(pending);
        pending = undefined;
        return;
      }
      if (inBurst || event.ctrlKey || event.altKey || event.metaKey) return;
      if (typingTarget(document.activeElement)) return;
      const mode = KEY_MODE[event.key];
      if (!mode) return;
      pending = setTimeout(() => {
        pending = undefined;
        pickRef.current(mode);
      }, SCANNER_BURST_GAP_MS);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (pending !== undefined) clearTimeout(pending);
    };
  }, []);
};
