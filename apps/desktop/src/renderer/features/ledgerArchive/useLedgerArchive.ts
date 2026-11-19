import { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useDataChanged } from "../../hooks/useDataChanged";
import { DATA_KIND } from "../../../shared/dataChange";
import { readArchiveView, type ArchiveView } from "./archiveReplies";

// One customer's archived rows for the Customer Ledger's date range (docs/50), loaded beside the live ledger and
// reloaded when an import here or on another computer adds some.

export type ArchiveState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; reason: string | null }
  | { status: "ready"; view: ArchiveView };

const EMPTY: ArchiveView = { statements: [], entries: [] };
const ARCHIVE_CHANGES = [DATA_KIND.BILLING];

export function useLedgerArchive(partyId: string, fromDate: string, toDate: string) {
  const api = useDesktopApi();
  const [state, setState] = useState<ArchiveState>({ status: "idle" });
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((count) => count + 1), []);
  useDataChanged(ARCHIVE_CHANGES, reload);

  useEffect(() => {
    if (!partyId) {
      setState({ status: "idle" });
      return;
    }
    let current = true;
    setState({ status: "loading" });
    api
      .getLedgerArchive(partyId, { fromDate, toDate })
      .then((raw) => {
        if (!current) return;
        const reply = readArchiveView(raw);
        setState(reply.ok ? { status: "ready", view: reply.value } : { status: "error", reason: reply.reason });
      })
      .catch(() => {
        if (current) setState({ status: "error", reason: null });
      });
    return () => {
      current = false;
    };
  }, [api, partyId, fromDate, toDate, reloads]);

  /** The rows to show: none until they have loaded, so the live ledger is never held up by the archive. */
  const view = state.status === "ready" ? state.view : EMPTY;
  return { state, view, reload };
}
