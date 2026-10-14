import { useCallback } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { usePolledRead, type PolledRead, type PolledReply } from "../../hooks/usePolledRead";
import type { ProgramReconciliation, ReconcilableProgram } from "../../types/desktopApi";

// The two reads behind Reconciliation — both the main process's answer, kept current by usePolledRead
// (on open, on a program or day change, and every POLL_MS while visible), so cartons received and uppers
// issued elsewhere show without pressing anything. Neither read writes.

export const POLL_MS = 10000;

/** Every machine program of one business date, for choosing one. */
export const useReconcilablePrograms = (programDate: string, failed: string): PolledRead<ReconcilableProgram[]> => {
  const api = useDesktopApi();
  const read = useCallback(async (): Promise<PolledReply<ReconcilableProgram[]>> => {
    const reply = await api.listReconcilablePrograms(programDate);
    return reply.accepted ? { accepted: true, value: reply.rows } : { accepted: false, reason: reply.reason };
  }, [api, programDate]);
  return usePolledRead(read, { intervalMs: POLL_MS, failed });
};

/** Upper Out against Production Received for one program. No program, nothing read. */
export const useProgramReconciliation = (programId: string | null, failed: string): PolledRead<ProgramReconciliation | null> => {
  const api = useDesktopApi();
  const read = useCallback(async (): Promise<PolledReply<ProgramReconciliation | null>> => {
    if (!programId) return { accepted: true, value: null };
    const reply = await api.getProgramReconciliation(programId);
    return reply.accepted && reply.reconciliation ? { accepted: true, value: reply.reconciliation } : { accepted: false, reason: reply.reason };
  }, [api, programId]);
  return usePolledRead(read, { intervalMs: POLL_MS, failed });
};
