import React, { useEffect, useMemo, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { Party } from "../types/desktopApi";
import { copy } from "../config/copy";
import { formatDate, toIsoDate } from "../utils/dates";
import { formatWholeMoney } from "../app/format";
import { downloadCsv } from "../utils/exportFile";

interface SupplierLedgerPageProps { onNavigate: (route: AppRoute, id?: string) => void; }

type SupplierLedgerType = "PURCHASE" | "CASH_PAYMENT" | "CASH_RECEIPT" | "CLAIM";
interface SupplierLedgerEntry {
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

const fmtDate = (value: string) => formatDate(value, value);
const fmtNum = formatWholeMoney;
const TYPE_LABEL: Record<SupplierLedgerType, string> = { PURCHASE: "Purchase", CASH_PAYMENT: "Payment", CASH_RECEIPT: "Receipt", CLAIM: copy.contractorLedger.claim };
const typeLabel = (type: SupplierLedgerType) => TYPE_LABEL[type];

export const SupplierLedgerPage: React.FC<SupplierLedgerPageProps> = ({ onNavigate }) => {
  const api = useDesktopApi();
  const [parties, setParties] = useState<Party[]>([]);
  const [selectedPartyId, setSelectedPartyId] = useState("");
  const [fromDate, setFromDate] = useState("2026-01-01");
  const [toDate, setToDate] = useState(toIsoDate());
  const [entries, setEntries] = useState<SupplierLedgerEntry[]>([]);
  const [openingBalance, setOpeningBalance] = useState(0);
  const [closingBalance, setClosingBalance] = useState(0);
  const [partyName, setPartyName] = useState("");
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("ALL");

  useEffect(() => {
    void api.listParties({ pageSize: 1000 }).then((result) => setParties(result.rows.filter((p) => p.partyType === "SUPPLIER")));
  }, [api]);

  useEffect(() => {
    if (!selectedPartyId) { setEntries([]); setPartyName(""); setOpeningBalance(0); setClosingBalance(0); return; }
    setLoading(true);
    void api.getSupplierLedger(selectedPartyId, { fromDate, toDate })
      .then((result) => {
        setEntries(result.entries as SupplierLedgerEntry[]);
        setPartyName(result.partyName);
        setOpeningBalance(result.openingBalance);
        setClosingBalance(result.closingBalance);
      })
      .catch(() => { setEntries([]); setPartyName(""); setOpeningBalance(0); setClosingBalance(0); })
      .finally(() => setLoading(false));
  }, [api, selectedPartyId, fromDate, toDate]);

  const filteredEntries = useMemo(() => entries.filter((entry) => {
    const q = search.trim().toLowerCase();
    return (!q || [entry.voucherNumber, entry.description, entry.modeOfTransfer || "", typeLabel(entry.voucherType)].some((v) => v.toLowerCase().includes(q)))
      && (typeFilter === "ALL" || entry.voucherType === typeFilter);
  }), [entries, search, typeFilter]);

  const totalPurchases = entries.filter((e) => e.voucherType === "PURCHASE").reduce((s, e) => s + e.creditAmount, 0);
  const totalPayments = entries.filter((e) => e.voucherType === "CASH_PAYMENT").reduce((s, e) => s + e.debitAmount, 0);
  const totalDebit = filteredEntries.reduce((s, e) => s + (e.debitAmount || 0), 0);
  const totalCredit = filteredEntries.reduce((s, e) => s + (e.creditAmount || 0), 0);
  const netBalance = totalCredit - totalDebit; // positive = we owe supplier

  const party = parties.find((p) => p.id === selectedPartyId);
  const initials = (partyName || party?.partyName || "Supplier").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  const exportCsv = () => {
    downloadCsv(`${(partyName || "supplier").replace(/\s+/g, "-")}-ledger`, {
      headers: ["Date", "Voucher No.", "Type", "Description", "Debit (Rs.)", "Credit (Rs.)", "Balance (Rs.)"],
      rows: filteredEntries.map((e) => [e.voucherDate, e.voucherNumber, typeLabel(e.voucherType), e.description, e.debitAmount || "", e.creditAmount || "", e.balance]),
    });
  };

  return (
    <div className="page customer-ledger-page">
      <div className="customer-ledger-heading">
        <div>
          <button type="button" className="customer-ledger-back" onClick={() => onNavigate("supplier-balance")}>‹ <span>{copy.common.back}</span></button>
          <h1>Supplier Ledger</h1>
          <p>Purchases and payments — amount we owe the supplier</p>
        </div>
        <div className="customer-ledger-actions">
          <div className="customer-ledger-search"><span>⌕</span><input aria-label="Search transactions" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search transactions..." /></div>
          <select aria-label="Filter transactions" className="customer-ledger-filter" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="ALL">Filter</option>
            <option value="PURCHASE">Purchase</option>
            <option value="CASH_PAYMENT">Payment</option>
            <option value="CASH_RECEIPT">Receipt</option>
            <option value="CLAIM">{copy.contractorLedger.claim}</option>
          </select>
          <button type="button" className="customer-ledger-action" onClick={exportCsv} disabled={!selectedPartyId}>⇩ <span>{copy.actions.export}</span></button>
        </div>
      </div>

      <section className="customer-ledger-customer-card">
        <div className="customer-ledger-identity">
          <div className="customer-ledger-avatar">{initials}</div>
          <div>
            <div className="customer-ledger-name-row">
              <select aria-label="Select supplier" value={selectedPartyId} onChange={(e) => setSelectedPartyId(e.target.value)}>
                <option value="">Select supplier</option>
                {parties.map((p) => <option key={p.id} value={p.id}>{p.partyName}</option>)}
              </select>
              {party && <span className="customer-ledger-status">{party.status === "ACTIVE" ? "Active" : "Inactive"}</span>}
            </div>
            <div className="customer-ledger-contact">☎ {party?.mobileNumber || party?.phoneNumber || "No phone number"}</div>
            <div className="customer-ledger-contact">⌖ {party?.city || party?.address || "Location not provided"}</div>
          </div>
        </div>
        <div className={`customer-ledger-highlight ${closingBalance >= 0 ? "is-payable" : "is-credit"}`}>
          <span>Amount Owed</span>
          <strong>Rs. {fmtNum(Math.abs(closingBalance))}</strong>
          <small>{closingBalance >= 0 ? "Payable to supplier" : "Advance / overpaid"}</small>
        </div>
        <div className="customer-ledger-highlight">
          <span>Total Transactions</span>
          <strong>{entries.length}</strong>
          <small>{fromDate} to {toDate}</small>
        </div>
      </section>

      <section className="customer-ledger-workspace">
        <div className="customer-ledger-tabs">
          <span style={{ fontWeight: 700, fontSize: 13, color: "var(--chrome-ink)" }}>Ledger</span>
          <div className="customer-ledger-date">
            <span>▣</span>
            <input aria-label={copy.filters.fromDate} type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            <b>to</b>
            <input aria-label={copy.filters.toDate} type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
        </div>
        <div className="customer-ledger-summary-grid">
          <div className="customer-ledger-summary-card"><div><span>Opening Balance</span><strong>Rs. {fmtNum(Math.abs(openingBalance))}</strong><small>{fromDate}</small></div></div>
          <div className="customer-ledger-summary-card"><div><span>Total Purchases</span><strong className="negative">Rs. {fmtNum(totalPurchases)}</strong><small>{entries.filter((e) => e.voucherType === "PURCHASE").length} bills</small></div></div>
          <div className="customer-ledger-summary-card"><div><span>Total Payments</span><strong className="positive">Rs. {fmtNum(totalPayments)}</strong><small>{entries.filter((e) => e.voucherType === "CASH_PAYMENT").length} payments</small></div></div>
          <div className="customer-ledger-summary-card"><div><span>Closing Balance</span><strong>Rs. {fmtNum(Math.abs(closingBalance))}</strong><small>{toDate}</small></div></div>
        </div>
        <div className="customer-ledger-table-wrap">
          {loading ? <div className="customer-ledger-empty">Loading ledger...</div>
            : !selectedPartyId ? <div className="customer-ledger-empty">Select a supplier to view the ledger.</div>
            : (
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
                  {filteredEntries.map((entry) => (
                    <tr key={`${entry.voucherId}-${entry.voucherType}`}>
                      <td>{fmtDate(entry.voucherDate)}</td>
                      <td>{entry.voucherNumber}</td>
                      <td><span className={`customer-ledger-type customer-ledger-type-${entry.voucherType === "PURCHASE" ? "cash_receipt" : entry.voucherType === "CASH_PAYMENT" ? "cash_payment" : "opening"}`}><span className="customer-ledger-type-dot" />{typeLabel(entry.voucherType)}</span></td>
                      <td>{entry.description}</td>
                      <td className="amount">{entry.debitAmount ? fmtNum(entry.debitAmount) : "-"}</td>
                      <td className="amount">{entry.creditAmount ? fmtNum(entry.creditAmount) : "-"}</td>
                      <td className="amount balance">{fmtNum(entry.balance)}</td>
                    </tr>
                  ))}
                  {filteredEntries.length === 0 && <tr><td colSpan={7} className="customer-ledger-empty">No transactions in this range.</td></tr>}
                </tbody>
                <tfoot>
                  <tr className="customer-ledger-total-row">
                    <td colSpan={4}>Total ({filteredEntries.length} entries)</td>
                    <td className="amount debit">{fmtNum(totalDebit)}</td>
                    <td className="amount credit">{fmtNum(totalCredit)}</td>
                    <td className="amount balance">{fmtNum(netBalance)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
        </div>
      </section>
    </div>
  );
};
