import React from "react";
import { copy } from "../../config/copy";
import { quantityLabel, type KindStockRow } from "./kindStock";

// One row per material, in the themed table (doc-table, as Customer Balance): the material with its code under it
// (proximity, one column fewer), its type, and what is in store last and strongest. Nothing in store says "Empty" in
// a pill, not only a grey zero (R18). Read-only: stock moves on the Store page, where every movement is scanned.

const text = copy.kindStock;
const SKELETON_ROWS = Array.from({ length: 8 }, (_, index) => index);

const Head: React.FC = () => (
  <thead>
    <tr>
      <th scope="col">{text.material}</th>
      <th scope="col" className="doc-col-wide">{text.type}</th>
      <th scope="col" className="doc-num">{text.inStore}</th>
    </tr>
  </thead>
);

const Row: React.FC<{ row: KindStockRow }> = ({ row }) => (
  <tr>
    <td>
      <span className="ks-name">{row.name}</span>
      <span className="ks-code">{row.code}</span>
    </td>
    <td className="doc-col-wide">{row.subCategory ? <span className="ks-type">{row.subCategory}</span> : <span className="doc-muted">—</span>}</td>
    <td className="doc-num ks-quantity">
      {row.quantity === 0
        ? <span className="badge badge-muted">{text.emptyBadge}</span>
        : <strong>{quantityLabel(row.quantity, row.unitCode)}</strong>}
    </td>
  </tr>
);

interface KindStockTableProps {
  label: string;
  rows: readonly KindStockRow[];
  refreshing: boolean;
}

export const KindStockTable: React.FC<KindStockTableProps> = ({ label, rows, refreshing }) => (
  <div className={refreshing ? "doc-table-wrap card is-refreshing" : "doc-table-wrap card"} aria-busy={refreshing || undefined}>
    <table className="data-table doc-table" aria-label={label}>
      <Head />
      <tbody>{rows.map((row) => <Row key={row.id} row={row} />)}</tbody>
    </table>
  </div>
);

/** The table's own shape while the first read is on its way (no layout shift). */
export const KindStockSkeleton: React.FC = () => (
  <div className="doc-table-wrap card" aria-busy="true">
    <p className="sr-only" role="status">{text.loading}</p>
    <table className="data-table doc-table" aria-hidden="true">
      <Head />
      <tbody>
        {SKELETON_ROWS.map((index) => (
          <tr key={index} className="doc-skeleton-row">
            <td><span className="cl-skeleton doc-bone doc-bone--wide" /></td>
            <td className="doc-col-wide"><span className="cl-skeleton doc-bone" /></td>
            <td className="doc-num"><span className="cl-skeleton doc-bone" /></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
