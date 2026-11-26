import React, { useCallback, useRef } from "react";
import { RAW_MATERIAL_KIND, type StockKind } from "@erp/domain";
import { Pager } from "../../components/shared/Pager";
import { SearchField } from "../../components/shared/SearchField";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { HeroSkeleton } from "../customerLedger/LedgerSkeleton";
import { KIND_STOCK_TEXT, parseKindStockReply, quantityLabel, type KindStockPage as StockPage } from "./kindStock";
import { KindStockSkeleton, KindStockTable } from "./KindStockTable";
import { useStockList, type StockRead } from "./useStockList";
import { usePrintStockSheet } from "./usePrintStockSheet";

// DANA STOCK: what is in the store of one kind of raw material, in the Customer Ledger's look (docs/56, 26 Nov 2026).
//
//   Dana Stock                                             [ Print stock sheet ]
//   ┌ IN STORE ──────────┐   [ Search materials  / ]
//   │ 1,250 KG            │
//   │ 48 materials        │
//   └─────────────────────┘
//   Material (code) | Type | In store                       one table card, the figure last and strongest
//
// The total is the one figure in the blue (von Restorff); it and every balance are the data layer's (totalsByUnit;
// units are never added together). Read-only: moving stock stays on the Store page, where every movement is scanned.
// The main process decides who may read this (STOCK_KIND_PERMISSION). Dana also prints as the store's paper Dana
// Stock Sheet (stockSheetPrint.ts).

const text = copy.kindStock;

const StoreHero: React.FC<{ data: StockPage; refreshing: boolean }> = ({ data, refreshing }) => (
  <section className="cl-hero ks-hero" aria-label={text.totalLabel} aria-busy={refreshing || undefined}>
    <span className="cl-hero-label">{text.totalLabel}</span>
    <strong className="cl-hero-figure">
      {data.totalsByUnit.length === 0 ? "0" : data.totalsByUnit.map((total) => quantityLabel(total.quantity, total.unitCode)).join(" · ")}
    </strong>
    <p className="cl-hero-note">{text.materialCount(data.itemCount)}</p>
  </section>
);

export const KindStockPage: React.FC<{ kind: StockKind }> = ({ kind }) => {
  const words = KIND_STOCK_TEXT[kind];
  const api = useDesktopApi();
  const read = useCallback<StockRead<StockPage>>(async (query) => parseKindStockReply(await api.listKindStock(kind, query)), [api, kind]);
  const stock = useStockList(read);
  const { data } = stock;
  const sheet = usePrintStockSheet(kind);
  const searchRef = useRef<HTMLInputElement>(null);
  const printsSheet = kind === RAW_MATERIAL_KIND.DANA;
  const refreshing = stock.loading && data !== null;

  const body = () => {
    if (stock.error && !data) return <StateView kind="error" title={text.failedTitle} message={stock.error} onRetry={stock.retry} />;
    if (!data) return <KindStockSkeleton />;
    if (data.itemCount === 0) {
      return stock.searching
        ? <StateView kind="empty" title={text.noMatchTitle} hint={text.noMatchHint} />
        : <StateView kind="empty" title={words.emptyTitle} hint={words.emptyHint} />;
    }
    return <KindStockTable label={text.tableLabel(words.title)} rows={data.items} refreshing={refreshing} />;
  };

  return (
    <div className="page kind-stock-page doc-themed cl-page ks-page">
      <header className="cl-head">
        <div className="cl-head-title"><h1>{words.title}</h1></div>
        {printsSheet ? (
          <div className="cl-head-actions">
            <button type="button" className="btn btn-secondary" onClick={sheet.print}>{text.printSheet}</button>
          </div>
        ) : null}
      </header>
      {sheet.blockedMessage ? <p className="error-message" role="alert">{sheet.blockedMessage}</p> : null}
      <div className="ks-top">
        {data ? <StoreHero data={data} refreshing={refreshing} /> : <HeroSkeleton />}
        <SearchField value={stock.search} onChange={stock.setSearch} label={text.searchLabel} placeholder={text.search} clearLabel={text.searchClear}
          shortcutHint={text.searchShortcut} inputRef={searchRef} />
      </div>
      {stock.error && data ? <StateView kind="error" compact message={stock.error} onRetry={stock.retry} /> : null}
      {body()}
      {data && data.pages > 1 ? <Pager page={data.page} pages={data.pages} onPage={stock.setPage} numbered /> : null}
    </div>
  );
};
