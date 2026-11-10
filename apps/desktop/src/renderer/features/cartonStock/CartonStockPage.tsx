import React, { useCallback, useState } from "react";
import type { CartonStockMatrix } from "@erp/domain";
import { Pager } from "../../components/shared/Pager";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { DATA_KIND } from "../../../shared/dataChange";
import { useStockList, type StockRead } from "../kindStock/useStockList";
import { NAV_ICONS, RAIL_ICONS } from "../navigation/NavIcons";
import { CartonMatrix } from "./CartonMatrix";
import { parseCartonMatrixReply } from "./cartonMatrixReply";

// CARTON STOCK, FOR AN ADMINISTRATOR: the cartons in store, one matrix per article (the owner's
// design), with a search and an article series picker. It only shows stock. Another computer's movement reaches
// this page through sync's CARTONS announcement, and the page re-reads the main process's figures.

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

const Matrices: React.FC<{ data: CartonStockMatrix; filtered: boolean; onPage: (page: number) => void }> = ({ data, filtered, onPage }) => {
  if (data.articleCount === 0) {
    return filtered ? <StateView kind="empty" title={text.noMatchTitle} hint={text.noMatchHint} /> : <StateView kind="empty" title={text.emptyTitle} hint={text.emptyHint} />;
  }
  return (
    <>
      <div className="cs-articles">
        {data.articles.map((article) => (
          <CartonMatrix key={article.key} article={article} />
        ))}
      </div>
      {data.pages > 1 ? <Pager page={data.page} pages={data.pages} onPage={onPage} /> : null}
    </>
  );
};

export const CartonStockPage: React.FC = () => {
  const api = useDesktopApi();
  const [series, setSeries] = useState("");
  const read = useCallback<StockRead<CartonStockMatrix>>(
    async (query) => parseCartonMatrixReply(await api.getCartonStockMatrix({ ...query, series })),
    [api, series]
  );
  const stock = useStockList(read, CARTON_CHANGES);
  const chooseSeries = (value: string) => {
    setSeries(value);
    stock.setPage(1);
  };

  const body = () => {
    if (stock.error) return <StateView kind="error" title={text.failed} message={stock.error} onRetry={stock.retry} />;
    if (!stock.data) return stock.loading ? <StateView kind="loading" message={text.loading} /> : null;
    return <Matrices data={stock.data} filtered={stock.searching || series !== ""} onPage={stock.setPage} />;
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
