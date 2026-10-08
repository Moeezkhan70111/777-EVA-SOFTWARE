import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { CashVoucher, Party, SaleVoucher } from "../types/desktopApi";
import { discountPerPairFromTotal } from "@erp/domain";
import { formatDate, formatMonth, toIsoDate } from "../utils/dates";
import { formatWholeMoney } from "../app/format";
import { copy } from "../config/copy";
import { downloadCsv } from "../utils/exportFile";

interface CustomerLedgerPageProps { onNavigate: (route: AppRoute, id?: string) => void; }
type LedgerType = "SALE" | "CASH_RECEIPT" | "CASH_PAYMENT";
interface LedgerLineItem { id: string; article: string; color: string; size: string; groupName: string | null; quantity: number; unitPrice: number; discount: number; totalPrice: number; }
interface LedgerEntry { voucherId: string; voucherNumber: string; voucherDate: string; voucherType: LedgerType; description: string; modeOfTransfer?: string; onlineFrom?: string; onlineTo?: string; bankAccountTitle?: string; chequeNumber?: string; chequeDate?: string; referenceNo?: string; debitAmount: number; creditAmount: number; balance: number; lineItems?: LedgerLineItem[]; }
const fmtDate = (value: string) => formatDate(value, value);
const fmtNum = formatWholeMoney;
const typeLabel = (type: LedgerType) => type === "CASH_RECEIPT" ? "Receipt" : type === "CASH_PAYMENT" ? "Payment" : "Sale Voucher";
const TypeBadge: React.FC<{ type: LedgerType }> = ({ type }) => <span className={`customer-ledger-type customer-ledger-type-${type.toLowerCase()}`}><span className="customer-ledger-type-dot" />{typeLabel(type)}</span>;
const Detail: React.FC<{ label: string; value: string }> = ({ label, value }) => <div><span>{label}</span><strong>{value}</strong></div>;

const CashLineDetails: React.FC<{ line: NonNullable<CashVoucher["lines"]>[number] }> = ({ line }) => {
  const fields = [
    ["Description", line.description],
    ["Bank / Account Title", line.bankAccountTitle],
    ["Cheque Number", line.chequeNumber],
    ["Cheque Date", line.chequeDate],
    ["Online From", line.onlineFrom],
    ["Online To", line.onlineTo],
    ["Reference Number", line.referenceNo],
  ].filter(([, value]) => value);
  return <>{fields.map(([label, value]) => <span key={label}><small>{label}</small>{value}</span>)}</>;
};

const SaleDetails: React.FC<{ sale: SaleVoucher }> = ({ sale }) => <>
  <Detail label={copy.columns.amount} value={`Rs. ${fmtNum(sale.totalAmount)}`} />
  <Detail label="Book No." value={sale.bookNo || "-"} />
  <Detail label="Sub-party" value={sale.subPartyNameUrdu || "-"} />
  <Detail label={copy.columns.remarks} value={sale.remarks || "-"} />
  <Detail label="Total Quantity" value={String(sale.totalQuantity)} />
  <div className="customer-ledger-sale-lines"><span>Line Items</span><table className="customer-ledger-lines-table"><thead><tr><th>{copy.columns.article}</th><th>Product Group</th><th>{copy.columns.size}</th><th className="num">{copy.columns.qty}</th><th className="num">Rate</th><th className="num">Gross</th><th className="num">Less</th><th className="num">Tot. Disc</th><th className="num">{copy.columns.amount}</th></tr></thead><tbody>{sale.lineItems.map((item) => { const less = item.quantity > 0 ? item.discount / item.quantity / 12 : 0; const totDisc = Math.round(less * 12 * item.quantity); const gross = item.quantity * 12 * item.unitPrice; return <tr key={item.id}><td>{item.article}</td><td>{item.groupName || "-"}</td><td>{item.size}</td><td className="num">{item.quantity}</td><td className="num">{fmtNum(item.unitPrice)}</td><td className="num">{fmtNum(gross)}</td><td className="num">{item.discount > 0 ? fmtNum(less) : "-"}</td><td className="num disc">{item.discount > 0 ? fmtNum(totDisc) : "-"}</td><td className="num">{fmtNum(item.totalPrice)}</td></tr>; })}</tbody></table></div>
