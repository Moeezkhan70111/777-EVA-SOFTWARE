import { useCallback, useEffect, useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { readArchiveBatch, readWithdrawOutcome, type ArchiveStatement, type WithdrawOutcome } from "./archiveReplies";

// WITHDRAWING ONE IMPORT (docs/53): load what the import wrote, take a reason, withdraw. One request id for the
// dialog's life, so a retry after a lost answer is answered, not repeated. Who withdrew comes from the session; the
// main process refuses an import an opening balance was checked against, and says so.

const text = copy.ledgerArchive;

export type BatchState = { status: "loading" } | { status: "error"; reason: string | null } | { status: "ready"; statements: ArchiveStatement[] };

export function useWithdrawArchive(batchId: string) {
  const api = useDesktopApi();
  const [requestId] = useState(() => crypto.randomUUID());
  const [batch, setBatch] = useState<BatchState>({ status: "loading" });
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<WithdrawOutcome | null>(null);

  const load = useCallback(() => {
    setBatch({ status: "loading" });
    api.getLedgerArchiveBatch(batchId)
      .then((raw) => {
        const reply = readArchiveBatch(raw);
        setBatch(reply.ok ? { status: "ready", statements: reply.value } : { status: "error", reason: reply.reason });
      })
      .catch(() => setBatch({ status: "error", reason: null }));
  }, [api, batchId]);
  useEffect(load, [load]);

  const submit = useCallback(async () => {
    if (!reason.trim()) {
      setRefusal(text.withdrawReasonNeeded);
      return;
    }
    setSaving(true);
    setRefusal(null);
    const reply = readWithdrawOutcome(await api.withdrawLedgerArchiveBatch({ requestId, batchId, reason: reason.trim() }).catch(() => null));
    setSaving(false);
    if (!reply.ok) {
      setRefusal(reply.reason ?? text.withdrawFailed);
      return;
    }
    setOutcome(reply.value);
  }, [api, batchId, reason, requestId]);

  return { batch, reason, setReason, saving, refusal, outcome, submit, reload: load };
}
