import { useCallback, useEffect, useRef, useState } from "react";
import { DATA_KIND, type DataKind } from "../../../shared/dataChange";
import { useDataChanged } from "../../hooks/useDataChanged";
import { copy } from "../../config/copy";

// Reads a stock page's list: Dana Stock's table, Upper Stock's matrices. A search or a page turn
// reads again, and only the newest answer counts, so a slow early reply cannot overwrite a later
// one. Stock that changes underneath the screen reloads it QUIETLY: the figures change, the page
// and the search stay where they are. A new `read` (a new category, a new sort) reads again too.

/** Raw material stock: what Dana and Upper Stock show. Carton Stock passes its own. */
const RAW_MATERIAL_CHANGES = [DATA_KIND.STOCK, DATA_KIND.MATERIALS] as const;
/** How long typing rests before the search is sent. */
const SEARCH_SETTLE_MS = 220;

export type StockReply<T> = { ok: true; data: T } | { ok: false; reason: string };

export type StockRead<T> = (query: { search: string; page: number }) => Promise<StockReply<T>>;

export const useStockList = <T>(read: StockRead<T>, changes: readonly DataKind[] = RAW_MATERIAL_CHANGES) => {
  const [search, setSearch] = useState("");
  const [settledSearch, setSettledSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(
    async (quiet: boolean) => {
      const asked = ++latest.current;
      if (!quiet) setLoading(true);
      try {
        const reply = await read({ search: settledSearch, page });
        if (asked !== latest.current) return;
        if (reply.ok) {
          setData(reply.data);
          setError(null);
        } else if (!quiet) {
          setError(reply.reason);
        }
      } catch (failure) {
        if (asked === latest.current && !quiet) setError(failure instanceof Error ? failure.message : copy.kindStock.unreadable);
      } finally {
        if (asked === latest.current) setLoading(false);
      }
    },
    [read, settledSearch, page]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettledSearch(search.trim());
      setPage(1);
    }, SEARCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  useDataChanged(changes, () => void load(true));

  return { search, setSearch, searching: settledSearch !== "", setPage, data, loading, error, retry: () => void load(false) };
};
