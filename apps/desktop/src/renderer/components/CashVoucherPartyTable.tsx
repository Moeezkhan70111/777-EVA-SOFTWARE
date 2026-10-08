import React, { RefObject } from "react";
import type { Party } from "../types/desktopApi";
import { copy } from "../config/copy";
import { formatWholeMoney } from "../app/format";

export interface CashVoucherLine {
  id: string;
  partyId: string;
  partyName: string;
  description: string;
  modeOfTransfer: string;
  bankAccountTitle: string;
  chequeNumber: string;
  chequeDate: string;
  onlineFrom: string;
  onlineTo: string;
  referenceNo: string;
  receiptAmount: string;
  paymentAmount: string;
}

type TransferField = "bankAccountTitle" | "chequeNumber" | "chequeDate" | "onlineFrom" | "onlineTo" | "referenceNo";
const detailFields: Record<string, Array<{ key: TransferField; label: string; type?: string }>> = {
  "Bank Transfer": [{ key: "bankAccountTitle", label: "Bank / Account Title" }],
  Cheque: [{ key: "bankAccountTitle", label: "Bank / Account Title" }, { key: "chequeNumber", label: "Cheque Number" }, { key: "chequeDate", label: "Cheque Date", type: "date" }],
  "Online Transfer": [{ key: "onlineFrom", label: "Online From" }, { key: "onlineTo", label: "Online To" }, { key: "referenceNo", label: "Reference Number" }],
};

interface Props {
  lines: CashVoucherLine[];
  parties: Party[];
  partyFieldRefs: RefObject<Record<string, HTMLSelectElement | null>>;
  onPartyChange: (lineId: string, partyId: string) => void;
  onModeChange: (lineId: string, mode: string) => void;
  onUpdate: (lineId: string, changes: Partial<CashVoucherLine>) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onDelete: (lineId: string) => void;
}

const fieldValue = (line: CashVoucherLine, field: TransferField) => {
  switch (field) {
    case "bankAccountTitle": return line.bankAccountTitle;
    case "chequeNumber": return line.chequeNumber;
    case "chequeDate": return line.chequeDate;
    case "onlineFrom": return line.onlineFrom;
    case "onlineTo": return line.onlineTo;
    case "referenceNo": return line.referenceNo;
  }
};

export const CashVoucherPartyTable: React.FC<Props> = ({ lines, parties, partyFieldRefs, onPartyChange, onModeChange, onUpdate, onKeyDown, onDelete }) => {
  const receiptTotal = lines.reduce((sum, line) => sum + (Number(line.receiptAmount) || 0), 0);
  const paymentTotal = lines.reduce((sum, line) => sum + (Number(line.paymentAmount) || 0), 0);

  return <div className="cash-party-table-wrap"><table className="cash-party-table"><thead><tr><th>#</th><th>Party *</th><th>Mode of Payment</th><th>{copy.columns.description}</th><th>Receipt Amount (Rs.)</th><th>Payment Amount (Rs.)</th><th>Action</th></tr></thead><tbody>{lines.map((line, index) => {
    const mode = line.modeOfTransfer || "Cash";
    const fields = detailFields[mode] || [];
    return <React.Fragment key={line.id}><tr className={`cash-party-entry-row cash-party-entry-${mode.toLowerCase().replace(/\s+/g, "-")}`}><td>{index + 1}</td><td><select ref={(element) => { partyFieldRefs.current[line.id] = element; }} value={line.partyId} onChange={(event) => void onPartyChange(line.id, event.target.value)} onKeyDown={onKeyDown}><option value="">Select party...</option>{parties.map((item) => <option key={item.id} value={item.id}>{item.partyName}</option>)}</select></td><td><select className="cash-party-mode-select" value={mode} onChange={(event) => onModeChange(line.id, event.target.value)} onKeyDown={onKeyDown}><option>Cash</option><option>Bank Transfer</option><option>Cheque</option><option>Online Transfer</option><option>Other</option></select></td><td><input value={line.description} placeholder={copy.columns.description} onChange={(event) => onUpdate(line.id, { description: event.target.value })} onKeyDown={onKeyDown} /></td><td><input type="number" min="0" value={line.receiptAmount} placeholder="0.00" onChange={(event) => onUpdate(line.id, { receiptAmount: event.target.value, paymentAmount: "" })} onKeyDown={onKeyDown} /></td><td><input type="number" min="0" value={line.paymentAmount} placeholder="0.00" onChange={(event) => onUpdate(line.id, { paymentAmount: event.target.value, receiptAmount: "" })} onKeyDown={onKeyDown} /></td><td><button type="button" className="cash-delete-line" title={copy.actions.removeRow} onClick={() => onDelete(line.id)}>×</button></td></tr>{fields.length > 0 && <tr className={`cash-party-details-row cash-party-details-${mode.toLowerCase().replace(/\s+/g, "-")}`}><td colSpan={7}><div className="cash-party-details"><div className="cash-party-details-heading"><strong>{mode} Details</strong></div><div className="cash-party-details-grid">{fields.map((field) => <label key={field.key}><span>{field.label}</span><input type={field.type || "text"} value={fieldValue(line, field.key)} onChange={(event) => onUpdate(line.id, { [field.key]: event.target.value })} onKeyDown={onKeyDown} /></label>)}</div></div></td></tr>}</React.Fragment>;
  })}<tr className="cash-party-total"><td colSpan={4}>{copy.columns.total}</td><td>Rs. {fmtNum(receiptTotal)}</td><td>Rs. {fmtNum(paymentTotal)}</td><td>-</td></tr></tbody></table></div>;
};

const fmtNum = formatWholeMoney;
