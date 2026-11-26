import { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../../config/copy";
import { useDataChanged } from "../../hooks/useDataChanged";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { DATA_KIND } from "../../../shared/dataChange";
import { parseBalancesReply, type CustomerBalanceRow } from "./customerBalances";

// Every customer's balance on a day, read again when a bill, cash voucher or party arrives from another computer
// (24 Nov 2026). A refresh keeps the rows on screen (no layout shift); a failure says so and offers Retry (R12).

const MONEY_CHANGES = [DATA_KIND.BILLING, DATA_KIND.CASH, DATA_KIND.PARTIES];

export interface BalancesState {
  rows: CustomerBalanceRow[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export const useCustomerBalances = (asOfDate: string): BalancesState => {
  const api = useDesktopApi();
  const [rows, setRows] = useState<CustomerBalanceRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const ticket = ++latest.current;
    setLoading(true);
    void api.listCustomerBalances({ asOfDate })
      .then((reply) => {
        if (ticket !== latest.current) return;
        const parsed = parseBalancesReply(reply);
        if (parsed.ok) { setRows(parsed.rows); setError(null); } else setError(parsed.reason);
      })
      .catch(() => { if (ticket === latest.current) setError(copy.customerBalance.failed); })
      .finally(() => { if (ticket === latest.current) setLoading(false); });
  }, [api, asOfDate]);

  useEffect(reload, [reload]);
  useDataChanged(MONEY_CHANGES, reload);
  return { rows, loading, error, reload };
};

