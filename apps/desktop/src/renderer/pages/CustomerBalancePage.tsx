import React, { useEffect, useMemo, useRef, useState } from "react";
import { formatWholeMoney } from "../app/format";
import type { AppRoute } from "../app/routes";
import { Pager } from "../components/shared/Pager";
import { SearchableCombobox } from "../components/shared/SearchableCombobox";
import { SearchField } from "../components/shared/SearchField";
import { StateView } from "../components/shared/StateView";
import { copy } from "../config/copy";
import { useTodayFollowingDate } from "../hooks/useTodayFollowingDate";
import { BalanceHero } from "../features/customerLedger/BalanceHero";
import { HeroSkeleton } from "../features/customerLedger/LedgerSkeleton";
import { BALANCES_PAGE_SIZE, balanceTotals, customerGroups, filterBalances } from "../features/customerBalance/customerBalances";
import { CustomerBalanceSkeleton, CustomerBalanceTable } from "../features/customerBalance/CustomerBalanceTable";
import { useCustomerBalances } from "../features/customerBalance/useCustomerBalances";

// CUSTOMER BALANCE: what every customer owes on a day, in the Customer Ledger's look (docs/56, 26 Nov 2026).
//
//   Customer Balance                                              [ Open Ledger ]
//   ┌ Balance till [date]   Group [All groups ▾] ┐  ┌ TOTAL RECEIVABLE as of … ─┐
//   │ Sales Rs. …        Cash received Rs. …     │  │ Rs. 1,234,567  ↓ Receivable │
//   └────────────────────────────────────────────┘  └ 120 customers ─────────────┘
//   [ Search customers  / ]
//   Customer (city) | Group | Last activity | Sales | Cash received | Balance ↓     a row opens its ledger
//
// The total is the one figure in the blue (von Restorff). Every balance is the main process's; the page only narrows
// the list and adds up what it shows, in paisa (customerBalances.ts).

const text = copy.customerBalance;

interface CustomerBalancePageProps {
  onNavigate: (route: AppRoute) => void;
  /** Opens the Customer Ledger on one customer. */
  onOpenLedger: (partyId: string) => void;
}

export const CustomerBalancePage: React.FC<CustomerBalancePageProps> = ({ onNavigate, onOpenLedger }) => {
  const [asOfDate, setAsOfDate] = useTodayFollowingDate();
  const [group, setGroup] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const searchRef = useRef<HTMLInputElement>(null);
  const balances = useCustomerBalances(asOfDate);
  const groupNames = useMemo(() => customerGroups(balances.rows ?? []), [balances.rows]);
  const groupOptions = useMemo(() => [{ value: "", label: text.allGroups }, ...groupNames.map((name) => ({ value: name, label: name }))], [groupNames]);
  const shown = useMemo(() => filterBalances(balances.rows ?? [], group, search), [balances.rows, group, search]);
  const totals = useMemo(() => balanceTotals(shown), [shown]);
  const pages = Math.max(1, Math.ceil(shown.length / BALANCES_PAGE_SIZE));
  const pageRows = shown.slice((page - 1) * BALANCES_PAGE_SIZE, page * BALANCES_PAGE_SIZE);
  const refreshing = balances.loading && balances.rows !== null;

  useEffect(() => setPage(1), [group, search, asOfDate]);

  const body = () => {
    if (balances.error && balances.rows === null) return <StateView kind="error" title={text.failed} onRetry={balances.reload} />;
    if (balances.rows === null) return <CustomerBalanceSkeleton />;
    if (balances.rows.length === 0) return <StateView kind="empty" title={text.emptyTitle} hint={text.emptyHint} />;
    if (shown.length === 0) return <StateView kind="empty" title={text.noMatchTitle} hint={text.noMatchHint} />;
    return <CustomerBalanceTable rows={pageRows} refreshing={refreshing} onOpen={onOpenLedger} />;
  };

  return (
    <div className="page customer-balance-page doc-themed cl-page cb-page">
      <header className="cl-head">
        <div className="cl-head-title"><h1>{text.title}</h1></div>
        <div className="cl-head-actions">
          <button type="button" className="btn btn-primary" onClick={() => onNavigate("customer-ledger")}>{text.openLedger}</button>
        </div>
      </header>
      <div className="cl-top has-party">
        <section className="cl-customer card cb-filters" aria-label={text.title}>
          <div className="cb-filter-fields">
            <label className="cl-customer-field">
              <span className="input-label">{text.asOfLabel}</span>
              <input type="date" className="form-input cb-date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} />
            </label>
            <label className="cl-customer-field">
              <span className="input-label">{text.groupLabel}</span>
              <SearchableCombobox ariaLabel={text.groupLabel} placeholder={text.allGroups} searchPlaceholder={text.groupSearch} emptyLabel={text.noGroups}
                value={group} options={groupOptions} onChange={setGroup} />
            </label>
          </div>
          <dl className="cb-figures">
            <div><dt>{text.salesLabel}</dt><dd>Rs. {formatWholeMoney(totals.sales)}</dd></div>
            <div><dt>{text.receiptsLabel}</dt><dd>Rs. {formatWholeMoney(totals.receipts)}</dd></div>
          </dl>
        </section>
        {balances.rows === null ? <HeroSkeleton /> : (
          <BalanceHero closingBalance={totals.balance} toDate={asOfDate} refreshing={refreshing} limit={null}
            label={text.totalLabel} hints={text.totalHint} note={text.customerCount(totals.count)} />
        )}
      </div>
      {balances.error && balances.rows !== null ? <StateView kind="error" compact message={text.failed} onRetry={balances.reload} /> : null}
      <SearchField value={search} onChange={setSearch} label={text.searchLabel} placeholder={text.searchPlaceholder} clearLabel={text.searchClear}
        shortcutHint={text.searchShortcut} inputRef={searchRef} />
      {body()}
      {pages > 1 ? <Pager page={page} pages={pages} onPage={setPage} numbered /> : null}
    </div>
  );
};
