import React from "react";
import { copy } from "../../config/copy";
import { dozensText } from "./stockAdjustmentDraft";

// The figure a line would leave, in dozens. Below zero is allowed for a decrease (owner, 12 Nov 2026): it is shown
// as it is, in amber, with words saying production is owed, so it never reads as an ordinary figure.

const text = copy.stockAdjustment;

export const ResultCell: React.FC<{ cartons: number | null }> = ({ cartons }) => {
  if (cartons === null) return <td className="sa-num sa-result">—</td>;
  const below = cartons < 0;
  return (
    <td className={below ? "sa-num sa-result is-below-zero" : "sa-num sa-result"}>
      {dozensText(cartons)}
      {below ? <span className="sa-below-zero">⚠ {text.belowZero}</span> : null}
    </td>
  );
};
