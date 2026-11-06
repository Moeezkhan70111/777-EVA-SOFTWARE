import React, { useCallback, useState } from "react";
import { UPPER_STOCK_CATEGORY, UPPER_STOCK_SORT, type UpperStockCategory, type UpperStockMatrix, type UpperStockSort } from "@erp/domain";
import { Pager } from "../../components/shared/Pager";
import { StateView } from "../../components/shared/StateView";
import { TabStrip } from "../../components/shared/TabStrip";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useStockList, type StockRead } from "../kindStock/useStockList";
import { NAV_ICONS, RAIL_ICONS } from "../navigation/NavIcons";
import { UpperMatrix } from "./UpperMatrix";
import { UPPER_CATEGORY_TABS, UPPER_SORT_OPTIONS, parseUpperStockReply } from "./upperStock";

// UPPER STOCK: what is in the store, one matrix per article. Read-only, behind stock.upper.view,
// which the main process checks on every read. Moving stock stays on the Store page, where every
// movement is scanned.

const TABS = UPPER_CATEGORY_TABS.map((tab) => ({ id: tab.id, label: tab.label, icon: NAV_ICONS[tab.icon] }));

const Matrices: React.FC<{ data: UpperStockMatrix; onPage: (page: number) => void }> = ({ data, onPage }) => (
  <>
    <div className="us-articles">
      {data.articles.map((article) => (
        <UpperMatrix key={article.key} article={article} />
      ))}
    </div>
    {data.pages > 1 ? <Pager page={data.page} pages={data.pages} onPage={onPage} /> : null}
  </>
);

export const UpperStockPage: React.FC = () => {
  const api = useDesktopApi();
  const [category, setCategory] = useState<UpperStockCategory>(UPPER_STOCK_CATEGORY.ALL);
  const [sort, setSort] = useState<UpperStockSort>(UPPER_STOCK_SORT.NAME_ASC);
  const read = useCallback<StockRead<UpperStockMatrix>>(
    async (query) => parseUpperStockReply(await api.listUpperStockMatrix({ ...query, category, sort })),
    [api, category, sort]
  );
  const stock = useStockList(read);
  const { data } = stock;

  const chooseCategory = (next: UpperStockCategory) => {
    setCategory(next);
    stock.setPage(1);
  };
  const chooseSort = (next: UpperStockSort) => {
    setSort(next);
    stock.setPage(1);
  };

  const body = () => {
    if (stock.error) return <StateView kind="error" title={copy.kindStock.failedTitle} message={stock.error} onRetry={stock.retry} />;
    if (!data) return stock.loading ? <StateView kind="loading" /> : null;
    if (data.articleCount > 0) return <Matrices data={data} onPage={stock.setPage} />;
    return stock.searching ? (
      <StateView kind="empty" title={copy.kindStock.noMatchTitle} hint={copy.kindStock.noMatchHint} />
    ) : (
      <StateView kind="empty" title={copy.kindStock.upperEmptyTitle} hint={copy.kindStock.upperEmptyHint} />
    );
  };

  return (
    <div className="page upper-stock-page">
      <h1 className="page-title">{copy.nav.items.upperStock.label}</h1>
      <div className="us-panel">
        <TabStrip className="us-tabs" items={TABS} active={category} onSelect={chooseCategory} label={copy.upperStock.categoriesLabel} />
        <div className="us-toolbar">
          <label className="us-search">
            <span className="us-search-icon" aria-hidden="true">{RAIL_ICONS.search}</span>
            <input
              type="search"
              aria-label={copy.upperStock.searchLabel}
              placeholder={copy.upperStock.searchPlaceholder}
              value={stock.search}
              onChange={(event) => stock.setSearch(event.target.value)}
            />
          </label>
          <label className="us-sort">
            <span className="us-sort-icon" aria-hidden="true">{RAIL_ICONS.sort}</span>
            <span>{copy.upperStock.sortBy}</span>
            <select value={sort} onChange={(event) => chooseSort(event.target.value as UpperStockSort)}>
              {UPPER_SORT_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <span className="us-sort-arrow" aria-hidden="true">{RAIL_ICONS.chevronUp}</span>
          </label>
        </div>
        {body()}
      </div>
    </div>
  );
};
