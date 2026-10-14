import { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { usePolledRead, type PolledRead, type PolledReply } from "../../hooks/usePolledRead";
import type { UpperIssuePage, UpperIssueSummary, UpperStockRow } from "../../types/desktopApi";
import { toIsoDate } from "../../utils/dates";

// The reads around Upper Move Out — every one the database's answer, kept current by usePolledRead
// (after each scan this screen makes, and every few seconds while visible, so issues made at another
// station appear too). Nothing is subtracted or added on screen.

export const ISSUES_POLL_MS = 5000;
export const STOCK_POLL_MS = 10000;
export const PAGE_SIZE = 25;

/** With no machine chosen there is nothing to read: the value is null, not a request. */
const NO_MACHINE = { accepted: true as const, value: null };

/** Today's issues to one machine, a page at a time. No machine, nothing read. */
export const useUpperIssues = (machineId: string | null, failed: string): PolledRead<UpperIssuePage | null> & { pageNo: number; setPageNo: (page: number) => void } => {
  const api = useDesktopApi();
  const [pageNo, setPageNo] = useState(1);
  useEffect(() => setPageNo(1), [machineId]);
  const read = useCallback(async (): Promise<PolledReply<UpperIssuePage | null>> => {
    if (!machineId) return NO_MACHINE;
    const reply = await api.listUpperIssues({ machineId, date: toIsoDate(), page: pageNo, pageSize: PAGE_SIZE });
    return reply.accepted && reply.page ? { accepted: true, value: reply.page } : { accepted: false, reason: reply.reason };
  }, [api, machineId, pageNo]);
  return { ...usePolledRead(read, { intervalMs: ISSUES_POLL_MS, failed }), pageNo, setPageNo };
};

/** This session, today, and the store — for one machine. */
export const useUpperSummary = (machineId: string | null, failed: string): PolledRead<UpperIssueSummary | null> => {
  const api = useDesktopApi();
  const read = useCallback(async (): Promise<PolledReply<UpperIssueSummary | null>> => {
    if (!machineId) return NO_MACHINE;
    const reply = await api.getUpperIssueSummary({ machineId, date: toIsoDate() });
    return reply.accepted && reply.summary ? { accepted: true, value: reply.summary } : { accepted: false, reason: reply.reason };
  }, [api, machineId]);
  return usePolledRead(read, { intervalMs: ISSUES_POLL_MS, failed });
};

/** Every upper material with stock in the store, narrowed by `search` in the main process. */
export const useUpperStock = (search: string, failed: string): PolledRead<UpperStockRow[]> => {
  const api = useDesktopApi();
  const read = useCallback(async (): Promise<PolledReply<UpperStockRow[]>> => {
    const reply = await api.listUpperStock({ search });
    return reply.accepted ? { accepted: true, value: reply.rows } : { accepted: false, reason: reply.reason };
  }, [api, search]);
  return usePolledRead(read, { intervalMs: STOCK_POLL_MS, failed });
};
