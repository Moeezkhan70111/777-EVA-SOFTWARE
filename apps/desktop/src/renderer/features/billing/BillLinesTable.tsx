import React from "react";
import { copy } from "../../config/copy";
import { StateView } from "../../components/shared/StateView";
import type { BillLine, EditableLineField, PriceType } from "./billLines";
import { ComputedCell, formatFigure, LineNumberInput } from "./LineNumberInput";

// The lines of the bill, one per article + size.
//
// The split that matters: WHAT went out — the articles, the sizes and the quantities — is
// the gatepass's, because that is the document the goods physically left on. WHAT IT IS
// WORTH — the rate, the price type and the "less" per pair — is not on the gatepass at all
// and is the desk's to set. So on a bill made from a gatepass the dozens are shown as a
// fact, not offered as a field, and no line can be taken off.
//
// The lock is only what the clerk sees; the rule itself is enforced on every line write in
// the data layer (assertBillLineMatchesGatepass), because a disabled input is not a rule.

interface BillLinesTableProps {
  lines: BillLine[];
  disabled?: boolean;
  /** The gatepass this bill must keep saying. Null when the bill was not made from one. */
  gatepassCode?: string | null;
  onFieldChange: (index: number, field: EditableLineField, value: number) => void;
  onPriceTypeChange: (index: number, priceType: PriceType) => void;
  onRemove: (index: number) => void;
}

const HEADERS: Array<{ label: string; numeric?: boolean }> = [
  { label: copy.billing.articleSize },
  { label: copy.columns.type },
  { label: copy.billing.dozens, numeric: true },
  { label: copy.billing.cartons, numeric: true },
  { label: copy.billing.pairRate, numeric: true },
  { label: copy.columns.amount, numeric: true },
  { label: copy.billing.pairLess, numeric: true },
  { label: copy.billing.totalLess, numeric: true },
  { label: copy.billing.lineTotal, numeric: true },
  { label: "" },
];

const sourceLabel = (line: BillLine): string => (line.discSource ? copy.billing.discountSource[line.discSource] : "");

export const BillLinesTable: React.FC<BillLinesTableProps> = ({ lines, disabled, gatepassCode, onFieldChange, onPriceTypeChange, onRemove }) => {
  if (lines.length === 0) {
    return <StateView kind="empty" compact title={copy.billing.noLinesOnBill} />;
  }

  const locked = Boolean(gatepassCode);

  return (
    <div className="bill-lines-scroll">
      {locked ? (
        <p className="bill-lines-locked-note">
          <strong>{copy.billing.quantityFromGatepass(gatepassCode ?? "")}</strong>
          <span>{copy.billing.quantityLockedHint}</span>
        </p>
      ) : null}
      <table className="gp-table bill-lines" data-testid="bill-lines">
        <thead>
          <tr>
            {HEADERS.map((header, index) => (
              <th key={index} className={header.numeric ? "num" : undefined} scope="col">
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => {
            const name = `${line.article} ${line.size}`;
            const isBType = line.priceType === "B_TYPE";
            return (
              <tr key={line.id ?? `${line.productVariantId}-${index}`} data-testid="bill-line">
                <td>
                  <span className="bill-line-article">{line.article}</span>
                  <span className="bill-line-size">{line.size}</span>
                </td>
                <td>
                  <select
                    className="bill-type-select"
                    aria-label={copy.billing.priceTypeLabel(line.article, line.size)}
                    value={line.priceType}
                    disabled={disabled}
                    onChange={(event) => onPriceTypeChange(index, event.target.value === "B_TYPE" ? "B_TYPE" : "NORMAL")}
                  >
                    <option value="NORMAL">{copy.billing.priceTypeNormal}</option>
                    <option value="B_TYPE">{copy.billing.priceTypeBType}</option>
                  </select>
                </td>
                <td className="num">
                  {locked ? (
                    <>
                      <ComputedCell value={line.dznQty} strong />
                      <span className="bill-line-hint">{copy.billing.quantityLockedCell(gatepassCode ?? "")}</span>
                    </>
                  ) : (
                    <LineNumberInput value={line.dznQty} onChange={(value) => onFieldChange(index, "dznQty", value)} label={`${copy.billing.dozens} ${name}`} disabled={disabled} />
                  )}
                </td>
                <td className="num"><ComputedCell value={line.unitQty} muted /></td>
                <td className="num">
                  <LineNumberInput value={line.pairRate} onChange={(value) => onFieldChange(index, "pairRate", value)} label={`${copy.billing.pairRate} ${name}`} disabled={disabled} />
                  <span className="bill-line-hint">{copy.billing.perDozen(formatFigure(line.dznRate))}</span>
                </td>
                <td className="num"><ComputedCell value={line.amount} /></td>
                <td className="num">
                  <LineNumberInput value={line.pairDisc} onChange={(value) => onFieldChange(index, "pairDisc", value)} label={`${copy.billing.pairLess} ${name}`} disabled={disabled || isBType} />
                  {!isBType && (
                    <span className="bill-line-hint">
                      {sourceLabel(line) && <span className="bill-less-source">{sourceLabel(line)} · </span>}
                      {copy.billing.perDozen(formatFigure(line.dznDisc))}
                    </span>
                  )}
                </td>
                <td className="num"><ComputedCell value={line.totalDisc} muted /></td>
                <td className="num"><ComputedCell value={line.total} strong /></td>
                <td>
                  {locked ? null : (
                    <button type="button" className="gp-icon-btn gp-icon-btn--danger" aria-label={copy.billing.removeLine(line.article, line.size)} disabled={disabled} onClick={() => onRemove(index)}>
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
