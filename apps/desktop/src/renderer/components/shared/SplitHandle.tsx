import React, { useCallback, useRef, useState } from "react";

// A DRAGGABLE DIVIDER BETWEEN TWO PANES, and the remembered width of the second (0.4.1).
//
// The width is a FRACTION of the container, so the layout keeps its proportions when the window
// changes size. The page turns it into a CSS width it clamps (splitWidth), so the pane never goes
// below a usable size whatever was stored. Null means "not chosen": the page's own default.
//
// IT NEVER TAKES THE FOCUS ON A PRESS. On a scanning screen the scan box holds the focus and only
// takes it back after a scan: a divider that took it on a click would leave the scanner typing into
// nothing. So a drag starts with preventDefault. A keyboard user still reaches it with Tab
// (arrows, Home, End; Enter or a double-click restores the default).

const STEP = 0.02;

interface SplitHandleProps {
  /** Names what it resizes, e.g. "Resize the scan panel". */
  label: string;
  /** The container the fraction is a share of. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** The second pane's share now, or null for the page's default. */
  fraction: number | null;
  /** What the keyboard starts from while fraction is null. */
  defaultFraction: number;
  min: number;
  max: number;
  onChange: (fraction: number | null) => void;
  className?: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const SplitHandle: React.FC<SplitHandleProps> = ({ label, containerRef, fraction, defaultFraction, min, max, onChange, className }) => {
  const dragging = useRef(false);
  const current = fraction ?? defaultFraction;

  const fromPointer = (clientX: number) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || !Number.isFinite(clientX)) return;
    onChange(clamp((box.right - clientX) / box.width, min, max));
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragging.current) fromPointer(event.clientX);
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // The handle sits left of the pane it sizes: left widens that pane, right narrows it.
    const next: Record<string, number | null> = {
      ArrowLeft: clamp(current + STEP, min, max),
      ArrowRight: clamp(current - STEP, min, max),
      Home: max,
      End: min,
      Enter: null,
    };
    if (!(event.key in next)) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(next[event.key] ?? null);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      aria-valuenow={Math.round(current * 100)}
      tabIndex={0}
      className={`split-handle${className ? ` ${className}` : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onChange(null)}
      onKeyDown={onKeyDown}
    />
  );
};

/** The CSS width for a pane at `fraction`, never under minPx nor leaving the other pane under otherMinPx. */
export const splitWidth = (fraction: number, minPx: number, otherMinPx: number): string =>
  `clamp(${minPx}px, ${(fraction * 100).toFixed(2)}%, calc(100% - ${otherMinPx}px))`;

/**
 * A pane's chosen share, remembered on this computer (browser storage: a per-computer convenience,
 * nothing depends on it). Unreadable or out of range reads as "not chosen".
 */
export const useSplitFraction = (storageKey: string, min: number, max: number): [number | null, (fraction: number | null) => void] => {
  const [fraction, setFraction] = useState<number | null>(() => {
    try {
      const stored = Number(window.localStorage.getItem(storageKey));
      return Number.isFinite(stored) && stored >= min && stored <= max ? stored : null;
    } catch {
      return null;
    }
  });
  const choose = useCallback(
    (next: number | null) => {
      setFraction(next);
      try {
        if (next === null) window.localStorage.removeItem(storageKey);
        else window.localStorage.setItem(storageKey, next.toFixed(4));
      } catch {
        // Storage refused (private window, policy): the width holds for this visit only.
      }
    },
    [storageKey]
  );
  return [fraction, choose];
};
