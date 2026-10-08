import { useEffect, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";

// The selected party's current balance (rupees), from the one balance query the billing
// screens use. Shown for information only — a Gatepass is not a bill and no limit applies.

export type PartyBalanceState = { status: "idle" } | { status: "loading" } | { status: "ready"; value: number } | { status: "error" };

export const usePartyBalance = (partyId: string): PartyBalanceState => {
  const api = useDesktopApi();
  const [state, setState] = useState<PartyBalanceState>({ status: "idle" });

  useEffect(() => {
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
  }, [api, partyId]);

  return state;
};
