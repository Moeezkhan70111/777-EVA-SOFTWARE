import React, { useMemo } from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { PendingOrderParty } from "../../types/desktopApi";
import { ORDER_PROGRESS } from "@erp/domain";
import { useElementWidth } from "../../hooks/useElementWidth";
import { BENTO_GAP_PX, bentoLayout } from "../../utils/bentoLayout";
import { OrderCheckIcon } from "./OrderIcons";
import { PendingArticleGrids } from "./PendingArticleGrids";
import { pendingMatrix } from "./pendingMatrix";
import { usePendingLines, type PendingQuery } from "./usePendingOrders";
import { orderDozens } from "./orderUnits";

// ONE PARTY ON PENDING ORDERS, in three levels: the name; under it one quiet line (orders, how much is dispatched, a bar
// of it and its share in words); and on the right the PENDING dozens, the one large figure on the row. Opening it reads
// the party's products, summed over its open orders, and shows them an article at a time: sizes down, colours across
// (pendingMatrix.ts).
//
// The UI/UX pass (owner, 24 Nov 2026): the share dispatched is said, not only drawn (goal-gradient, and never colour
// alone); a party with nothing left says "All dispatched" with a tick (peak-end); the row carries its own transition
// name, so when another opens it moves to its place instead of jumping (PendingOrdersPage); its products load as
// placeholder grids the size of the real ones (no layout shift).
//
// The articles sit in a bento grid (owner, 25 Nov 2026): twelve columns, each card as wide as its table needs, every
// row filled edge to edge, A to Z (bentoLayout.ts).

const words = copy.pendingOrders;
const figure = orderDozens;
const SKELETON_GRIDS = [0, 1];
/** How much of what was ordered has been dispatched, 0 to 100, for the bar and its words. */
const shareOf = (dispatched: number, ordered: number) => (ordered > 0 ? Math.min(Math.round((dispatched / ordered) * 100), 100) : 0);
/** A View Transition name must be an identifier: a party id may start with a digit, so it is prefixed. */
const transitionName = (partyId: string) => `ord-party-${partyId.replace(/[^A-Za-z0-9_-]/g, "")}`;

interface PendingPartyRowProps {
  token: string;
  party: PendingOrderParty;
  query: PendingQuery;
  open: boolean;
  onToggle: () => void;
}

const ChevronIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

const PartyLines: React.FC<{ token: string; party: PendingOrderParty; query: PendingQuery }> = ({ token, party, query }) => {
  const lines = usePendingLines(token, party.partyId, query);
  const articles = useMemo(() => pendingMatrix(lines.value), [lines.value]);
  const [gridRef, gridWidth] = useElementWidth<HTMLDivElement>();
  const skeletonSpans = bentoLayout(SKELETON_GRIDS.map(() => 3), gridWidth, BENTO_GAP_PX);
  if (lines.loading && lines.value.length === 0) {
    return (
      <div className="ord-matrices" aria-busy="true" ref={gridRef}>
        <p className="sr-only" role="status">{words.loadingLines}</p>
        {SKELETON_GRIDS.map((index, position) => <div key={index} className="ord-matrix ord-matrix--skeleton" aria-hidden="true" style={{ gridColumn: `span ${String(skeletonSpans[position] ?? 12)}` }} />)}
      </div>
    );
  }
  if (lines.error) return <StateView kind="error" compact message={lines.error} onRetry={() => void lines.reload()} />;
  if (lines.value.length === 0) return <StateView kind="empty" compact title={words.emptySearchTitle} />;
  return <PendingArticleGrids label={party.partyName} articles={articles} />;
};

const PartyProgress: React.FC<{ party: PendingOrderParty }> = ({ party }) => {
  const share = shareOf(party.dispatched, party.ordered);
  if (party.progress === ORDER_PROGRESS.DISPATCHED) {
    return <span className="ord-done-badge"><OrderCheckIcon />{words.allDispatched}</span>;
  }
  return (
    <>
      <span>{words.dispatchedOf(figure(party.dispatched), figure(party.ordered))}</span>
      <span className="ord-meter" aria-hidden="true"><span style={{ width: `${share}%` }} /></span>
      <span className="ord-share">{words.percentDispatched(share)}</span>
    </>
  );
};

export const PendingPartyRow: React.FC<PendingPartyRowProps> = ({ token, party, query, open, onToggle }) => {
  const panelId = `pending-party-${party.partyId}`;
  return (
    <li className={open ? "card ord-party is-open" : "card ord-party"} style={{ viewTransitionName: transitionName(party.partyId) }}>
      <button type="button" className="ord-party-head" aria-expanded={open} aria-controls={panelId}
        aria-label={open ? words.collapse(party.partyName) : words.expand(party.partyName)} onClick={onToggle}>
        <span className="ord-chevron" aria-hidden="true"><ChevronIcon /></span>
        <span className="ord-party-main">
          <span className="ord-party-name">{party.partyName}</span>
          <span className="ord-party-meta">
            <span>{words.orderCount(party.orderCount)}</span>
            <span aria-hidden="true">·</span>
            <PartyProgress party={party} />
          </span>
        </span>
        <span className="ord-party-total">
          <strong className="ord-party-pending">{figure(party.pending)}</strong>
          <span className="ord-pending-label">{words.dozensPending}</span>
        </span>
      </button>
      {open ? <div id={panelId} className="ord-party-body"><PartyLines token={token} party={party} query={query} /></div> : null}
    </li>
  );
};
