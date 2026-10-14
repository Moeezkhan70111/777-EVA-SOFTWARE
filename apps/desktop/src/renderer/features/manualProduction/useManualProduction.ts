import { useCallback, useRef, useState } from "react";
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
//   useSaveManualProduction  one Save at a time, each with its own request id
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

export interface ManualProductionDraft {
  machineId: string;
  articleSizeId: string;
  color: string;
  dozens: string;
}

export type SaveOutcome = { kind: "saved"; message: string } | { kind: "refused"; message: string };

export const useSaveManualProduction = (onSaved: () => void) => {
  const api = useDesktopApi();
  const requestId = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);

  const save = useCallback(async (draft: ManualProductionDraft): Promise<boolean> => {
    setBusy(true);
    setOutcome(null);
    try {
      const reply = await api.recordManualProduction({ ...draft, requestId: requestId.current });
      requestId.current = crypto.randomUUID();
      if (!reply.accepted || !reply.entry) {
        setOutcome({ kind: "refused", message: reply.reason ?? text.unreachable });
        return false;
      }
      const { entry } = reply;
      const product = `${entry.article} ${entry.size} ${entry.color}`;
      setOutcome({ kind: "saved", message: reply.duplicate ? text.alreadySaved(entry.code) : text.saved(entry.code, entry.cartons, product) });
      onSaved();
      return true;
    } catch {
      // No answer: the entry may or may not exist, so the same request id is kept for the retry.
      setOutcome({ kind: "refused", message: text.unreachable });
      return false;
    } finally {
      setBusy(false);
    }
  }, [api, onSaved]);

  return { busy, outcome, save };
};
