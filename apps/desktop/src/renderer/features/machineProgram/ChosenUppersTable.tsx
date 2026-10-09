import React from "react";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { TrashIcon } from "./MachineProgramIcons";
import { formatAmount } from "./machineProgram";
import { rowProblem, type ChosenUpper } from "./useChosenUppers";

// SELECTED ARTICLES — what Add to Program is about to put on the injector:
//
//   Article / Size   Upper Color   Available Stock   Quantity
//   SK6 · 7/10       ● Brown       10 DOZEN          [ 10 ]     🗑
//
// Nothing here is saved yet, so the quantity is simply typed and kept; it is measured against
// the store's figure for that upper with the same wording used everywhere a quantity is typed
// (machineProgram quantityProblem). An empty box is not an error — it is a row still being
// filled in — so it only holds Add to Program back rather than shouting at the operator.

interface ChosenUppersTableProps {
  rows: ChosenUpper[];
  onSetQuantity: (itemId: string, quantity: string) => void;
  onRemove: (itemId: string) => void;
}

export const ChosenUppersTable: React.FC<ChosenUppersTableProps> = ({ rows, onSetQuantity, onRemove }) => {
  if (rows.length === 0) {
    return <StateView kind="empty" compact title={copy.machineProgram.nothingChosenTitle} hint={copy.machineProgram.nothingChosenHint} />;
  }

  return (
    <div className="mpa-table-wrap mpa-table-wrap--chosen">
      <table className="mpa-table">
        <thead>
          <tr>
            <th scope="col">{copy.machineProgram.colArticleSize}</th>
            <th scope="col">{copy.machineProgram.colUpper}</th>
            <th scope="col" className="mpa-num">
              {copy.machineProgram.colAvailableStock}
            </th>
            <th scope="col">{copy.machineProgram.colQuantityPlain}</th>
            <th scope="col">
              <span className="sr-only">{copy.machineProgram.colAction}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <ChosenRow key={row.itemId} row={row} onSetQuantity={onSetQuantity} onRemove={onRemove} />
          ))}
        </tbody>
      </table>
    </div>
  );
};

const ChosenRow: React.FC<{ row: ChosenUpper } & Omit<ChosenUppersTableProps, "rows">> = ({ row, onSetQuantity, onRemove }) => {
  const typed = row.quantity.trim() !== "";
  const problem = typed ? rowProblem(row) : null;
  return (
    <tr>
      <td>
        <span className="mpa-article">{row.article}</span>
        <span className="mpa-sub">{row.size}</span>
      </td>
      <td>
        <span className="mpa-colour">
          <ColorSwatch color={row.upperColour} className="mpa-swatch" />
          {row.upperColour}
        </span>
        <span className="mpa-sub">{row.kind}</span>
      </td>
      <td className="mpa-num">{formatAmount(row.available, row.unitCode)}</td>
      <td>
        <span className="mpx-qty-cell">
          <input
            className={`mpx-qty-input${problem ? " is-wrong" : ""}`}
            inputMode="decimal"
            value={row.quantity}
            aria-label={copy.machineProgram.quantityOf(row.upperColour, row.article, row.size)}
            aria-invalid={problem ? true : undefined}
            onChange={(event) => onSetQuantity(row.itemId, event.target.value.replace(",", "."))}
          />
          {problem ? (
            <span className="mpx-qty-problem" role="alert">
              ⚠ {problem}
            </span>
          ) : null}
        </span>
      </td>
      <td>
        <button
          type="button"
          className="mpx-icon-btn mpx-icon-btn--danger"
          aria-label={copy.machineProgram.removeFromSelection(row.upperColour)}
          onClick={() => onRemove(row.itemId)}
        >
          <TrashIcon />
        </button>
      </td>
    </tr>
  );
};
