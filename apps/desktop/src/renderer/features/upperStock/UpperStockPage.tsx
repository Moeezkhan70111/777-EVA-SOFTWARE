import React, { useCallback, useRef, useState } from "react";
import { UPPER_STOCK_CATEGORY, UPPER_STOCK_PAGE_SIZE, UPPER_STOCK_SORT, type UpperStockCategory, type UpperStockMatrix, type UpperStockSort } from "@erp/domain";
import { SearchField } from "../../components/shared/SearchField";
import { StateView } from "../../components/shared/StateView";
import { TabStrip } from "../../components/shared/TabStrip";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { CartonCardsSkeleton } from "../cartonStock/CartonStockSkeleton";
import { useLoadMoreOnScroll } from "../cartonStock/useLoadMoreOnScroll";
import { useStockList, type StockRead } from "../kindStock/useStockList";
import { NAV_ICONS, RAIL_ICONS } from "../navigation/NavIcons";
import { UpperMatrix } from "./UpperMatrix";
import { UPPER_CATEGORY_TABS, UPPER_SORT_OPTIONS, parseUpperStockReply } from "./upperStock";

// UPPER STOCK: what is in the store, one matrix per article. Read-only, behind stock.upper.view,
// which the main process checks on every read. Moving stock stays on the Store page, where every
// movement is scanned.
//
// docs/56 (26 Nov 2026): the shared search ("/" to search, × to clear) like every other list; how many articles match
// said beside the controls; the first read shows the cards' own outline, not a spinner (no layout shift); a re-read
// keeps the cards on screen, dimmed (aria-busy); the side-by-side button sits in this toolbar, one row of controls.
// No page numbers (owner, 26 Nov 2026): like Carton Stock, 20 articles, and 20 more each time the list's end scrolls
// near. Every read asks for all the articles shown so far, so a re-read after a change keeps the same list.

const TABS = UPPER_CATEGORY_TABS.map((tab) => ({ id: tab.id, label: tab.label, icon: NAV_ICONS[tab.icon] }));
const SKELETON_CARDS = 3;

interface MatricesProps {
  data: UpperStockMatrix;
  refreshing: boolean;
  loadingMore: boolean;
  /** Marks the list's end: when it scrolls near, the next articles are asked for. */
  endMarker: React.RefObject<HTMLDivElement | null>;
}

const Matrices: React.FC<MatricesProps> = ({ data, refreshing, loadingMore, endMarker }) => (
  <>
    <div className={refreshing ? "us-articles stock-results is-refreshing" : "us-articles stock-results"} aria-busy={refreshing || undefined}>
      {data.articles.map((article) => (
        <UpperMatrix key={article.key} article={article} />
      ))}
    </div>
    {loadingMore ? <CartonCardsSkeleton count={2} message={copy.cartonStock.loadingMore} /> : null}
    <div ref={endMarker} className="cs-list-end" aria-hidden="true" />
  </>
);

interface UpperStockPageProps {
  /** false beside Carton Stock, where the split pane names it. */
  showTitle?: boolean;
  /** The side-by-side button (StockSplitView), placed at the end of the toolbar. */
  toolbarEnd?: React.ReactNode;
}

export const UpperStockPage: React.FC<UpperStockPageProps> = ({ showTitle = true, toolbarEnd = null }) => {
  const api = useDesktopApi();
  const [category, setCategory] = useState<UpperStockCategory>(UPPER_STOCK_CATEGORY.ALL);
  const [sort, setSort] = useState<UpperStockSort>(UPPER_STOCK_SORT.NAME_ASC);
  const searchRef = useRef<HTMLInputElement>(null);
  const read = useCallback<StockRead<UpperStockMatrix>>(
    // The hook's page counts the parts loaded so far: page 3 shows the first 60 articles, all asked for at once.
    async ({ search, page }) => parseUpperStockReply(await api.listUpperStockMatrix({ search, category, sort, page: 1, pageSize: page * UPPER_STOCK_PAGE_SIZE })),
    [api, category, sort]
  );
  const stock = useStockList(read);
  const { data } = stock;
  const shown = data?.articles.length ?? 0;
  const hasMore = shown < (data?.articleCount ?? 0);
  const loadingMore = stock.loading && hasMore && stock.page * UPPER_STOCK_PAGE_SIZE > shown;
  // Loading more articles is not a re-read of the ones on screen: only a re-read dims them.
  const refreshing = stock.loading && data !== null && !loadingMore;
  const showMore = useCallback(() => stock.setPage((page) => page + 1), [stock.setPage]);
  const endMarker = useLoadMoreOnScroll<HTMLDivElement>(showMore, hasMore && !stock.loading && !stock.error);

  const chooseCategory = (next: UpperStockCategory) => {
    setCategory(next);
    stock.setPage(1);
  };
  const chooseSort = (next: UpperStockSort) => {
    setSort(next);
    stock.setPage(1);
  };

  const body = () => {
    if (stock.error && !data) return <StateView kind="error" title={copy.kindStock.failedTitle} message={stock.error} onRetry={stock.retry} />;
    if (!data) return <CartonCardsSkeleton count={SKELETON_CARDS} message={copy.kindStock.loading} />;
    if (data.articleCount > 0) return <Matrices data={data} refreshing={refreshing} loadingMore={loadingMore} endMarker={endMarker} />;
    return stock.searching ? (
      <StateView kind="empty" title={copy.kindStock.noMatchTitle} hint={copy.kindStock.noMatchHint} />
    ) : (
      <StateView kind="empty" title={copy.kindStock.upperEmptyTitle} hint={copy.kindStock.upperEmptyHint} />
    );
  };

  return (
    <div className="page upper-stock-page">
      {showTitle ? <h1 className="page-title">{copy.nav.items.upperStock.label}</h1> : null}
      <div className="us-panel">
        <TabStrip className="us-tabs" items={TABS} active={category} onSelect={chooseCategory} label={copy.upperStock.categoriesLabel} />
        <div className="us-toolbar stock-toolbar">
          <SearchField value={stock.search} onChange={stock.setSearch} label={copy.upperStock.searchLabel} placeholder={copy.upperStock.searchPlaceholder}
            clearLabel={copy.kindStock.searchClear} shortcutHint={copy.kindStock.searchShortcut} inputRef={searchRef} />
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
          {data ? <span className="stock-count" aria-live="polite">{copy.upperStock.articleCount(data.articleCount)}</span> : null}
          {toolbarEnd}
        </div>
        {stock.error && data ? <StateView kind="error" compact message={stock.error} onRetry={stock.retry} /> : null}
        {body()}
      </div>
    </div>
  );
};
