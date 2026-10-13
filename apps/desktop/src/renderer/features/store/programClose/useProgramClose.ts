import { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { useNotifications } from "../../../state/NotificationsContext";
import { copy } from "../../../config/copy";
import type { MachineProgramReconciliation, ReconciliationEntryInput } from "../../../types/desktopApi";
import type { ProgramOutState } from "../programOut/useProgramOut";

// COMPLETE PROGRAM — closing a machine program against the cartons that came back.
//
// The figures (due, back, missing uppers) and every rule are the main process's: this hook reads
// how the program stands, sends what the store says became of the missing uppers, and re-reads.

interface UseProgramCloseInput {
  token: string;
  programId: string;
  /** Re-reads the program after it closes, so every section shows it closed. */
  onClosed: () => Promise<void>;
}

export interface ProgramCloseState {
  reconciliation: MachineProgramReconciliation | null;
  loading: boolean;
  error: string | null;
  /** Re-reads how the program stands — before the dialog opens, so its figures are current. */
  load: () => Promise<MachineProgramReconciliation | null>;
  /** Closes the program. Answers with the main process's refusal, or null when it closed. */
  complete: (entries: ReconciliationEntryInput[]) => Promise<string | null>;
}

export const useProgramClose = ({ token, programId, onClosed }: UseProgramCloseInput): ProgramCloseState => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [reconciliation, setReconciliation] = useState<MachineProgramReconciliation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // No program open yet: nothing to count.
    if (!programId) {
      setReconciliation(null);
      setLoading(false);
      return null;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMachineProgramReconciliation(programId, { token });
      const next = result.accepted && result.reconciliation ? result.reconciliation : null;
      setReconciliation(next);
      if (!next) setError(result.reason ?? copy.states.loadFailedBody);
      return next;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.states.loadFailedBody);
      return null;
    } finally {
      setLoading(false);
    }
  }, [api, programId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const complete = useCallback(
    async (entries: ReconciliationEntryInput[]): Promise<string | null> => {
      try {
        const result = await api.completeMachineProgramProduction({ programId, entries }, { token });
        if (!result.accepted || !result.closure) return result.reason ?? copy.states.loadFailedBody;
        const code = reconciliation?.code ?? "";
        if (result.closure.outcome === "COMPLETE") push("success", copy.programClose.completedTitle, copy.programClose.completedBody(code));
        else push("success", copy.programClose.reconciledTitle, copy.programClose.reconciledBody(code));
        await load();
        await onClosed();
        return null;
      } catch (caught) {
        return caught instanceof Error ? caught.message : copy.states.loadFailedBody;
      }
    },
    [api, load, onClosed, programId, push, reconciliation?.code, token]
  );

  return { reconciliation, loading, error, load, complete };
};

/**
 * The close state of whatever program a Store page has open — ONE per page, shared by everything
 * on it that needs to know whether the program is closed (the program view, and Store In's Carton
 * In station on the right). Every carton stored in changes how the program stands, so it counts
 * afresh whenever the carton figures move.
 */
export const useProgramCloseFor = (state: Pick<ProgramOutState, "token" | "program" | "reload" | "cartonProgress">): ProgramCloseState => {
  const close = useProgramClose({ token: state.token, programId: state.program?.id ?? "", onClosed: state.reload });
  const { load } = close;
  useEffect(() => {
    void load();
  }, [state.cartonProgress, load]);
  return close;
};

/** Closed is final: nothing more is issued, printed or stored in against the program. */
export const isProgramClosed = (close: ProgramCloseState): boolean => Boolean(close.reconciliation?.closure);
