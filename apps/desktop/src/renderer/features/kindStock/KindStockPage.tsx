import React, { useCallback } from "react";
import type { StockKind } from "@erp/domain";
import { Pager } from "../../components/shared/Pager";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { KIND_STOCK_TEXT, parseKindStockReply, quantityLabel, type KindStockPage as StockPage } from "./kindStock";
import { useStockList, type StockRead } from "./useStockList";

// DANA STOCK: what is in the store of one kind of raw material, as a plain table. Read-only: moving
// stock stays on the Store page, where every movement is scanned. The main process decides who may
// read this (STOCK_KIND_PERMISSION). Uppers have sizes and colours, so theirs is a matrix instead
// (features/upperStock).

const Summary: React.FC<{ data: StockPage }> = ({ data }) => (
  <div className="kpi-grid">
    <div className="kpi-card">
      <div className="kpi-label">{copy.kindStock.materials}</div>
      <div className="kpi-value">{data.itemCount.toLocaleString()}</div>
    </div>
    {data.totalsByUnit.map((total) => (
      <div className="kpi-card" key={total.unitId}>
        <div className="kpi-label">{copy.kindStock.inStore}</div>
        <div className="kpi-value">{quantityLabel(total.quantity, total.unitCode)}</div>
      </div>
    ))}
  </div>
);

const StockTable: React.FC<{ data: StockPage }> = ({ data }) => (
  <div className="table-wrap">
    <table className="data-table">
      <thead>
        <tr>
          <th scope="col">{copy.kindStock.material}</th>
          <th scope="col">{copy.kindStock.type}</th>
          <th scope="col">{copy.kindStock.code}</th>
          <th scope="col" className="kind-stock-quantity">{copy.kindStock.inStore}</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((row) => (
          <tr key={row.id}>
            <td>{row.name}</td>
            <td>{row.subCategory || "—"}</td>
            <td className="cell-mono">{row.code}</td>
            <td className="kind-stock-quantity">{quantityLabel(row.quantity, row.unitCode)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const KindStockPage: React.FC<{ kind: StockKind }> = ({ kind }) => {
  const text = KIND_STOCK_TEXT[kind];
  const api = useDesktopApi();
  const read = useCallback<StockRead<StockPage>>(async (query) => parseKindStockReply(await api.listKindStock(kind, query)), [api, kind]);
  const stock = useStockList(read);
  const { data } = stock;

  const body = () => {
    if (stock.error) return <StateView kind="error" title={copy.kindStock.failedTitle} message={stock.error} onRetry={stock.retry} />;
    if (stock.loading && !data) return <StateView kind="loading" />;
    if (!data) return null;
    if (data.itemCount === 0) {
      return stock.searching ? (
        <StateView kind="empty" title={copy.kindStock.noMatchTitle} hint={copy.kindStock.noMatchHint} />
      ) : (
        <StateView kind="empty" title={text.emptyTitle} hint={text.emptyHint} />
      );
    }
    return (
      <>
        <Summary data={data} />
        <StockTable data={data} />
        {data.pages > 1 ? <Pager page={data.page} pages={data.pages} onPage={stock.setPage} /> : null}
      </>
    );
  };

  return (
    <div className="page kind-stock-page">
      <h1 className="page-title">{text.title}</h1>
      <div className="toolbar">
        <div className="search-wrap" style={{ flex: 1 }}>
          <svg className="search-icon" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
          </svg>
          <input
            className="form-input"
            type="search"
            aria-label={copy.kindStock.search}
            placeholder={copy.kindStock.search}
            value={stock.search}
            onChange={(event) => stock.setSearch(event.target.value)}
          />
        </div>
      </div>
      {body()}
    </div>
  );
};
