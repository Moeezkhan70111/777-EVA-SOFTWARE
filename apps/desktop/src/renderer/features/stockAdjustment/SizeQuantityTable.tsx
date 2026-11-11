import React from "react";
import { CARTON_ADJUSTMENT_KIND, type CartonAdjustmentDirection, type CartonAdjustmentKind } from "@erp/domain";
import { copy } from "../../config/copy";
import { dozensText, resultOf, typedCartons } from "./stockAdjustmentDraft";
import type { AdjustmentChoice } from "./stockAdjustmentReply";

// One article and colour, a row per size, IN DOZENS: in store now, the dozens typed, the figure it would leave. A size
// that already has opening stock says so in words and takes no opening quantity. A size the colour is not on yet says
// so too, and takes a quantity only where the colour can be added to it. Enter adds the typed sizes.

const text = copy.stockAdjustment;

interface SizeQuantityTableProps {
  kind: CartonAdjustmentKind;
  direction: CartonAdjustmentDirection;
  rows: readonly AdjustmentChoice[];
  typed: Readonly<Record<string, string>>;
  problems: ReadonlyArray<string | null>;
  canAddColor: boolean;
  onType: (articleSizeId: string, value: string) => void;
  onEnter: () => void;
}

const resultText = (row: AdjustmentChoice, direction: CartonAdjustmentDirection, typed: string): string => {
  const cartons = typedCartons(typed);
  return cartons === null ? "—" : dozensText(resultOf({ inStore: row.inStore, direction, cartons }));
};

/** Why a row takes no quantity, in words, or null when it does. */
const lockedNote = (row: AdjustmentChoice, opening: boolean, canAddColor: boolean): string | null => {
  if (row.colorMissing && !canAddColor) return text.colorNotOnSize;
  if (opening && row.hasOpening) return text.hasOpening;
  return null;
};

export const SizeQuantityTable: React.FC<SizeQuantityTableProps> = ({ kind, direction, rows, typed, problems, canAddColor, onType, onEnter }) => {
  const opening = kind === CARTON_ADJUSTMENT_KIND.OPENING;
  return (
    <div className="sa-table-wrap">
      <table className="data-table sa-table">
        <thead>
          <tr>
            <th scope="col">{text.sizeColumn}</th>
            <th scope="col" className="sa-num">{text.inStoreColumn}</th>
            <th scope="col" className="sa-num">{opening ? text.openingColumn : text.directions[direction]}</th>
            <th scope="col" className="sa-num">{text.resultColumn}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const locked = lockedNote(row, opening, canAddColor);
            const problem = problems[index] ?? null;
            const inputId = `sa-qty-${row.articleSizeId}`;
            return (
              <tr key={row.articleSizeId} className={problem ? "is-invalid" : undefined}>
                <th scope="row">
                  {row.size}
                  {row.colorMissing && canAddColor ? <span className="sa-note sa-new-on-size"> · {text.newOnSize}</span> : null}
                </th>
                <td className="sa-num">{dozensText(row.inStore)}</td>
                <td className="sa-num">
                  {locked ? (
                    <span className="sa-note">{locked}</span>
                  ) : (
                    <>
                      <input id={inputId} className="form-input sa-qty" inputMode="decimal" autoComplete="off" value={typed[row.articleSizeId] ?? ""}
                        aria-label={text.quantityFor(row.size)} aria-invalid={problem !== null} aria-describedby={problem ? `${inputId}-problem` : undefined}
                        onChange={(event) => onType(row.articleSizeId, event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onEnter(); } }} />
                      {problem ? <span id={`${inputId}-problem`} className="sa-problem" role="alert">⚠ {problem}</span> : null}
                    </>
                  )}
                </td>
                <td className="sa-num sa-result">{locked ? dozensText(row.inStore) : resultText(row, direction, typed[row.articleSizeId] ?? "")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
