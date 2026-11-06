import React from "react";
import { Pager } from "../../components/shared/Pager";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import type { CartonReconciliation } from "../../types/desktopApi";
import { CartonAdjustForm } from "./CartonAdjustForm";
import { useCartonAdjust, useCartonReconciliation } from "./useCartonStock";

// CARTON STOCK, FOR AN ADMINISTRATOR (docs/42 sections 11 and 12): adjust the figure with a reason, and
// see whether this computer's figure matches its movements. The fingerprint is what to compare across
// computers: the same movements give the same one. QR cartons are shown apart: local, and on hold.

const text = copy.cartonStock;

const Summary: React.FC<{ data: CartonReconciliation }> = ({ data }) => (
  <div className="kpi-grid">
    <div className="kpi-card"><div className="kpi-label">{text.movements}</div><div className="kpi-value">{data.movements.toLocaleString()}</div></div>
    <div className="kpi-card"><div className="kpi-label">{text.fingerprint}</div><div className="kpi-value">{data.fingerprint}</div></div>
    <div className="kpi-card"><div className="kpi-label">{text.differences}</div><div className="kpi-value">{data.differences.toLocaleString()}</div></div>
    <div className="kpi-card"><div className="kpi-label">{text.unsent}</div><div className="kpi-value">{data.unsent.toLocaleString()}</div></div>
  </div>
);

const Warnings: React.FC<{ data: CartonReconciliation }> = ({ data }) => {
  const lines = [
    data.differences > 0 ? text.differencesWarning(data.differences) : null,
    data.refused > 0 ? text.refusedWarning(data.refused) : null,
    data.waiting > 0 ? text.waitingWarning(data.waiting) : null,
    data.entriesBeforeFreshStart > 0 ? text.beforeFreshStart(data.entriesBeforeFreshStart) : null,
  ].filter((line): line is string => line !== null);
  if (lines.length === 0) return <p className="text-muted text-small" role="status">✓ {text.allAgree}</p>;
  return <ul role="status">{lines.map((line) => <li key={line}>⚠ {line}</li>)}</ul>;
};

const Table: React.FC<{ data: CartonReconciliation }> = ({ data }) => (
  <div className="table-wrap">
    <table className="data-table">
      <thead>
        <tr>
          <th scope="col">{text.product}</th>
          <th scope="col">{text.produced}</th>
          <th scope="col">{text.adjusted}</th>
          <th scope="col">{text.issued}</th>
          <th scope="col">{text.movementStock}</th>
          <th scope="col">{text.qrInStore}</th>
          <th scope="col">{text.storeFigure}</th>
          <th scope="col">{text.difference}</th>
        </tr>
      </thead>
      <tbody>
        {data.rows.map((row) => (
          <tr key={row.variantId}>
            <td>{`${row.article} ${row.size} ${row.color}`}</td>
            <td>{row.produced}</td>
            <td>{row.adjusted}</td>
            <td>{row.issued}</td>
            <td>{row.movementStock}</td>
            <td>{row.qrInStore}</td>
            <td>{row.storeFigure}</td>
            <td>{row.difference === 0 ? text.agrees : `⚠ ${row.difference}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const Reconciliation: React.FC<{ read: ReturnType<typeof useCartonReconciliation> }> = ({ read }) => {
  if (read.loading && !read.value) return <StateView kind="loading" compact message={text.loading} />;
  if (read.error) return <StateView kind="error" compact message={read.error} onRetry={() => void read.reload()} />;
  const data = read.value;
  if (!data) return null;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <section aria-labelledby="carton-reconcile-title">
      <h3 id="carton-reconcile-title" className="card-title">{text.reconcileTitle}</h3>
      <Summary data={data} />
      <Warnings data={data} />
      {data.rows.length === 0 ? <StateView kind="empty" compact title={text.emptyTitle} hint={text.emptyHint} /> : <Table data={data} />}
      {pages > 1 ? <Pager page={read.pageNo} pages={pages} onPage={read.setPageNo} /> : null}
    </section>
  );
};

export const CartonStockPage: React.FC = () => {
  const read = useCartonReconciliation();
  const { adjust, busy, outcome } = useCartonAdjust(read.reload);
  return (
    <div className="page-stack">
      <p className="text-muted">{text.subtitle}</p>
      <CartonAdjustForm busy={busy} outcome={outcome} onAdjust={adjust} />
      <Reconciliation read={read} />
    </div>
  );
};
