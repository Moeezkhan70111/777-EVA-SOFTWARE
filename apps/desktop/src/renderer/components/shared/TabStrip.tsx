import React from "react";

// One tab strip for the whole app (R1). Pages used to hand-roll a row of buttons with their
// own classes and no ARIA; this is the single implementation, keyboard-navigable and
// announced as a tablist so the selected tab is never signalled by colour alone (R18).

export interface TabStripItem<T extends string> {
  id: T;
  label: string;
  /** Optional count or warning shown after the label, e.g. "3". */
  badge?: string;
  /** Marks the badge as a warning rather than a neutral count. */
  badgeTone?: "neutral" | "warn";
}

interface TabStripProps<T extends string> {
  items: TabStripItem<T>[];
  active: T;
  onSelect: (id: T) => void;
  /** Names the strip for screen readers, e.g. "Raw material sections". */
  label: string;
}

export function TabStrip<T extends string>({ items, active, onSelect, label }: TabStripProps<T>) {
  const move = (from: number, delta: number) => {
    const next = (from + delta + items.length) % items.length;
    onSelect(items[next].id);
    document.getElementById(`tab-${items[next].id}`)?.focus();
  };

  return (
    <div className="tab-strip" role="tablist" aria-label={label}>
      {items.map((item, index) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            id={`tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={`tab-strip-btn${selected ? " is-active" : ""}`}
            onClick={() => onSelect(item.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") { event.preventDefault(); move(index, 1); }
              if (event.key === "ArrowLeft") { event.preventDefault(); move(index, -1); }
            }}
          >
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
