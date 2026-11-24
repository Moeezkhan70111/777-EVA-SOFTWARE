import { useCallback } from "react";
import { isCustomerOrderPartyType } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useDataChanged } from "../../hooks/useDataChanged";
import { useLoaded, type Loaded } from "../../hooks/useLoaded";
import { DATA_KIND } from "../../../shared/dataChange";
import type { SearchableComboboxOption } from "../../components/shared/SearchableCombobox";

// What an order may name: the active parties of Party Master, and the articles of Product Master. Re-read when either
// changes on any computer. The article's colours and sizes are read when it is added (useOrderDraft).
//
// Customers only (owner, 24 Nov 2026; CUSTOMER_ORDER_PARTY_TYPES): every active party is read, each marked whether it is
// a customer, so an order being edited still names its own party when that was written before the rule
// (orderPartyOptions). Saving refuses any other party in the main process; this list is a convenience, not the guard.

const PARTY_PAGE_SIZE = 1000;

export interface OrderPartyOption extends SearchableComboboxOption {
  readonly customer: boolean;
}

export interface OrderChoices {
  readonly parties: Loaded<OrderPartyOption[]>;
  readonly articles: Loaded<SearchableComboboxOption[]>;
}

/** The parties the order offers: customers, and the party the order already names (kept from before the rule). */
export const orderPartyOptions = (parties: readonly OrderPartyOption[], keepPartyId: string): OrderPartyOption[] =>
  parties.filter((party) => party.customer || party.value === keepPartyId);

export const useOrderChoices = (): OrderChoices => {
  const api = useDesktopApi();

  const readParties = useCallback(async () => {
    const result = await api.listParties({ status: "ACTIVE", page: 1, pageSize: PARTY_PAGE_SIZE, sortBy: "party_name", sortOrder: "ASC" });
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    return {
      accepted: true,
      value: rows.map((party) => ({ value: party.id, label: party.partyName, detail: party.city ?? undefined, customer: isCustomerOrderPartyType(party.partyType) })),
    };
  }, [api]);

  const readArticles = useCallback(async () => {
    const names = await api.listUniqueArticles();
    return { accepted: true, value: (Array.isArray(names) ? names : []).filter((name) => typeof name === "string").map((name) => ({ value: name, label: name })) };
  }, [api]);

  const parties = useLoaded("orders:parties", readParties, (answer) => answer.value, [] as OrderPartyOption[]);
  const articles = useLoaded("orders:articles", readArticles, (answer) => answer.value, [] as SearchableComboboxOption[]);
  useDataChanged([DATA_KIND.PARTIES], () => void parties.reload());
  useDataChanged([DATA_KIND.PRODUCTS], () => void articles.reload());
  return { parties, articles };
};
