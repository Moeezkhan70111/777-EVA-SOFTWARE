import React from "react";
import { copy } from "../../config/copy";
import { formatWholeMoney } from "../../app/format";
import { formatMonth } from "../../utils/dates";
import type { LedgerEntry } from "./ledgerTypes";

// The Summary tab: the period's totals and month by month. Moved from the Customer Ledger page.

const fmtNum = formatWholeMoney;
const Summary: React.FC<{ label: string; value: number; detail: string; tone?: "positive" | "negative" }> = ({ label, value, detail, tone }) => <div className="customer-ledger-summary-card"><div className={`customer-ledger-summary-icon ${tone || "neutral"}`}>{tone === "positive" ? "↓" : tone === "negative" ? "↑" : "▣"}</div><div><span>{label}</span><strong className={tone || ""}>Rs. {fmtNum(Math.abs(value))}</strong><small>{detail}</small></div></div>;

interface SummaryTabProps { entries: LedgerEntry[]; openingBalance: number; closingBalance: number; totalReceipts: number; totalPayments: number; fromDate: string; toDate: string; selectedPartyId: string; loading: boolean; }
export const SummaryTab: React.FC<SummaryTabProps> = ({ entries, openingBalance, closingBalance, totalReceipts, totalPayments, fromDate, toDate, selectedPartyId, loading }) => {
  const totalSales = entries.filter((e) => e.voucherType === "SALE").reduce((s, e) => s + e.debitAmount, 0);
  const saleCount = entries.filter((e) => e.voucherType === "SALE").length;
  const totalReturns = entries.filter((e) => e.voucherType === "SALE_RETURN").reduce((s, e) => s + e.creditAmount, 0);
  const receiptCount = entries.filter((e) => e.voucherType === "CASH_RECEIPT").length;
  // Monthly breakdown
  const monthMap = new Map<string, { sales: number; receipts: number; payments: number; returns: number }>();
  for (const e of entries) {
    const key = e.voucherDate.slice(0, 7); // "YYYY-MM"
    if (!monthMap.has(key)) monthMap.set(key, { sales: 0, receipts: 0, payments: 0, returns: 0 });
    const m = monthMap.get(key)!;
    if (e.voucherType === "SALE") m.sales += e.debitAmount;
    else if (e.voucherType === "CASH_RECEIPT") m.receipts += e.creditAmount;
    else if (e.voucherType === "CASH_PAYMENT") m.payments += e.debitAmount;
    else if (e.voucherType === "SALE_RETURN") m.returns += e.creditAmount;
  }
  const months = Array.from(monthMap.entries()).sort(([a], [b]) => a.localeCompare(b));
  const fmtMonth = (key: string) => formatMonth(key, key);
  if (!selectedPartyId) return <div className="customer-ledger-empty customer-ledger-tab-empty">Select a customer to view the summary.</div>;
  if (loading) return <div className="customer-ledger-empty customer-ledger-tab-empty">{copy.common.loading}</div>;
  return <div className="cl-summary-tab">
    <div className="customer-ledger-summary-grid" style={{ gridTemplateColumns: "repeat(3,1fr)", padding: "22px 20px 4px" }}>
      <Summary label="Total Sales" value={totalSales} detail={`${saleCount} voucher${saleCount !== 1 ? "s" : ""}`} tone="negative" />
      <Summary label="Total Receipts" value={totalReceipts} detail={`${receiptCount} receipt${receiptCount !== 1 ? "s" : ""}`} tone="positive" />
      <Summary label="Net Balance" value={closingBalance} detail={closingBalance > 0 ? "Receivable" : closingBalance < 0 ? "Advance / Credit" : "Settled"} tone={closingBalance > 0 ? "negative" : closingBalance < 0 ? "positive" : undefined} />
    </div>
    <div className="cl-summary-body">
      <div className="cl-summary-section">
        <h3>Period Overview</h3>
        <table className="cl-summary-table">
          <tbody>
            <tr><td>Opening Balance</td><td className="num">{openingBalance >= 0 ? "" : "("}{fmtNum(Math.abs(openingBalance))}{openingBalance < 0 ? ")" : ""}</td><td className="tag">{openingBalance >= 0 ? "Receivable" : "Credit"}</td></tr>
            <tr><td>Total Sales (Debit)</td><td className="num red">{fmtNum(totalSales)}</td><td className="tag">Sales</td></tr>
            <tr><td>Total Receipts (Credit)</td><td className="num grn">{fmtNum(totalReceipts)}</td><td className="tag">Receipts</td></tr>
            <tr><td>Total Payments (Debit)</td><td className="num red">{fmtNum(totalPayments)}</td><td className="tag">Payments</td></tr>
            <tr><td>{copy.customerLedger.returnsRow}</td><td className="num grn">{fmtNum(totalReturns)}</td><td className="tag">{copy.customerLedger.filters.SALE_RETURN}</td></tr>
            <tr className="cl-summary-total"><td>Closing Balance</td><td className="num">{fmtNum(Math.abs(closingBalance))}</td><td className="tag">{closingBalance > 0 ? "Receivable" : closingBalance < 0 ? "Credit" : "Settled"}</td></tr>
          </tbody>
        </table>
      </div>
      {months.length > 0 && <div className="cl-summary-section">
        <h3>Monthly Breakdown <small>{fromDate} → {toDate}</small></h3>
        <table className="cl-summary-table">
          <thead><tr><th>Month</th><th className="num">Sales</th><th className="num">Receipts</th><th className="num">Payments</th><th className="num">Net</th></tr></thead>
          <tbody>{months.map(([key, m]) => {
            // A payment to the customer adds to what they owe (a debit); a receipt or a return takes from it.
            const net = m.sales + m.payments - m.receipts - m.returns;
            return <tr key={key}><td>{fmtMonth(key)}</td><td className="num red">{m.sales ? fmtNum(m.sales) : "-"}</td><td className="num grn">{m.receipts ? fmtNum(m.receipts) : "-"}</td><td className="num red">{m.payments ? fmtNum(m.payments) : "-"}</td><td className={`num ${net > 0 ? "red" : net < 0 ? "grn" : ""}`}>{fmtNum(Math.abs(net))}</td></tr>;
          })}</tbody>
          <tfoot><tr><td><strong>{copy.columns.total}</strong></td><td className="num red"><strong>{fmtNum(totalSales)}</strong></td><td className="num grn"><strong>{fmtNum(totalReceipts)}</strong></td><td className="num red"><strong>{fmtNum(totalPayments)}</strong></td><td className="num"><strong>{fmtNum(Math.abs(closingBalance - openingBalance))}</strong></td></tr></tfoot>
        </table>
      </div>}
    </div>
  </div>;
};
