import React from "react";
import { formatQuantityInDozens } from "@erp/domain";
import { copy } from "../../config/copy";
import type { ProductionReceiptSummaryLine } from "../../types/desktopApi";

// SUMMARY — today's received production added up per article, size and colour:
//
//   Article  Size   Colour   Cartons   Dozens
//   SK6      7/10   RED           20    10 DZN
//   SK6      4/6    BLACK         40    20 DZN
//   Total                         60    30 DZN
//
// The whole day, not one page of the details. Every figure is counted by the database
// (listProductionReceipts, listManualProduction); the dozens are the one carton rule
// (formatQuantityInDozens). Shared by Receive Production and Manual Production.

const text = copy.receiveProduction;

const lineKey = (line: ProductionReceiptSummaryLine) => `${line.article}|${line.size}|${line.color}|${line.grade ?? ""}`;

interface ReceiptSummaryProps {
  lines: ProductionReceiptSummaryLine[];
  totalCartons: number;
  /** What the table is, for a screen reader. */
  caption?: string;
}

export const ReceiptSummary: React.FC<ReceiptSummaryProps> = ({ lines, totalCartons, caption = text.summaryCaption }) => (
  <div className="rp-table-wrap">
    <table className="data-table rp-table rp-summary">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{text.colArticle}</th>
          <th scope="col">{text.colSize}</th>
          <th scope="col">{text.colColor}</th>
          <th scope="col" className="rp-num">{text.colCartons}</th>
          <th scope="col" className="rp-num">{text.colDozens}</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={lineKey(line)}>
            <td><strong>{line.article}</strong></td>
            <td>{line.size}</td>
            <td>
              {line.color}
              {line.grade ? <span className="badge badge-warn rp-grade" aria-label={text.bCarton} title={text.bCarton}>B</span> : null}
            </td>
            <td className="rp-num">{line.cartons.toLocaleString()}</td>
            <td className="rp-num rp-dozens">{formatQuantityInDozens(line.cartons)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="rp-total">
          <th scope="row" colSpan={3}>{text.total}</th>
          <td className="rp-num">{totalCartons.toLocaleString()}</td>
          <td className="rp-num rp-dozens">{formatQuantityInDozens(totalCartons)}</td>
        </tr>
      </tfoot>
    </table>
  </div>
);
