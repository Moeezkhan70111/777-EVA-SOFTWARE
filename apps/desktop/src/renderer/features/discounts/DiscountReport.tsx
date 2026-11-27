import React, { useMemo, useState } from "react";
import { toPaisa } from "@erp/domain";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { discountMatrix } from "./discountMatrix";
import { DISCOUNT_KINDS, discountText, reportLinesFor, type DiscountKind, type DiscountReportLine } from "./discountPolicy";
import { downloadDiscountExcel, printDiscountPdf } from "./discountExports";

// THE DISCOUNT REPORT (owner, 28 Nov 2026): every customer's discounts as one grid, the same as the PDF and the Excel
// file: "Party name | EVR GENTS | EVR KIDS | EVR LADIES", one row per customer A to Z, "—" where there is none. Show:
// the shared toggle (All or one kind); the downloads take what is shown. The page's one search ("/") is in Set
// discounts, where customers are looked for to change them.

const text = copy.discountPolicy;
type Filter = DiscountKind | "ALL";
const FILTERS: readonly Filter[] = ["ALL", ...DISCOUNT_KINDS];

export const DiscountReport: React.FC<{ report: readonly DiscountReportLine[] }> = ({ report }) => {
  const [filter, setFilter] = useState<Filter>("ALL");
  const grid = useMemo(() => discountMatrix(reportLinesFor(report, filter)), [report, filter]);
  const title = `${text.title} — ${text.reportKinds[filter]}`;

  const table = () => {
    if (grid.columns.length === 0) return <StateView kind="empty" compact title={text.reportEmptyTitle} hint={text.reportEmptyHint} />;
    return (
      <div className="doc-table-wrap card dp-table-wrap">
        <table className="data-table doc-table dp-table" aria-label={text.reportLabel}>
          <thead>
            <tr>
              <th scope="col">{text.reportPartyName}</th>
              {grid.columns.map((column) => <th key={column.key} scope="col" className="doc-num">{column.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => (
              <tr key={row.partyId}>
                <th scope="row" className="dp-customer">{row.partyName}</th>
                {grid.columns.map((column) => {
                  const value = row.cells[column.key];
                  return <td key={column.key} className="doc-num">{value === undefined ? <span className="doc-muted">—</span> : <strong>{discountText(toPaisa(value))}</strong>}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <section className="card dp-card" aria-labelledby="dp-report-title">
      <header className="dp-card-head">
        <div>
          <h2 id="dp-report-title" className="dp-card-title">{text.reportTitle}</h2>
          <p className="dp-muted">{text.reportCount(grid.rows.length)} · {text.discountColumn}</p>
        </div>
        <div className="dp-card-tools">
          <button type="button" className="btn btn-secondary" aria-label={text.excelLabel} title={text.excelLabel} disabled={grid.rows.length === 0} onClick={() => downloadDiscountExcel(grid, title)}>{text.excel}</button>
          <button type="button" className="btn btn-secondary" aria-label={text.pdfLabel} title={text.pdfLabel} disabled={grid.rows.length === 0} onClick={() => printDiscountPdf(grid, title)}>{text.pdf}</button>
        </div>
      </header>
      <div className="dp-pickers">
        <div className="dp-picker">
          <span className="input-label" id="dp-report-filter">{text.reportFilter}</span>
          <div className="sa-toggle" role="group" aria-labelledby="dp-report-filter">
            {FILTERS.map((value) => (
              <button key={value} type="button" className={filter === value ? "sa-toggle-btn is-on" : "sa-toggle-btn"} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {text.reportKinds[value]}
              </button>
            ))}
          </div>
        </div>
      </div>
      {table()}
    </section>
  );
};
