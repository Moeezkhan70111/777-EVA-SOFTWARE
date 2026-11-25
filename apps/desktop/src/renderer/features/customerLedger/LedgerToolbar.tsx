import React, { useRef } from "react";
import { SearchField } from "../../components/shared/SearchField";
import { copy } from "../../config/copy";
import { LEDGER_TYPE } from "./ledgerTypes";

// Search, and what to show as one row of named choices instead of a menu called "Filter" (recognition over
// recall). One ledger (owner, 25 Nov 2026): imported rows answer to the same choices as the ERP's own.

const text = copy.customerLedger;
export const ALL_FILTER = "ALL";
const FILTERS = [ALL_FILTER, LEDGER_TYPE.SALE, LEDGER_TYPE.CASH_RECEIPT, LEDGER_TYPE.CASH_PAYMENT, LEDGER_TYPE.SALE_RETURN] as const;
export type LedgerFilter = (typeof FILTERS)[number];

interface LedgerToolbarProps {
  search: string;
  onSearch: (value: string) => void;
  filter: LedgerFilter;
  onFilter: (filter: LedgerFilter) => void;
  details: boolean;
  onDetails: (details: boolean) => void;
}

export const LedgerToolbar: React.FC<LedgerToolbarProps> = ({ search, onSearch, filter, onFilter, details, onDetails }) => {
  const searchRef = useRef<HTMLInputElement>(null);
  return (
    <div className="ord-toolbar cl-toolbar">
      <SearchField value={search} onChange={onSearch} label={text.searchLabel} placeholder={text.searchPlaceholder} clearLabel={text.searchClear}
        shortcutHint={text.searchShortcut} inputRef={searchRef} />
      <div className="sa-toggle cl-filters" role="group" aria-label={text.showLabel}>
        {FILTERS.map((choice) => (
          <button key={choice} type="button" className={choice === filter ? "sa-toggle-btn is-on" : "sa-toggle-btn"} aria-pressed={choice === filter} onClick={() => onFilter(choice)}>
            {text.filters[choice]}
          </button>
        ))}
      </div>
      <button type="button" className="customer-ledger-print cl-columns-toggle" aria-pressed={details} title={text.moreColumnsHint} onClick={() => onDetails(!details)}>
        {details ? text.fewerColumns : text.moreColumns}
      </button>
    </div>
  );
};
