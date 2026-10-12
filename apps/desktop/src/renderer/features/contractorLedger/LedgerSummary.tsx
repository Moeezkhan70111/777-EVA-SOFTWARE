import React from "react";
import { copy } from "../../config/copy";
import { formatDate } from "../../utils/dates";
import type { ContractorLedgerReport } from "../../types/desktopApi";
import { dozensText, rupees } from "./contractorLedgerView";

// The four figures above a contractor's ledger, and a warning when some production has no rate.
//
//   Opening Balance   Work Done      Paid           Balance Payable
//   Rs 700.00         Rs 1,050.00    Rs 650.00      Rs 1,100.00
//   as of 1 Oct       15 DZN         Cash vouchers  as of 31 Oct

const text = copy.contractorLedger;

const Figure: React.FC<{ label: string; value: string; line: string; tone?: "positive" | "negative" }> = ({ label, value, line, tone }) => (
  <div className="customer-ledger-summary-card contractor-ledger-figure">
    <div>
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      <small>{line}</small>
    </div>
  </div>
);

export const LedgerSummary: React.FC<{ ledger: ContractorLedgerReport }> = ({ ledger }) => {
  // Positive is owed TO the contractor; negative means they have been paid ahead of their work.
  const owed = ledger.closingBalancePaisa >= 0;
  return (
    <>
      <div className="contractor-ledger-summary">
        <Figure label={text.openingBalance} value={rupees(ledger.openingBalancePaisa)} line={text.asOf(formatDate(ledger.fromDate))} />
        <Figure label={text.workDone} value={rupees(ledger.earnedPaisa)} line={text.dozensLine(dozensText(ledger.dozens))} tone="positive" />
        <Figure label={text.paid} value={rupees(ledger.paidPaisa)} line={text.paidLine} tone="negative" />
        <Figure
          label={owed ? text.balance : text.advance}
          value={rupees(Math.abs(ledger.closingBalancePaisa))}
          line={text.asOf(formatDate(ledger.toDate))}
        />
      </div>
      {ledger.unpricedDozens > 0 && (
        <p className="contractor-ledger-warning" role="status">
          ⚠ {text.unpriced(dozensText(ledger.unpricedDozens))}
        </p>
      )}
    </>
  );
};
