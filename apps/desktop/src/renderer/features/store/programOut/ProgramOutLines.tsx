import React from "react";
import { copy } from "../../../config/copy";
import { StateView } from "../../../components/shared/StateView";
import { formatQuantity, type ProgramOutRow } from "./programOut";

// What the open program authorises, as one flat table.
//
//   Article  Size   Sole    Upper    Authorised   Issued   Remaining
//   SK6      7/10   BLACK   BLACK    100 DOZEN    30       70
//
// Flat on purpose: the storekeeper is fetching packets of an upper, not reading a production
// plan, so injector and run — which the Machine Program screen groups by — are not shown. Every
// figure comes from the program record, recomputed from the event log after every scan; nothing
// is calculated here.

interface ProgramOutLinesProps {
  rows: ProgramOutRow[];
}

export const ProgramOutLines: React.FC<ProgramOutLinesProps> = ({ rows }) => {
  if (rows.length === 0) {
    return <StateView kind="empty" compact title={copy.programOut.noLines} hint={copy.programOut.noLinesHint} />;
  }

  return (
    <div className="mpo-lines">
      <table className="mpo-table">
        <caption className="mpo-table-caption">{copy.programOut.linesNote}</caption>
        <thead>
          <tr>
            <th scope="col">{copy.programOut.colArticle}</th>
            <th scope="col">{copy.programOut.colSize}</th>
            <th scope="col">{copy.programOut.colSole}</th>
            <th scope="col">{copy.programOut.colUpper}</th>
            <th scope="col" className="mpo-num">
              {copy.programOut.colAuthorized}
            </th>
            <th scope="col" className="mpo-num">
              {copy.programOut.colIssued}
            </th>
            <th scope="col" className="mpo-num">
              {copy.programOut.colRemaining}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className={row.remaining <= 0 ? "mpo-row--done" : undefined}>
              <td>{row.article}</td>
              <td>{row.size}</td>
              <td>{row.soleColour}</td>
              <td>
                <span className="mpo-upper">{row.upperColour || row.upper}</span>
                {row.remaining <= 0 ? <span className="mpo-done-tag">✓ fully issued</span> : null}
              </td>
              <td className="mpo-num">{formatQuantity(row.authorized, row.unitCode)}</td>
              <td className="mpo-num">{formatQuantity(row.issued, row.unitCode)}</td>
              <td className="mpo-num">
                <strong>{formatQuantity(row.remaining, row.unitCode)}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
