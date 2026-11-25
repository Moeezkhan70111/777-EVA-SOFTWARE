import React from "react";
import { RAIL_ICONS } from "../../features/navigation/NavIcons";
import { useSlashToSearch } from "../../hooks/useSlashToSearch";

// One search box for the list pages (R1): a magnifier, the field, and on the right either the "/" key that jumps to
// it or a × that clears it. Escape clears it too, as in most search boxes (Jakob's law). Written for Pending Orders; shared when the Customer Ledger needed the same one.

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** The field's accessible name (R18). */
  label: string;
  placeholder: string;
  clearLabel: string;
  shortcutHint: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

const ClearIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d="M7 7l10 10M17 7L7 17" />
  </svg>
);

export const SearchField: React.FC<SearchFieldProps> = ({ value, onChange, label, placeholder, clearLabel, shortcutHint, inputRef }) => {
  useSlashToSearch(inputRef);
  return (
    <label className="ord-search">
      <span className="sr-only">{label}</span>
      <span className="ord-search-icon" aria-hidden="true">{RAIL_ICONS.search}</span>
      <input ref={inputRef} className="input" type="search" value={value} placeholder={placeholder} aria-keyshortcuts="/" title={shortcutHint}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape" && value) { event.stopPropagation(); onChange(""); } }} />
      {value ? (
        <button type="button" className="ord-search-clear" aria-label={clearLabel} title={clearLabel} onClick={() => { onChange(""); inputRef.current?.focus(); }}>
          <ClearIcon />
        </button>
      ) : <kbd className="ord-search-key" aria-hidden="true">/</kbd>}
    </label>
  );
};
