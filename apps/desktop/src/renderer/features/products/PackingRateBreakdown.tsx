import React from "react";
import { fromPaisa } from "@erp/domain";
import { formatMoney } from "../../app/format";
import { copy } from "../../config/copy";
import { packingTotalRupees, type PackingRateItem } from "./packingRateItems";

// What the product's packing rate is made of, under the rate boxes:
//
//   PACKING BREAKDOWN                    per DOZEN
//   BOX                       Rs 50.00     ✎  ×
//   TAPE                      Rs 30.00     ✎  ×
//   Total                    Rs 150.00
//
// Shown only once there is at least one attribute; until then the packing rate is one typed box.

interface PackingRateBreakdownProps {
  items: readonly PackingRateItem[];
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
}

const rupees = (value: number): string => `${copy.machineProgram.rupeePrefix} ${formatMoney(value)}`;

export const PackingRateBreakdown: React.FC<PackingRateBreakdownProps> = ({ items, onEdit, onRemove }) => {
  if (items.length === 0) return null;
  const text = copy.products.packingItems;

  return (
    <div className="packing-breakdown">
      <div className="packing-breakdown-head">
        <h3>{text.breakdownTitle}</h3>
        <span>{copy.machineProgram.perDozen}</span>
      </div>
      <ul className="packing-breakdown-list">
        {items.map((item, index) => (
          <li className="packing-breakdown-row" key={`${index}-${item.name}`}>
            <span className="packing-breakdown-name">{item.name}</span>
            <span className="packing-breakdown-amount">{rupees(fromPaisa(item.ratePaisa))}</span>
            <span className="packing-breakdown-actions">
              <button type="button" className="packing-breakdown-btn" aria-label={text.edit(item.name)} title={text.edit(item.name)} onClick={() => onEdit(index)}>
                ✎
              </button>
              <button type="button" className="packing-breakdown-btn packing-breakdown-btn--remove" aria-label={text.remove(item.name)} title={text.remove(item.name)} onClick={() => onRemove(index)}>
                ×
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div className="packing-breakdown-total">
        <span>{text.total}</span>
        <strong>{rupees(packingTotalRupees(items))}</strong>
      </div>
    </div>
  );
};
