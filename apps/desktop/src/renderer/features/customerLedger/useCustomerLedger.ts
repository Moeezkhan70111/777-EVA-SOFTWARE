import { useCallback, useEffect, useState } from "react";
import { useDataChanged } from "../../hooks/useDataChanged";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { DATA_KIND } from "../../../shared/dataChange";
import type { Party } from "../../types/desktopApi";
import type { CustomerLedgerData, LedgerEntry } from "./ledgerTypes";

// The Customer Ledger's two reads: the customers to choose from, and the chosen one's ledger for the period. Both
// read again when another computer's bills, cash or parties arrive (no Ctrl+R). While a ledger is read again, the
// one on screen stays (dimmed by the page) instead of the page going blank: no layout shift.

const MONEY_CHANGES = [DATA_KIND.BILLING, DATA_KIND.CASH];
const PARTY_CHANGES = [DATA_KIND.PARTIES];
const CUSTOMER = "CUSTOMER";
const PARTY_PAGE = 1000;

export type LedgerState =
  | { status: "idle" }
  | { status: "loading"; previous: CustomerLedgerData | null }
  | { status: "error" }
  | { status: "ready"; partyId: string; data: CustomerLedgerData };

export function useLedgerCustomers() {
  const api = useDesktopApi();
  const [customers, setCustomers] = useState<Party[]>([]);
  const [failed, setFailed] = useState(false);
  const [reads, setReads] = useState(0);
  const reload = useCallback(() => setReads((count) => count + 1), []);
  useDataChanged(PARTY_CHANGES, reload);
  useEffect(() => {
    let current = true;
    api.listParties({ pageSize: PARTY_PAGE })
      .then((result) => { if (current) { setCustomers(result.rows.filter((party) => party.partyType === CUSTOMER)); setFailed(false); } })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [api, reads]);
  return { customers, failed, reload };
}

const dataOf = (result: Awaited<ReturnType<ReturnType<typeof useDesktopApi>["getCustomerLedgerWithCash"]>>): CustomerLedgerData => ({
  partyName: result.partyName,
  balanceLimit: result.balanceLimit ?? null,
  openingBalance: result.openingBalance,
  closingBalance: result.closingBalance,
  oldLedgerBalance: result.oldLedgerBalance ?? 0,
  entries: result.entries as LedgerEntry[],
});

export function useCustomerLedger(partyId: string, fromDate: string, toDate: string) {
  const api = useDesktopApi();
  const [state, setState] = useState<LedgerState>({ status: "idle" });
  const [reads, setReads] = useState(0);
  const reload = useCallback(() => setReads((count) => count + 1), []);
  useDataChanged(MONEY_CHANGES, reload);
  useDataChanged(PARTY_CHANGES, reload);

  useEffect(() => {
    if (!partyId) { setState({ status: "idle" }); return; }
    let current = true;
    // Only the same customer's ledger stays on screen while it is read again; another customer starts blank.
    setState((before) => ({ status: "loading", previous: before.status === "ready" && before.partyId === partyId ? before.data : null }));
    api.getCustomerLedgerWithCash(partyId, { fromDate, toDate })
      .then((result) => { if (current) setState({ status: "ready", partyId, data: dataOf(result) }); })
      .catch(() => { if (current) setState({ status: "error" }); });
    return () => { current = false; };
  }, [api, partyId, fromDate, toDate, reads]);

  /** What to show: the ledger read, or the one before it while the next is read. */
  const data = state.status === "ready" ? state.data : state.status === "loading" ? state.previous : null;
  return { state, data, reload };
}
