import { useCallback, useEffect, useRef, useState } from "react";
import { compareSizes } from "@erp/domain";
import { copy } from "../../config/copy";
import { useDataChanged } from "../../hooks/useDataChanged";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { DATA_KIND } from "../../../shared/dataChange";
import type { Party } from "../../types/desktopApi";
import type { DiscountReportLine } from "./discountPolicy";

// Everything the Discount Policy page shows, read once and again when a customer (and so their rules, which travel
// with them) or a product arrives from another computer. A refresh keeps what is on screen; a failure says so and
// offers Retry (R12).

const CHANGES = [DATA_KIND.PARTIES, DATA_KIND.PRODUCTS];

export interface NamedOption { readonly id: string; readonly name: string }

export interface DiscountPolicyData {
  readonly customers: readonly Party[];
  readonly groups: readonly NamedOption[];
  readonly series: readonly NamedOption[];
  /** Each active article with its sizes, smallest first. */
  readonly articles: ReadonlyMap<string, readonly string[]>;
  readonly report: readonly DiscountReportLine[];
}

export interface DiscountPolicyState {
  data: DiscountPolicyData | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const articleSizes = (rows: ReadonlyArray<{ article: string; size: string }>): Map<string, string[]> => {
  const sizes = new Map<string, Set<string>>();
  for (const row of rows) sizes.set(row.article, (sizes.get(row.article) ?? new Set()).add(row.size));
  return new Map([...sizes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([article, set]) => [article, [...set].sort(compareSizes)]));
};

export const useDiscountPolicy = (): DiscountPolicyState => {
  const api = useDesktopApi();
  const [data, setData] = useState<DiscountPolicyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const ticket = ++latest.current;
    setLoading(true);
    void (async () => {
      try {
        const [parties, groups, series, products] = await Promise.all([
          api.listParties({ pageSize: 1000, partyType: "CUSTOMER" }), api.listProductGroups(), api.listArticleSeries(), api.listProducts({ pageSize: 1000, status: "ACTIVE" }),
        ]);
        const report = (await Promise.all(parties.rows.map((party) => api.getPartyDiscountReport(party.id)))).flat();
        if (ticket !== latest.current) return;
        setData({
          customers: [...parties.rows].sort((a, b) => a.partyName.localeCompare(b.partyName)),
          groups: groups.map((group) => ({ id: group.id, name: group.groupName })).sort((a, b) => a.name.localeCompare(b.name)),
          series: series.map((one) => ({ id: one.id, name: one.name })).sort((a, b) => a.name.localeCompare(b.name)),
          articles: articleSizes(products.rows),
          report,
        });
        setError(null);
      } catch {
        if (ticket === latest.current) setError(copy.discountPolicy.failed);
      } finally {
        if (ticket === latest.current) setLoading(false);
      }
    })();
  }, [api]);

  useEffect(reload, [reload]);
  useDataChanged(CHANGES, reload);
  return { data, loading, error, reload };
};
