import React, { useCallback, useState } from "react";
import { CARTON_STOCK_PAGE_SIZE, type CartonStockMatrix } from "@erp/domain";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { DATA_KIND } from "../../../shared/dataChange";
import { useStockList, type StockRead } from "../kindStock/useStockList";
import { NAV_ICONS, RAIL_ICONS } from "../navigation/NavIcons";
import { CartonMatrix } from "./CartonMatrix";
import { CARTON_LAYOUT, cartonLayout } from "./cartonMatrixLayout";
import { CartonCardsSkeleton, CartonStockSkeleton } from "./CartonStockSkeleton";
import { parseCartonMatrixReply } from "./cartonMatrixReply";
import { useElementWidth } from "./useElementWidth";
import { useLoadMoreOnScroll } from "./useLoadMoreOnScroll";

// CARTON STOCK, FOR AN ADMINISTRATOR: the cartons in store, one matrix per article (the owner's
// design), with a search and an article series picker. It only shows stock. Another computer's movement reaches
// this page through sync's CARTONS announcement, and the page re-reads the main process's figures.
//
// The list has no pages: it shows 20 articles, and 20 more each time its end scrolls near. Every
// read asks for all the articles shown so far, so a re-read after a change keeps the same list.

const text = copy.cartonStock;
const CARTON_CHANGES = [DATA_KIND.CARTONS, DATA_KIND.PRODUCTS] as const;

interface PickerProps {
  icon: React.ReactNode;
  label: string;
  all: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}

/** All, or one value. Its options are every series with stock, whatever the search says. */
const Picker: React.FC<PickerProps> = ({ icon, label, all, value, options, onChange }) => (
  <label className="cs-picker">
    <span className="cs-picker-icon" aria-hidden="true">{icon}</span>
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{all}</option>
      {options.map((option) => (
        <option key={option} value={option}>{option}</option>
      ))}
    </select>
    <span className="cs-picker-arrow" aria-hidden="true">{RAIL_ICONS.chevronUp}</span>
  </label>
);

interface MatricesProps {
  data: CartonStockMatrix;
  filtered: boolean;
  loadingMore: boolean;
  /** Marks the list's end: when it scrolls near, the next articles are asked for. */
  endMarker: React.RefObject<HTMLDivElement | null>;
}

/** The cards' column widths come from cartonMatrixLayout, so the bands it works out are the ones drawn. */
const LIST_STYLE = { "--cs-name-width": `${CARTON_LAYOUT.nameWidth}px` } as React.CSSProperties;

const Matrices: React.FC<MatricesProps> = ({ data, filtered, loadingMore, endMarker }) => {
  // Measured once for the whole list: every card is as wide as the list.
  const [listRef, listWidth] = useElementWidth<HTMLDivElement>();
  if (data.articleCount === 0) {
    return filtered ? <StateView kind="empty" title={text.noMatchTitle} hint={text.noMatchHint} /> : <StateView kind="empty" title={text.emptyTitle} hint={text.emptyHint} />;
  }
  const layout = cartonLayout(listWidth);
  return (
    <>
      <div ref={listRef} className={layout.stacked ? "cs-articles cs-articles--stacked" : "cs-articles"} style={LIST_STYLE}>
        {data.articles.map((article) => (
          <CartonMatrix key={article.key} article={article} layout={layout} />
        ))}
      </div>
      {loadingMore ? <CartonCardsSkeleton count={2} message={text.loadingMore} /> : null}
      <div ref={endMarker} className="cs-list-end" aria-hidden="true" />
    </>
  );
};

export const CartonStockPage: React.FC = () => {
  const api = useDesktopApi();
  const [series, setSeries] = useState("");
  const read = useCallback<StockRead<CartonStockMatrix>>(
    // The hook's page counts the parts loaded so far: page 3 shows the first 60 articles.
    async ({ search, page }) => parseCartonMatrixReply(await api.getCartonStockMatrix({ search, series, shown: page * CARTON_STOCK_PAGE_SIZE })),
    [api, series]
  );
  const stock = useStockList(read, CARTON_CHANGES);
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
    return <Matrices data={stock.data} filtered={stock.searching || series !== ""} loadingMore={loadingMore} endMarker={endMarker} />;
  };

  return (
    <div className="page-stack carton-stock-page">
      <div className="cs-panel">
        <div className="cs-toolbar">
          <label className="us-search cs-search">
            <span className="us-search-icon" aria-hidden="true">{RAIL_ICONS.search}</span>
            <input type="search" aria-label={text.searchLabel} placeholder={text.searchPlaceholder} value={stock.search} onChange={(event) => stock.setSearch(event.target.value)} />
          </label>
          <Picker icon={NAV_ICONS.stock} label={text.seriesLabel} all={text.allSeries} value={series} options={stock.data?.seriesOptions ?? []} onChange={chooseSeries} />
        </div>
        {body()}
      </div>
    </div>
  );
};
