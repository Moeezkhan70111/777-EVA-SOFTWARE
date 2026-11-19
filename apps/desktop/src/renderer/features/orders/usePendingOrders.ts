import { useCallback, useState } from "react";
import { PENDING_ORDER_FILTER, type PendingOrderFilter } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useDataChanged } from "../../hooks/useDataChanged";
import { useLoaded, type Loaded } from "../../hooks/useLoaded";
import { DATA_KIND } from "../../../shared/dataChange";
import type { PendingOrderLine, PendingOrderPartyPage } from "../../types/desktopApi";
import { parsePartyPageReply, parsePendingLinesReply, type Reply } from "./orderReply";

// What the Pending Orders screen reads: a page of parties, and one party's products when it is opened. Both re-read
// when an order or a gatepass changes on any computer (BILLING), so a dispatch shows as soon as it arrives.

const PAGE_SIZE = 25;
const CHANGES = [DATA_KIND.BILLING] as const;
const EMPTY_PAGE: PendingOrderPartyPage = { rows: [], total: 0, page: 1, pageSize: PAGE_SIZE, totalPending: 0 };

const asAnswer = <T,>(reply: Reply<T>) => (reply.accepted ? { accepted: true, value: reply.value } : { accepted: false, reason: reply.reason, value: null });

export interface PendingQuery {
  readonly search: string;
  readonly filter: PendingOrderFilter;
}

export const usePendingParties = (token: string, query: PendingQuery) => {
  const api = useDesktopApi();
  const [page, setPage] = useState(1);
  const read = useCallback(
    async () => asAnswer(parsePartyPageReply(await api.listPendingOrderParties({ search: query.search, filter: query.filter, page, pageSize: PAGE_SIZE }, { token }).catch(() => null))),
    [api, token, query.search, query.filter, page]
  );
  const loaded = useLoaded(`pending:${query.filter}:${query.search}:${page}`, read, (answer) => answer.value ?? EMPTY_PAGE, EMPTY_PAGE);
  useDataChanged(CHANGES, () => void loaded.reload());
  return { ...loaded, page, setPage, pages: Math.max(Math.ceil(loaded.value.total / PAGE_SIZE), 1) };
};

/** One party's products, read when the party is opened. */
export const usePendingLines = (token: string, partyId: string, query: PendingQuery): Loaded<PendingOrderLine[]> => {
  const api = useDesktopApi();
  const read = useCallback(
    async () => asAnswer(parsePendingLinesReply(await api.listPendingOrderLines(partyId, { search: query.search, filter: query.filter }, { token }).catch(() => null))),
    [api, token, partyId, query.search, query.filter]
  );
  const loaded = useLoaded(`pending-lines:${partyId}:${query.filter}:${query.search}`, read, (answer) => answer.value ?? [], [] as PendingOrderLine[]);
  useDataChanged(CHANGES, () => void loaded.reload());
  return loaded;
};

export const DEFAULT_PENDING_QUERY: PendingQuery = { search: "", filter: PENDING_ORDER_FILTER.OUTSTANDING };
