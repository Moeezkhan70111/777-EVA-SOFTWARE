import React from "react";
import { copy } from "../../config/copy";
import { formatWholeMoney } from "../../app/format";
import { formatDate } from "../../utils/dates";
import { ArchivedLedgerRow } from "../ledgerArchive/ArchivedLedgerRow";
import type { LedgerTimelineItem } from "../ledgerArchive/unifiedLedger";
import { balancePosition } from "./ledgerFigures";
import { LiveLedgerRows } from "./LedgerRows";
import type { LedgerEntry } from "./ledgerTypes";

// THE ONE LEDGER TABLE (docs/50): the ERP's entries and the imported ledger's rows, by date, as one ledger with one
// total (owner, 25 Nov 2026: "there is no old and new, both are real values").
// The header stays put while the rows scroll; every amount column is right-aligned in tabular figures.
//
// Jakob's and Miller's laws (24 Nov 2026): by default the table shows the nine columns of the old software's ledger
// the accountant already reads (date, voucher, type, bill, description, qty, debit, credit, balance); Less, Tot.
// Disc and Reference come back with "More columns" (CSS hides them: every row keeps its twelve cells). The table
// ends on the period's closing balance (serial position, peak-end): the last thing read is the answer.

const text = copy.customerLedger;
const archiveText = copy.ledgerArchive;
const fmt = formatWholeMoney;
const COLUMNS = 12;

interface LedgerTableProps {
  items: readonly LedgerTimelineItem<LedgerEntry>[];
  broughtForward: number;
  fromDate: string;
  /** Every row listed, and their sums: the ERP's and the imported ledger's together. */
  count: number;
  debit: number;
  credit: number;
  refreshing: boolean;
  /** Less, Tot. Disc and Reference shown. */
  details: boolean;
  closingBalance: number;
  toDate: string;
  onOpen: (entry: LedgerEntry) => void;
}

const Head: React.FC = () => (
  <thead><tr>
    <th>{copy.columns.date}</th><th>Voucher No.</th><th>{copy.columns.type}</th><th>{archiveText.billNo}</th><th>{copy.columns.description}</th>
    <th className="amount">{archiveText.qty}</th><th className="amount">Less</th><th className="amount">Tot. Disc</th>
    <th className="amount">Debit (Rs.)</th><th className="amount">Credit (Rs.)</th><th className="amount">Balance (Rs.)</th><th>{copy.columns.reference}</th>
  </tr></thead>
);

const BroughtForwardRow: React.FC<{ amount: number; fromDate: string }> = ({ amount, fromDate }) => (
  <tr className="opening-row">
    <td>{formatDate(fromDate, fromDate)}</td><td>OB</td>
    <td><span className="customer-ledger-type customer-ledger-type-opening"><span className="customer-ledger-type-dot" />{text.broughtForward}</span></td>
    <td>-</td><td>{text.broughtForwardRow}</td><td className="amount">-</td><td className="amount">-</td><td className="amount">-</td>
    <td className="amount">{amount > 0 ? fmt(amount) : "-"}</td><td className="amount">{amount < 0 ? fmt(Math.abs(amount)) : "-"}</td>
    <td className="amount">{fmt(amount)}</td><td>-</td>
  </tr>
);

export const LedgerTable: React.FC<LedgerTableProps> = (props) => {
  const { items, broughtForward, fromDate, refreshing, details, onOpen } = props;
  const labelSpan = details ? 8 : 6;
  const reference = (value: string) => (details ? <td>{value}</td> : null);
  const position = balancePosition(props.closingBalance);
  return (
    <div className={refreshing ? "customer-ledger-table-wrap is-refreshing" : "customer-ledger-table-wrap"} aria-busy={refreshing || undefined}>
      <table className={details ? "customer-ledger-table" : "customer-ledger-table cl-table--simple"}>
        <Head />
        <tbody>
          {broughtForward !== 0 && <BroughtForwardRow amount={broughtForward} fromDate={fromDate} />}
          {items.length === 0 && <tr><td colSpan={COLUMNS} className="customer-ledger-empty">{archiveText.empty}</td></tr>}
          {items.map((item) => item.kind === "archived"
            ? <ArchivedLedgerRow key={`archived-${item.entry.id}`} entry={item.entry} merged />
            : <LiveLedgerRows key={`${item.entry.voucherId}-${item.entry.voucherType}`} entry={item.entry} onOpen={onOpen} />)}
        </tbody>
        <tfoot>
          <tr className="customer-ledger-total-row">
            <td colSpan={labelSpan}>{text.totalRow(props.count)}</td>
            <td className="amount debit">{fmt(props.debit)}</td><td className="amount credit">{fmt(props.credit)}</td>
            <td className="amount balance">-</td>{reference("-")}
          </tr>
          <tr className="cl-closing-row" data-position={position}>
            <td colSpan={labelSpan + 2}>{text.closingRow(formatDate(props.toDate, props.toDate))} · {text.position[position]}</td>
            <td className="amount balance">{fmt(Math.abs(props.closingBalance))}</td>{reference("")}
          </tr>
        </tfoot>
      </table>
    </div>
  );
};
