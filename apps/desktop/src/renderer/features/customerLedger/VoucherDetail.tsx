import React, { useEffect } from "react";
import { copy } from "../../config/copy";
import { formatWholeMoney } from "../../app/format";
import { formatDate } from "../../utils/dates";
import type { CashVoucher, SaleVoucher } from "../../types/desktopApi";
import { typeLabel } from "./LedgerRows";
import type { LedgerType } from "./ledgerTypes";

// A sale or cash voucher opened from the ledger, read only, with Edit and Print. Moved from the Customer Ledger page.

const fmtDate = (value: string) => formatDate(value, value);
const fmtNum = formatWholeMoney;
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


export const VoucherDetail: React.FC<{ voucher: CashVoucher | SaleVoucher; type: LedgerType; onClose: () => void; onEdit?: () => void }> = ({ voucher, type, onClose, onEdit }) => {
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; document.addEventListener("keydown", handler); return () => document.removeEventListener("keydown", handler); }, [onClose]);
  const cash = type === "SALE" ? null : voucher as CashVoucher;
  const sale = type === "SALE" ? voucher as SaleVoucher : null;
  const number = type === "SALE" ? `SV-${sale?.voucherNumber}` : `${type === "CASH_RECEIPT" ? "RV" : "PV"}-${String(cash?.voucherNumber ?? 0).padStart(5, "0")}`;
  const cashAmount = cash ? (cash.lines && cash.lines.length > 0 ? cash.lines.reduce((sum, line) => sum + (line.receiptAmount || line.paymentAmount || 0), 0) : (cash.receiptAmount || cash.paymentAmount)) : 0;
  return <div className="customer-ledger-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className={`customer-ledger-modal ${type === "CASH_RECEIPT" ? "receipt" : type === "CASH_PAYMENT" ? "payment" : "sale"}`} role="dialog" aria-modal="true"><div className="customer-ledger-modal-header"><div><span>{typeLabel(type)}</span><h2>{number}</h2></div><div className="customer-ledger-modal-header-actions">{onEdit && <button type="button" className="customer-ledger-print" onClick={onEdit}>✎ <span>{copy.actions.edit}</span></button>}<button type="button" className="customer-ledger-print" onClick={() => window.print()}>▣ <span>{copy.actions.print}</span></button><button type="button" onClick={onClose} aria-label="Close voucher">×</button></div></div><div className="customer-ledger-detail-grid"><Detail label={copy.columns.date} value={fmtDate(voucher.voucherDate)} /><Detail label={copy.columns.party} value={voucher.partyName} /><Detail label="Transaction" value={typeLabel(type)} />{cash ? <><Detail label={copy.columns.amount} value={`Rs. ${fmtNum(cashAmount)}`} /><Detail label="Mode of Transfer" value={cash.modeOfTransfer || cash.lines?.[0]?.modeOfTransfer || "Not recorded"} /><Detail label={copy.columns.description} value={cash.description || "-"} /></> : <SaleDetails sale={sale!} />}</div>{cash?.lines && <div className="customer-ledger-modal-lines"><h3>Voucher details</h3>{cash.lines.map((line, index) => <div className="customer-ledger-modal-line" key={`${line.partyId}-${index}`}><strong>{line.partyName}</strong><div className="customer-ledger-modal-line-fields"><CashLineDetails line={line} /></div><b>{line.modeOfTransfer || "Not recorded"}</b><em>Rs. {fmtNum(line.receiptAmount || line.paymentAmount)}</em></div>)}</div>}</div></div>;
};
