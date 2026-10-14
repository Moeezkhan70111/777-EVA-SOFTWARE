import React from "react";
import { formatDozens } from "@erp/domain";
import { copy } from "../../config/copy";
import type { ProgramReconciliation } from "../../types/desktopApi";
import { formatDate } from "../../utils/dates";
import { formatUpperQuantities } from "../upperMoveOut/upperFeedback";

// One program's reconciliation — the two figures side by side, then the difference when they are one
// measure:
//
//   MP-000001 · MACHINE 1 · 14 Oct 2026
//   Measure             Upper Out        Production Received
//   Quantity (dozens)   20 DZN           11.5 DZN
//   Count               4 packets        23 cartons
//   Difference (Upper Out − Production Received)   8.5 DZN
//
// Every figure is the main process's; the comparison is the domain's (compareUpperOutToProduction).
// When an upper is counted in a unit with no rule to dozens, it is listed and no difference is given.

const text = copy.reconciliation;

export const ReconciliationTable: React.FC<{ reconciliation: ProgramReconciliation }> = ({ reconciliation }) => {
  const { program, upperOut, productionReceived, comparison } = reconciliation;
  const day = formatDate(program.programDate);
  return (
    <section className="card rc-card" aria-labelledby="rc-program">
      <header className="rc-program">
        <div className="mp-program-identity">
          <span className="mp-program-code">{program.code}</span>
          <h3 id="rc-program" className="rc-program-machine">{program.machineName}</h3>
          <span className="rc-program-day">{day}</span>
        </div>
        <p className="rc-program-crew">{text.contractors(program.contractorName, program.packingContractorName)}</p>
      </header>

      <div className="rp-table-wrap">
        <table className="data-table rc-table">
          <caption className="sr-only">{text.caption(program.code)}</caption>
          <thead>
            <tr>
              <th scope="col">{text.colMeasure}</th>
              <th scope="col" className="rp-num">{text.colUpperOut}</th>
              <th scope="col" className="rp-num">{text.colReceived}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="rc-main">
              <th scope="row">{text.rowDozens}</th>
              <td className="rp-num">{formatDozens(comparison.upperDozens)}</td>
              <td className="rp-num">{formatDozens(comparison.receivedDozens)}</td>
            </tr>
            <tr>
              <th scope="row">{text.rowCount}</th>
              <td className="rp-num">{text.packets(upperOut.packets)}</td>
              <td className="rp-num">
                {text.cartons(productionReceived.cartons)}
                {productionReceived.bCartons > 0 ? <small className="cp-voided">{text.ofWhichB(productionReceived.bCartons)}</small> : null}
              </td>
            </tr>
            {comparison.otherUpper.length > 0 ? (
              <tr>
                <th scope="row">{text.rowOther}</th>
                <td className="rp-num">{formatUpperQuantities(comparison.otherUpper)}</td>
                <td className="rp-num">—</td>
              </tr>
            ) : null}
          </tbody>
          <tfoot>
            <tr className="rc-difference">
              <th scope="row">{text.difference}</th>
              <td className="rp-num" colSpan={2}>
                {comparison.differenceDozens === null ? <span className="rc-not-comparable">{text.notComparable}</span> : formatDozens(comparison.differenceDozens)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <ul className="rc-basis">
        <li>{text.basisUpper(program.machineName, day)}</li>
        <li>{text.basisReceived}</li>
        <li>{text.basisRule}</li>
      </ul>
    </section>
  );
};
