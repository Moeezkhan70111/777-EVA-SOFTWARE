import { useCallback, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { usePolledRead, type PolledReply } from "../../hooks/usePolledRead";
import type { ProductionReceiptPage } from "../../types/desktopApi";
import { toIsoDate } from "../../utils/dates";

// Today's receipts, kept current without anyone pressing Refresh (usePolledRead): after every scan
// this screen makes, and every POLL_MS while the window is visible — so cartons received at another
// station or by another operator appear too.
//
// The list is always the database's: nothing is added on screen ahead of the main process, so an
// optimistic row can never sit beside the real one. "Today" is re-read at every load, so a station
// left open past midnight moves on to the new day by itself.

export const POLL_MS = 5000;
export const PAGE_SIZE = 25;

export interface ProductionReceiptsState {
  page: ProductionReceiptPage | null;
  loading: boolean;
  /** The first load failed: nothing to show. */
  error: string | null;
  /** A refresh after a good load failed: the list shown may be out of date. */
  stale: boolean;
  pageNo: number;
  setPageNo: (page: number) => void;
  reload: () => Promise<void>;
}

export const useProductionReceipts = (failed: string): ProductionReceiptsState => {
  const api = useDesktopApi();
  const [pageNo, setPageNo] = useState(1);
  const read = useCallback(async (): Promise<PolledReply<ProductionReceiptPage>> => {
    const reply = await api.listProductionReceipts({ date: toIsoDate(), page: pageNo, pageSize: PAGE_SIZE });
    return reply.accepted && reply.page ? { accepted: true, value: reply.page } : { accepted: false, reason: reply.reason };
  }, [api, pageNo]);
  const polled = usePolledRead(read, { intervalMs: POLL_MS, failed });

  return { page: polled.value, loading: polled.loading, error: polled.error, stale: polled.stale, pageNo, setPageNo, reload: polled.reload };
};
