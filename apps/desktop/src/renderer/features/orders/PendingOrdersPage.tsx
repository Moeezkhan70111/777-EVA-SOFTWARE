import React, { useEffect, useRef, useState } from "react";
import { PENDING_ORDER_FILTER, type PendingOrderFilter } from "@erp/domain";
import { KpiCard } from "../../components/dashboard/KpiCard";
import { Pager } from "../../components/shared/Pager";
import { StateView } from "../../components/shared/StateView";
import { RAIL_ICONS } from "../navigation/NavIcons";
import { copy } from "../../config/copy";
import { OrderCloseIcon } from "./OrderIcons";
import { PendingPartyRow } from "./PendingPartyRow";
import { DEFAULT_PENDING_QUERY, usePendingParties, type PendingQuery } from "./usePendingOrders";
import { orderDozens } from "./orderUnits";
import { withViewTransition } from "./withViewTransition";

// PENDING ORDERS (docs/52): what each party is still owed, from its open orders less what gatepasses dispatched.
//
//   ┌ TOTAL PENDING ┐
//   │ 1,240 dozen   │   [ Search party or article  × ]   Show [Outstanding] [Fully dispatched] [All]
//   │ 12 parties    │
//   └───────────────┘
//   ▸ BEHRAAM SHOES   2 orders · 13.5 of 22.5 dispatched ███░░ 60% dispatched          9  DOZEN PENDING
//   ▾ MAMA CHAPPAL …  (its articles, each a band and a grid: sizes down, colours across)
//
// Read only, on every computer. The figures are the main process's; this screen adds nothing up.
//
// The UI/UX pass (owner, 24 Nov 2026): the total first and alone in the blue (serial position, von Restorff); a party
// opens with the rows around it moving to their places (a View Transition, withViewTransition), and opens by itself
// when it is the only one (the default effect); "/" goes to the search, × clears it; while a new filter is read, the
// rows on screen stay, dimmed, instead of the page going blank (no layout shift).

const words = copy.pendingOrders;
const FILTERS: readonly PendingOrderFilter[] = [PENDING_ORDER_FILTER.OUTSTANDING, PENDING_ORDER_FILTER.DISPATCHED, PENDING_ORDER_FILTER.ALL];
const SEARCH_DELAY_MS = 250;

interface PendingOrdersPageProps {
  token: string;
  onEnterOrders?: () => void;
}

/** "/" anywhere but a text field goes to the search, as on most search pages (the paradox of the active user). */
const useSlashToSearch = (input: React.RefObject<HTMLInputElement | null>) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = target?.closest("input, textarea, select, [contenteditable='true']");
      if (event.key !== "/" || typing || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input]);
};

export const PendingOrdersPage: React.FC<PendingOrdersPageProps> = ({ token, onEnterOrders }) => {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState<PendingQuery>(DEFAULT_PENDING_QUERY);
  const [openParty, setOpenParty] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const parties = usePendingParties(token, query);
  const { setPage } = parties;
  useSlashToSearch(searchRef);

  // A search is sent once typing pauses, and starts again from the first page.
  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery((current) => (current.search === typed.trim() ? current : { ...current, search: typed.trim() })); setPage(1); }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [typed, setPage]);

  const { rows, total, totalPending } = parties.value;
  // The default effect: one party on the list is the one to look at, so it opens by itself.
  const onlyParty = rows.length === 1 ? (rows[0]?.partyId ?? null) : null;
  useEffect(() => { if (onlyParty) setOpenParty(onlyParty); }, [onlyParty]);

  const chooseFilter = (filter: PendingOrderFilter) => { setQuery((current) => ({ ...current, filter })); setPage(1); };
  const toggle = (partyId: string) => withViewTransition(() => setOpenParty((current) => (current === partyId ? null : partyId)));
  const searching = query.search !== "" || query.filter !== PENDING_ORDER_FILTER.OUTSTANDING;
  const refreshing = parties.loading && rows.length > 0;

  const body = (() => {
    if (parties.loading && rows.length === 0) return <StateView kind="loading" message={words.loading} />;
    if (parties.error) return <StateView kind="error" message={parties.error} onRetry={() => void parties.reload()} />;
    if (rows.length === 0) {
      return searching
        ? <StateView kind="empty" title={words.emptySearchTitle} hint={words.emptySearchHint} />
        : <StateView kind="empty" title={words.emptyTitle} hint={words.emptyHint} action={onEnterOrders ? { label: words.enterOrders, onClick: onEnterOrders } : undefined} />;
    }
    return (
      <ul className={refreshing ? "ord-parties is-refreshing" : "ord-parties"} aria-busy={refreshing || undefined}>
        {rows.map((party) => (
          <PendingPartyRow key={party.partyId} token={token} party={party} query={query} open={openParty === party.partyId} onToggle={() => toggle(party.partyId)} />
        ))}
      </ul>
    );
  })();

  return (
    <div className="ord-page doc-themed ord-pending">
      <div className="ord-pending-top">
        <KpiCard className="cs-summary cs-summary--hero ord-pending-hero" label={words.heroLabel} value={words.heroValue(orderDozens(totalPending))} sub={words.partyCount(total)} />
        <div className="ord-toolbar">
          <label className="ord-search">
            <span className="sr-only">{words.searchLabel}</span>
            <span className="ord-search-icon" aria-hidden="true">{RAIL_ICONS.search}</span>
            <input ref={searchRef} className="input" type="search" value={typed} placeholder={words.searchPlaceholder} aria-keyshortcuts="/" title={words.searchShortcut}
              onChange={(event) => setTyped(event.target.value)} />
            {typed ? (
              <button type="button" className="ord-search-clear" aria-label={words.searchClear} title={words.searchClear} onClick={() => { setTyped(""); searchRef.current?.focus(); }}>
                <OrderCloseIcon />
              </button>
            ) : <kbd className="ord-search-key" aria-hidden="true">/</kbd>}
          </label>
          <div className="sa-toggle" role="group" aria-label={words.filterLabel}>
            {FILTERS.map((filter) => (
              <button key={filter} type="button" className={filter === query.filter ? "sa-toggle-btn is-on" : "sa-toggle-btn"} aria-pressed={filter === query.filter} onClick={() => chooseFilter(filter)}>
                {words.filters[filter]}
              </button>
            ))}
          </div>
        </div>
      </div>
      {body}
      {parties.pages > 1 ? <Pager page={parties.page} pages={parties.pages} onPage={setPage} numbered /> : null}
    </div>
  );
};
