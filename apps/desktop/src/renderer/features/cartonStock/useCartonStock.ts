import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { DATA_CHANGE_TRACE_STAGE, DATA_KIND } from "../../../shared/dataChange";
import { traceDataChange, useDataChanged } from "../../hooks/useDataChanged";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { usePolledRead, type PolledRead, type PolledReply } from "../../hooks/usePolledRead";
import { copy } from "../../config/copy";
import type { CartonAdjustDraft, CartonReconciliation } from "../../types/desktopApi";

// The Carton Stock page's read and its one write.
//
// LIVE, LIKE RAW MATERIAL STOCK. Another computer's production, gatepass, void or adjustment reaches
// this computer through the cloud log's doorbell and a sync pass; the pass then announces CARTONS
// (shared/dataChange.ts) and the open page re-reads the ledger in place. The page never adds a
// movement to what it shows: every figure is the main process's answer, so a repeated announcement
// re-reads the same figure and cannot count a movement twice. The poll is only the fallback.
//
// The request id is what keeps a retried Save from adjusting twice: renewed after a definite answer,
// and KEPT when the answer never arrived, so pressing Save again asks about the same movement.

/** Carton movements, and the products that name them. */
const CARTON_CHANGES = [DATA_KIND.CARTONS, DATA_KIND.PRODUCTS];
/** The fallback re-read; announcements are what keep the page current. */
export const CARTON_STOCK_FALLBACK_POLL_MS = 60000;
const PAGE_SIZE = 25;

const text = copy.cartonStock;

export type AdjustOutcome = { kind: "saved" | "refused"; message: string };

/** How this page names itself in app.log's change traces. */
export const CARTON_STOCK_TRACE_SCREEN = "carton-stock";
const describeAnswer = (data: CartonReconciliation): string => `movements=${data.movements} fingerprint=${data.fingerprint}`;

/**
 * Re-reads on every announced carton change, and traces each step under the change's id: re-read
 * started, re-read answered (with what the main process said), and the answer shown on screen.
 */
const useLiveReread = (polled: PolledRead<CartonReconciliation>, lastAnswer: MutableRefObject<string>): void => {
  const showingFor = useRef<string | undefined>(undefined);
  useDataChanged(
    CARTON_CHANGES,
    (change) => {
      traceDataChange(CARTON_STOCK_TRACE_SCREEN, change.id, DATA_CHANGE_TRACE_STAGE.REREAD_STARTED);
      showingFor.current = change.id;
      void polled.reload().then(() => traceDataChange(CARTON_STOCK_TRACE_SCREEN, change.id, DATA_CHANGE_TRACE_STAGE.REREAD_DONE, lastAnswer.current));
    },
    { trace: CARTON_STOCK_TRACE_SCREEN }
  );
  useEffect(() => {
    if (showingFor.current === undefined || polled.value === null) return;
    traceDataChange(CARTON_STOCK_TRACE_SCREEN, showingFor.current, DATA_CHANGE_TRACE_STAGE.SHOWN, describeAnswer(polled.value));
    showingFor.current = undefined;
  }, [polled.value]);
};

export const useCartonReconciliation = (): PolledRead<CartonReconciliation> & { pageNo: number; setPageNo: (page: number) => void } => {
  const api = useDesktopApi();
  const [pageNo, setPageNo] = useState(1);
  /** What the last read was answered, for the change trace. */
  const lastAnswer = useRef("no answer");
  const read = useCallback(async (): Promise<PolledReply<CartonReconciliation>> => {
    lastAnswer.current = "no answer";
    const reply = await api.getCartonStockReconciliation({ page: pageNo, pageSize: PAGE_SIZE });
    const ok = reply.accepted && reply.reconciliation;
    lastAnswer.current = ok ? describeAnswer(ok) : `refused: ${reply.reason ?? "no reason"}`;
    return ok ? { accepted: true, value: ok } : { accepted: false, reason: reply.reason };
  }, [api, pageNo]);
  const polled = usePolledRead(read, { intervalMs: CARTON_STOCK_FALLBACK_POLL_MS, failed: text.failed });
  useLiveReread(polled, lastAnswer);
  return { ...polled, pageNo, setPageNo };
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
