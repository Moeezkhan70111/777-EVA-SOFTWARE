import React from "react";
import { formatWholeMoney } from "../../app/format";
import { copy } from "../../config/copy";
import { formatDate } from "../../utils/dates";
import { PositionIcon } from "../customerLedger/BalanceHero";
import { balancePosition, type BalancePosition } from "../customerLedger/ledgerFigures";
import type { CustomerBalanceRow } from "./customerBalances";

// One row per customer, the balance last and strongest (serial position). A row opens that customer's ledger: the
// name is the button (keyboard and screen reader), the whole row is the target for a mouse or a finger (Fitts).
// The city sits under the name (proximity), so the table has one column fewer. How the balance stands is said in
// words beside a mark, never by colour alone (R18).

const text = copy.customerBalance;
const ledgerText = copy.customerLedger;
const money = (rupees: number) => formatWholeMoney(rupees);
const SKELETON_ROWS = Array.from({ length: 8 }, (_, index) => index);
/** The app's status pill for how a balance stands (the same badges as Pending Orders, R1). */
const POSITION_TONE: Readonly<Record<BalancePosition, string>> = { RECEIVABLE: "badge-info", ADVANCE: "badge-ok", SETTLED: "badge-muted" };

const Head: React.FC = () => (
  <thead>
    <tr>
      <th scope="col">{text.columns.customer}</th>
      <th scope="col" className="doc-col-wide">{text.columns.group}</th>
      <th scope="col" className="doc-col-wide doc-num">{text.columns.lastActivity}</th>
      <th scope="col" className="doc-col-wide doc-num">{text.columns.sales}</th>
      <th scope="col" className="doc-col-wide doc-num">{text.columns.receipts}</th>
      <th scope="col" className="doc-num">{text.columns.balance}</th>
    </tr>
  </thead>
);

const Row: React.FC<{ row: CustomerBalanceRow; onOpen: (partyId: string) => void }> = ({ row, onOpen }) => {
  const position = balancePosition(row.balance);
  return (
    <tr className="doc-row" onClick={() => onOpen(row.partyId)}>
      <td>
        <button type="button" className="cb-name" aria-label={text.openRow(row.partyName)} onClick={(event) => { event.stopPropagation(); onOpen(row.partyId); }}>
          {row.partyName}
        </button>
        {row.city ? <span className="cb-city">{row.city}</span> : null}
      </td>
      <td className="doc-col-wide">{row.groupName ? <span className="cb-group">{row.groupName}</span> : <span className="doc-muted">—</span>}</td>
      <td className="doc-col-wide doc-num doc-muted">{row.lastVoucherDate ? formatDate(row.lastVoucherDate) : text.noActivity}</td>
      <td className="doc-col-wide doc-num">{money(row.totalSales)}</td>
      <td className="doc-col-wide doc-num">{row.totalReceipts > 0 ? money(row.totalReceipts) : <span className="doc-muted">—</span>}</td>
      <td className="doc-num cb-balance" data-position={position}>
        <strong>{money(Math.abs(row.balance))}</strong>
        <span className={`badge ${POSITION_TONE[position]} cb-position`}><PositionIcon position={position} />{ledgerText.position[position]}</span>
      </td>
    </tr>
  );
};

interface CustomerBalanceTableProps {
  rows: readonly CustomerBalanceRow[];
  refreshing: boolean;
  onOpen: (partyId: string) => void;
}

export const CustomerBalanceTable: React.FC<CustomerBalanceTableProps> = ({ rows, refreshing, onOpen }) => (
  <div className={refreshing ? "doc-table-wrap card is-refreshing" : "doc-table-wrap card"} aria-busy={refreshing || undefined}>
    <table className="data-table doc-table" aria-label={text.tableLabel}>
      <Head />
      <tbody>{rows.map((row) => <Row key={row.partyId} row={row} onOpen={onOpen} />)}</tbody>
    </table>
  </div>
);

/** The table's own shape while the first read is on its way (no layout shift). */
export const CustomerBalanceSkeleton: React.FC = () => (
  <div className="doc-table-wrap card" aria-busy="true">
    <p className="sr-only" role="status">{text.loading}</p>
    <table className="data-table doc-table" aria-hidden="true">
      <Head />
      <tbody>
        {SKELETON_ROWS.map((index) => (
          <tr key={index} className="doc-skeleton-row">
            <td><span className="cl-skeleton doc-bone doc-bone--wide" /></td>
            <td className="doc-col-wide"><span className="cl-skeleton doc-bone" /></td>
            <td className="doc-col-wide doc-num"><span className="cl-skeleton doc-bone" /></td>
            <td className="doc-col-wide doc-num"><span className="cl-skeleton doc-bone" /></td>
            <td className="doc-col-wide doc-num"><span className="cl-skeleton doc-bone" /></td>
            <td className="doc-num"><span className="cl-skeleton doc-bone" /></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
