import React, { useEffect, useRef, useState } from "react";
import { copy } from "../../config/copy";

// Inline searchable combobox that drops UP or DOWN relative to its own position, using a
// fixed-positioned overlay so nothing clips it. Originally written for the Purchase Voucher
// item/supplier pickers; shared here so any picker over a searchable value/label list (Party,
// Raw Material Item, …) uses one implementation (R1 — do not copy-paste UI).
export interface SearchableComboboxOption {
  value: string;
  /** The main line — what tells this option apart. Also what the input shows once picked. */
  label: string;
  /** A smaller second line under the label in the list (e.g. category and code). */
  detail?: string;
  /** Extra words the search should find this option by, without showing them. */
  keywords?: string;
  /** A short tag beside the label in the list, in words (e.g. a party's type: "Supplier"). */
  badge?: string;
}

/** Lower-case, with the separators labels use (— · , |) turned into plain spaces. */
const normalizeForSearch = (text: string): string => text.toLowerCase().replace(/[—–·,|]+/g, " ");

/**
 * Whether an option matches what was typed: every word of the query must appear somewhere in
 * the label, detail or keywords — in any order. "brown 8/13", "8/13 brown" and "sk19 ragzine"
 * all find "SK19 · BROWN · 8/13". An empty query matches everything.
 */
export const matchesSearch = (option: SearchableComboboxOption, query: string): boolean => {
  const words = normalizeForSearch(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalizeForSearch(`${option.label} ${option.detail ?? ""} ${option.keywords ?? ""}`);
  return words.every((word) => haystack.includes(word));
};

/** The list never shrinks below this, so a long name stays readable in a narrow column. */
const MIN_DROPDOWN_WIDTH = 380;

export const SearchableCombobox: React.FC<{
  value: string;
  options: SearchableComboboxOption[];
  placeholder: string;
  emptyLabel?: string;
  /** Accessible name for the input, when the field's visible label cannot target it (R18). */
  ariaLabel?: string;
  onChange: (value: string) => void;
  onEnter?: () => void; // called when user presses Enter to confirm selection
  /**
   * Look and behave like a dropdown: a ▾ arrow, a click opens the whole list, and typing only
   * filters it — the picked option stays until another one is chosen. Without it the field is
   * a search box whose pick is cleared as soon as the text is edited.
   */
  dropdown?: boolean;
}> = ({ value, options, placeholder, emptyLabel = "No results found", ariaLabel, onChange, onEnter, dropdown = false }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [listStyle, setListStyle] = useState<React.CSSProperties>({});

  const selected = options.find((o) => o.value === value);
  const displayValue = selected && !open ? selected.label : query;
  // While an option is picked the input shows its label; that is not a search, so list everything.
  const searching = !(selected && query === selected.label);
  const filtered = searching ? options.filter((o) => matchesSearch(o, query)) : options;
  // An open dropdown starts with an empty filter; the current pick shows faintly behind it.
  const shownPlaceholder = dropdown && selected ? selected.label : placeholder;

  // sync display when value/selected changes externally
  useEffect(() => {
    if (selected && !open) setQuery(selected.label);
    if (!value && !open) setQuery("");
  }, [value, selected, open]);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (
        wrapRef.current && !wrapRef.current.contains(e.target as Node) &&
        listRef.current && !listRef.current.contains(e.target as Node)
      ) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  // position the fixed dropdown relative to the input
  const openDropdown = () => {
    if (!inputRef.current) return;
    const rect = inputRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const dropHeight = Math.min(320, (dropdown ? options.length : filtered.length) * 52 + 8);
    // Wider than the input when the input is narrow, but never past the right edge of the window.
    const width = Math.min(Math.max(rect.width, MIN_DROPDOWN_WIDTH), window.innerWidth - rect.left - 12);

    // Each case clears the other edge explicitly: the shared .city-options rule sets `top`, and a
    // list pinned by both top and bottom collapses to a sliver when it drops up.
    if (spaceBelow >= dropHeight || spaceBelow >= spaceAbove) {
      setListStyle({
        position: "fixed",
        top: rect.bottom + 2,
        bottom: "auto",
        right: "auto",
        left: rect.left,
        width,
        maxHeight: Math.min(320, spaceBelow - 8),
        zIndex: 9999,
      });
    } else {
      setListStyle({
        position: "fixed",
        top: "auto",
        bottom: window.innerHeight - rect.top + 2,
        right: "auto",
        left: rect.left,
        width,
        maxHeight: Math.min(320, spaceAbove - 8),
        zIndex: 9999,
      });
    }
    if (dropdown) setQuery("");
    setOpen(true);
    setHighlight(0);
  };

  const toggleFromArrow = () => {
    if (open) {
      setOpen(false);
      return;
    }
    inputRef.current?.focus();
    openDropdown();
  };

  const select = (opt: SearchableComboboxOption) => {
    onChange(opt.value);
    setQuery(opt.label);
    setOpen(false);
    setHighlight(0);
  };

  return (
    <div ref={wrapRef} className={`pv-item-combobox${dropdown ? " pv-item-combobox--dropdown" : ""}${open ? " is-open" : ""}`}>
      {dropdown ? null : <span className="city-search-icon" aria-hidden="true">⌕</span>}
      <input
        ref={inputRef}
        type="text"
        className="form-input"
        value={displayValue}
        placeholder={shownPlaceholder}
        aria-label={ariaLabel}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(e) => {
          setQuery(e.target.value);
          if (value && !dropdown) onChange("");
          if (!open) openDropdown();
          else setHighlight(0);
        }}
        onFocus={() => { if (!open) openDropdown(); }}
        onClick={() => { if (dropdown && !open) openDropdown(); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) openDropdown();
            else setHighlight((i) => Math.min(i + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            if (open && filtered.length > 0) {
              e.preventDefault();
              select(filtered[highlight] ?? filtered[0]);
              onEnter?.();
            }
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {dropdown ? (
        <button
          type="button"
          className="combobox-chevron"
          aria-label={copy.actions.showOptions}
          aria-expanded={open}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleFromArrow}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : value && (
        <button
          type="button"
          className="party-combobox-clear"
          aria-label={copy.actions.clear}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onChange(""); setQuery(""); setOpen(false); }}
        >×</button>
      )}

      {/* Fixed-positioned dropdown — never clipped by overflow */}
      {open && (
        <div
          ref={listRef}
          className="pv-item-dropdown city-options"
          style={listStyle}
          role="listbox"
        >
          {filtered.length === 0
            ? <div className="city-options-empty">{emptyLabel}</div>
            : filtered.map((opt, idx) => (
              <button
                key={opt.value}
                type="button"
                className={`city-option${idx === highlight ? " highlighted" : ""}`}
                role="option"
                aria-selected={opt.value === value}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(opt)}
              >
                {opt.badge ? (
                  <span className="city-option-head">
                    <span className="city-option-label">{opt.label}</span>
                    <span className="badge badge-info city-option-badge">{opt.badge}</span>
                  </span>
                ) : (
                  <span className="city-option-label">{opt.label}</span>
                )}
                {opt.detail ? <span className="city-option-detail">{opt.detail}</span> : null}
              </button>
            ))
          }
        </div>
      )}
    </div>
  );
};
