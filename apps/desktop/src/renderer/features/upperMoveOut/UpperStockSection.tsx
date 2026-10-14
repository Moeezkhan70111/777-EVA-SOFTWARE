import React, { useEffect, useState } from "react";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { UpperStockRow } from "../../types/desktopApi";
import { formatUpperQuantity } from "./upperFeedback";
import { useUpperStock } from "./useUpperData";

// STOCK — what upper is in the store to issue, read from the stock balances (the same figure Raw
// Material stock shows), uppers only:
//
//   [ Search article, size or colour ]
//   Article  Size  Colour  Category       Packets  Available
//   SK6      7/10  RED     RUBBER UPPER        12   60 DOZEN
//
// The search runs in the main process. The list is read fresh each time Stock is opened and every few
// seconds while it is, so issues and receipts made here or elsewhere show.

const text = copy.upperMoveOut;
const SEARCH_DELAY_MS = 250;

const StockRow: React.FC<{ row: UpperStockRow }> = ({ row }) => (
  <tr>
    <td><strong>{row.article ?? row.displayName}</strong></td>
    <td>{row.size ?? "—"}</td>
    <td>{row.colour ?? "—"}</td>
    <td className="rp-time">{row.categoryName}</td>
    <td className="rp-num">{row.packetsInStore.toLocaleString()}</td>
    <td className="rp-num"><strong>{formatUpperQuantity({ quantity: row.onHand, unitCode: row.unitCode })}</strong></td>
  </tr>
);

export const UpperStockSection: React.FC = () => {
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(typed.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);
  const stock = useUpperStock(search, text.stockFailed);

  const rows = stock.value;
  const body = () => {
    if (stock.loading && !rows) return <StateView kind="loading" compact message={text.stockLoading} />;
    if (stock.error && !rows) return <StateView kind="error" compact message={stock.error} onRetry={() => void stock.reload()} />;
    if (!rows || rows.length === 0) {
      return search ? <StateView kind="empty" compact title={text.stockNoMatch} /> : <StateView kind="empty" compact title={text.stockEmptyTitle} hint={text.stockEmptyHint} />;
    }
    return (
      <div className="rp-table-wrap">
        <table className="data-table rp-table">
          <caption className="sr-only">{text.stockCaption}</caption>
          <thead>
            <tr>
              <th scope="col">{text.colArticle}</th>
              <th scope="col">{text.colSize}</th>
              <th scope="col">{text.colColour}</th>
              <th scope="col">{text.colCategory}</th>
              <th scope="col" className="rp-num">{text.colPackets}</th>
              <th scope="col" className="rp-num">{text.colAvailable}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <StockRow key={row.itemId} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <section className="card rp-activity" aria-labelledby="um-stock-title">
      <div className="rp-activity-head">
        <h2 id="um-stock-title" className="card-title">{text.stockTitle}</h2>
        <span className="rp-activity-note">{text.stockNote}</span>
      </div>
      <input
        type="search"
        className="form-input um-stock-search"
        aria-label={text.stockSearch}
        placeholder={text.stockSearch}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
      />
      {stock.stale ? <p className="rp-stale" role="status">⚠ {text.offline}</p> : null}
      {body()}
    </section>
  );
};
