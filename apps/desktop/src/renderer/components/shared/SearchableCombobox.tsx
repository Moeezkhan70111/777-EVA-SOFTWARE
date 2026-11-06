import React, { useEffect, useId, useRef, useState } from "react";
import { copy } from "../../config/copy";
import { ComboboxOptionList } from "./ComboboxOptionList";

// Inline searchable combobox that drops UP or DOWN relative to its own position, using a
// fixed-positioned overlay so nothing clips it. Originally written for the Purchase Voucher
// item/supplier pickers; shared here so any picker over a searchable value/label list (Party,
// Raw Material Item, …) uses one implementation (R1 — do not copy-paste UI).
//
// THE PANEL (1 Nov 2026, the scan stations' party pickers): given a `searchPlaceholder`, the field
// is a plain select — it shows the pick, or the placeholder — and the list opens under it as a
// panel with its own search box at the top, which takes the typing.
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
  /** The badge's colour, from the app's badge classes: badge-info (the default) or badge-ok. */
  badgeTone?: "info" | "ok";
  /** A picture before the badge's words. It only repeats them. */
  badgeIcon?: React.ReactNode;
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
/** How tall the list may grow, and what one row and the panel's search box take, for placing it. */
const LIST_MAX_HEIGHT = 320;
const PANEL_MAX_HEIGHT = 440;
const ROW_HEIGHT = 52;
const PANEL_ROW_HEIGHT = 60;
const PANEL_SEARCH_HEIGHT = 76;

/**
 * Where the fixed list goes: under the field when it fits (or fits better), else above it.
 *
 * `rect` and the window are in screen pixels; the list's own pixels are scaled by any CSS zoom
 * around the field (the Store page's scan rail is drawn at 80%), so every length it is given is
 * divided by that zoom. `wanted` and `maxHeight` are in the list's own pixels.
 */
const placeList = (field: HTMLElement, wanted: number, maxHeight: number): React.CSSProperties => {
  const zoom = field.currentCSSZoom || 1;
  const rect = field.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  // Wider than the input when the input is narrow, but never past the right edge of the window.
  const width = Math.min(Math.max(rect.width, MIN_DROPDOWN_WIDTH * zoom), window.innerWidth - rect.left - 12);
  // Each case clears the other edge explicitly: the shared .city-options rule sets `top`, and a
  // list pinned by both top and bottom collapses to a sliver when it drops up.
  const below = spaceBelow >= wanted * zoom || spaceBelow >= spaceAbove;
  return {
    position: "fixed",
    top: below ? (rect.bottom + 2) / zoom : "auto",
    bottom: below ? "auto" : (window.innerHeight - rect.top + 2) / zoom,
    right: "auto",
    left: rect.left / zoom,
    width: width / zoom,
    maxHeight: Math.min(maxHeight, ((below ? spaceBelow : spaceAbove) - 8) / zoom),
    zIndex: 9999,
  };
};

const ChevronIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const SearchIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
    <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

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
  /** A picture at the start of the field (a person for a party picker), in place of the search mark. */
  icon?: React.ReactNode;
  /** Opens the list as a panel with its own search box, saying this. Implies `dropdown`. */
  searchPlaceholder?: string;
}> = ({ value, options, placeholder, emptyLabel = "No results found", ariaLabel, onChange, onEnter, dropdown = false, icon, searchPlaceholder }) => {
  const panel = searchPlaceholder !== undefined;
  const isDropdown = dropdown || panel;
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Set when the field is given its focus back after a pick or Escape, so that focus does not reopen it.
  const quietFocus = useRef(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [listStyle, setListStyle] = useState<React.CSSProperties>({});

  const selected = options.find((o) => o.value === value);
  const displayValue = panel ? (selected?.label ?? "") : selected && !open ? selected.label : query;
  // While an option is picked the input shows its label; that is not a search, so list everything.
  const searching = !(selected && query === selected.label);
  const filtered = searching ? options.filter((o) => matchesSearch(o, query)) : options;
  // An open dropdown starts with an empty filter; the current pick shows faintly behind it.
  const shownPlaceholder = isDropdown && selected ? selected.label : placeholder;

  // sync display when value/selected changes externally
  useEffect(() => {
    if (selected && !open) setQuery(selected.label);
    if (!value && !open) setQuery("");
  }, [value, selected, open]);

  // The panel's search box takes the typing as soon as it opens.
  useEffect(() => {
    if (open && panel) searchRef.current?.focus();
  }, [open, panel]);

  // The open panel follows its field when the field changes size or the window does (the Store
  // rail being dragged wider, a window resized), rather than staying where it first opened.
  useEffect(() => {
    const field = inputRef.current;
    if (!open || !panel || !field) return;
    const follow = () => setListStyle((style) => ({ ...style, ...placeList(field, Number(style.maxHeight) || PANEL_MAX_HEIGHT, PANEL_MAX_HEIGHT) }));
    window.addEventListener("resize", follow);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(follow) : null;
    observer?.observe(field);
    return () => {
      window.removeEventListener("resize", follow);
      observer?.disconnect();
    };
  }, [open, panel]);

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
  const openDropdown = (seed = "") => {
    if (!inputRef.current) return;
    const rows = isDropdown ? options.length : filtered.length;
    const wanted = panel
      ? Math.min(PANEL_MAX_HEIGHT, rows * PANEL_ROW_HEIGHT + PANEL_SEARCH_HEIGHT)
      : Math.min(LIST_MAX_HEIGHT, rows * ROW_HEIGHT + 8);
    setListStyle(placeList(inputRef.current, wanted, panel ? PANEL_MAX_HEIGHT : LIST_MAX_HEIGHT));
    if (isDropdown) setQuery(seed);
    setOpen(true);
    setHighlight(0);
  };

  const focusFieldQuietly = () => {
    if (!panel) return;
    quietFocus.current = true;
    inputRef.current?.focus();
  };

  const close = () => {
    setOpen(false);
    focusFieldQuietly();
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
    setHighlight(0);
    close();
  };

  /** The keys that move through the list and pick from it, in the field or the panel's search box. */
  const onListKeys = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
      close();
    }
  };

  /** The panel's field is a select: a typed letter opens it with that letter already searched. */
  const onPanelFieldKeys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
      e.preventDefault();
      openDropdown(e.key);
    } else if (!open && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openDropdown();
    } else {
      onListKeys(e);
    }
  };

  const list = (
    <ComboboxOptionList id={listId} options={filtered} value={value} highlight={highlight} emptyLabel={emptyLabel} onSelect={select} />
  );

  return (
    <div
      ref={wrapRef}
      className={`pv-item-combobox${isDropdown ? " pv-item-combobox--dropdown" : ""}${icon ? " pv-item-combobox--icon" : ""}${panel ? " pv-item-combobox--panel" : ""}${open ? " is-open" : ""}`}
    >
      {icon ? <span className="combobox-icon" aria-hidden="true">{icon}</span> : null}
      {!icon && !isDropdown ? <span className="city-search-icon" aria-hidden="true">⌕</span> : null}
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
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        readOnly={panel}
        onChange={(e) => {
          setQuery(e.target.value);
          if (value && !isDropdown) onChange("");
          if (!open) openDropdown(e.target.value);
          else setHighlight(0);
        }}
        onFocus={() => {
          if (quietFocus.current) {
            quietFocus.current = false;
            return;
          }
          if (!open) openDropdown();
        }}
        onClick={() => { if (isDropdown && !open) openDropdown(); }}
        onKeyDown={panel ? onPanelFieldKeys : onListKeys}
      />
      {isDropdown ? (
        <button
          type="button"
          className="combobox-chevron"
          aria-label={copy.actions.showOptions}
          aria-expanded={open}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggleFromArrow}
        >
          <ChevronIcon />
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
      {open && !panel && (
        <div ref={listRef} id={listId} className="pv-item-dropdown city-options" style={listStyle} role="listbox">
          {list}
        </div>
      )}
      {open && panel && (
        <div ref={listRef} className="pv-item-dropdown combobox-panel" style={listStyle}>
          <div className="combobox-panel-search">
            <span className="combobox-panel-search-icon" aria-hidden="true"><SearchIcon /></span>
            <input
              ref={searchRef}
              type="text"
              className="combobox-panel-search-input"
              value={query}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listId}
              autoComplete="off"
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onListKeys}
            />
          </div>
          <div id={listId} className="combobox-panel-list" role="listbox" aria-label={ariaLabel}>
            {list}
          </div>
        </div>
      )}
    </div>
  );
};
