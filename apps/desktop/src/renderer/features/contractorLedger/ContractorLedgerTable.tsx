import React, { useState } from "react";
import type { ContractorLedgerEntry } from "@erp/domain";
import { copy } from "../../config/copy";
import { formatDate } from "../../utils/dates";
import type { ContractorLedgerReport } from "../../types/desktopApi";
import { amount, dozensText } from "./contractorLedgerView";
import { WorkDayDetail } from "./WorkDayDetail";

// The ledger itself, the way a ledger reads: one row per production day and per payment, with
// a running balance. A production day opens to show what it was made of and how it was worked out.
//
//   Date     Particulars                     Qty      Earned (Cr)   Paid (Dr)   Balance
//            Opening balance                                                    700.00
//   12 Oct   ▸ Production · MP-000011        10 DZN   700.00                    1,400.00
//   14 Oct   Payment · CV-000045 · Cash                             500.00      900.00

const text = copy.contractorLedger;

const COLUMNS = 6;

/** "Production · MP-000011, MP-000012" — the programs that day's work came from. */
const workParticulars = (entry: Extract<ContractorLedgerEntry, { kind: "WORK" }>): string => {
  const programs = [...new Set(entry.work.lines.map((line) => line.programCode))];
  return `${text.production} · ${programs.join(", ")}`;
};

/** "Payment · CV-000045 · Cash · Weekly payment" */
const paymentParticulars = (entry: Exclude<ContractorLedgerEntry, { kind: "WORK" }>): string => {
  const { payment } = entry;
  const label = { PAYMENT: text.payment, RECEIPT: text.receipt, CLAIM: text.claim }[entry.kind];
  return [label, payment.voucherNumber, payment.modeOfTransfer, payment.description].filter(Boolean).join(" · ");
};

const AmountCells: React.FC<{ entry: ContractorLedgerEntry }> = ({ entry }) => (
  <>
    <td className="amount credit">{entry.creditPaisa ? amount(entry.creditPaisa) : "—"}</td>
    <td className="amount debit">{entry.debitPaisa ? amount(entry.debitPaisa) : "—"}</td>
    <td className="amount balance">{amount(entry.balancePaisa)}</td>
  </>
);

const WorkRows: React.FC<{ entry: Extract<ContractorLedgerEntry, { kind: "WORK" }>; open: boolean; onToggle: () => void }> = ({ entry, open, onToggle }) => {
  const date = formatDate(entry.date);
  return (
    <>
      <tr className={`contractor-ledger-work-row${open ? " is-open" : ""}`} onClick={onToggle}>
        <td>{date}</td>
        <td>
          <button
            type="button"
            className="contractor-ledger-toggle"
            aria-expanded={open}
            aria-label={open ? text.hideDetails(date) : text.showDetails(date)}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
          >
            <span aria-hidden="true" className="contractor-ledger-chevron">▸</span>
          </button>
          {workParticulars(entry)}
        </td>
        <td className="amount">{dozensText(entry.work.dozens)}</td>
        <AmountCells entry={entry} />
      </tr>
      {open && (
        <tr className="contractor-ledger-detail-row">
          <td colSpan={COLUMNS}>
            <WorkDayDetail day={entry.work} />
          </td>
        </tr>
      )}
    </>
  );
};

export const ContractorLedgerTable: React.FC<{ ledger: ContractorLedgerReport }> = ({ ledger }) => {
  const [openDates, setOpenDates] = useState<ReadonlySet<string>>(new Set());
  const toggle = (date: string) =>
    setOpenDates((previous) => {
      const next = new Set(previous);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });

  return (
    <div className="contractor-ledger-table-wrap">
      <table className="customer-ledger-table contractor-ledger-table">
        <thead>
          <tr>
            <th>{text.colDate}</th>
            <th>{text.colParticulars}</th>
            <th className="amount">{text.colQty}</th>
            <th className="amount">{text.colEarned}</th>
            <th className="amount">{text.colPaid}</th>
            <th className="amount">{text.colBalance}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="opening-row">
            <td>{formatDate(ledger.fromDate)}</td>
            <td colSpan={4}>{text.openingRow}</td>
            <td className="amount balance">{amount(ledger.openingBalancePaisa)}</td>
          </tr>
          {ledger.entries.map((entry) =>
            entry.kind === "WORK" ? (
              <WorkRows key={`work-${entry.date}`} entry={entry} open={openDates.has(entry.date)} onToggle={() => toggle(entry.date)} />
            ) : (
              <tr key={`${entry.kind}-${entry.payment.voucherId}`}>
                <td>{formatDate(entry.date)}</td>
                <td>{paymentParticulars(entry)}</td>
                <td className="amount">—</td>
                <AmountCells entry={entry} />
              </tr>
            )
          )}
        </tbody>
        <tfoot>
          <tr className="customer-ledger-total-row">
            <td colSpan={2}>{text.totalRow}</td>
            <td className="amount">{dozensText(ledger.dozens)}</td>
            <td className="amount credit">{amount(ledger.totalCreditPaisa)}</td>
            <td className="amount debit">{amount(ledger.totalDebitPaisa)}</td>
            <td className="amount balance">{amount(ledger.closingBalancePaisa)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
};
