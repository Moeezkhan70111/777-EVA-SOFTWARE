import React from "react";
import { copy } from "../../config/copy";
import { formatWholeMoney } from "../../app/format";
import { formatDate } from "../../utils/dates";
import { ArchivedLedgerRow, archiveAmount } from "../ledgerArchive/ArchivedLedgerRow";
import type { ArchiveSummary, LedgerTimelineItem } from "../ledgerArchive/unifiedLedger";

// The Supplier Ledger's table (docs/53): the live entries and the old software's archived rows in one date order.
// The live totals and the archived totals are separate lines: an archived row never adds to the live balance.

export type SupplierLedgerType = "PURCHASE" | "CASH_PAYMENT" | "CASH_RECEIPT" | "CLAIM" | "OPENING_BALANCE";

export interface SupplierLedgerEntry {
  voucherId: string;
  voucherNumber: string;
  voucherDate: string;
  voucherType: SupplierLedgerType;
  description: string;
  modeOfTransfer?: string;
  debitAmount: number;
  creditAmount: number;
  balance: number;
}

const TYPE_LABEL: Record<SupplierLedgerType, string> = {
  PURCHASE: "Purchase",
  CASH_PAYMENT: "Payment",
  CASH_RECEIPT: "Receipt",
  CLAIM: copy.contractorLedger.claim,
  OPENING_BALANCE: copy.openingBalance.ledgerRow,
};
export const supplierTypeLabel = (type: SupplierLedgerType): string => TYPE_LABEL[type] ?? type;

const TYPE_CLASS: Record<SupplierLedgerType, string> = { PURCHASE: "cash_receipt", CASH_PAYMENT: "cash_payment", CASH_RECEIPT: "opening", CLAIM: "opening", OPENING_BALANCE: "opening" };

const fmtNum = formatWholeMoney;
const archiveText = copy.ledgerArchive;

interface Props {
  loading: boolean;
  hasParty: boolean;
  openingBalance: number;
  fromDate: string;
  timeline: readonly LedgerTimelineItem<SupplierLedgerEntry>[];
  liveCount: number;
  archiveSummary: ArchiveSummary;
  totals: { debit: number; credit: number; net: number };
}

const LiveRow: React.FC<{ entry: SupplierLedgerEntry }> = ({ entry }) => (
  <tr>
    <td>{formatDate(entry.voucherDate, entry.voucherDate)}</td>
    <td>{entry.voucherNumber}</td>
    <td><span className={`customer-ledger-type customer-ledger-type-${TYPE_CLASS[entry.voucherType]}`}><span className="customer-ledger-type-dot" />{supplierTypeLabel(entry.voucherType)}</span></td>
    <td>{entry.description}</td>
    <td className="amount">{entry.debitAmount ? fmtNum(entry.debitAmount) : "-"}</td>
    <td className="amount">{entry.creditAmount ? fmtNum(entry.creditAmount) : "-"}</td>
    <td className="amount balance">{fmtNum(entry.balance)}</td>
  </tr>
);

export const SupplierLedgerTable: React.FC<Props> = ({ loading, hasParty, openingBalance, fromDate, timeline, liveCount, archiveSummary, totals }) => {
  if (loading) return <div className="customer-ledger-empty" role="status">{copy.common.loading}</div>;
  if (!hasParty) return <div className="customer-ledger-empty">Select a supplier to view the ledger.</div>;
  return (
    <table className="customer-ledger-table">
      <thead>
        <tr><th>{copy.columns.date}</th><th>Voucher No.</th><th>{copy.columns.type}</th><th>{copy.columns.description}</th><th className="amount">Debit (Rs.)</th><th className="amount">Credit (Rs.)</th><th className="amount">Balance (Rs.)</th></tr>
      </thead>
      <tbody>
        {openingBalance !== 0 && (
          <tr className="opening-row">
            <td>{fromDate}</td><td>OB</td>
            <td><span className="customer-ledger-type customer-ledger-type-opening"><span className="customer-ledger-type-dot" />Opening Balance</span></td>
            <td>Opening balance carried forward</td>
            <td className="amount">{openingBalance < 0 ? fmtNum(Math.abs(openingBalance)) : "-"}</td>
            <td className="amount">{openingBalance > 0 ? fmtNum(openingBalance) : "-"}</td>
            <td className="amount balance">{fmtNum(openingBalance)}</td>
          </tr>
        )}
        {timeline.map((item) => item.kind === "archived"
          ? <ArchivedLedgerRow key={`archived-${item.entry.id}`} entry={item.entry} compact />
          : <LiveRow key={`${item.entry.voucherId}-${item.entry.voucherType}`} entry={item.entry} />)}
        {timeline.length === 0 && <tr><td colSpan={7} className="customer-ledger-empty">{archiveText.empty}</td></tr>}
      </tbody>
      <tfoot>
        <tr className="customer-ledger-total-row">
          <td colSpan={4}>{archiveSummary.rows > 0 ? archiveText.liveTotals(liveCount) : `Total (${liveCount} entries)`}</td>
          <td className="amount debit">{fmtNum(totals.debit)}</td>
          <td className="amount credit">{fmtNum(totals.credit)}</td>
          <td className="amount balance">{fmtNum(totals.net)}</td>
        </tr>
        {archiveSummary.rows > 0 && (
          <tr className="customer-ledger-total-row ledger-archived-total">
            <td colSpan={4}>{archiveText.archivedTotals(archiveSummary.rows)}</td>
            <td className="amount debit">{archiveAmount(archiveSummary.debitPaisa)}</td>
            <td className="amount credit">{archiveAmount(archiveSummary.creditPaisa)}</td>
            <td className="amount balance">{archiveText.archived}</td>
          </tr>
        )}
      </tfoot>
    </table>
  );
};
