import React, { useEffect, useMemo, useRef, useState } from "react";

// Searchable single select: a text box that filters a list as the clerk types, with
// keyboard navigation. Used for the party and the Add Article search on the Gatepass.

export interface SelectOption {
  id: string;
  label: string;
  sub?: string;
}

interface SearchSelectProps {
  id: string;
  label: string;
  placeholder: string;
  options: SelectOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  loading?: boolean;
  emptyText: string;
  autoFocus?: boolean;
  /** Keeps the accessible name but does not render the label text (a heading says it already). */
  hideLabel?: boolean;
  /** Opens the list as soon as the field mounts — for a picker that appears on demand. */
  autoOpen?: boolean;
  /** Called when the clerk dismisses the list without choosing (Escape or clicking away). */
  onDismiss?: () => void;
}

const MAX_VISIBLE = 60;

export const SearchSelect: React.FC<SearchSelectProps> = ({ id, label, placeholder, options, value, onChange, disabled, loading, emptyText, autoFocus, hideLabel, autoOpen, onDismiss }) => {
  const [open, setOpen] = useState(Boolean(autoOpen));
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(() => options.find((o) => o.id === value) ?? null, [options, value]);

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return options.slice(0, MAX_VISIBLE);
    return options
      .filter((o) => {
        const hay = `${o.label} ${o.sub ?? ""}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .slice(0, MAX_VISIBLE);
  }, [options, query]);

  useEffect(() => {
    setCursor(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
        onDismiss?.();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onDismiss]);

  const pick = (option: SelectOption) => {
    onChange(option.id);
    setOpen(false);
    setQuery("");
  };

  const dismiss = () => {
    setOpen(false);
    setQuery("");
    onDismiss?.();
  };

  const clear = () => {
    onChange("");
    setQuery("");
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div className="gp-field" ref={wrapRef}>
      <label className={hideLabel ? "sr-only" : "input-label"} htmlFor={id}>
        {label}
      </label>
      <div className={`gp-select${selected ? " has-value" : ""}`}>
        <input
          id={id}
          ref={inputRef}
          className="form-input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          aria-autocomplete="list"
          autoComplete="off"
          autoFocus={autoFocus || autoOpen}
          disabled={disabled}
          placeholder={loading ? "Loading…" : placeholder}
          value={open ? query : selected?.label ?? ""}
          // Opens on click, typing or ArrowDown — not on plain focus, so landing on the page
          // (the party field is focused on arrival) does not drop a list over the form.
          onClick={() => setOpen(true)}
          // Options prevent default on mousedown, so picking one never blurs the input;
          // tabbing or clicking elsewhere does, and closes the list.
          onBlur={() => {
            if (open) dismiss();
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!open) setOpen(true);
              setCursor((c) => Math.min(c + 1, Math.max(filtered.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              if (open && filtered[cursor]) {
                e.preventDefault();
                pick(filtered[cursor]);
              }
            } else if (e.key === "Escape") {
              // Closing the list is all Escape means here; the app-wide "Escape = home"
              // shortcut only applies once nothing is open.
              if (open) e.stopPropagation();
              dismiss();
            } else if (e.key === "Backspace" && !open && selected) {
              clear();
            }
          }}
        />
        {selected && !disabled && (
          <button type="button" className="gp-select-clear" aria-label={`Clear ${label}`} onClick={clear}>
            ×
          </button>
        )}
        {open && (
          <ul className="gp-select-list" role="listbox" id={`${id}-listbox`}>
            {filtered.length === 0 ? (
              <li className="gp-select-empty">{emptyText}</li>
            ) : (
              filtered.map((option, idx) => (
                <li
                  key={option.id}
                  role="option"
                  aria-selected={option.id === value}
                  className={`gp-select-option${idx === cursor ? " is-cursor" : ""}${option.id === value ? " is-selected" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(option);
                  }}
                  onMouseEnter={() => setCursor(idx)}
                >
                  <span className="gp-select-option-label">{option.label}</span>
                  {option.sub && <span className="gp-select-option-sub">{option.sub}</span>}
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>
  );
};
