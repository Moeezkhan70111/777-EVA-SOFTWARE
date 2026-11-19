import React, { useEffect, useState } from "react";
import { PENDING_ORDER_FILTER, type PendingOrderFilter } from "@erp/domain";
import { Pager } from "../../components/shared/Pager";
import { StateView } from "../../components/shared/StateView";
import { RAIL_ICONS } from "../navigation/NavIcons";
import { copy } from "../../config/copy";
import { PendingPartyRow } from "./PendingPartyRow";
import { DEFAULT_PENDING_QUERY, usePendingParties, type PendingQuery } from "./usePendingOrders";

// PENDING ORDERS (docs/52): what each party is still owed, from its open orders less what gatepasses dispatched.
//
//   [ Search party or article ]   Show [Outstanding] [Fully dispatched] [All]          1,240 cartons pending
//   ▸ BEHRAAM SHOES   2 orders   ◐ Part dispatched   Ordered 45  Dispatched 27   PENDING 18
//   ▾ MAMA CHAPPAL …  (its products: article, colour, size, ordered, dispatched, pending, orders)
//
// Read only, on every computer. The figures are the main process's; this screen adds nothing up.

const words = copy.pendingOrders;
const FILTERS: readonly PendingOrderFilter[] = [PENDING_ORDER_FILTER.OUTSTANDING, PENDING_ORDER_FILTER.DISPATCHED, PENDING_ORDER_FILTER.ALL];
const SEARCH_DELAY_MS = 250;

interface PendingOrdersPageProps {
  token: string;
  onEnterOrders?: () => void;
}

export const PendingOrdersPage: React.FC<PendingOrdersPageProps> = ({ token, onEnterOrders }) => {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState<PendingQuery>(DEFAULT_PENDING_QUERY);
  const [openParty, setOpenParty] = useState<string | null>(null);
  const parties = usePendingParties(token, query);
  const { setPage } = parties;

  // A search is sent once typing pauses, and starts again from the first page.
  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery((current) => (current.search === typed.trim() ? current : { ...current, search: typed.trim() })); setPage(1); }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [typed, setPage]);

  const chooseFilter = (filter: PendingOrderFilter) => { setQuery((current) => ({ ...current, filter })); setPage(1); };
  const { rows, total, totalPending } = parties.value;
  const searching = query.search !== "" || query.filter !== PENDING_ORDER_FILTER.OUTSTANDING;

  const body = (() => {
    if (parties.loading && rows.length === 0) return <StateView kind="loading" message={words.loading} />;
    if (parties.error) return <StateView kind="error" message={parties.error} onRetry={() => void parties.reload()} />;
    if (rows.length === 0) {
      return searching
        ? <StateView kind="empty" title={words.emptySearchTitle} hint={words.emptySearchHint} />
        : <StateView kind="empty" title={words.emptyTitle} hint={words.emptyHint} action={onEnterOrders ? { label: words.enterOrders, onClick: onEnterOrders } : undefined} />;
    }
    return (
      <ul className="ord-parties">
        {rows.map((party) => (
          <PendingPartyRow key={party.partyId} token={token} party={party} query={query} open={openParty === party.partyId}
            onToggle={() => setOpenParty((current) => (current === party.partyId ? null : party.partyId))} />
        ))}
      </ul>
    );
  })();

  return (
    <div className="ord-page">
      <div className="ord-toolbar">
        <label className="ord-search">
          <span className="sr-only">{words.searchLabel}</span>
          <span className="ord-search-icon" aria-hidden="true">{RAIL_ICONS.search}</span>
          <input className="input" type="search" value={typed} placeholder={words.searchPlaceholder} onChange={(event) => setTyped(event.target.value)} />
        </label>
        <div className="sa-toggle" role="group" aria-label={words.filterLabel}>
          {FILTERS.map((filter) => (
            <button key={filter} type="button" className={filter === query.filter ? "sa-toggle-btn is-on" : "sa-toggle-btn"} aria-pressed={filter === query.filter} onClick={() => chooseFilter(filter)}>
              {words.filters[filter]}
            </button>
          ))}
        </div>
        <span className="ord-toolbar-total" aria-live="polite">
          <strong>{words.totalPending(totalPending)}</strong> <span className="ord-muted">· {words.partyCount(total)}</span>
        </span>
      </div>
      {body}
      {parties.pages > 1 ? <Pager page={parties.page} pages={parties.pages} onPage={setPage} numbered /> : null}
    </div>
  );
};
