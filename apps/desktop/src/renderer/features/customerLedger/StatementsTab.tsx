import React from "react";
import { copy } from "../../config/copy";
import { formatWholeMoney } from "../../app/format";
import { formatDate } from "../../utils/dates";
import type { Party } from "../../types/desktopApi";
import { typeLabel } from "./LedgerRows";
import type { LedgerEntry } from "./ledgerTypes";

// The Statement tab: a printable account statement for the period. Moved from the Customer Ledger page.

const fmtDate = (value: string) => formatDate(value, value);
const fmtNum = formatWholeMoney;

interface StatementsTabProps { entries: LedgerEntry[]; openingBalance: number; closingBalance: number; partyName: string; party: Party | undefined; fromDate: string; toDate: string; selectedPartyId: string; loading: boolean; balanceLimit: number | null; }
export const StatementsTab: React.FC<StatementsTabProps> = ({ entries, openingBalance, closingBalance, partyName, party, fromDate, toDate, selectedPartyId, loading, balanceLimit }) => {
  if (!selectedPartyId) return <div className="customer-ledger-empty customer-ledger-tab-empty">Select a customer to generate a statement.</div>;
  if (loading) return <div className="customer-ledger-empty customer-ledger-tab-empty">{copy.common.loading}</div>;
  const totalDebit = entries.reduce((s, e) => s + e.debitAmount, 0);
  const totalCredit = entries.reduce((s, e) => s + e.creditAmount, 0);
  return <div className="cl-statement-wrap">
    <div className="cl-statement-actions"><button type="button" className="customer-ledger-action" onClick={() => window.print()}>▣ Print Statement</button></div>
    <div className="cl-statement" id="cl-statement-printable">
      <div className="cl-statement-header">
        <div className="cl-statement-title"><h2>Account Statement</h2><p>For the period: {fmtDate(fromDate)} — {fmtDate(toDate)}</p></div>
        <div className="cl-statement-party">
          <strong>{partyName || party?.partyName || "—"}</strong>
          {party?.mobileNumber && <span>☎ {party.mobileNumber}</span>}
          {(party?.city || party?.address) && <span>⌖ {party.city || party.address}</span>}
          {balanceLimit != null && <span>Limit: Rs. {fmtNum(balanceLimit)}</span>}
        </div>
      </div>
      <table className="cl-statement-table">
        <thead><tr><th>{copy.columns.date}</th><th>Voucher No.</th><th>{copy.columns.description}</th><th className="num">Debit (Rs.)</th><th className="num">Credit (Rs.)</th><th className="num">Balance (Rs.)</th></tr></thead>
        <tbody>
          {openingBalance !== 0 && <tr className="opening-row"><td>{fmtDate(fromDate)}</td><td>—</td><td>Opening Balance</td><td className="num">{openingBalance > 0 ? fmtNum(openingBalance) : "—"}</td><td className="num">{openingBalance < 0 ? fmtNum(Math.abs(openingBalance)) : "—"}</td><td className="num">{fmtNum(openingBalance)}</td></tr>}
          {entries.map((e) => <tr key={`${e.voucherId}-${e.voucherType}`}><td>{fmtDate(e.voucherDate)}</td><td>{e.voucherNumber}</td><td>{typeLabel(e.voucherType)}{e.description ? ` — ${e.description}` : ""}</td><td className="num red">{e.debitAmount ? fmtNum(e.debitAmount) : "—"}</td><td className="num grn">{e.creditAmount ? fmtNum(e.creditAmount) : "—"}</td><td className="num">{fmtNum(e.balance)}</td></tr>)}
        </tbody>
        <tfoot>
          <tr><td colSpan={3}><strong>{copy.columns.total}</strong></td><td className="num red"><strong>{fmtNum(totalDebit)}</strong></td><td className="num grn"><strong>{fmtNum(totalCredit)}</strong></td><td className="num"><strong>{fmtNum(Math.abs(closingBalance))}</strong></td></tr>
        </tfoot>
      </table>
      <div className="cl-statement-footer">
        <div className="cl-statement-balance-box">
          <span>Closing Balance</span>
          <strong>{closingBalance > 0 ? "Receivable" : closingBalance < 0 ? "Advance / Credit" : "Settled"}</strong>
          <em>Rs. {fmtNum(Math.abs(closingBalance))}</em>
        </div>
        <p className="cl-statement-note">This is a computer-generated statement. Please verify with the accounts department for any discrepancies.</p>
      </div>
    </div>
  </div>;
};
