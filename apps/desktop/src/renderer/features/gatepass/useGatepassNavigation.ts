import { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { Gatepass } from "../../types/desktopApi";
import { copy } from "../../config/copy";

// Previous / next / load between stored Gatepasses. Numbers are assigned in order and
// never reused (cancelled documents keep theirs), so "next" is simply number + 1 and the
// highest existing number is the last row of the list. Looking at an old document never
// touches the draft being written — "next" past the latest returns to it.

export interface GatepassNavigation {
  /** The stored document on screen; null while a new one is being written. */
  viewing: Gatepass | null;
  /** Highest number that exists (0 when none); null until known. */
  latest: number | null;
  busy: boolean;
  goTo: (gatepassNumber: number) => Promise<void>;
  /** Show a document that was just created or re-read. */
  show: (document: Gatepass) => void;
  /** Back to the draft. */
  close: () => void;
}

export const useGatepassNavigation = (token: string): GatepassNavigation => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [viewing, setViewing] = useState<Gatepass | null>(null);
  const [latest, setLatest] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.listGatepasses({ page: 1, pageSize: 1 }, { token });
        if (!cancelled) setLatest(result.rows[0]?.gatepassNumber ?? 0);
      } catch {
        if (!cancelled) setLatest(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, token]);

  const goTo = useCallback(
    async (gatepassNumber: number) => {
      if (busy || !Number.isInteger(gatepassNumber) || gatepassNumber < 1) return;
      setBusy(true);
      try {
        const document = await api.getGatepassByNumber(gatepassNumber, { token });
        if (document) {
          setViewing(document);
          setLatest((prev) => Math.max(prev ?? 0, document.gatepassNumber));
        } else {
          push("info", copy.toast.notFound, copy.gatepass.numberNotFound(gatepassNumber));
        }
      } catch {
        push("error", copy.toast.loadFailed, copy.gatepass.documentLoadFailed);
      } finally {
        setBusy(false);
      }
    },
    [api, busy, push, token]
  );

  const show = useCallback((document: Gatepass) => {
    setViewing(document);
    setLatest((prev) => Math.max(prev ?? 0, document.gatepassNumber));
  }, []);

  const close = useCallback(() => setViewing(null), []);

  return { viewing, latest, busy, goTo, show, close };
};
