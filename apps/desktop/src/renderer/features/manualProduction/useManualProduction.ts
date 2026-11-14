import { useCallback, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useLoaded, type Loaded } from "../../hooks/useLoaded";
import { usePolledRead, type PolledReply } from "../../hooks/usePolledRead";
import { copy } from "../../config/copy";
import type { ManualProductionPage } from "../../types/desktopApi";
import { toIsoDate } from "../../utils/dates";
import { toProductChoices, type ProductChoice } from "./productChoices";

// The Manual Production tab's reads and its one write.
//
//   useManualProductionDay   today's entries, kept current (usePolledRead) — after every Save made here,
//                            and every POLL_MS while visible, so entries made at another computer appear
//   useProductChoices        the active products the form offers
//
// The request id is what keeps a retried Save from adding the stock twice: it is renewed after a
// definite answer (saved, or refused — nothing written), and KEPT when the answer never arrived, so
// pressing Save again asks the main process about the same entry rather than making a second one.

export const POLL_MS = 5000;
export const PAGE_SIZE = 25;
const PRODUCTS_PAGE = 1000;

const text = copy.manualProduction;

export interface ManualProductionDay {
  page: ManualProductionPage | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  pageNo: number;
  setPageNo: (page: number) => void;
  reload: () => Promise<void>;
}

export const useManualProductionDay = (): ManualProductionDay => {
  const api = useDesktopApi();
  const [pageNo, setPageNo] = useState(1);
  const read = useCallback(async (): Promise<PolledReply<ManualProductionPage>> => {
    const reply = await api.listManualProduction({ date: toIsoDate(), page: pageNo, pageSize: PAGE_SIZE });
    return reply.accepted && reply.page ? { accepted: true, value: reply.page } : { accepted: false, reason: reply.reason };
  }, [api, pageNo]);
  const polled = usePolledRead(read, { intervalMs: POLL_MS, failed: text.failed });
  return { page: polled.value, loading: polled.loading, error: polled.error, stale: polled.stale, pageNo, setPageNo, reload: polled.reload };
};

export const useProductChoices = (): Loaded<ProductChoice[]> => {
  const api = useDesktopApi();
  const read = useCallback(async () => {
    const result = await api.listProducts({ status: "ACTIVE", pageSize: PRODUCTS_PAGE });
    return { accepted: true, rows: result.rows };
  }, [api]);
  return useLoaded("active-products", read, (answer) => toProductChoices(answer.rows), []);
};

/**
 * Voiding one entry (docs/42). Resolves with null once voided, or with the reason it was not --
 * the main process's own words, or the connection's. Safe to press again: an entry already voided
 * is refused, and nothing moves twice.
 */
export const useVoidManualProduction = (onVoided: () => void) => {
  const api = useDesktopApi();
  return useCallback(async (entryId: string, reason: string): Promise<string | null> => {
    try {
      const reply = await api.voidManualProduction({ entryId, reason });
      if (!reply.accepted) return reply.reason ?? text.voidUnreachable;
      onVoided();
      return null;
    } catch {
      return text.voidUnreachable;
    }
  }, [api, onVoided]);
};
