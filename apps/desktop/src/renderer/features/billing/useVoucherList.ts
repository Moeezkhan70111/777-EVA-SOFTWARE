import { useCallback, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";

// The saved bills in number order, for ‹ › navigation and the next bill's number.

const numberOf = (voucherNumber?: string | null): number => {
  const value = Number.parseInt(String(voucherNumber ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(value) ? value : 0;
};

interface VoucherRef {
  id: string;
  voucherNumber?: string | null;
}

const sortByNumber = <T extends VoucherRef>(rows: T[]): T[] => [...rows].sort((a, b) => numberOf(a.voucherNumber) - numberOf(b.voucherNumber));

export interface VoucherListSnapshot {
  ids: string[];
  /** One past the highest number saved. */
  nextNumber: string;
}

export const useVoucherList = () => {
  const api = useDesktopApi();
  const [ids, setIds] = useState<string[]>([]);

  const refresh = useCallback(async (): Promise<VoucherListSnapshot> => {
    const rows = sortByNumber((await api.listSaleVouchers({ pageSize: 1000 })).rows);
    const next = rows.reduce((max, row) => Math.max(max, numberOf(row.voucherNumber)), 0) + 1;
    const snapshot = { ids: rows.map((row) => row.id), nextNumber: String(next) };
    setIds(snapshot.ids);
    return snapshot;
  }, [api]);

  /** The bill with this number, and where it sits in the list. */
  const findByNumber = useCallback(
    async (voucherNumber: string): Promise<{ id: string; index: number } | null> => {
      const result = await api.listSaleVouchers({ pageSize: 1000, search: voucherNumber });
      const match = result.rows[0];
      if (!match) return null;
      const snapshot = await refresh();
      return { id: match.id, index: Math.max(0, snapshot.ids.indexOf(match.id)) };
    },
    [api, refresh]
  );

  return { ids, refresh, findByNumber };
};
