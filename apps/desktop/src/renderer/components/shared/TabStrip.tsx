import React, { useLayoutEffect, useRef } from "react";

// One tab strip for the whole app (R1). Pages used to hand-roll a row of buttons with their
// own classes and no ARIA; this is the single implementation, keyboard-navigable and
// announced as a tablist so the selected tab is never signalled by colour alone (R18).
//
// THE THUMB (1 Nov 2026): one highlight behind the selected tab that slides to the next one, as
// the Store page's Move in | Move out switch does. Tabs differ in width and the strip can wrap,
// so it is placed by measuring the selected tab. Only a stylesheet that wants it shows it (the
// Store page); everywhere else it stays hidden and the tabs look as they always have.

export interface TabStripItem<T extends string> {
  id: T;
  label: string;
  /** Optional count or warning shown after the label, e.g. "3". */
  badge?: string;
  /** A small picture before the label; decorative, the label is what is read. */
  icon?: React.ReactNode;
  /** Marks the badge as a warning rather than a neutral count. */
  badgeTone?: "neutral" | "warn";
}

interface TabStripProps<T extends string> {
  items: TabStripItem<T>[];
  /** The selected tab, or null when none is — the page is showing something else in their place. */
  active: T | null;
  onSelect: (id: T) => void;
  /** Extra class on the strip, for a page that draws its tabs its own way. */
  className?: string;
  /** Names the strip for screen readers, e.g. "Raw material sections". */
  label: string;
}

/** Puts the thumb over the selected tab, or hides it when no tab is selected. */
const placeThumb = (strip: HTMLElement, thumb: HTMLElement): void => {
  const selected = strip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  thumb.dataset.shown = selected ? "true" : "false";
  if (!selected) return;
  thumb.style.setProperty("--tab-thumb-x", `${selected.offsetLeft}px`);
  thumb.style.setProperty("--tab-thumb-y", `${selected.offsetTop}px`);
  thumb.style.setProperty("--tab-thumb-w", `${selected.offsetWidth}px`);
  thumb.style.setProperty("--tab-thumb-h", `${selected.offsetHeight}px`);
};

/** Keeps the thumb on the selected tab as the selection, the labels or the strip's width change. */
const useSlidingThumb = (active: string | null, itemsKey: string) => {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const thumb = thumbRef.current;
    if (!strip || !thumb) return undefined;
    placeThumb(strip, thumb);
    // It slides only once it has been placed, so it never flies in from the corner on arrival.
    const ready = requestAnimationFrame(() => {
      thumb.dataset.ready = "true";
    });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => placeThumb(strip, thumb)) : null;
    observer?.observe(strip);
    return () => {
      cancelAnimationFrame(ready);
      observer?.disconnect();
    };
  }, [active, itemsKey]);

  return { stripRef, thumbRef };
};

export function TabStrip<T extends string>({ items, active, onSelect, label, className }: TabStripProps<T>) {
  const itemsKey = items.map((item) => `${item.id}:${item.label}:${item.badge ?? ""}`).join("|");
  const { stripRef, thumbRef } = useSlidingThumb(active, itemsKey);

  const move = (from: number, delta: number) => {
    const next = (from + delta + items.length) % items.length;
    onSelect(items[next].id);
    document.getElementById(`tab-${items[next].id}`)?.focus();
  };

  return (
    <div ref={stripRef} className={`tab-strip${className ? ` ${className}` : ""}`} role="tablist" aria-label={label}>
      <span ref={thumbRef} className="tab-strip-thumb" aria-hidden="true" />
      {items.map((item, index) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            id={`tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            // With nothing selected the first tab takes the focus, so the strip is never unreachable.
            tabIndex={selected || (active === null && index === 0) ? 0 : -1}
            className={`tab-strip-btn${selected ? " is-active" : ""}`}
            onClick={() => onSelect(item.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") { event.preventDefault(); move(index, 1); }
              if (event.key === "ArrowLeft") { event.preventDefault(); move(index, -1); }
            }}
          >
            {item.icon ? <span className="tab-strip-icon" aria-hidden="true">{item.icon}</span> : null}
            {item.label}
            {item.badge ? (
              <span className={`tab-strip-badge${item.badgeTone === "warn" ? " tab-strip-badge--warn" : ""}`}>
                {item.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
