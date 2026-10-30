import { useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useLedgersShown } from "./ledgerVisibility";

// The selected party's current balance (rupees), from the one balance query the billing
// screens use. Shown for information only — a Gatepass is not a bill and no limit applies.
// "hidden" on any computer that does not hold the Accounts lease (ledgerVisibility.ts).

export type PartyBalanceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; value: number }
  | { status: "error" }
  | { status: "hidden" };

export const usePartyBalance = (partyId: string): PartyBalanceState => {
  const api = useDesktopApi();
  const shown = useLedgersShown();
  const [state, setState] = useState<PartyBalanceState>({ status: "idle" });

  useEffect(() => {
    if (!shown) {
      setState({ status: "hidden" });
      return;
    }
    if (!partyId) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const value = await api.getCurrentPartyBalance(partyId);
        if (!cancelled) setState(typeof value === "number" && Number.isFinite(value) ? { status: "ready", value } : { status: "error" });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, partyId, shown]);

  return state;
};
