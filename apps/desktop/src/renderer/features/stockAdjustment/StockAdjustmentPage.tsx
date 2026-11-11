import React from "react";
import { LEASE_DOMAIN } from "@erp/domain";
import { ReadOnlyNotice } from "../../components/shared/ReadOnlyNotice";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { articlesOf } from "../manualProduction/productChoices";
import { useProductChoices } from "../manualProduction/useManualProduction";
import { useWriteLease } from "../sync/useWriteLease";
import { AdjustmentHeader } from "./AdjustmentHeader";
import { AdjustmentHistory } from "./AdjustmentHistory";
import { ArticleEntry } from "./ArticleEntry";
import { DocumentLines } from "./DocumentLines";
import { useAdjustmentHistory, useStockAdjustment } from "./useStockAdjustment";

// STOCK ADJUSTMENT, FOR AN ADMINISTRATOR (docs/46): Opening Stock and Stock Adjustment documents for carton stock.
// Written on the computer that holds carton stock (the CARTON_STOCK lease); read-only everywhere else, where the
// documents still arrive with the figure. Separate from Manual Production, which records daily production.

const text = copy.stockAdjustment;

export const StockAdjustmentPage: React.FC = () => {
  const lease = useWriteLease(LEASE_DOMAIN.CARTON_STOCK);
  const products = useProductChoices();
  const history = useAdjustmentHistory();
  const document = useStockAdjustment(() => void history.reload());

  const entry = () => {
    if (products.error) return <StateView kind="error" message={products.error} onRetry={() => void products.reload()} />;
    if (products.loading && products.value.length === 0) return <StateView kind="loading" message={text.productsLoading} />;
    if (products.value.length === 0) return <StateView kind="empty" title={text.noProductsTitle} hint={text.noProductsHint} />;
    return <ArticleEntry kind={document.header.kind} articles={articlesOf(products.value)} onAdd={document.addLines} />;
  };

  return (
    <div className="page-stack sa-page">
      <ReadOnlyNotice status={lease.status} />
      {lease.canWrite ? <AdjustmentHeader header={document.header} onKind={document.chooseKind} onChange={document.setHeader} /> : null}
      {lease.canWrite ? entry() : null}
      {lease.canWrite ? (
        <DocumentLines header={document.header} lines={document.lines} busy={document.busy} canWrite={lease.canWrite}
          outcome={document.outcome} onRemove={document.removeLine} onPost={document.post} />
      ) : null}
      <AdjustmentHistory history={history} />
    </div>
  );
};