</>;

const VoucherDetail: React.FC<{ voucher: CashVoucher | SaleVoucher; type: LedgerType; onClose: () => void; onEdit?: () => void }> = ({ voucher, type, onClose, onEdit }) => {
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; document.addEventListener("keydown", handler); return () => document.removeEventListener("keydown", handler); }, [onClose]);
  const cash = type === "SALE" ? null : voucher as CashVoucher;
  const sale = type === "SALE" ? voucher as SaleVoucher : null;
  const number = type === "SALE" ? `SV-${sale?.voucherNumber}` : `${type === "CASH_RECEIPT" ? "RV" : "PV"}-${String(cash?.voucherNumber ?? 0).padStart(5, "0")}`;
  const cashAmount = cash ? (cash.lines && cash.lines.length > 0 ? cash.lines.reduce((sum, line) => sum + (line.receiptAmount || line.paymentAmount || 0), 0) : (cash.receiptAmount || cash.paymentAmount)) : 0;
  return <div className="customer-ledger-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className={`customer-ledger-modal ${type === "CASH_RECEIPT" ? "receipt" : type === "CASH_PAYMENT" ? "payment" : "sale"}`} role="dialog" aria-modal="true"><div className="customer-ledger-modal-header"><div><span>{typeLabel(type)}</span><h2>{number}</h2></div><div className="customer-ledger-modal-header-actions">{onEdit && <button type="button" className="customer-ledger-print" onClick={onEdit}>✎ <span>{copy.actions.edit}</span></button>}<button type="button" className="customer-ledger-print" onClick={() => window.print()}>▣ <span>{copy.actions.print}</span></button><button type="button" onClick={onClose} aria-label="Close voucher">×</button></div></div><div className="customer-ledger-detail-grid"><Detail label={copy.columns.date} value={fmtDate(voucher.voucherDate)} /><Detail label={copy.columns.party} value={voucher.partyName} /><Detail label="Transaction" value={typeLabel(type)} />{cash ? <><Detail label={copy.columns.amount} value={`Rs. ${fmtNum(cashAmount)}`} /><Detail label="Mode of Transfer" value={cash.modeOfTransfer || cash.lines?.[0]?.modeOfTransfer || "Not recorded"} /><Detail label={copy.columns.description} value={cash.description || "-"} /></> : <SaleDetails sale={sale!} />}</div>{cash?.lines && <div className="customer-ledger-modal-lines"><h3>Voucher details</h3>{cash.lines.map((line, index) => <div className="customer-ledger-modal-line" key={`${line.partyId}-${index}`}><strong>{line.partyName}</strong><div className="customer-ledger-modal-line-fields"><CashLineDetails line={line} /></div><b>{line.modeOfTransfer || "Not recorded"}</b><em>Rs. {fmtNum(line.receiptAmount || line.paymentAmount)}</em></div>)}</div>}</div></div>;
};
const CustomerSelect: React.FC<{ parties: Party[]; value: string; onChange: (id: string) => void }> = ({ parties, value, onChange }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);

  const selected = parties.find((p) => p.id === value) ?? null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? parties.filter((p) => p.partyName.toLowerCase().includes(q) || (p.city ?? "").toLowerCase().includes(q) || (p.mobileNumber ?? "").includes(q)) : parties;
  }, [parties, query]);

  useEffect(() => {
    if (selected && !open) setQuery(selected.partyName);
    if (!value && !open) setQuery("");
  }, [value, selected, open]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  const pick = useCallback((p: Party) => { onChange(p.id); setQuery(p.partyName); setOpen(false); setHi(0); }, [onChange]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && open && filtered[hi]) { e.preventDefault(); pick(filtered[hi]); }
    else if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
  };

  return (
    <div ref={wrapRef} className="cl-customer-select">
      <div className="cl-customer-select-box" onClick={() => { setOpen((o) => !o); setTimeout(() => inputRef.current?.focus(), 30); }}>
        {selected ? (
          <div className="cl-customer-selected">
            <div className="cl-customer-avatar">{selected.partyName.trim().split(/\s+/).map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}</div>
            <div className="cl-customer-info">
              <strong>{selected.partyName}</strong>
              <span>{selected.city || selected.mobileNumber || "—"}</span>
            </div>
            <span className={`customer-ledger-status${selected.status !== "ACTIVE" ? " inactive" : ""}`}>{selected.status === "ACTIVE" ? "Active" : "Inactive"}</span>
          </div>
        ) : (
          <div className="cl-customer-placeholder"><span>⌕</span> Select customer…</div>
        )}
        <span className="cl-customer-chevron">{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div className="cl-customer-dropdown">
          <div className="cl-customer-search-wrap">
            <span>⌕</span>
            <input
              ref={inputRef}
              type="text"
              className="cl-customer-search"
              placeholder="Search by name, city or phone…"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHi(0); if (value) onChange(""); }}
              onKeyDown={onKey}
              autoComplete="off"
              aria-label="Search customers"
            />
            {query && <button type="button" className="cl-customer-clear" onMouseDown={(e) => e.preventDefault()} onClick={() => { setQuery(""); onChange(""); inputRef.current?.focus(); }}>×</button>}
          </div>
          <div className="cl-customer-options" role="listbox">
            {filtered.length === 0 ? (
              <div className="cl-customer-empty">No customers found</div>
            ) : filtered.map((p, idx) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={p.id === value}
                className={`cl-customer-option${idx === hi ? " hi" : ""}${p.id === value ? " selected" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(p)}
                onMouseEnter={() => setHi(idx)}
              >
                <div className="cl-customer-opt-avatar">{p.partyName.trim().split(/\s+/).map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}</div>
                <div className="cl-customer-opt-body">
                  <strong>{p.partyName}</strong>
                  <span>{[p.city, p.mobileNumber].filter(Boolean).join(" · ") || "—"}</span>
                </div>
                {p.id === value && <span className="cl-customer-opt-check">✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
const Summary: React.FC<{ label: string; value: number; detail: string; tone?: "positive" | "negative" }> = ({ label, value, detail, tone }) => <div className="customer-ledger-summary-card"><div className={`customer-ledger-summary-icon ${tone || "neutral"}`}>{tone === "positive" ? "↓" : tone === "negative" ? "↑" : "▣"}</div><div><span>{label}</span><strong className={tone || ""}>Rs. {fmtNum(Math.abs(value))}</strong><small>{detail}</small></div></div>;

interface SummaryTabProps { entries: LedgerEntry[]; openingBalance: number; closingBalance: number; totalReceipts: number; totalPayments: number; fromDate: string; toDate: string; selectedPartyId: string; loading: boolean; }
const SummaryTab: React.FC<SummaryTabProps> = ({ entries, openingBalance, closingBalance, totalReceipts, totalPayments, fromDate, toDate, selectedPartyId, loading }) => {
  const totalSales = entries.filter((e) => e.voucherType === "SALE").reduce((s, e) => s + e.debitAmount, 0);
  const saleCount = entries.filter((e) => e.voucherType === "SALE").length;
  const receiptCount = entries.filter((e) => e.voucherType === "CASH_RECEIPT").length;
  // Monthly breakdown
  const monthMap = new Map<string, { sales: number; receipts: number; payments: number }>();
  for (const e of entries) {
    const key = e.voucherDate.slice(0, 7); // "YYYY-MM"
    if (!monthMap.has(key)) monthMap.set(key, { sales: 0, receipts: 0, payments: 0 });
    const m = monthMap.get(key)!;
    if (e.voucherType === "SALE") m.sales += e.debitAmount;
    else if (e.voucherType === "CASH_RECEIPT") m.receipts += e.creditAmount;
    else if (e.voucherType === "CASH_PAYMENT") m.payments += e.debitAmount;
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
            <tr><td>Total Payments (Credit)</td><td className="num grn">{fmtNum(totalPayments)}</td><td className="tag">Payments</td></tr>
            <tr className="cl-summary-total"><td>Closing Balance</td><td className="num">{fmtNum(Math.abs(closingBalance))}</td><td className="tag">{closingBalance > 0 ? "Receivable" : closingBalance < 0 ? "Credit" : "Settled"}</td></tr>
          </tbody>
        </table>
      </div>
      {months.length > 0 && <div className="cl-summary-section">
        <h3>Monthly Breakdown <small>{fromDate} → {toDate}</small></h3>
        <table className="cl-summary-table">
          <thead><tr><th>Month</th><th className="num">Sales</th><th className="num">Receipts</th><th className="num">Payments</th><th className="num">Net</th></tr></thead>
          <tbody>{months.map(([key, m]) => {
            const net = m.sales - m.receipts - m.payments;
            return <tr key={key}><td>{fmtMonth(key)}</td><td className="num red">{m.sales ? fmtNum(m.sales) : "-"}</td><td className="num grn">{m.receipts ? fmtNum(m.receipts) : "-"}</td><td className="num grn">{m.payments ? fmtNum(m.payments) : "-"}</td><td className={`num ${net > 0 ? "red" : net < 0 ? "grn" : ""}`}>{fmtNum(Math.abs(net))}</td></tr>;
          })}</tbody>
          <tfoot><tr><td><strong>{copy.columns.total}</strong></td><td className="num red"><strong>{fmtNum(totalSales)}</strong></td><td className="num grn"><strong>{fmtNum(totalReceipts)}</strong></td><td className="num grn"><strong>{fmtNum(totalPayments)}</strong></td><td className="num"><strong>{fmtNum(Math.abs(closingBalance - openingBalance))}</strong></td></tr></tfoot>
        </table>
      </div>}
    </div>
  </div>;
};

interface StatementsTabProps { entries: LedgerEntry[]; openingBalance: number; closingBalance: number; partyName: string; party: Party | undefined; fromDate: string; toDate: string; selectedPartyId: string; loading: boolean; balanceLimit: number | null; }
const StatementsTab: React.FC<StatementsTabProps> = ({ entries, openingBalance, closingBalance, partyName, party, fromDate, toDate, selectedPartyId, loading, balanceLimit }) => {
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

export const CustomerLedgerPage: React.FC<CustomerLedgerPageProps> = ({ onNavigate }) => {
  const api = useDesktopApi();
  const [parties, setParties] = useState<Party[]>([]); const [selectedPartyId, setSelectedPartyId] = useState(""); const [fromDate, setFromDate] = useState("2026-01-01"); const [toDate, setToDate] = useState(toIsoDate());
  const [entries, setEntries] = useState<LedgerEntry[]>([]); const [openingBalance, setOpeningBalance] = useState(0); const [closingBalance, setClosingBalance] = useState(0); const [partyName, setPartyName] = useState(""); const [balanceLimit, setBalanceLimit] = useState<number | null>(null); const [loading, setLoading] = useState(false); const [search, setSearch] = useState(""); const [typeFilter, setTypeFilter] = useState("ALL"); const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(10); const [activeTab, setActiveTab] = useState("Ledger"); const [detailVoucher, setDetailVoucher] = useState<{ voucher: CashVoucher | SaleVoucher; type: LedgerType } | null>(null);
  useEffect(() => { void api.listParties({ pageSize: 1000 }).then((result) => setParties(result.rows.filter((party) => party.partyType === "CUSTOMER"))); }, [api]);
  useEffect(() => { if (!selectedPartyId) { setEntries([]); setPartyName(""); setOpeningBalance(0); setClosingBalance(0); setBalanceLimit(null); return; } setLoading(true); void api.getCustomerLedgerWithCash(selectedPartyId, { fromDate, toDate }).then((result) => { setEntries(result.entries as LedgerEntry[]); setPartyName(result.partyName); setOpeningBalance(result.openingBalance); setClosingBalance(result.closingBalance); setBalanceLimit(result.balanceLimit ?? null); }).catch(() => { setEntries([]); setPartyName(""); setOpeningBalance(0); setClosingBalance(0); setBalanceLimit(null); }).finally(() => setLoading(false)); }, [api, selectedPartyId, fromDate, toDate]);
  useEffect(() => { setPage(1); }, [search, typeFilter, selectedPartyId, fromDate, toDate]);
  const party = parties.find((item) => item.id === selectedPartyId);
  const filteredEntries = useMemo(() => entries.filter((entry) => { const query = search.trim().toLowerCase(); return (!query || [entry.voucherNumber, entry.description, entry.modeOfTransfer || "", typeLabel(entry.voucherType)].some((value) => value.toLowerCase().includes(query))) && (typeFilter === "ALL" || entry.voucherType === typeFilter); }), [entries, search, typeFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredEntries.length / pageSize)); const visibleEntries = filteredEntries.slice((page - 1) * pageSize, page * pageSize); const totalReceipts = entries.filter((entry) => entry.voucherType === "CASH_RECEIPT").reduce((sum, entry) => sum + entry.creditAmount, 0); const totalPayments = entries.filter((entry) => entry.voucherType === "CASH_PAYMENT").reduce((sum, entry) => sum + entry.debitAmount, 0); const usedPercent = balanceLimit != null && balanceLimit > 0 ? Math.min(100, Math.max(0, Math.round((Math.abs(closingBalance) / balanceLimit) * 100))) : 0; const initials = (partyName || party?.partyName || "Customer").split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase();
  const totalDebit = filteredEntries.reduce((sum, entry) => sum + (entry.debitAmount || 0), 0); const totalCredit = filteredEntries.reduce((sum, entry) => sum + (entry.creditAmount || 0), 0); const netBalance = totalDebit - totalCredit;
  const openVoucher = async (entry: LedgerEntry) => { const voucher = entry.voucherType === "SALE" ? await api.getSaleVoucher(entry.voucherId) : await api.getCashVoucher(entry.voucherId); if (voucher) setDetailVoucher({ voucher, type: entry.voucherType }); };
  const exportCsv = () => downloadCsv(`${(partyName || "customer").replace(/\s+/g, "-")}-ledger`, {
    headers: ["Date", "Voucher No.", "Type", "Description", "Mode of Transfer", "Debit (Rs.)", "Credit (Rs.)", "Balance (Rs.)"],
    rows: filteredEntries.map((entry) => [entry.voucherDate, entry.voucherNumber, typeLabel(entry.voucherType), entry.description, entry.modeOfTransfer || "", entry.debitAmount || "", entry.creditAmount || "", entry.balance]),
  });
  return <div className="page customer-ledger-page">{detailVoucher && <VoucherDetail voucher={detailVoucher.voucher} type={detailVoucher.type} onClose={() => setDetailVoucher(null)} onEdit={() => { const target = detailVoucher.type === "SALE" ? "sale-voucher-form" : "cash-voucher-form"; const id = detailVoucher.voucher.id; setDetailVoucher(null); onNavigate(target, id); }} />}<div className="customer-ledger-heading"><div><button type="button" className="customer-ledger-back" onClick={() => onNavigate("customer-balance")}>‹ <span>{copy.common.back}</span></button><h1>Customer Ledger</h1></div><div className="customer-ledger-actions"><div className="customer-ledger-search"><span>⌕</span><input aria-label="Search transactions" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search transactions..." /></div><select aria-label="Filter transactions" className="customer-ledger-filter" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="ALL">Filter</option><option value="SALE">Sale Voucher</option><option value="CASH_RECEIPT">Receipt</option><option value="CASH_PAYMENT">Payment</option></select><button type="button" className="customer-ledger-action" onClick={exportCsv} disabled={!selectedPartyId}>⇩ <span>{copy.actions.export}</span></button><button type="button" className="customer-ledger-more" aria-label="More actions">•••</button></div></div>
  <section className="customer-ledger-customer-card"><div className="customer-ledger-identity"><CustomerSelect parties={parties} value={selectedPartyId} onChange={setSelectedPartyId} /></div><div className="customer-ledger-limit"><span>Balance Limit</span><strong>{balanceLimit == null ? "No limit" : `Rs. ${fmtNum(balanceLimit)}`}</strong>{balanceLimit != null && <><small>Used: Rs. {fmtNum(Math.abs(closingBalance))} <b>{usedPercent}%</b></small></>}</div><div className={`customer-ledger-highlight ${closingBalance > 0 ? "is-receivable" : closingBalance < 0 ? "is-credit" : "is-zero"}`}><span>Current Balance</span><strong>Rs. {fmtNum(Math.abs(closingBalance))}</strong><small>{closingBalance > 0 ? "Receivable" : closingBalance < 0 ? "Advance / Credit" : "Settled"}</small></div>
</section>
  <section className="customer-ledger-workspace"><div className="customer-ledger-tabs">{["Ledger", "Summary", "Statements"].map((tab) => <button type="button" className={activeTab === tab ? "active" : ""} key={tab} onClick={() => setActiveTab(tab)}>{tab}</button>)}<div className="customer-ledger-date"><span>▣</span><input aria-label={copy.filters.fromDate} type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /><b>to</b><input aria-label={copy.filters.toDate} type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></div></div>
  {activeTab === "Ledger" ? <><div className="customer-ledger-summary-grid"><Summary label="Opening Balance" value={openingBalance} detail={fromDate} /><Summary label="Total Receipts" value={totalReceipts} detail={`${entries.filter((e) => e.voucherType === "CASH_RECEIPT").length} transactions`} tone="positive" /><Summary label="Total Payments" value={totalPayments} detail={`${entries.filter((e) => e.voucherType === "CASH_PAYMENT").length} transactions`} tone="negative" /><Summary label="Closing Balance" value={closingBalance} detail={toDate} tone={closingBalance >= 0 ? "negative" : "positive"} /></div><div className="customer-ledger-table-wrap">{loading ? <div className="customer-ledger-empty">Loading ledger...</div> : !selectedPartyId ? <div className="customer-ledger-empty">Select a customer to view the ledger.</div> : <table className="customer-ledger-table"><thead><tr><th>{copy.columns.date}</th><th>Voucher No.</th><th>{copy.columns.type}</th><th>{copy.columns.description}</th><th className="amount">Less</th><th className="amount">Tot. Disc</th><th className="amount">Debit (Rs.)</th><th className="amount">Credit (Rs.)</th><th className="amount">Balance (Rs.)</th><th>{copy.columns.reference}</th></tr></thead><tbody>{openingBalance !== 0 && <tr className="opening-row"><td>{fromDate}</td><td>OB</td><td><span className="customer-ledger-type customer-ledger-type-opening"><span className="customer-ledger-type-dot" />Opening Balance</span></td><td>Opening balance carried forward</td><td className="amount">-</td><td className="amount">-</td><td className="amount">{openingBalance > 0 ? fmtNum(openingBalance) : "-"}</td><td className="amount">{openingBalance < 0 ? fmtNum(Math.abs(openingBalance)) : "-"}</td><td className="amount">{fmtNum(openingBalance)}</td><td>-</td></tr>}{visibleEntries.map((entry) => {
  const lines = entry.voucherType === "SALE" && entry.lineItems && entry.lineItems.length > 0 ? entry.lineItems : null;
  if (lines) {
    const fmtQty = (q: number) => Number.isInteger(q) ? String(q) : q.toFixed(2);
    return (
      <React.Fragment key={`${entry.voucherId}-${entry.voucherType}`}>
        {lines.map((li, idx) => {
          const isLast = idx === lines.length - 1;
          // "Less" is the per-pair discount implied by the saved line; total discount is the saved figure.
          const less = discountPerPairFromTotal({ dozens: li.quantity, totalDiscount: li.discount });
          const totDisc = Math.round(li.discount);
          return (
            <tr key={`${entry.voucherId}-li-${li.id}`} className={`customer-ledger-row ledger-line-row${isLast ? " ledger-line-last" : ""}`} onClick={() => void openVoucher(entry)}>
              <td>{idx === 0 ? fmtDate(entry.voucherDate) : ""}</td>
              <td>{idx === 0 ? <span className="customer-ledger-voucher">{entry.voucherNumber}</span> : ""}</td>
              <td>{idx === 0 ? <TypeBadge type={entry.voucherType} /> : ""}</td>
              <td className="ledger-line-desc-cell">
                <span className="ll-article">{li.article}</span>
                {li.groupName && <><span className="ll-sep">|</span><span className="ll-group">{li.groupName}</span></>}
                <span className="ll-sep">|</span>
                <span className="ll-size">{li.size}</span>
                <span className="ll-sep">|</span>
                <span className="ll-qty">{fmtQty(li.quantity)} x {fmtNum(li.unitPrice)}</span>
              </td>
              <td className="amount">{li.discount > 0 ? fmtNum(less) : "-"}</td>
              <td className="amount ll-discount-amt">{li.discount > 0 ? fmtNum(totDisc) : "-"}</td>
              <td className="amount debit">{fmtNum(li.totalPrice)}</td>
              <td className="amount credit">-</td>
              <td className="amount balance">{isLast ? fmtNum(entry.balance) : ""}</td>
              <td>Sale voucher</td>
            </tr>
          );
        })}
      </React.Fragment>
    );
  }
  return (
    <tr key={`${entry.voucherId}-${entry.voucherType}`} className="customer-ledger-row" onClick={() => void openVoucher(entry)}>
      <td>{fmtDate(entry.voucherDate)}</td>
      <td><span className="customer-ledger-voucher">{entry.voucherNumber}</span></td>
      <td><TypeBadge type={entry.voucherType} /></td>
      <td><div className="ledger-cash-desc">
        {entry.description && <span className="ledger-cash-main">{entry.description}</span>}
        {entry.modeOfTransfer === "Online Transfer" && <>
          {entry.onlineFrom  && <span><small>Online From</small>{entry.onlineFrom}</span>}
          {entry.onlineTo    && <span><small>Online To</small>{entry.onlineTo}</span>}
          {entry.referenceNo && <span><small>Ref No.</small>{entry.referenceNo}</span>}
        </>}
        {(entry.modeOfTransfer === "Cheque") && <>
          {entry.bankAccountTitle && <span><small>Bank</small>{entry.bankAccountTitle}</span>}
          {entry.chequeNumber     && <span><small>Chq #</small>{entry.chequeNumber}</span>}
          {entry.chequeDate       && <span><small>Chq Date</small>{entry.chequeDate}</span>}
        </>}
        {entry.modeOfTransfer === "Bank Transfer" && <>
          {entry.bankAccountTitle && <span><small>Bank / Acc</small>{entry.bankAccountTitle}</span>}
          {entry.referenceNo      && <span><small>Ref No.</small>{entry.referenceNo}</span>}
        </>}
        {!entry.description && !entry.onlineFrom && !entry.onlineTo && !entry.bankAccountTitle && !entry.chequeNumber && !entry.referenceNo && <span className="ledger-cash-main">-</span>}
      </div></td>
      <td className="amount">-</td>
      <td className="amount">-</td>
      <td className="amount debit">{entry.debitAmount ? fmtNum(entry.debitAmount) : "-"}</td>
      <td className="amount credit">{entry.creditAmount ? fmtNum(entry.creditAmount) : "-"}</td>
      <td className="amount balance">{fmtNum(entry.balance)}</td>
      <td>{entry.modeOfTransfer || "Not recorded"}</td>
    </tr>
  );
})}</tbody><tfoot><tr className="customer-ledger-total-row"><td colSpan={6}>Total ({filteredEntries.length} entries)</td><td className="amount debit">{fmtNum(totalDebit)}</td><td className="amount credit">{fmtNum(totalCredit)}</td><td className="amount balance">{fmtNum(netBalance)}</td><td>-</td></tr></tfoot></table>}</div><div className="customer-ledger-footer"><span>Showing {filteredEntries.length ? (page - 1) * pageSize + 1 : 0} to {Math.min(page * pageSize, filteredEntries.length)} of {filteredEntries.length} entries</span><div><button type="button" aria-label="Previous page" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>‹</button><b>{page}</b><button type="button" aria-label="Next page" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>›</button><select aria-label="Rows per page" value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}><option value={10}>10 / page</option><option value={25}>25 / page</option><option value={50}>50 / page</option></select></div></div></>
  : activeTab === "Summary" ? <SummaryTab entries={entries} openingBalance={openingBalance} closingBalance={closingBalance} totalReceipts={totalReceipts} totalPayments={totalPayments} fromDate={fromDate} toDate={toDate} selectedPartyId={selectedPartyId} loading={loading} />
  : <StatementsTab entries={entries} openingBalance={openingBalance} closingBalance={closingBalance} partyName={partyName} party={party} fromDate={fromDate} toDate={toDate} selectedPartyId={selectedPartyId} loading={loading} balanceLimit={balanceLimit} />}
  </section></div>;
};

