import React from "react";
import { cartonsToPairs } from "@erp/domain";
import { copy } from "../../../config/copy";
import type { ReconciliationLine } from "../../../types/desktopApi";

// Where one upper's cartons stand, at a glance:
//
//   Expected        Upper returned     Cartons back     B cartons              Remaining
//   12 cartons      4 cartons          6 cartons        1 printed, not in yet  1 carton
//   72 pairs        24 pairs                                                    6 pairs
//
// Every figure is the main process's. Remaining is what the cut size and claims below must add up to.

const text = copy.programClose;

const Figure: React.FC<{ label: string; cartons: number | null; extra?: string | null; strong?: boolean }> = ({ label, cartons, extra, strong }) => (
  <div className={`mur-fig${strong ? " mur-fig--remaining" : ""}`}>
    <dt>{label}</dt>
    <dd>
      <b>{cartons == null ? "—" : text.cartons(cartons)}</b>
      {cartons == null ? null : <small>{text.pairs(cartonsToPairs(cartons))}</small>}
      {extra ? <small>{extra}</small> : null}
    </dd>
  </div>
);

export const UpperLineFigures: React.FC<{ line: ReconciliationLine; name: string }> = ({ line, name }) => {
  const waiting = line.bCartons - line.bBack;
  return (
    <dl className="mur-figs" aria-label={text.figuresLabel(name)}>
      <Figure label={text.figExpected} cartons={line.issuedCartons} />
      <Figure label={text.figReturned} cartons={line.returnedUpperCartons} />
      <Figure label={text.figBack} cartons={line.cartonsBack} />
      <Figure label={text.figB} cartons={line.bCartons} extra={waiting > 0 ? text.bWaiting(waiting) : null} />
      <Figure label={text.figRemaining} cartons={line.missingCartons} strong />
    </dl>
  );
};
