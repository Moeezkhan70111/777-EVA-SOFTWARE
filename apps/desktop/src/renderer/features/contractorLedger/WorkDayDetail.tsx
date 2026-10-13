import React from "react";
import type { ContractorWorkDay } from "@erp/domain";
import { copy } from "../../config/copy";
import { amount, calculationText, dozensText, rateSourceLabel, rupees } from "./contractorLedgerView";

// One production day opened up: every program and article it was made of, and how each amount
// was worked out.
//
//   Program              Work      Article    Qty                  Rate / dozen          Calculation                      Amount
//   MP-000011 · MACHINE 1 Machine  SK6 7/10   10 DZN · 20 cartons  Rs 70.00 Program rate 10 DZN × Rs 70.00 = Rs 700.00    700.00

const text = copy.contractorLedger;

export const WorkDayDetail: React.FC<{ day: ContractorWorkDay }> = ({ day }) => (
  <div className="contractor-ledger-detail">
    <table className="contractor-ledger-detail-table">
      <thead>
        <tr>
          <th>{text.colProgram}</th>
          <th>{text.colWork}</th>
          <th>{text.colArticle}</th>
          <th className="amount">{text.colQty}</th>
          <th className="amount">{text.colRate}</th>
          <th>{text.colCalculation}</th>
          <th className="amount">{text.colAmount}</th>
        </tr>
      </thead>
      <tbody>
        {day.lines.map((line) => (
          <tr key={`${line.programId}-${line.role}-${line.articleSizeId}`}>
            <td>
              <strong>{line.programCode}</strong>
              {line.machineName && <small> · {line.machineName}</small>}
            </td>
            <td>{text.jobs[line.role]}</td>
            <td>{`${line.article} ${line.size}`}</td>
            <td className="amount">
              {dozensText(line.dozens)}
              <small>{text.cartons(line.cartons)}</small>
            </td>
            <td className="amount">
              {line.ratePaisa == null ? <span className="contractor-ledger-unpriced">{text.notPriced}</span> : rupees(line.ratePaisa)}
              {line.ratePaisa != null && <small>{rateSourceLabel(line)}</small>}
            </td>
            <td className="contractor-ledger-calc">{calculationText(line)}</td>
            <td className="amount">{line.ratePaisa == null ? "—" : amount(line.amountPaisa)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={3}>{text.dayTotal}</td>
          <td className="amount">{dozensText(day.dozens)}</td>
          <td colSpan={2} />
          <td className="amount">{amount(day.amountPaisa)}</td>
        </tr>
      </tfoot>
    </table>
  </div>
);
