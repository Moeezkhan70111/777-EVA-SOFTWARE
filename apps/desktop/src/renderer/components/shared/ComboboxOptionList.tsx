import React, { useEffect, useRef } from "react";
import type { SearchableComboboxOption } from "./SearchableCombobox";

// The rows of a SearchableCombobox's open list: the label, its detail line under it, and its badge
// (a tone and an optional picture beside the words). The highlighted row is kept in view as the
// arrow keys move through a long list.

interface ComboboxOptionListProps {
  id: string;
  options: SearchableComboboxOption[];
  value: string;
  highlight: number;
  emptyLabel: string;
  onSelect: (option: SearchableComboboxOption) => void;
}

const OptionBadge: React.FC<{ option: SearchableComboboxOption }> = ({ option }) => (
  <span className={`badge badge-${option.badgeTone ?? "info"} city-option-badge`}>
    {option.badgeIcon ? <span className="city-option-badge-icon" aria-hidden="true">{option.badgeIcon}</span> : null}
    {option.badge}
  </span>
);

export const ComboboxOptionList: React.FC<ComboboxOptionListProps> = ({ id, options, value, highlight, emptyLabel, onSelect }) => {
  const highlightedRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    highlightedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlight]);

  if (options.length === 0) return <div className="city-options-empty">{emptyLabel}</div>;
  return (
    <>
      {options.map((opt, idx) => (
        <button
          key={opt.value}
          ref={idx === highlight ? highlightedRef : undefined}
          id={`${id}-${idx}`}
          type="button"
          className={`city-option${idx === highlight ? " highlighted" : ""}`}
          role="option"
          aria-selected={opt.value === value}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(opt)}
        >
          {opt.badge ? (
            <span className="city-option-head">
              <span className="city-option-label">{opt.label}</span>
              <OptionBadge option={opt} />
            </span>
          ) : (
            <span className="city-option-label">{opt.label}</span>
          )}
          {opt.detail ? <span className="city-option-detail">{opt.detail}</span> : null}
        </button>
      ))}
    </>
  );
};
