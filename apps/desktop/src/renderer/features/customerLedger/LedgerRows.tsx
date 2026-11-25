import React from "react";
import { discountPerPairFromTotal } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatWholeMoney } from "../../app/format";
import { formatDate } from "../../utils/dates";
import { LEDGER_TYPE, opensVoucher, type LedgerEntry, type LedgerLineItem, type LedgerType } from "./ledgerTypes";

// One live ledger entry as table rows: a sale voucher as one row per line, anything else as one row. The voucher
// number is a button (its affordance and its name, R18): Enter or a click opens the voucher; so does the whole row.

const text = copy.customerLedger;
const fmt = formatWholeMoney;
const dash = "-";

export const typeLabel = (type: LedgerType): string => (type === LEDGER_TYPE.OPENING_BALANCE ? copy.openingBalance.ledgerRow : text.types[type]);

export const TypeBadge: React.FC<{ type: LedgerType }> = ({ type }) => (
  <span className={`customer-ledger-type customer-ledger-type-${type === LEDGER_TYPE.OPENING_BALANCE ? "opening" : type.toLowerCase()}`}>
    <span className="customer-ledger-type-dot" />{typeLabel(type)}
  </span>
);

const VoucherNumber: React.FC<{ entry: LedgerEntry; onOpen: (entry: LedgerEntry) => void }> = ({ entry, onOpen }) => opensVoucher(entry.voucherType)
  ? <button type="button" className="customer-ledger-voucher cl-voucher-open" aria-label={text.openVoucher(entry.voucherNumber)} onClick={(event) => { event.stopPropagation(); onOpen(entry); }}>{entry.voucherNumber}</button>
  : <span className="customer-ledger-voucher">{entry.voucherNumber}</span>;

const quantityText = (quantity: number) => (Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(2));

const SaleLineRow: React.FC<{ entry: LedgerEntry; line: LedgerLineItem; first: boolean; last: boolean; onOpen: (entry: LedgerEntry) => void }> = ({ entry, line, first, last, onOpen }) => {
  // "Less" is the per-pair discount implied by the saved line; total discount is the saved figure.
  const less = discountPerPairFromTotal({ dozens: line.quantity, totalDiscount: line.discount });
  return (
    <tr className={`customer-ledger-row ledger-line-row${last ? " ledger-line-last" : ""}`} onClick={() => onOpen(entry)}>
      <td>{first ? formatDate(entry.voucherDate, entry.voucherDate) : ""}</td>
      <td>{first ? <VoucherNumber entry={entry} onOpen={onOpen} /> : ""}</td>
      <td>{first ? <TypeBadge type={entry.voucherType} /> : ""}</td>
      <td>{first ? dash : ""}</td>
      <td className="ledger-line-desc-cell">
        <span className="ll-article">{line.article}</span>
        {line.groupName && <><span className="ll-sep">|</span><span className="ll-group">{line.groupName}</span></>}
        <span className="ll-sep">|</span><span className="ll-size">{line.size}</span>
        <span className="ll-sep">|</span><span className="ll-qty">{quantityText(line.quantity)} x {fmt(line.unitPrice)}</span>
      </td>
      <td className="amount">{quantityText(line.quantity)}</td>
      <td className="amount">{line.discount > 0 ? fmt(less) : dash}</td>
      <td className="amount ll-discount-amt">{line.discount > 0 ? fmt(Math.round(line.discount)) : dash}</td>
      <td className="amount debit">{fmt(line.totalPrice)}</td>
      <td className="amount credit">{dash}</td>
      <td className="amount balance">{last ? fmt(entry.balance) : ""}</td>
      <td>{text.types.SALE}</td>
    </tr>
  );
};

/** What a cash voucher says about how the money moved, by its mode. */
const CashDescription: React.FC<{ entry: LedgerEntry }> = ({ entry }) => {
  const mode = entry.modeOfTransfer;
  const fields: Array<[string, string | undefined]> =
    mode === "Online Transfer" ? [["Online From", entry.onlineFrom], ["Online To", entry.onlineTo], ["Ref No.", entry.referenceNo]]
      : mode === "Cheque" ? [["Bank", entry.bankAccountTitle], ["Chq #", entry.chequeNumber], ["Chq Date", entry.chequeDate]]
        : mode === "Bank Transfer" ? [["Bank / Acc", entry.bankAccountTitle], ["Ref No.", entry.referenceNo]]
          : [];
  const shown = fields.filter(([, value]) => value);
  return (
    <div className="ledger-cash-desc">
      {entry.description && <span className="ledger-cash-main">{entry.description}</span>}
      {shown.map(([label, value]) => <span key={label}><small>{label}</small>{value}</span>)}
      {!entry.description && shown.length === 0 && <span className="ledger-cash-main">{dash}</span>}
    </div>
  );
};

const OneRow: React.FC<{ entry: LedgerEntry; onOpen: (entry: LedgerEntry) => void }> = ({ entry, onOpen }) => {
  const reference = entry.voucherType === LEDGER_TYPE.OPENING_BALANCE ? copy.openingBalance.ledgerRow
    : entry.voucherType === LEDGER_TYPE.SALE_RETURN ? text.types.SALE_RETURN
      : entry.modeOfTransfer || "Not recorded";
  return (
    <tr className="customer-ledger-row" onClick={() => onOpen(entry)}>
      <td>{formatDate(entry.voucherDate, entry.voucherDate)}</td>
      <td><VoucherNumber entry={entry} onOpen={onOpen} /></td>
      <td><TypeBadge type={entry.voucherType} /></td>
      <td>{dash}</td>
      <td><CashDescription entry={entry} /></td>
      <td className="amount">{dash}</td>
      <td className="amount">{dash}</td>
      <td className="amount">{dash}</td>
      <td className="amount debit">{entry.debitAmount ? fmt(entry.debitAmount) : dash}</td>
      <td className="amount credit">{entry.creditAmount ? fmt(entry.creditAmount) : dash}</td>
      <td className="amount balance">{fmt(entry.balance)}</td>
      <td>{reference}</td>
    </tr>
  );
};

export const LiveLedgerRows: React.FC<{ entry: LedgerEntry; onOpen: (entry: LedgerEntry) => void }> = ({ entry, onOpen }) => {
  const lines = entry.voucherType === LEDGER_TYPE.SALE ? entry.lineItems ?? [] : [];
  if (lines.length === 0) return <OneRow entry={entry} onOpen={onOpen} />;
  return <>{lines.map((line, index) => <SaleLineRow key={line.id} entry={entry} line={line} first={index === 0} last={index === lines.length - 1} onOpen={onOpen} />)}</>;
};
