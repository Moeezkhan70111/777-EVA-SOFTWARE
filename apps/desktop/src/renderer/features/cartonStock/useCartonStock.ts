import { useCallback, useRef, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { usePolledRead, type PolledRead, type PolledReply } from "../../hooks/usePolledRead";
import { copy } from "../../config/copy";
import type { CartonAdjustDraft, CartonReconciliation } from "../../types/desktopApi";

// The Carton Stock page's read and its one write.
//
// The request id is what keeps a retried Save from adjusting twice: renewed after a definite answer,
// and KEPT when the answer never arrived, so pressing Save again asks about the same movement.

const POLL_MS = 15000;
const PAGE_SIZE = 25;

const text = copy.cartonStock;

export type AdjustOutcome = { kind: "saved" | "refused"; message: string };

export const useCartonReconciliation = (): PolledRead<CartonReconciliation> & { pageNo: number; setPageNo: (page: number) => void } => {
  const api = useDesktopApi();
  const [pageNo, setPageNo] = useState(1);
  const read = useCallback(async (): Promise<PolledReply<CartonReconciliation>> => {
    const reply = await api.getCartonStockReconciliation({ page: pageNo, pageSize: PAGE_SIZE });
    return reply.accepted && reply.reconciliation ? { accepted: true, value: reply.reconciliation } : { accepted: false, reason: reply.reason };
  }, [api, pageNo]);
  return { ...usePolledRead(read, { intervalMs: POLL_MS, failed: text.failed }), pageNo, setPageNo };
};

export const useCartonAdjust = (onSaved: () => Promise<void>) => {
  const api = useDesktopApi();
  const requestId = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AdjustOutcome | null>(null);

  const adjust = useCallback(async (draft: CartonAdjustDraft): Promise<boolean> => {
    setBusy(true);
    setOutcome(null);
    try {
      const reply = await api.adjustCartonStock({ requestId: requestId.current, ...draft });
      requestId.current = crypto.randomUUID();
      if (!reply.accepted) {
        setOutcome({ kind: "refused", message: reply.reason ?? text.notSaved });
        return false;
      }
      setOutcome({ kind: "saved", message: reply.duplicate ? text.alreadySaved : text.saved(draft.direction, draft.cartons) });
      await onSaved();
      return true;
    } catch (error) {
      // No answer: the same id goes again, so the movement cannot be made twice.
      setOutcome({ kind: "refused", message: error instanceof Error && error.message ? error.message : text.noAnswer });
      return false;
    } finally {
      setBusy(false);
    }
  }, [api, onSaved]);

  return { adjust, busy, outcome };
};
