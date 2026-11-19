import { useCallback, useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useDataChanged } from "../../hooks/useDataChanged";
import { DATA_KIND } from "../../../shared/dataChange";
import { readOpeningBalanceView, type OpeningBalanceView } from "./openingBalanceReplies";

// One party's opening balance for its ledger screen (docs/53), loaded beside the ledger and reloaded when it is
// posted, corrected or reversed here or on the accounts computer.

export type OpeningBalanceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; reason: string | null }
  | { status: "ready"; view: OpeningBalanceView };

const CHANGES = [DATA_KIND.CASH];

export function useOpeningBalance(partyId: string) {
  const api = useDesktopApi();
  const [state, setState] = useState<OpeningBalanceState>({ status: "idle" });
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((count) => count + 1), []);
  useDataChanged(CHANGES, reload);

  useEffect(() => {
    if (!partyId) {
      setState({ status: "idle" });
      return;
    }
    let current = true;
    setState({ status: "loading" });
    api
      .getPartyOpeningBalance(partyId)
      .then((raw) => {
        if (!current) return;
        const reply = readOpeningBalanceView(raw);
        setState(reply.ok ? { status: "ready", view: reply.value } : { status: "error", reason: reply.reason });
      })
      .catch(() => {
        if (current) setState({ status: "error", reason: null });
      });
    return () => {
      current = false;
    };
  }, [api, partyId, reloads]);

  return { state, reload };
}
