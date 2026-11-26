import React, { useCallback, useRef, useState } from "react";
import { CARTON_STOCK_PAGE_SIZE, type CartonStockMatrix } from "@erp/domain";
import { SearchField } from "../../components/shared/SearchField";
import { StateView } from "../../components/shared/StateView";
import { KpiCard } from "../../components/dashboard/KpiCard";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { DATA_KIND } from "../../../shared/dataChange";
import { useStockList, type StockRead } from "../kindStock/useStockList";
import { ProductionStatusBox } from "../productionDay/ProductionStatusBox";
import { useTodayMark } from "../productionDay/useProductionDay";
import { CartonMatrixList } from "./CartonMatrixList";
import { CartonCardsSkeleton, CartonStockSkeleton } from "./CartonStockSkeleton";
import { parseCartonMatrixReply } from "./cartonMatrixReply";
import { dozenFigure } from "./CartonMatrix";
import { SeriesPicker } from "./SeriesPicker";
import { useLoadMoreOnScroll } from "./useLoadMoreOnScroll";

// CARTON STOCK, FOR AN ADMINISTRATOR: the cartons in store, one matrix per article (the owner's
// design), with a search and an article series picker. It only shows stock. Another computer's movement reaches
// this page through sync's CARTONS announcement, and the page re-reads the main process's figures.
//
// The list has no pages: it shows 20 articles, and 20 more each time its end scrolls near. Every
// read asks for all the articles shown so far, so a re-read after a change keeps the same list.
//
// docs/56 (26 Nov 2026): the shared search ("/" to search, × to clear) like every other list; a re-read keeps the
// cards on screen, dimmed (aria-busy); the side-by-side button sits in this toolbar, one row of controls.

const text = copy.cartonStock;
const CARTON_CHANGES = [DATA_KIND.CARTONS, DATA_KIND.PRODUCTS] as const;
/** The picker's "All" before the first read answers. */
const NOTHING_HELD = { articles: 0, cartons: 0 };

interface MatricesProps {
  data: CartonStockMatrix;
  refreshing: boolean;
  filtered: boolean;
  loadingMore: boolean;
  /** Marks the list's end: when it scrolls near, the next articles are asked for. */
  endMarker: React.RefObject<HTMLDivElement | null>;
}

const Matrices: React.FC<MatricesProps> = ({ data, refreshing, filtered, loadingMore, endMarker }) => {
  if (data.articleCount === 0) {
    return filtered ? <StateView kind="empty" title={text.noMatchTitle} hint={text.noMatchHint} /> : <StateView kind="empty" title={text.emptyTitle} hint={text.emptyHint} />;
  }
  return (
    <>
      <div className={refreshing ? "stock-results is-refreshing" : "stock-results"} aria-busy={refreshing || undefined}>
        <CartonMatrixList articles={data.articles} />
      </div>
      {loadingMore ? <CartonCardsSkeleton count={2} message={text.loadingMore} /> : null}
      <div ref={endMarker} className="cs-list-end" aria-hidden="true" />
    </>
  );
};

/** toolbarEnd: the side-by-side button (StockSplitView), placed at the end of the toolbar. */
export const CartonStockPage: React.FC<{ toolbarEnd?: React.ReactNode }> = ({ toolbarEnd = null }) => {
  const api = useDesktopApi();
  const [series, setSeries] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const read = useCallback<StockRead<CartonStockMatrix>>(
    // The hook's page counts the parts loaded so far: page 3 shows the first 60 articles.
    async ({ search, page }) => parseCartonMatrixReply(await api.getCartonStockMatrix({ search, series, shown: page * CARTON_STOCK_PAGE_SIZE })),
    [api, series]
  );
  const stock = useStockList(read, CARTON_CHANGES);
  // Grey until today's production is completed on the Manual Production page, then green (owner, 14 Nov 2026).
  const today = useTodayMark();
  const chooseSeries = (value: string) => {
    setSeries(value);
    stock.setPage(1);
  };

  const shown = stock.data?.articles.length ?? 0;
  const hasMore = shown < (stock.data?.articleCount ?? 0);
  const loadingMore = stock.loading && hasMore && stock.page * CARTON_STOCK_PAGE_SIZE > shown;
  const showMore = useCallback(() => stock.setPage((page) => page + 1), [stock.setPage]);
  const endMarker = useLoadMoreOnScroll<HTMLDivElement>(showMore, hasMore && !stock.loading && !stock.error);

  if (!stock.data && !stock.error) return <CartonStockSkeleton />;

  const body = () => {
    if (stock.error) return <StateView kind="error" title={text.failed} message={stock.error} onRetry={stock.retry} />;
    if (!stock.data) return null;
    // Loading more articles is not a re-read of the ones on screen: only a re-read dims them.
    return <Matrices data={stock.data} refreshing={stock.loading && !loadingMore} filtered={stock.searching || series !== ""} loadingMore={loadingMore} endMarker={endMarker} />;
  };

  return (
    <div className="page-stack carton-stock-page">
      <div className="cs-panel">
        {/* The total and today's production first (owner, 16 Nov 2026), then the search and series under them. */}
        <div className="cs-overview">
          {stock.data && !stock.error ? (
            <KpiCard className="cs-summary cs-summary--hero" label={text.totalCardLabel} value={dozenFigure(stock.data.totalCartons)}
              sub={text.totalCardSub(stock.data.articleCount, stock.data.totalCartons.toLocaleString(), stock.searching || series !== "")} />
          ) : null}
          <ProductionStatusBox variant="card" mark={today.value?.mark ?? null} loading={today.loading} error={today.error} />
        </div>
        <div className="cs-toolbar stock-toolbar">
          <SearchField value={stock.search} onChange={stock.setSearch} label={text.searchLabel} placeholder={text.searchPlaceholder}
            clearLabel={copy.kindStock.searchClear} shortcutHint={copy.kindStock.searchShortcut} inputRef={searchRef} />
          <SeriesPicker value={series} options={stock.data?.seriesOptions ?? []} allSeries={stock.data?.allSeries ?? NOTHING_HELD} onChange={chooseSeries} />
          {toolbarEnd}
        </div>
        {body()}
      </div>
    </div>
  );
};
