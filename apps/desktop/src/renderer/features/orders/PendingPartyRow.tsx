import React, { useMemo } from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { PendingOrderParty } from "../../types/desktopApi";
import { ORDER_PROGRESS } from "@erp/domain";
import { PendingArticleMatrix } from "./PendingArticleMatrix";
import { pendingMatrix } from "./pendingMatrix";
import { usePendingLines, type PendingQuery } from "./usePendingOrders";

// ONE PARTY ON PENDING ORDERS, in three levels: the name; under it one quiet line (orders, how much is dispatched, a thin
// bar of it); and on the right the PENDING cartons, the one large figure on the row. Opening it reads the party's products, summed over its open orders, and shows them an article at a
// time: sizes down, colours across (pendingMatrix.ts).

const words = copy.pendingOrders;
const figure = (value: number) => value.toLocaleString("en-US");
/** How much of what was ordered has been dispatched, 0 to 100, for the bar. */
const shareOf = (dispatched: number, ordered: number) => (ordered > 0 ? Math.min(Math.round((dispatched / ordered) * 100), 100) : 0);

interface PendingPartyRowProps {
  token: string;
  party: PendingOrderParty;
  query: PendingQuery;
  open: boolean;
  onToggle: () => void;
}

const PartyLines: React.FC<{ token: string; party: PendingOrderParty; query: PendingQuery }> = ({ token, party, query }) => {
  const lines = usePendingLines(token, party.partyId, query);
  const articles = useMemo(() => pendingMatrix(lines.value), [lines.value]);
  if (lines.loading && lines.value.length === 0) return <StateView kind="loading" compact message={words.loadingLines} />;
  if (lines.error) return <StateView kind="error" compact message={lines.error} onRetry={() => void lines.reload()} />;
  if (lines.value.length === 0) return <StateView kind="empty" compact title={words.emptySearchTitle} />;
  return (
    <div className="ord-matrices" aria-label={party.partyName}>
      {articles.map((group) => <PendingArticleMatrix key={group.article} group={group} />)}
    </div>
  );
};

export const PendingPartyRow: React.FC<PendingPartyRowProps> = ({ token, party, query, open, onToggle }) => {
  const panelId = `pending-party-${party.partyId}`;
  return (
    <li className={open ? "card ord-party is-open" : "card ord-party"}>
      <button type="button" className="ord-party-head" aria-expanded={open} aria-controls={panelId}
        aria-label={open ? words.collapse(party.partyName) : words.expand(party.partyName)} onClick={onToggle}>
        <span className="ord-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="ord-party-main">
          <span className="ord-party-name">{party.partyName}</span>
          <span className="ord-party-meta">
            <span>{words.orderCount(party.orderCount)}</span>
            <span aria-hidden="true">·</span>
            <span>{party.progress === ORDER_PROGRESS.DISPATCHED ? words.progress.DISPATCHED : words.dispatchedOf(figure(party.dispatched), figure(party.ordered))}</span>
            <span className={party.progress === ORDER_PROGRESS.DISPATCHED ? "ord-meter is-done" : "ord-meter"} aria-hidden="true">
              <span style={{ width: `${shareOf(party.dispatched, party.ordered)}%` }} />
            </span>
          </span>
        </span>
        <span className="ord-party-total">
          <strong className="ord-party-pending">{figure(party.pending)}</strong>
          <span className="ord-pending-label">{words.cartonsPending}</span>
        </span>
      </button>
      {open ? <div id={panelId} className="ord-party-body"><PartyLines token={token} party={party} query={query} /></div> : null}
    </li>
  );
};
