import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { GatepassShortage, GatepassStockRow, Party } from "../../types/desktopApi";
import { buildStockGrid } from "../../utils/gatepassGrid";
import { copy } from "../../config/copy";

// What the Gatepass screen reads: active parties and the whole store's stock figures
// (Current Stock, Reserved, Reflected Stock per colour + size). Figures on screen are a
// snapshot — the use case re-reads them inside the write transaction.

const PARTY_PAGE_SIZE = 1000;

export interface StoreStockState {
  rows: GatepassStockRow[];
  loading: boolean;
  error: string | null;
}

export const useGatepassData = (token: string) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [parties, setParties] = useState<Party[]>([]);
  const [partiesLoading, setPartiesLoading] = useState(true);
  const [stock, setStock] = useState<StoreStockState>({ rows: [], loading: true, error: null });
  /** Latest stock request, so a slow response never overwrites a newer one. */
  const stockRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.listParties({ status: "ACTIVE", page: 1, pageSize: PARTY_PAGE_SIZE, sortBy: "party_name", sortOrder: "ASC" });
        if (!cancelled) setParties(result.rows ?? []);
      } catch {
        if (!cancelled) push("error", copy.gatepass.partiesLoadFailed, "Reopen the page to try again.");
      } finally {
        if (!cancelled) setPartiesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, push]);

  const reloadStock = useCallback(async () => {
    const requestId = ++stockRequest.current;
    setStock((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const result = await api.listGatepassStoreStock({ token });
      if (requestId !== stockRequest.current) return;
      if (!result.accepted) {
        setStock({ rows: [], loading: false, error: result.reason ?? copy.gatepass.stockLoadFailed });
        return;
      }
      setStock({ rows: result.rows, loading: false, error: null });
    } catch {
      if (requestId !== stockRequest.current) return;
      setStock({ rows: [], loading: false, error: copy.gatepass.stockLoadFailed });
    }
  }, [api, token]);

  useEffect(() => {
    void reloadStock();
  }, [reloadStock]);

  /**
   * After a STOCK_CHANGED / INSUFFICIENT_STOCK rejection: put the live figures the backend
   * reported into the rows straight away, then re-read the whole store.
   */
  const applyShortages = useCallback(
    (shortages: GatepassShortage[]) => {
      if (shortages.length === 0) return;
      setStock((prev) => ({
        ...prev,
        rows: prev.rows.map((row) => {
          const short = shortages.find((s) => s.productVariantId === row.productVariantId);
          return short ? { ...row, storeQuantity: short.currentStock, reservedQuantity: short.reserved, reflectedQuantity: short.reflected } : row;
        }),
      }));
      void reloadStock();
    },
    [reloadStock]
  );

  const grid = useMemo(() => buildStockGrid(stock.rows), [stock.rows]);

  return { parties, partiesLoading, stock, grid, reloadStock, applyShortages };
};
